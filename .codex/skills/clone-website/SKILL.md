---
name: clone-website
description: Reverse-engineer and clone any website into a pixel-perfect Next.js app. Use whenever the user wants to clone, replicate, rebuild, reverse-engineer, or copy a website, a landing page, or a specific page — or says "make a copy of this site", "rebuild this page", "pixel-perfect clone". Drives a real headless browser (Playwright) to extract exact computed CSS, real assets, and interaction/scroll/hover states, then builds it section-by-section with parallel Task subagents. Provide one or more target URLs.
---

# Clone Website

You reverse-engineer and rebuild the target URL(s) the user provided as pixel-perfect clones, into a Next.js 16 + React 19 + shadcn/ui + Tailwind v4 scaffold.

This is NOT a two-phase "inspect then build". You are a **foreman walking the job site** — as you inspect each section you write a detailed spec file, then hand that file to a builder subagent with everything it needs. Extraction is meticulous and produces auditable artifacts; construction runs in parallel.

When multiple URLs are given, process them with isolated artifacts per site (e.g. `docs/research/<hostname>/`).

## Toolchain (read first)

Browser automation is **mandatory** and is provided by a bundled Playwright helper — there is no browser-MCP dependency. Resolve `H` (the skill's own directory) once, then drive everything through it:

```bash
# Resolve skill dir: explicit override wins, then the repo-vendored copy (a cloned repo
# ships its own .claude/skills/clone-website, so it stays self-contained), then a global
# install. Claude Code also exposes ${CLAUDE_SKILL_DIR} for the currently-invoked skill.
H="${CLONE_WEBSITE_SKILL_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.claude/skills/clone-website}"
[ -d "$H/scripts" ] || H="${CLAUDE_SKILL_DIR:-$HOME/.config/opencode/skills/clone-website}"
[ -d "$H/scripts" ] || H="$HOME/.claude/skills/clone-website"
[ -d "$H/scripts" ] || { echo "clone-website skill not found. Set CLONE_WEBSITE_SKILL_DIR to its path." >&2; }

# screenshots (master refs + per-section + QA). --full = full page; --mobile = 390px.
node "$H/scripts/inspect.mjs" screenshot <url> <out.png> [--full] [--width 1440|--mobile] [--scroll Y] [--hover SEL] [--click SEL]
# exact computed-style DOM walk for ONE selector (the heart of extraction)
node "$H/scripts/inspect.mjs" extract <url> "<css-selector>" [--width 1440|--mobile] [--scroll Y] [--hover SEL] [--click SEL]
# frozen six-bucket vocabulary (colors, spacing, radii, fonts, shadows, fontSizes) — pipe to docs/research/tokens.lock.json
# --responsive scans desktop AND mobile in one call and merges them; always use it for the lock
node "$H/scripts/inspect.mjs" tokens <url> [--responsive] [--width 1440|--mobile] [--min-count N] [--top N]
# enumerate every image / video / background-image / font / favicon on the page
node "$H/scripts/inspect.mjs" assets <url> [--mobile]
# download every discovered asset into a folder (batched, deduped)
node "$H/scripts/inspect.mjs" download <url> public/images
# map top-level sections, boxes, z-index, headings — your page topology starter
node "$H/scripts/inspect.mjs" topology <url> [--mobile]
# "is this element moving on its own?" — one load, long observation window, samples transform/opacity/backgroundPosition
node "$H/scripts/inspect.mjs" motion-check <url> "<css-selector>" [--duration 8000] [--samples 5] [--props a,b,c]
```

**Multi-state extraction = two calls, then diff.** To capture a scroll/hover/click state, run `extract` (or `screenshot`) once in the default state and again with `--scroll Y` / `--hover SEL` / `--click SEL`. The diff between the two outputs IS the behavior spec. Use `--wait MS` to let animations settle. This two-call diff is for *triggered* states only — for self-driven, continuous motion use `motion-check`, never two `extract --wait` calls (see the Motion sweep in Phase 1).

If `inspect.mjs` fails because Playwright/Chromium is missing, run once: `cd "$H/scripts" && npm install && npx playwright install chromium`.

## Scope Defaults

Clone exactly what's visible at the URL. Unless the user says otherwise:
- **Fidelity:** Pixel-perfect — exact colors, spacing, typography, animations
- **In scope:** Visual layout/styling, component structure, interactions, responsive design, mock data for demos
- **Out of scope:** Real backend/database, auth, real-time features, SEO, a11y audit
- **Customization:** None — pure emulation. Honor any user overrides.

## Pre-Flight

1. **Scaffold check / bootstrap.** If the current working directory is NOT already this cloner scaffold (no `package.json` depending on `next` + `src/app/`), bootstrap one:
   ```bash
   cp -R "$H/scaffold/." <target-dir>
   cd <target-dir> && npm install
   ```
   Ask the user for the target directory name if it's ambiguous. If a scaffold is already present, use it in place.
2. **Verify this is a git repository** (`git rev-parse --is-inside-work-tree`). If not, `git init && git add -A && git commit -m 'chore: baseline before clone'` — the tripwire mechanism below requires git history to diff against.
3. **Verify the helper works:** `node "$H/scripts/inspect.mjs" topology <url>` should return JSON. If it errors on Playwright, run the install line above.
4. **Validate URLs.** Normalize each; confirm each loads (the `topology` call above doubles as a reachability check). If a site blocks headless browsers (Cloudflare/anti-bot), tell the user — it may be uncloneable.
5. **Verify the base builds:** `npm run build`. Fix before proceeding. (Node ≥ 24 is recommended by the scaffold; if the build complains about Node version, tell the user to upgrade or `nvm use`.)
6. **Create output dirs:** `docs/research/`, `docs/research/components/`, `docs/design-references/`, `scripts/`. For multiple sites add `docs/research/<hostname>/`.

## Guiding Principles

Internalize these — they inform every decision.

### 1. Completeness Beats Speed
Every builder must receive **everything**: screenshot, exact CSS values, downloaded assets with local paths, real text, component structure. If a builder has to guess a color/size/padding, extraction failed. Extract one more property rather than ship an incomplete brief.

### 2. Small Tasks, Perfect Results
A builder handed "build the entire features section" approximates and gets it "close enough but wrong". Handed one focused component with exact CSS, it nails it. Judge each section's complexity. Simple banner → one builder. Section with 3 card variants each with unique hover states → one builder per variant plus one wrapper. When in doubt, smaller.
**Complexity budget:** if a builder spec exceeds ~150 lines, split the section. Mechanical rule — don't override with "but it's all related".

### 3. Real Content, Real Assets
Extract actual text, images, videos, SVGs from the live site (`assets` + `download`). This is a clone, not a mockup. Only generate content that is clearly server-generated/unique per session.
**Layered assets matter.** A section that looks like one image is often a background + a foreground UI PNG + an overlay icon. Enumerate ALL `<img>` and background-images in each container, including absolutely-positioned overlays. A missed overlay makes the clone look empty.

### 4. Foundation First
Nothing builds until the foundation exists: global CSS design tokens (colors, fonts, spacing), TypeScript types, global assets (fonts, favicons). Sequential and non-negotiable. Everything after can be parallel.

### 5. Extract How It Looks AND How It Behaves
A website is not a screenshot. Elements move/change/appear on scroll, hover, click, resize, time. For every element extract its **appearance** (exact `getComputedStyle` via the `extract` command) AND its **behavior** (what changes, what triggers it, how it transitions). Not "the nav changes on scroll" — capture styles at `--scroll 0` and `--scroll 400`, diff them, and record the trigger threshold + transition (duration, easing).
Watch for (illustrative, not exhaustive): scroll-shrinking navbars, viewport-entry animations (fade-up/stagger), `scroll-snap`, parallax, animated hover states, modals/accordions with enter/exit, scroll-driven progress, autoplay carousels, theme transitions, **tab/pill content that cycles**, **scroll-driven tab switching (IntersectionObserver, not clicks)**, **smooth-scroll libs (Lenis/Locomotive — check for `.lenis` class)**.

### 6. Identify the Interaction Model BEFORE Building
The single most expensive mistake: building click-based UI when the original is scroll-driven (or vice versa). Before any builder spec for an interactive section, definitively answer: clicks, scrolls, hovers, time, or a combination?
1. **Don't click first.** `screenshot` at increasing `--scroll` values and watch what changes on its own.
2. If things change on scroll → scroll-driven. Extract the mechanism (IntersectionObserver, scroll-snap, sticky, animation-timeline, JS listeners).
3. If nothing changes on scroll → THEN test `--click`/`--hover`.
4. Document explicitly in the spec: e.g. "INTERACTION MODEL: scroll-driven with IntersectionObserver".

### 7. Extract Every State, Not Just the Default
Tab bars show different cards per tab; headers differ at scroll 0 vs 100; cards have hover effects. Capture ALL states.
- Tabbed/stateful: `extract --click <each tab selector>` and record content + styles per state, plus the transition.
- Scroll-dependent: `extract --scroll 0` then `extract --scroll <past threshold>`, diff, record trigger px + transition.

### 8. Spec Files Are the Source of Truth
Every component gets a spec in `docs/research/components/<name>.spec.md` BEFORE any builder is dispatched. The builder receives the spec contents **inline** in its prompt; the file persists as an auditable artifact. No spec = the builder guesses from memory. Non-negotiable.

### 9. Build Must Always Compile
Every builder verifies `npx tsc --noEmit` before finishing. After reconciling, you verify `npm run build`. A broken build is never acceptable, even temporarily.

## Phase 1: Reconnaissance

### Screenshots
- Full-page master refs at desktop and mobile:
  `inspect.mjs screenshot <url> docs/design-references/<host>-desktop.png --full`
  `inspect.mjs screenshot <url> docs/design-references/<host>-mobile.png --full --mobile`

### Global Extraction
- **Fonts** — `extract` key elements (h1, body, code, labels) and read `fontFamily`/weights. Configure in `src/app/layout.tsx` via `next/font`.
- **Colors** — pull the palette from `extract` across the page; write the target's real colors into `:root`/`.dark` in `src/app/globals.css`, mapped to shadcn tokens where they fit.
- **Favicons & meta** — `assets` lists favicons/manifest; `download` them to `public/seo/`; update `layout.tsx` metadata.
- **Global patterns** — scrollbar hiding, scroll-snap on the container, global keyframes, backdrop filters, overlay gradients, **smooth-scroll libs**. Add to `globals.css`; note libs to install.

### Mandatory Interaction Sweep
A dedicated pass after screenshots, before building — most behaviors are invisible in a static shot.
- **Scroll sweep:** `screenshot` at several `--scroll` offsets top→bottom. Note header changes (+ trigger px), viewport-entry animations, auto-switching sidebars/tabs, scroll-snap, non-native scrolling.
- **Motion sweep (time-driven / self-animating):** `node "$H/scripts/inspect.mjs" motion-check <url> "<selector>" [--duration 8000] [--samples 5]`. This is the only correct way to answer "is this element moving on its own, with no interaction?" One page load, a generous settle for JS to boot, then N evenly-spaced samples of `transform`/`opacity`/`backgroundPosition` across a long observation window (default 5 samples over 8s), reporting `animating: true/false` plus which properties changed. **Do not** answer this by comparing two separate `extract --wait X` calls — that technique has a demonstrated blind spot for slow-starting animations (gated behind hydration, video preload, or lazy JS): both short-wait loads can land before the loop starts, and a genuinely-rotating carousel reads as byte-identical and gets recorded as static. Run `motion-check` on anything that could plausibly be a carousel, marquee, ticker, or decorative background motion, and record the result in BEHAVIORS.md.
- **Click sweep:** `extract --click` every button/tab/pill/card; record what changes and per-state content.
- **Hover sweep:** `extract --hover` buttons/cards/links/nav; record color/scale/shadow/opacity changes + transition.
- **Responsive sweep:** capture at `--width 1440`, `--width 768`, and `--mobile` (390); note where each section reflows.
Save findings to `docs/research/BEHAVIORS.md` — your behavior bible.

### Page Topology
Start from `inspect.mjs topology <url>`, then refine by hand. Document section order, fixed/sticky overlays vs flow content, the page layout (scroll container, columns, z-index layers), inter-section dependencies, and each section's interaction model. Save as `docs/research/PAGE_TOPOLOGY.md` — your assembly blueprint.

## Phase 2: Foundation Build

Sequential; do it yourself (touches many files):
1. **Fonts** in `layout.tsx` to match the target.
2. **`globals.css`** — target color tokens, spacing, keyframes, utility classes, global scroll behavior (Lenis/scroll-snap).
3. **TypeScript interfaces** in `src/types/` for observed content structures.
4. **SVG icons** — find inline `<svg>`s, dedupe, save each icon as its own file in `src/components/icons/<IconName>.tsx`, one named export per file (e.g. `src/components/icons/SearchIcon.tsx` exporting `SearchIcon`). `src/components/icons/index.ts` is a GENERATED barrel (via `codegen.mjs`), never hand-edited. Do not create `src/components/icons.tsx` — a single-file barrel at that path wins module resolution over the `icons/` directory and silently breaks every `@/components/icons` import (`TS2305: has no exported member`). If the scaffold still ships one, delete it.
5. **Download global assets** — `inspect.mjs download <url> public/images` (and `public/videos`, `public/seo` as needed). Preserve meaningful structure.
6. **Token lock** — generate it: `node "$H/scripts/inspect.mjs" tokens <url> --responsive > docs/research/tokens.lock.json`. This freezes the target's real color/spacing/radius/font/shadow/fontSizes vocabulary — every builder's generated literals must come from this vocabulary from here on (see token-lint below). **Always pass `--responsive`:** it scans desktop and mobile in one invocation and merges the buckets before curation. A desktop-only lock is an incomplete lock — values that exist only at mobile widths (a mobile-only font size, a mobile-only gap) are simply absent from it, so a builder who implements them correctly later gets flagged for a "violation" that is really a hole in the lock. Confirmed on real sites. It costs roughly 2x the wall-clock time of a single-viewport scan; pay it, lock correctness is worth more than a minute.
7. **Reconcile `globals.css` against the token lock, now, while you still have direct edit access.** Run `node "$H/scripts/token-lint.mjs" docs/research/tokens.lock.json src/app/globals.css`. For every violation: either update the CSS custom property to the target's real value, or — if it's a shadcn structural default this specific clone genuinely doesn't use (e.g. an unused chart color slot) — mark it with a CSS comment `/* @clone-degraded: <reason> */` on the line above and log a row in `docs/research/DEGRADATIONS.md`. Resolve every violation before moving on — builders dispatched in Phase 3 cannot edit this file directly (see Shared-Scope Contract), so anything left unresolved here becomes permanently unfixable later in the pipeline. A fresh, unmodified scaffold typically produces around 60 violations here (shadcn's default color slots) — that is the expected starting count, not a broken lock; work through them via Fix or `@clone-degraded`, don't second-guess the tool.
8. **Runtime claims ledger** — seed `docs/research/.runtime-claims.json`, written by you (the orchestrator) only — builders never write this file. `runtime` keys are the shared global infrastructure your Interaction Sweep found; `signature_slots` budgets scarce spectacle interactions; `shared_files` lists files no builder may edit directly. Create it with exactly this structure:

   ```json
   {
     "runtime": {
       "lenis": { "status": "planned", "owner": null, "file": null },
       "webgl-provider": { "status": "planned", "owner": null, "file": null },
       "page-transition": { "status": "planned", "owner": null, "file": null }
     },
     "signature_slots": {
       "magnetic-cursor": 1,
       "pinned-scroll-section": 1
     },
     "shared_files": [
       "src/app/globals.css",
       "src/app/layout.tsx",
       "src/app/page.tsx"
     ]
   }
   ```
