# madmethod Website Cloner

A general-purpose pipeline that turns any live website into a clean, modern Next.js codebase.

Point it at a URL. It drives a real headless browser over the target, extracts exact computed CSS, real assets and actual interaction behavior, locks the design vocabulary it measured, then builds the site back section by section with parallel agents that cannot silently drift from the measurements or clobber each other's work.

This is madmethod.io's internal tool, being open-sourced. It is not tied to any one target site.

## What it actually does

Most "clone this site" tooling screenshots a page and asks a model to eyeball it. This does not do that. Every value that lands in the generated code traces back to something measured on the live page:

- **Real browser, real measurements.** A bundled Playwright helper walks the DOM and pulls `getComputedStyle()` output, not estimates. No browser-MCP dependency.
- **Real behavior, not just appearance.** Scroll, hover and click states are captured by running the page twice and diffing. The diff *is* the behavior spec.
- **Real assets.** Images, videos, background images, fonts and favicons are enumerated and downloaded from the source, deduped and batched.
- **Measured vocabulary, enforced.** The extracted tokens become a locked six-bucket vocabulary (colors, spacing, radii, fonts, shadows, fontSizes). Generated code that uses a value outside it gets flagged.
- **Parallel construction that does not corrupt itself.** Builder agents run concurrently on separate sections, with the shared files locked at the OS level and a git tripwire behind that.

## Pipeline

Five phases. Extraction is meticulous and produces auditable artifacts on disk. Construction runs in parallel.

1. **Reconnaissance.** Full-page screenshots at desktop and mobile, global font/color/favicon extraction, then a mandatory interaction sweep (scroll, motion, click, hover, responsive) written to `BEHAVIORS.md`, plus a page topology map written to `PAGE_TOPOLOGY.md`.
2. **Foundation.** Fonts, `globals.css` tokens, TypeScript types, per-file SVG icons, asset download, and generation of the token lock. The foundation is reconciled against its own lock before anything else runs, because this is the last point where shared files are directly editable.
3. **Component Spec & Dispatch.** Per section: extract, write a spec file with exact computed values, dispatch builder agents in parallel, reconcile. Every builder receives its full spec inline. No spec, no dispatch.
4. **Assembly.** Sections are wired into the page from the topology map: scroll containers, z-index layers, sticky and fixed overlays, page-level behaviors.
5. **Visual QA.** Screenshot the original and the clone at matched widths, compare section by section at both viewports, then drive the interactions on the clone and confirm they match.

## What makes it different

Four pieces of real engineering, not boilerplate.

### Token containment

`inspect.mjs tokens` freezes the target's measured design vocabulary into `tokens.lock.json`. From that point on, `token-lint.mjs` checks every hardcoded color, spacing, radius, font, font-size and shadow literal in the source against it.

