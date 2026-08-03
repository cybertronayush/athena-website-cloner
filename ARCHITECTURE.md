# How `/clone-website` actually works

Before I understood this system, I thought "AI clones a website" meant: screenshot the page, describe it to a model, get back some approximate HTML. That's what most people build. It produces something that's *close*. Close is a synonym for wrong, just dressed up nicer.

After building this, the difference is specific and measurable: every section of a real clone built with this pipeline gets pixel-verified against the live site's actual computed CSS — not eyeballed against a screenshot, but diffed against `getComputedStyle()` output, real DOM structure, and in more than one case, the target site's own JavaScript bundle. On one real run, a section came out within **0.42 pixels** of the target's measured height across a 2756px-tall component. That's not luck. That's the architecture doing its job.

<!-- QUOTABLE -->
Screenshots are a lossy compression of the truth. The DOM isn't.

Here's the actual system, section by section, and I'm not going to pretend any of it was obvious in advance — most of it exists because an earlier, simpler version of it broke in a specific way.

## The core bet: query reality, don't approximate it

Every other approach to "clone this website" treats the live site as an image. This one treats it as a database you can query.

A small CLI tool (`inspect.mjs`) drives a real headless browser and exposes subcommands: `extract` (walk the DOM, return real computed styles for any selector — font-size in actual pixels, not "looks like 20px"), `tokens` (build a design-token lockfile from real measured values across desktop and mobile), `topology` (map the page's actual section structure), `screenshot`, `assets`/`download`, and `motion-check` (sample an element repeatedly over time to tell real animation from a static frame).

<!-- QUOTABLE -->
You can't clone what you haven't measured.

This sounds obvious once you say it. It wasn't obvious while building it — the first version of the motion-check tool compared two snapshots and called anything unchanged "static." It missed a real 5.284°/s rotating carousel because two snapshots close together in time both looked frozen. The fix was longer, multi-sample observation windows. That's the shape of almost every fix in this system: not "add more AI," but "measure for longer, or measure the right thing."

## Phase 1–2: reconnaissance and foundation, before a single component gets built

Before any UI code is written, the pipeline runs a reconnaissance pass: screenshot the whole page (desktop and mobile), extract the page's real section topology, download every visible asset, and — critically — build a `tokens.lock.json` file. This is a snapshot of every color, spacing value, font size, and radius actually measured on the live site, deduplicated and frequency-ranked.

That lockfile becomes law for everything downstream. A separate tool, `token-lint.mjs`, scans every line of generated CSS and fails the build if a color or spacing value doesn't match something in the lockfile — with one deliberate escape hatch: an inline `@clone-degraded:` comment for values that are real but too rare to warrant a permanent token. This isn't decoration. It's the mechanism that stops "looks about right" from silently becoming the standard.

<!-- QUOTABLE -->
A design system without an enforcement mechanism is just a suggestion nobody follows under deadline.

## Phase 3: many builders, one house style, zero coordination meetings

Here's the part that sounds like it shouldn't work: each section of the page — hero, pricing, testimonials, footer, whatever the target site actually has — gets built by an independent AI agent, in parallel, with no shared memory of what the other builders are doing. They only share the measured tokens and the locked infrastructure.

I think this is the right call, but I know reasonable engineers would push back here: doesn't parallel, uncoordinated work produce visual drift? Doesn't every builder end up solving the same small problems slightly differently?

Yes. It does. And the system is built to expect that, not prevent it — because preventing it would mean serializing every section behind a single bottlenecked agent, which is slower and, in practice, not actually more consistent (a tired context window drifts too).

What actually happened, more than once in real runs: three separate builders, working on three separate sections with zero knowledge of each other, independently reverse-engineered the same obscure CSS technique — a "leading-trim" pattern for compensating text line-height — using three differently-worded formulas. When reconciled, all three formulas turned out to be *algebraically identical*. That's not proof the parallel approach is safe by accident. That's proof that if you give competent builders the same real, measured ground truth, they converge on the same answer even without talking to each other. The convergence isn't luck — it's downstream of everyone querying the same reality instead of guessing from different screenshots.

## The lock: the one place coordination *is* mandatory

Three files can't tolerate uncoordinated parallel writes: the global stylesheet, the root layout, and the page that mounts every section. If two builders edit `globals.css` at the same time, you don't get a merge conflict — you get silent, undetected data loss.

So those three files get filesystem-locked (`chmod 0444`, read-only) for the entire duration of parallel building. Builders can't touch them even if they try. Instead, a builder that needs a new design token, or needs its section mounted into the page, *reports what it needs* in its completion message — a description of the change, not a diff applied directly. A separate reconciliation step, running after the parallel batch finishes, unlocks the files, applies the accumulated requests, regenerates the page-mount list from each section's own manifest file, re-locks everything, and verifies the lock state before moving on.

<!-- QUOTABLE -->
The safest way to let five people edit one file is to not let them.

## The tripwire — and the honest story about how it once bit me

There's a script, `tripwire-check.sh`, that diffs the three locked files against the last known-good git commit and reverts anything that doesn't match. It exists to catch exactly one failure mode: someone editing a locked file outside the sanctioned reconcile process.

I'm going to tell you the failure this actually caused, because pretending a system this complex never breaks would make the rest of this document less credible. Mid-reconcile, before a new commit existed to serve as the updated baseline, the tripwire got run against the *old* baseline. It did exactly what it's designed to do: it saw uncommitted, legitimate, correctly-locked changes — a new global navigation component, some consolidated design tokens — and reverted them, because from its narrow point of view, those changes hadn't been authorized yet. They had been. The authorization just hadn't been git-committed.

<!-- QUOTABLE -->
A safety mechanism that can't tell "unauthorized" from "not yet committed" will eventually punish you for doing the right thing in the wrong order.

The recovery worked because the tripwire prints the full diff of what it's about to revert *before* it reverts it — so the lost work was fully recoverable from the tool's own output, not gone. But the real fix was procedural: never run the tripwire mid-reconcile, only after a commit exists. That's now a hard rule in how this system gets operated, not a rule in the code. The code still has the sharp edge. I think that's honestly the right trade-off — I'd rather have a paranoid script that occasionally needs careful operating than a lenient one that lets real drift through — but I know a case could be made the other way, that the tool should warn instead of act. Both positions are defensible. We chose paranoid.

## Reconciliation: the part that makes many small truths add up to one coherent page

After a batch of sections finishes, a reconcile pass runs, in order: lint every token against the measured lockfile, check for drift against the last commit, unlock the three shared files, apply every requested token/mount change, regenerate the page's import list from each section's manifest, re-lock, re-verify the lock state, run the whole build (typecheck, lint, production build), and only then commit — establishing the new baseline that the *next* batch's tripwire check will compare against.

This loop is why the system doesn't accumulate small inconsistencies the way ad-hoc AI-generated code usually does. Every batch either fully reconciles into a clean, buildable, committed state, or it doesn't land at all.

## The part I didn't expect going in: builders correct the orchestrator

I write the spec each builder receives — extracted DOM structure, measured styles, text content — and I explicitly tell every builder: verify everything yourself, don't trust my spec blindly. I expected that instruction to be a formality. It wasn't.

In real runs, builders caught things I'd gotten wrong from a first-pass extraction: a section I described as "scroll-reveal text" turned out to be a 200-viewport-height pinned scroll-scrub with continuous cross-fading images — my own motion-check tool had given a false negative because I'd tested it while the element was scrolled out of view. A section I described with an 8-column/4-column image split turned out, on measurement, to be 7/5. A hover animation I assumed existed, based on suspicious-looking CSS class names, turned out not to exist at all — the class names were just Webflow's leftover naming convention, not evidence of a real interaction.

<!-- QUOTABLE -->
The most reliable QA process isn't a reviewer. It's making the builder check its own work against the same reality the spec was supposed to come from.

## An honest disagreement I still hold

I think the right default is: parallel builders, locked shared files, reconcile after each batch. I know capable engineers would argue for a single sequential agent with full page context instead — fewer moving parts, no lock choreography, no tripwire edge cases to operate carefully around.

My argument for the parallel version isn't "it's faster," though it is. It's that a single long-running agent's context degrades — by the time it reaches section nine of nine, its attention to section one's exact measured values has thinned. Nine independent agents, each with a full, fresh context budget spent entirely on one section, each checking their own work against the same locked, measured ground truth — that produces more consistent per-section fidelity, even though it costs more coordination machinery to keep the whole page coherent. I'd rather pay the coordination cost explicitly, in code I can read and fix, than pay a hidden attention-decay cost I can't see happening.

## What's still open

The system gets a page's structure, styling, and behavior right with a rigor that surprised me the first time I saw three unrelated builders derive the same CSS formula independently. It does not — cannot — clone licensed commercial fonts, or a target's exact brand marks, or reproduce private business logic that isn't observable from the client. Those get flagged, not faked.

The next question I'm actually sitting with: how much of this locking-and-reconcile choreography is specific to *cloning a known target*, where "correct" has a real, measurable answer to check against — and how much of it would still hold up if you pointed nine parallel builders at a page that doesn't exist yet, where there's no ground truth to measure against, only taste. I don't know yet. That's the next thing I'm building toward.