9. **Run the permission canary:** `bash "$H/scripts/permission-canary.sh" .` — this live-tests the POSIX-lock mechanism itself, not the (inert) OpenCode agent-permission config. If it reports NOT enforced, the pipeline proceeds in paranoid mode — meaning the POSIX lock below is mandatory, not optional. Read `.clone-run/capabilities.json` to confirm (`{"permissions_enforced": bool, "mechanism": "posix-lock", "checked_at": ISO, "detail": string}`).
10. **Establish the fragment convention:** `src/sections/<name>/` will hold each parallel builder's section component + optional `section.css` + `section.meta.json`, and `src/components/icons/` will hold one file per icon (plus the generated `index.ts` barrel — there is no `src/components/icons.tsx`). `globals.css` and `page.tsx` carry generated marker blocks that `codegen.mjs` will fill in — never hand-edit content between `/* BEGIN GENERATED... */` and `/* END GENERATED... */` markers.
11. Verify `npm run build`.
12. **Lock the shared files before parallel dispatch:** `bash "$H/scripts/lock-shared.sh" .` — locks the 3 shared files (`globals.css`, `layout.tsx`, `page.tsx`) via POSIX file+dir permissions. Commit the tree state now (`git add -A && git commit -m 'chore: pre-dispatch baseline'`) — this commit is what `tripwire-check.sh` will diff against.

