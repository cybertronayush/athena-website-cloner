# Athena

Athena is a general-purpose pipeline that turns any live website into a clean, modern Next.js codebase.

Point it at a URL. It drives a real headless browser over the target, extracts exact computed CSS, real assets and actual interaction behavior, locks the design vocabulary it measured, then builds the site back section by section with parallel agents that cannot silently drift from the measurements or clobber each other's work.

Athena is madmethod.io's internal tool, being open-sourced. It is not tied to any one target site.

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

## Requirements

- **Node.js 24 or newer.** `package.json` sets `engines: { node: ">=24" }` and `.nvmrc` pins `24`. Run `nvm use` if you have nvm.
- **npm.** The repo ships a `package-lock.json`. pnpm and yarn are untested here.
- **git.** The tripwire layer diffs against real git history, so the working tree has to be a git repo. A `git clone` of this repo already is one.
- **bash and POSIX file permissions.** The shared-file lock is plain shell (`lock-shared.sh` and friends). macOS and Linux work as-is; on Windows, use WSL.
- **An AI coding agent.** `/clone-website` is a prompt that an agent executes, not a CLI. You bring your own agent and its account or API key. See [Supported agents](#supported-agents).
- **Network access and roughly 150 MB of disk** for the Chromium build Playwright downloads.

The extraction scripts themselves need no accounts, API keys or hosted services. `inspect.mjs` drives a local Chromium and nothing else.

## Quick start

**1. Clone the repo and install the app's dependencies.**

```bash
git clone https://github.com/cybertronayush/athena-website-cloner.git
cd athena-website-cloner
npm install
```

**2. Install the browser helper's dependencies.** This is a second, separate install, and skipping it is the most common way a first run fails.

```bash
S=.claude/skills/clone-website/scripts
npm install --prefix "$S"
npm --prefix "$S" exec -- playwright install chromium
```

(The `--prefix` matters. `npx playwright` from the repo root would miss the pinned local copy and pull a different one from the registry.)

`.claude/skills/clone-website/scripts/` carries its own `package.json`, because Playwright is a dependency of the extraction helper and not of the Next.js app. Its `node_modules/` is gitignored, so a fresh clone never has it. Without this step `inspect.mjs` fails on a missing Playwright or a missing Chromium, and the pipeline can't extract anything.

Confirm it works before going further:

```bash
node .claude/skills/clone-website/scripts/inspect.mjs topology https://example.com
```

That should print a JSON topology of the page. If it does, extraction is good.

**3. Open the repo in your AI coding agent and run the pipeline.** **This is not a terminal command — type it directly to the agent**, the same way you'd type any other instruction to it:

```
/clone-website <url> [<url2> ...]
```

That block is a slash-command / agent prompt, not shell syntax. Pasting it into a terminal does nothing. (See **[Commands (inside a generated clone project)](#commands-inside-a-generated-clone-project)** below for how to actually view what gets built — `npm run dev` — once sections exist.)

Run the agent with this repo as its working directory. The skill resolves its own directory from the git root (`<repo>/.claude/skills/clone-website`), so from anywhere else it won't find `scripts/` unless you point `CLONE_WEBSITE_SKILL_DIR` at that path.

During Pre-Flight the skill verifies the tree is a git repo (the tripwire needs history to diff against), confirms the target is reachable and not blocking headless browsers, then walks the five phases. Multiple URLs get isolated artifacts under `docs/research/<hostname>/`.

One thing to know about where it builds: if the current directory is already a Next.js scaffold, the skill builds **in place**. The repo root is one, and it still holds the Bending Spoons example below, so a clone run started at the root builds alongside that example. If you want a clean tree, either tell the agent a fresh target directory to bootstrap into (it copies `.claude/skills/clone-website/scaffold/` there and runs `npm install`), or clear out `src/sections/`, `docs/research/` and `public/images/` first.

## Supported agents

The pipeline lives in one place — `.claude/skills/clone-website/`, which carries `SKILL.md`, `scripts/` and `scaffold/`. `node scripts/sync-skills.mjs` regenerates the per-platform command files from that single `SKILL.md`:

| Agent | Command file |
| --- | --- |
| Claude Code | `.claude/skills/clone-website/SKILL.md` (source of truth) |
| Codex CLI | `.codex/skills/clone-website/SKILL.md` |
| GitHub Copilot | `.github/skills/clone-website/SKILL.md` |
| Cursor | `.cursor/commands/clone-website.md` |
| Windsurf | `.windsurf/workflows/clone-website.md` |
| Gemini CLI | `.gemini/commands/clone-website.toml` |
| opencode | `.opencode/commands/clone-website.md` |
| Augment Code | `.augment/commands/clone-website.md` |
| Continue | `.continue/commands/clone-website.md` |
| Amazon Q | `.amazonq/cli-agents/clone-website.json` |

Most of these expose it as `/clone-website`; Amazon Q ships it as a CLI agent definition rather than a slash command. The generated copies contain the prompt text only — `scripts/` and `scaffold/` are never duplicated, so the Playwright install in step 2 is the same path no matter which agent you use.

Edit `SKILL.md` and re-run `node scripts/sync-skills.mjs`; don't edit the generated files.

## What a run produces

Artifacts land in predictable places, so you can audit a run rather than trust it:

```
docs/research/            # tokens.lock.json, BEHAVIORS.md, PAGE_TOPOLOGY.md,
                          #   components/<name>.spec.md, DEGRADATIONS.md
docs/design-references/   # full-page screenshots, desktop and mobile
public/images|videos|seo/ # assets downloaded from the target
src/sections/<name>/      # one folder per section: component + section.meta.json
src/components/icons/     # one file per extracted icon + generated barrel
src/app/                  # globals.css, layout.tsx, page.tsx (regenerated by codegen)
```

Then check the result yourself:

```bash
npm run dev      # http://localhost:3000
npm run check    # lint + typecheck + build — the go/no-go on a finished clone
```

`npm run check` is the honest verification step. A clone that doesn't pass it isn't done.

The scripts also run standalone, with no agent involved:

```bash
S=.claude/skills/clone-website/scripts   # after the step-2 install

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
    package.json        # Playwright lives here, not in the app — install separately
  scaffold/             # The Next.js 16 base copied into new clone projects
  references/           # Inspection guide

.codex/ .github/ .cursor/ .windsurf/ .gemini/ .opencode/ .augment/ .continue/
.amazonq/               # Generated per-agent command files (prompt text only)
scripts/sync-skills.mjs # Regenerates all nine from SKILL.md

src/                    # The current example build
  sections/<name>/      # One folder per section: component + meta + scoped css
  components/icons/     # One file per icon + generated barrel (created by a run)
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

## Commands (inside a generated clone project)

These commands run inside whatever Next.js project `/clone-website` produces, not the cloning tool itself. Run them from the project root after (or during) a clone, the same as any Next.js app.

```bash
npm run dev         # Dev server
npm run build       # Production build
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run check       # lint + typecheck + build
npm run lint:tokens # Token containment check against the lock
```

`lint:tokens` ships in the scaffold's `package.json`, so it exists in projects bootstrapped from it. This repo's own root `package.json` doesn't define it — run the linter directly here:

```bash
node .claude/skills/clone-website/scripts/token-lint.mjs docs/research/tokens.lock.json src
```

## Honest limitations

Pixel-perfection is the target, not a guarantee.

Expect lower fidelity on Canvas/WebGL/Three.js scenes, heavy GSAP or scroll-timeline motion, licensed or auth-gated fonts and content, and A/B-tested or personalized pages. Sites that block headless browsers may be uncloneable outright.

Token-lock tolerance is a genuine tradeoff. Too tight and it false-positives on legitimate values that a messy live site really does use; too loose and it stops protecting anything. Use `--report-only` on a first run against a new target rather than raising tolerance to silence violations.

The shared-file lock is same-UID POSIX. It stops normal edits and common bypasses but not a deliberate `chmod`. The tripwire is the layer that covers that.

Clone only sites you are authorized to replicate. Logos, brand assets and copy belong to their owners.

## Troubleshooting

**`Cannot find package 'playwright'` / `Executable doesn't exist`** — step 2 of the Quick start was skipped or only half-done. Run both lines — the npm install and the `playwright install chromium`.

**`clone-website skill not found`** — the agent isn't running with this repo as its working directory. Either `cd` into the repo first, or set `CLONE_WEBSITE_SKILL_DIR` to the absolute path of `.claude/skills/clone-website`.

**`npm install` warns about the Node engine** — you're below Node 24. `nvm use` picks up `.nvmrc`.

**`codegen.mjs` says "run unlock-shared.sh first"** — the shared files are still POSIX-locked from a dispatch batch. `bash .claude/skills/clone-website/scripts/unlock-shared.sh .`

**A finished project is read-only and you can't edit or delete it** — the final unlock at the end of Phase 5 didn't run. Same command as above.

**The target won't load** — some sites block headless browsers. `inspect.mjs topology <url>` doubles as the reachability check; if it fails there, the site may be uncloneable.

## License

MIT, See [LICENSE](LICENSE) for the full text.