The color comparison is actual color-space math, not string matching. Chrome hands back `oklab()` for some computed values, source files hold hex, and Tailwind v4 project tokens are `oklch`, so everything is collapsed to a common RGB representation through a real OKLab to linear-sRGB conversion (Björn Ottosson's), with `oklch` treated as `oklab` in polar form. `hsl()` gets its own conversion. The identical color written three different ways compares equal.

It is built to be honest about its own limits. Values that went through a lossy conversion are marked `approx`. Values that genuinely cannot be checked (`em`, which is relative to the element's own font size) land in an `unverifiable` bucket and never fail a run. A violation you have consciously accepted can be marked `@clone-degraded: <reason>` in a comment and gets logged rather than blocking. There is a `--report-only` mode for sanity-checking a fresh lock before enforcing it, and a `--tolerance-px` knob (default 0.5).

### Shared-file protection

Three files are shared by every builder: `globals.css`, `layout.tsx`, `page.tsx`. Concurrent agents editing them is how parallel builds corrupt themselves.

Agent-framework permission rules were tested for this and empirically did not hold, so the tool does not rely on them. Instead:

- `lock-shared.sh` makes the shared files read-only at the POSIX level (read-only file inside a non-writable parent directory), which defeats normal edits and the usual bypass tricks like temp-file-plus-rename.
- `permission-canary.sh` live-tests that the lock mechanism actually blocks writes on this machine *before* the pipeline trusts it, and records the verdict to `.clone-run/capabilities.json`. If enforcement can't be proven, the run proceeds in paranoid mode rather than assuming it worked.
- `tripwire-check.sh` is the defense-in-depth layer: a git-diff based detect-and-revert that catches drift regardless of how the write got through, including an agent that deliberately `chmod`s around the lock.
- `verify-shared.sh` audits lock state between batches, with a distinct exit code for partial application so "half locked" can't read as green.

The stack is documented with its real limit stated plainly: it's a same-UID lock, so it cannot stop a determined `chmod`. That's exactly the case the tripwire exists for.

### Fragment-based codegen

The better fix for contention is removing the reason to contend. Builders never edit shared files at all. Each owns a folder, `src/sections/<name>/`, holding its component, optional scoped CSS, and a `section.meta.json` declaring its render order. Icons are one file per icon under `src/components/icons/`.

`codegen.mjs` then regenerates the shared files from those fragments: the `globals.css` import block, the icons barrel, and the section mounts in `page.tsx`. It writes only between generated markers, refuses to run while the files are still locked, and has a read-only `--check` mode that exits non-zero on drift for CI. Missing or malformed section metadata hard-fails the batch instead of silently skipping a section, because a silently skipped section produces an empty page and a run that looks successful.

### Motion-aware extraction

Asking "is this element animating on its own?" by taking two short snapshots and diffing them has a real blind spot. If the animation is gated behind hydration, video preload or lazy JS, both snapshots land before the loop starts and a genuinely rotating carousel gets recorded as static.

`inspect.mjs motion-check` exists for that question specifically: one page load, a generous settle for JS to boot, then N evenly-spaced samples of `transform` / `opacity` / `backgroundPosition` across a long observation window (default 5 samples over 8 seconds), reporting which properties actually changed. This blind spot is not hypothetical. It was hit on a real target, and it is the reason the tool has a separate command for it.

## Quick start

Requires Node 24+.

**1. Install the browser helper's dependencies** (once):

```bash
cd .claude/skills/clone-website/scripts
npm install && npx playwright install chromium
```

**2. Make the skill visible to your agent.** `.claude/skills/clone-website/` is the canonical copy, carrying `SKILL.md`, `scripts/` and the `scaffold/`. The `.codex/`, `.github/` and `.opencode/` copies are generated from it by `node scripts/sync-skills.mjs`.

**3. Run it** against one or more targets:

```
/clone-website <url> [<url2> ...]
```

The skill bootstraps a fresh Next.js scaffold in your target directory (`scaffold/` is copied during Pre-Flight), verifies the tree is a git repo (the tripwire needs history to diff against), confirms the target is reachable and not blocking headless browsers, then walks the five phases. Multiple URLs get isolated artifacts under `docs/research/<hostname>/`.

The scripts also run standalone, with no agent involved:

```bash
S=.claude/skills/clone-website/scripts

node $S/inspect.mjs topology  https://example.com
node $S/inspect.mjs screenshot https://example.com out.png --full --mobile
node $S/inspect.mjs extract   https://example.com "header" --scroll 400
node $S/inspect.mjs tokens    https://example.com --responsive > tokens.lock.json
node $S/inspect.mjs assets    https://example.com
node $S/inspect.mjs download  https://example.com public/images
node $S/inspect.mjs motion-check https://example.com ".carousel" --duration 8000

node $S/token-lint.mjs tokens.lock.json src --report-only
node $S/codegen.mjs . --check
```

## Example: Bending Spoons

A demo build produced with this tool, kept in the repo so you can see what the output actually looks like rather than taking the description on faith.

Target: [bendingspoons.com](https://www.bendingspoons.com). Current state: foundation complete (fonts, full color and typography token system, downloaded assets, favicon) and the Hero section built and pixel-verified against the live page.

The hero is a reasonable illustration of the point. It's a rotating 3D card cylinder, and the numbers in `src/sections/hero/HeroSection.tsx` are measured rather than guessed: 10 cards at a 36 degree step, a radius that tracks card width at a measured 1.6 ratio, steady-state rotation of 5.284 deg/s, and roughly 29.8 degrees of eased spin-in over the first two seconds. It also has a `prefers-reduced-motion` resting state. An early extraction pass using the two-snapshot technique recorded this carousel as static, which is the concrete failure that produced the `motion-check` command described above.

The remaining sections (header, Products, Proprietary technologies, Interviews, careers CTA, footer) are not built yet, so `src/app/page.tsx` still renders the scaffold placeholder below the hero. Extraction artifacts for the run are in `docs/research/`, including the token lock and `DEGRADATIONS.md`.

## Project structure

```
.claude/skills/clone-website/
  SKILL.md              # The pipeline itself: phases, contracts, checklists
  scripts/
    inspect.mjs         # Playwright: screenshot/extract/tokens/assets/
                        #   download/topology/motion-check
    token-lint.mjs      # Token containment linter (oklch/oklab/hsl math)
    codegen.mjs         # Regenerates shared files from section fragments
    validate-claims.mjs # Validates the parallel-dispatch coordination ledger
    lock-shared.sh      # POSIX lock on the 3 shared files
    unlock-shared.sh    #   ...and its release
    verify-shared.sh    #   ...and its audit
    permission-canary.sh# Self-test: does the lock actually block writes?
    tripwire-check.sh   # git-diff detect-and-revert backstop
    distill-motion.mjs  # Optional: raw motion-corpus dump for hand curation
  scaffold/             # The Next.js 16 base copied into new clone projects
  references/           # Inspection guide

src/                    # The current example build
  sections/<name>/      # One folder per section: component + meta + scoped css
  components/icons/     # One file per icon, generated barrel
  app/                  # globals.css, layout.tsx, page.tsx (the shared three)
docs/research/          # Extraction artifacts: token lock, specs, degradations
docs/design-references/ # Screenshots
```

## Tech stack

The tool targets, and its scaffold ships:

- **Next.js 16** with the App Router, **React 19**, TypeScript strict
- **shadcn/ui** on Radix primitives
- **Tailwind CSS v4** with oklch design tokens

The extraction scripts themselves are plain Node. Only `inspect.mjs` has a dependency (Playwright); `token-lint.mjs`, `codegen.mjs` and `validate-claims.mjs` have none. The lock and tripwire layer is POSIX shell.

## Commands

Inside a generated clone project:

```bash
npm run dev         # Dev server
npm run build       # Production build
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run check       # lint + typecheck + build
npm run lint:tokens # Token containment check against the lock
```

## Honest limitations

Pixel-perfection is the target, not a guarantee.

Expect lower fidelity on Canvas/WebGL/Three.js scenes, heavy GSAP or scroll-timeline motion, licensed or auth-gated fonts and content, and A/B-tested or personalized pages. Sites that block headless browsers may be uncloneable outright.

Token-lock tolerance is a genuine tradeoff. Too tight and it false-positives on legitimate values that a messy live site really does use; too loose and it stops protecting anything. Use `--report-only` on a first run against a new target rather than raising tolerance to silence violations.

The shared-file lock is same-UID POSIX. It stops normal edits and common bypasses but not a deliberate `chmod`. The tripwire is the layer that covers that.

Clone only sites you are authorized to replicate. Logos, brand assets and copy belong to their owners.

## Credit and lineage

This started from [`ai-website-cloner-template`](https://github.com/JCodesMore/ai-website-cloner-template) by JCodesMore (MIT), which provided the original scaffold and the shape of the clone pipeline. madmethod.io then extended it substantially: the token-lock and containment linter with real color-space math, the shared-file protection stack (POSIX lock, canary, tripwire, verifier), fragment-based codegen, the claims ledger for parallel dispatch coordination, and motion-aware extraction. Those additions are what the sections above describe.

Original and derivative work are both MIT. See [LICENSE](LICENSE).

## License

MIT