## Phase 3: Component Specification & Dispatch

The core loop, per section top→bottom: **extract → write spec → dispatch builder(s) → reconcile.**

### Step 1: Extract
1. **Screenshot** the section in isolation (`screenshot --scroll <Y>` to bring it into view) → `docs/design-references/`.
2. **Extract CSS** for the section container: `inspect.mjs extract <url> "<selector>"`. Capture the full JSON — don't hand-measure.
3. **Multi-state** — for any stateful element, run `extract` again with `--scroll`/`--click`/`--hover` and record the diff: "Property X: VALUE_A → VALUE_B, trigger TRIGGER, transition TRANSITION".
4. **Real content** — verbatim text, alt/aria, placeholders; per-state content for tabs (`--click` each).
5. **Assets** this section uses (from the `assets`/`download` manifest), including layered/overlay images.
6. **Complexity** — count distinct sub-components (each with own styling/structure/behavior).

### Step 2: Write the Component Spec File
Create `docs/research/components/<component-name>.spec.md`. Required for every builder. Template:

```markdown
# <ComponentName> Specification
## Overview
- Target file: `src/sections/<section-name>/<ComponentName>.tsx`
- Screenshot: `docs/design-references/<name>.png`
- Interaction model: <static | click-driven | scroll-driven | time-driven>
## DOM Structure
<hierarchy — what contains what>
## Computed Styles (exact getComputedStyle values)
### Container
- <every relevant property with exact values>
### <Child element N>
- ...
## States & Behaviors
### <Behavior name>
- Trigger: <scroll 50px | IntersectionObserver -30% | click .tab | hover>
- State A (before): <props>
- State B (after): <props>
- Transition: <transition css>
- Implementation: <CSS transition + listener | IntersectionObserver | animation-timeline>
### Hover states
- <Element>: <prop>: <before> → <after>, transition: <value>
## Per-State Content (if applicable)
### State: "<name>"
- <title/cards/etc.>
## Assets
- <local paths from public/> + icons used from `@/components/icons`
## Text Content (verbatim)
<copy-pasted from the live site>
## Responsive Behavior
- Desktop 1440 / Tablet 768 / Mobile 390: <what changes> ; breakpoint ~<N>px
```

Fill every section; "N/A" only after thinking twice (even footers have link hovers).

If a distilled motion lexicon exists at `$H/motion/index.json` (see References — this is an optional, manually-curated Phase 0 asset, not required for every clone), look up the section's interaction-model verb (e.g. `pin-scrub`, `magnetize`, `mask-reveal`) and resolve its token-slots against `docs/research/tokens.lock.json` before writing the spec's `## States & Behaviors` block. This only fills gaps your own `extract`/`--scroll`/`--click` diff can't see (stagger order, overshoot shape, easing between two sampled states) — anything your diff actually measured always overrides the lexicon. Never let a builder see raw reference-repo source; only the resolved numeric/token contract.

### Step 3: Dispatch Builders (opencode Task tool)
Based on complexity, dispatch builders with the **Task tool** (`subagent_type: "designer"`). opencode subagents share the working tree — **no git worktrees needed.** Dispatch independent builders in parallel (multiple Task calls in one message).

- **Simple section** (1–2 sub-components): one builder for the whole section.
- **Complex section** (3+ distinct sub-components): one builder per sub-component + one wrapper builder that imports them (sub-components first).

**Every builder prompt includes:**
- The FULL spec file contents inline (never "go read the spec file").
- The section screenshot path.
- Which shared things to import (`@/components/icons`, `cn()` from `@/lib/utils`, shadcn primitives in `@/components/ui`).
- The exact target file path — always inside the builder's own section folder: `src/sections/<section-name>/<ComponentName>.tsx` (e.g. `src/sections/hero/HeroSection.tsx`). The file name is free-form inside that folder; what matters is that it lives under `src/sections/<section-name>/` so codegen can find it. Never `src/components/<ComponentName>.tsx` — a component written there is invisible to codegen, so the section silently never mounts in `page.tsx` and the run looks successful while producing an empty page.
- Use only assets already in `public/`.
- A hard rule: any literal color/px/font-family value the component uses must come from `docs/research/tokens.lock.json`'s vocabulary (within ~0.5px tolerance for spacing/radii). If a spec'd pattern is genuinely unsatisfiable under the target's real tokens (e.g. target has one font or near-zero contrast but the pattern assumes a multi-weight type scale), write `@clone-degraded: <reason>` on the line above the literal instead of silently drifting (in CSS files, use a `/* @clone-degraded: <reason> */` comment on the line above instead of the JS/TS line-comment form), and note it for the orchestrator to log in `docs/research/DEGRADATIONS.md` during Reconcile.
- Its Shared-Scope Contract, rendered from `.runtime-claims.json`: which global infra is already installed (import it — e.g. `useLenis()` — never recreate a second provider), which signature slots are already claimed (don't reach for a magnetic-cursor or pinned-scroll pattern if the budget is spent), and an explicit rule that it may NOT edit any of the 3 protected shared files — `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx` — directly; it must instead report the exact patch it needs (e.g. a new keyframe, a new icon) in its completion message for you to apply during Reconcile. This is enforced by the POSIX permission lock from Phase 2 (`lock-shared.sh`), which is the actual tested-working mechanism: the files are read-only at the OS level, so Edit/Write **and** bash workarounds like `echo >>` or `sed -i` both fail. The project-level `opencode.json` `agent.designer.permission.edit` deny rule is left in place opportunistically but is **currently inert** — it was empirically proven non-functional on this install (4 live tests, including a blanket deny-all, all failed to block anything). Harmless if it ever starts working; never relied upon.
- Its section folder: `src/sections/<section-name>/` — the builder creates its component there (`src/sections/<section-name>/<ComponentName>.tsx`), any scoped CSS, plus a `section.meta.json`. Paste this exact schema into the prompt; never tell the builder to go read it from the scaffold README:

  ```json
  {
    "order": 20,
    "componentName": "HeroSection",
    "importPath": "../sections/hero/HeroSection"
  }
  ```

  All 3 fields are **required**: `order` (number — ascending position on the page, unique across sections; you assign it, and leave gaps of 10 so a section can be inserted later without renumbering), `componentName` (string, PascalCase, must match the actual named export from the `.tsx` exactly), `importPath` (string — path to that `.tsx`, relative to `src/app/page.tsx`). Codegen **hard-fails the entire batch** if any field is missing, misspelled, or the wrong type — it does not silently skip the offending section. New icons go in `src/components/icons/<IconName>.tsx`, one file per icon; the builder never touches `src/components/icons/index.ts` (generated barrel) and never creates `src/components/icons.tsx`.
- An explicit note that the 3 shared files (`globals.css`, `layout.tsx`, `page.tsx`) are locked (POSIX permissions) during this phase — attempting to edit them will fail at the OS level, not just be discouraged by convention. If a builder genuinely needs something added to one of these (e.g. a new global keyframe), it reports the request in its completion message instead.
- Verify `npx tsc --noEmit` before finishing; report files written + anything uncertain.

### Step 4: Reconcile
As builders finish: confirm each target file exists, then run `npm run build`. Fix any type errors immediately (you have full context). Continue extract→spec→dispatch→reconcile until all sections are built.

Run the rest of Reconcile in exactly this order. Only steps 4-5 sit inside the unlock window — opened at step 3, closed at step 6 — because they are the only ones that write to the locked shared files, and what they write (hand-applied patches and codegen output alike) is legitimate orchestrator-authored content. Keep that window as narrow as this; everything else, including the claims ledger, works fine with the files locked. Never leave the shared files unlocked across a builder dispatch.

1. **Token-lint the batch:** `node "$H/scripts/token-lint.mjs" docs/research/tokens.lock.json src` (equivalently, `npm run lint:tokens` inside the cloned project — the scaffold ships this as an npm script). Fix real violations, or confirm each is covered by an `@clone-degraded:` comment and logged in `docs/research/DEGRADATIONS.md` (create this file on first use — one row per degradation: file, reason, date). Use `--report-only` on the first run against any new target to sanity-check the lock before enforcing. A handful of legitimate violations is normal on a real site; if violations are still near-universal, that's a genuine signal worth investigating (check the lock's `--min-count`/`--top` curation settings) rather than an expected default.
2. **Run the tripwire check:** `bash "$H/scripts/tripwire-check.sh" . <the most recent baseline commit — Phase 2's pre-dispatch commit for the first batch, or the previous batch's step 9 re-baseline commit for every batch after that>` — reverts anything that slipped past the lock and prints the diff. Run it first, while the files are still locked: it is self-contained and handles lock state itself via a narrow per-file unlock → revert → re-lock cycle, so it works whether the tree is currently locked or not. If anything was reverted, fold the reported change into that builder's legitimate request path (fragment folder or an orchestrator-applied patch) rather than just discarding it.
3. **Unlock:** `bash "$H/scripts/unlock-shared.sh" .`.
4. **Apply builder patch requests:** every shared-file patch builders reported in their completion messages (dedupe overlapping asks — e.g. two builders both requesting the same icon).
5. **Regenerate the derived files:** `node "$H/scripts/codegen.mjs" .` — rebuilds `globals.css`'s import block, the icons barrel, and `page.tsx`'s section mounts from this batch's fragment folders. This has to run here, inside the unlock window: codegen writes directly into `globals.css` and `page.tsx`, and it refuses with "run unlock-shared.sh first" if they're still locked. `--check` is read-only and works at any point if you want to preview the diff before writing.
6. **Re-lock:** `bash "$H/scripts/lock-shared.sh" .`.
7. **Verify the re-lock took:** `bash "$H/scripts/verify-shared.sh" .` — exit 0 (PASS) is the only green result; see the Pre-Dispatch Checklist for what exit 1 and exit 3 mean.
8. **Update and validate the claims ledger:** in `.runtime-claims.json`, mark any global infra this batch installed as `{"status": "installed", "owner": "<builder/component that claimed it>", "file": "<path where the infra lives>"}` — `owner` is who claimed the infra, `file` is the actual on-disk path builders will import from, and both are required (non-null strings) once `status` is `"installed"` — and mark any signature slot a builder claimed as spent. Then validate it: `node "$H/scripts/validate-claims.mjs" docs/research/.runtime-claims.json docs/research/components`. Fix any structural violation or stale claim before dispatching the next batch — a claims file that's wrong is worse than one that doesn't exist, since every subsequent Shared-Scope Contract is rendered from it.
9. **Re-baseline for the next batch:** `git add -A && git commit -m 'chore: post-reconcile baseline'`. This commit — not the Phase 2 one — is the baseline the NEXT batch's tripwire-check diverges against. Using a stale baseline makes the tripwire revert the previous batch's legitimate work (codegen output self-heals since it's regenerated every run, but hand-applied patches do not — they're silently and permanently lost, reported as a successful revert).

## Phase 4: Page Assembly
Wire everything in `src/app/page.tsx`: import sections, implement the page-level layout from `PAGE_TOPOLOGY.md` (scroll containers, columns, sticky/fixed, z-index), connect real content to props, implement page-level behaviors (scroll-snap, scroll-driven animations, theme transitions, IntersectionObservers, Lenis). Verify `npm run build` clean.

## Phase 5: Visual QA Diff
Do NOT declare done at assembly. Run the clone (`npm run dev`) and compare against the original:
1. **Final unlock — always, and this one is permanent:** `bash "$H/scripts/unlock-shared.sh" .`. All builders are done, so the lock has no remaining job, and QA fixes routinely need `globals.css`/`layout.tsx`/`page.tsx`. **Do NOT re-lock afterward** — this is the one unlock in the pipeline that is not paired with a `lock-shared.sh`. Leaving the lock on hands the user a permanently read-only project they can't edit or even `rm -rf` without manually `chmod`-ing first.
2. `screenshot` the original and your clone at the same widths (1440 and 390, `--full`).
3. Compare section by section, top to bottom, both viewports.
4. For each discrepancy: if the spec was wrong, re-extract → update spec → fix component; if the spec was right but the build diverged, fix the component to match.
5. Drive interactions on the clone (`--scroll`/`--click`/`--hover`) and confirm scroll behavior, header transitions, tab switching, and animations match the original.

Only after this pass is the clone complete. Before reporting, confirm the shared files are still writable — the project you hand back is a normal, editable one.

## Pre-Dispatch Checklist
Before dispatching ANY builder, verify every box; if you can't, extract more.
- [ ] Spec file written with ALL sections filled
- [ ] Every CSS value is from `getComputedStyle` (the `extract` command), not estimated
- [ ] Interaction model identified and documented
- [ ] For stateful components: every state's content + styles captured
- [ ] For scroll-driven: trigger threshold, before/after styles, transition recorded
- [ ] For hover: before/after + transition timing recorded
- [ ] All images identified (including overlays/layered compositions)
- [ ] Responsive documented for at least desktop + mobile
- [ ] Text is verbatim, not paraphrased
- [ ] Builder spec is under ~150 lines; if over, split the section
- [ ] `token-lint` passes on the previous batch (or every violation is `@clone-degraded` + logged in DEGRADATIONS.md) before dispatching the next
- [ ] Each builder's Shared-Scope Contract is resolved from the current `.runtime-claims.json` before its prompt is written
- [ ] `.runtime-claims.json` passes `validate-claims.mjs` (or every violation/stale claim is resolved) before dispatching the next batch
- [ ] `verify-shared.sh` exits 0 (PASS) before dispatching the next batch — exit 3 (PARTIAL) is NOT a pass and must be resolved first; exit 1 (FAIL) means the lock itself is broken
- [ ] `tripwire-check.sh` shows no reverted files from the previous batch, or every reversion has been folded into a legitimate fragment/patch

## What NOT to Do
- **Don't build click-tabs when the original is scroll-driven (or vice versa).** Determine the model FIRST by scrolling before clicking. #1 most expensive mistake — full rewrite, not a CSS fix.
- **Don't extract only the default state.** Click each tab; capture header at scroll 0 AND past the threshold.
- **Don't miss overlay/layered images.** Check every container's DOM for multiple `<img>` + positioned overlays.
- **Don't build mockups for content that's actually video/Lottie/canvas.** Check first.
- **Don't approximate CSS.** Extract exact computed values, not "looks like text-lg".
- **Don't reference external docs from builder prompts.** The spec goes inline.
- **Don't skip asset extraction.** Without real images/videos/fonts the clone looks fake.
- **Don't over-scope a builder.** Long prompt = split the section.
- **Don't bundle unrelated sections** (a CTA and a footer are different builders).
- **Don't skip responsive extraction** (test 1440 / 768 / 390).
- **Don't forget smooth-scroll libraries** (Lenis etc. — native scroll feels different and users notice).
- **Don't dispatch a builder without a spec file.**

## Completion
Report: sections built, components created, spec files written (should match components), assets downloaded, `npm run build` status, visual-QA results (remaining discrepancies), and known gaps/limitations. Confirm the final `unlock-shared.sh` from Phase 5 ran and was not followed by a re-lock — you hand back a normal, writable project, never a read-only one.

## Honest Limitations
Pixel-perfection is the target, not a guarantee. Expect lower fidelity on Canvas/WebGL/Three.js scenes, heavy GSAP/scroll-timeline motion, licensed/auth-gated fonts and content, A/B-tested or personalized pages, and sites that block headless browsers. Clone only sites you are authorized to replicate; logos, brand assets, and copy belong to their owners. Token-lock tolerance is a real tradeoff — too tight and it false-positives on legitimate values a messy live site actually uses, too loose and it stops protecting anything; see Phase 3 Step 4 for the `--report-only` first-run check. Never raise the tolerance blindly to silence violations.

## References
- `references/INSPECTION_GUIDE.md` — checklist of what to capture (design tokens, components, layout, tech stack).
- `scaffold/` — the Next.js 16 + shadcn + Tailwind v4 base copied during Pre-Flight.
- `scaffold/AGENTS.md` — code-style + structure rules for the generated project.
- `motion/index.json` — optional, manually-curated verb catalog (durations, easings, stagger, overshoot ranges). Not auto-generated: `scripts/distill-motion.mjs` produces a raw, unclustered `motion-corpus-raw.json` observation dump from a reference-repo corpus; turning that into named verbs with numeric ranges is a deliberate human curation step (an agent auto-naming interaction verbs risks injecting confidently-wrong motion data). If `motion/index.json` doesn't exist yet, Phase 3 extraction proceeds exactly as before, purely from live measurement.
- `scripts/token-lint.mjs` — token containment linter used in Phase 3 Step 4 Reconcile.
- `scripts/validate-claims.mjs` — validates `.runtime-claims.json` structure and staleness, used in Phase 3 Step 4 Reconcile.
- `scripts/lock-shared.sh` / `unlock-shared.sh` / `verify-shared.sh` — POSIX permission lock protecting the 3 shared files (`globals.css`, `layout.tsx`, `page.tsx`), replacing the (confirmed non-functional on this install) OpenCode agent-permission deny rule. The old `icons.tsx` vault-symlink is retired: icons now live one-per-file under `src/components/icons/` behind a generated barrel, so there's nothing to contend over. Run `unlock-shared.sh` once more at the end of Phase 5 and leave it unlocked. Know its real limit: this is a same-UID POSIX lock — it stops normal edits and common bypass tricks (temp-file+rename, etc.) but cannot stop an agent that deliberately runs `chmod` to unlock/edit/re-lock itself. The tripwire check (`tripwire-check.sh`) is the layer that catches that case, since it detects content drift regardless of how the write got through.
- `scripts/permission-canary.sh` — live-tests the lock mechanism before trusting it; never claim enforcement without this passing.
- `scripts/tripwire-check.sh` — git-diff based detect-and-revert defense-in-depth layer.
- `scripts/codegen.mjs` — regenerates globals.css/icons barrel/page.tsx from per-section fragment folders, removing the reason to contend over these files in the first place.
