# PAGE TOPOLOGY — bendingspoons.com

The assembly blueprint for this clone run (SKILL.md Phase 1 → Page Topology,
consumed by Phase 4 → Page Assembly). Documents section order, fixed/sticky
overlays vs flow content, the page layout, z-index layers, inter-section
dependencies, and each section's interaction model.

- **Target:** https://www.bendingspoons.com (single page, `/`)
- **Capture date of the raw artifacts:** 2026-08-02
- **Behavior detail:** see `BEHAVIORS.md`. This file is structure; that file is motion.

## Provenance caveat — no `topology.json` exists

**SKILL.md line 149 says to start from `inspect.mjs topology <url>`. That output
was never saved to `docs/research/`.** There is no `topology.json` in this repo,
and nothing else in the run captured a full-page section walk.

So the section inventory below is assembled from three weaker sources, and each
row names which one it rests on:

1. **Direct capture** — `hero-extract.json` and `nav-scroll0.json` / `nav-scroll400.json`
   are real `extract` walks. Only the hero and the nav have this.
2. **Asset-manifest inference** — `global-assets.json` enumerates every image,
   video, background-image, font and favicon on the page. Assets cluster into
   recognizable sections (product logos + product cards, six `interview-*`
   images, Glassdoor/GPTW badges). This proves the assets *exist on the page*; it
   does not prove section boundaries or ordering.
3. **Project prose** — `README.md` line 190 names the unbuilt sections outright.

Additionally, no artifact carries a `_meta` block (provenance metadata shipped
2026-08-04 in commit `e09ad5f`; these captures are from 2026-08-02), so viewport
and scroll position cannot be independently confirmed on any of them.

**Only the nav and the hero have verified positions.** Everything from section 2
(Products) down is ordered the way `README.md` line 190 happens to list them,
which is prose, not a measurement. Run `topology` and save it before relying on
this document for assembly.

## Page-level layout

Measured from `hero-extract.json` and `nav-scroll0.json`:

- **Scroll container:** the native document. No smooth-scroll library found in
  any artifact (no `.lenis`, no `.locomotive`). No `scroll-snap` observed.
- **Viewport at capture:** `1440 × 900`. Both files agree — the hero measures
  `1440 × 900px` and the fixed nav reports `bottom: 819px`, i.e. `900 − 81`.
- **Column system:** single-column vertical stack. Sections are full-bleed at
  `1440px`; content is centered inside by an inner wrapper with
  `max-width: 1440px` and `padding: 0 48px` (nav inner bar) — the hero centers
  its own children with flexbox instead.
- **Background:** black (`rgb(0, 0, 0)`), site-wide. Dark-only, no theme toggle.

### Z-index layers, bottom to top

| Layer | Element | Source |
|---|---|---|
| auto (flow) | section content, hero cards (`position: absolute`, no z-index) | `hero-extract.json` |
| `1` | `.gradient-overlay::before` / `::after` edge fades, `pointer-events: none` | `src/app/globals.css` lines 270-289 |
| `50` | header / nav, `position: fixed`, `top: 0`, `left: 0` | `nav-scroll0.json` |
| unknown | OneTrust cookie banner, runtime-injected | `global-assets.json` → `backgroundImages` |

### Overlays vs flow content

- **Fixed overlay:** the nav, and only the nav. `position: fixed`, `z-index: 50`,
  `height: 81px`, `backdrop-filter: blur(16px)` over a
  `oklab(0 0 0 / 0.1)` background — so page content scrolls *under* a blurred
  translucent bar. Nothing sticky was found anywhere else.
- **Third-party overlay:** OneTrust cookie consent. Injected by
  `cdn.cookielaw.org`, out of clone scope, ignore during assembly.
- **Everything else** is normal document flow.

Because the nav is fixed and 81px tall, it consumes no layout height. The hero
starts at `y = 0` and slides beneath it. Any future top-offset padding is a
clone-side decision, not something the target does.

## Section inventory

Ordering follows `README.md` line 190. **Build status is verified** against
`src/sections/` and `src/app/page.tsx`.

| # | Section | Built? | `order` | Interaction model | Evidence grade |
|---|---|---|---|---|---|
| 0 | Header / nav | **No** | — | Static (no scroll response observed) | Direct capture |
| 1 | Hero | **YES** | `10` | **Time-driven** — continuous 3D rotation | Direct capture |
| 2 | Products | No | — | Unknown; videos are `autoplay: false` | Asset inference |
| 3 | Proprietary technologies | No | — | Unknown | Prose only |
| 4 | Interviews | No | — | JS carousel (Embla) | Asset inference |
| 5 | Careers CTA | No | — | Unknown | Prose + asset inference |
| 6 | Footer | No | — | Unknown | Prose + asset inference |

---

### 0. Header / nav — **NOT BUILT**

Fully extracted, never built. `src/sections/` contains no header folder.

- **Artifacts:** `nav-scroll0.json`, `nav-scroll400.json` (byte-identical).
- **Placement:** fixed overlay, `z-index: 50`, outside the section flow. When
  built it must mount *outside* the generated section list in `page.tsx`, since
  codegen stacks sections in `order` sequence and a fixed overlay does not belong
  in that stack.
- **Structure:** `nav.fixed.top-0.left-0.z-50.flex`
  → `div.mx-auto.flex.h-16.w-full.max-w-lg` (computed `max-width: 1440px`,
  `padding: 0 48px`, `justify-content: space-between`, `height: 80px`)
  → `a.self-center` wrapping `img` (`bsp-logotype...svg`, alt `BSP Logotype`,
  natural `1336 × 180`, class `mt-1 h-5 w-auto transition-all duration-300`)
  and `a.cta-link.inline-block.rounded-full.border.bg-white`.
- **Two children only.** No nav link list was captured at 1440px — the header is
  just logo + one CTA.
- **Interaction model:** static as far as the captures show. See `BEHAVIORS.md`
  §1 for the `scrollY` caveat and §4 for the unswept hover states on both links.
- **Dependencies:** none. Self-contained, safe to build in isolation.

### 1. Hero — **BUILT** ✅

- **Files:** `src/sections/hero/HeroSection.tsx`, `src/sections/hero/section.meta.json`
  (`order: 10`, `componentName: "HeroSection"`, `importPath: "../sections/hero/HeroSection"`).
- **Spec:** `docs/research/components/hero-section.spec.md` — **note: its
  "Interaction model: static" line is wrong.** See `BEHAVIORS.md` §2.
- **Artifacts:** `hero-extract.json`, `docs/design-references/bendingspoons-{desktop,tablet,mobile}.png`.
- **Root:** `section.gradient-overlay.relative.flex.min-h-screen.flex-col` —
  `1440 × 900px`, `min-height: 900px`, `background-color: rgb(0, 0, 0)`,
  `justify-content: space-around`.
- **Two children, top to bottom:**
  1. `div.flex.items-center.justify-center.pb-30.md:pt-30` — `1440 × 322px`,
     `padding: 120px 0 0`. Holds the `h1`: `font-size: 100px`,
     `line-height: 100px`, `letter-spacing: -6px`, `font-weight: 400`,
     `color: rgb(255, 255, 255)`, rendered box `885.328 × 202px` (two lines),
     with two `<em class="font-serif tracking-tight text-accent">` accent words.
  2. `div.relative.flex.flex-col.items-center.justify-center` — `1440 × 537px`,
     `padding: 120px 0`, `overflow-x: clip`. Holds
     `div.carousel.flex.h-[33vh].w-1/2.items-center` (`360 × 297px`) and its 10
     absolutely-positioned `.card` children (`360 × 450px` each,
     `border-radius: 32px`, 9 `<video>` + 1 `<img>`).
- **Interaction model:** **time-driven.** Cylinder rotates continuously; ten
  muted looping videos play on its faces; two staggered entrance animations run
  on load. Full detail in `BEHAVIORS.md` §2.
- **Dependencies:** the `.gradient-overlay` utility in `globals.css` (shared —
  the edge fades are page-level chrome, not hero-local). Card media from
  `public/images/`. Nothing else.

**Verbatim-text gap.** The built headline reads `We acquire and improve iconic
products`, and `hero-section.spec.md` attributes that full string to "topology
extraction". **The words `We`, `and` and `iconic products` appear in no raw
artifact in `docs/research/`** — grepping every `.json` here for `iconic` returns
zero matches. `hero-extract.json` captures `text` on the two `<em>` children only
(`acquire`, `improve`); the `h1`'s own text nodes come back `null`, because the
extractor records text per-element and the bare text nodes between the `<em>`s
were not captured as elements.

The full headline is almost certainly correct — it is coherent English, it
matches the two captured `<em>`s, and it was visually verified against the
screenshot. But its stated source (`topology` output) is the artifact that does
not exist in this repo. Re-capture it before treating the wording as extracted
fact. This is the one place where built display copy outruns the saved evidence.

### 2. Products — **NOT BUILT**, not extracted

Named in `README.md` line 190. Never extracted; no spec file exists.

Asset cluster from `global-assets.json`, which is the only structural evidence:

- **10 brand logo SVGs** — Vimeo, Evernote, Remini, WeTransfer, Eventbrite,
  Meetup, Komoot, AOL, StreamYard, Brightcove. All ten share a `parentClasses`
  prefix of `mb-0 flex shrink-0 items-center h-… desktop:mb-5 desktop:h-[…]`, so
  every logo sits in an identically-structured card header with a per-brand
  height override.
- **5 `*_card.webp` images** — `vimeo_card`, `wetransfer_card`, `eventbrite_card`,
  `aol_card`, `streamyard_card`, all requested at `w=3840`.
- **5 `product-card-animation-*.mp4`** — Evernote, Remini, Meetup, Komoot,
  Brightcove, all `autoplay: false, loop: true, muted: true`.

**The 5 and the 5 are disjoint and together cover all 10 logos exactly.** Vimeo,
WeTransfer, Eventbrite, AOL and StreamYard get a still `.webp`; Evernote, Remini,
Meetup, Komoot and Brightcove get an `.mp4`. No brand has both, none has neither.
So the repeating unit is `brand logo + one media slot`, where the media is either
a still or a video — not "still plus optional animation".

Those same 10 brands are the 10 hero cards (`global-assets.json` →
`videos[]` lists 9 of them under `/videos/hero-cards-home/`, and Eventbrite is
the hero's one still image). Hero and Products present the identical portfolio in
two different formats.

- **Interaction model: UNKNOWN and consequential.** `autoplay: false` on a
  looping muted video means a trigger exists. Follow SKILL.md principle 6 —
  scroll first, then hover, then click. Building the wrong model is a rewrite.
- **Dependency:** shares brand assets with the hero. Both already downloaded to
  `public/images/`. Neither section should re-download.

### 3. Proprietary technologies — **NOT BUILT**, not extracted

Named in `README.md` line 190 and nowhere else. **No assets in
`global-assets.json` could be confidently attributed to it, and no capture exists.**

This row is prose-only. Its existence, position, and content are all unverified.
Recorded so the section is not silently dropped during assembly — not as a
description of anything measured.

### 4. Interviews — **NOT BUILT**, not extracted

Named in `README.md` line 190.

- **6 images** — `interview-1` … `interview-6`, requested at `w=3840`, every one
  with `parentClasses` of exactly **`embla__scale__layer w-full overflow-hidden`**
  (`global-assets.json`).
- **Interaction model: JS carousel via [Embla](https://www.embla-carousel.com/).**
  The `embla__` prefix is that library's class namespace and `__scale__` is its
  scale-effect layer. This is a real dependency the clone will need to install,
  not a CSS pattern to reimplement by hand.
- **Trigger UNVERIFIED** — drag, arrow buttons, autoplay, or a mix. Nothing
  beyond the class name was captured. Sweep before building.
- Possibly related: six identical `radial-gradient(at 50% 75%, ...)` background
  images on `span.block` elements in `global-assets.json`. Six radials next to
  six interview images is suggestive. **Inference, not measurement.**

### 5. Careers CTA — **NOT BUILT**, not extracted

Named in `README.md` line 190. Corroborated by the nav CTA reading `See careers`
(`nav-scroll0.json`), which implies an in-page careers destination.

Plausibly-associated assets in `global-assets.json`, attribution unconfirmed:

- `badge_italy_gptw.webp` — alt: `Great Place to Work Italy badges - first place in 2025, 2023, 2020, and 2019`
- `badge_europe_gptw.webp` — alt: `Great Place to Work Europe badges - third place in 2025`
- `glassdoor_rating.svg`, `glassdoor_logo.svg`, `glassdoor_reviews.webp` (alt:
  `Some very positive reviews`), all sharing `parentClasses` beginning
  `col-start-2 row-start-1 flex basis-1/3 flex-col items-c…`

Those `col-start-2 row-start-1` classes are the one hard structural fact here:
this content lives in a **CSS grid**, not a flex stack, and occupies column 2 of
row 1. Whether that grid is the careers CTA or its own employer-brand section is
**UNVERIFIED** — it may well be a seventh section `README.md` folds into "careers".

### 6. Footer — **NOT BUILT**, not extracted

Named in `README.md` line 190.

Only direct evidence: `global-assets.json` lists `bsp-logotype...svg` **twice**.
The first instance has `alt: "BSP Logotype"` and `parentClasses: "self-center"` —
that is the nav, matching `nav-scroll0.json` exactly. The second has
`alt: "Logotype"` and `parentClasses: "pt-6"`, a different element with different
alt text and different classes. A second logo lockup near the end of the asset
enumeration is consistent with a footer.

Everything else about the footer — links, columns, legal text, social icons — is
**uncaptured**. `global-assets.json` reports `svgCount: 40` page-wide while its
`images[]` array holds exactly 15 SVG-bearing `<img>` entries, so **25 inline
`<svg>` elements were counted but never enumerated**. Some are likely footer
social icons. Not extractable from what is saved; re-run `assets` and `extract`
on the footer.

## Current assembly state

`src/app/page.tsx` today:

```tsx
// BEGIN GENERATED SECTION IMPORTS
import { HeroSection } from "../sections/hero/HeroSection";
// END GENERATED SECTION IMPORTS

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">
        Clone target not yet built. Run <code …>/clone-website</code> to start.
      </p>
      {/* BEGIN GENERATED SECTIONS */}
      <HeroSection />
      {/* END GENERATED SECTIONS */}
    </main>
  );
}
```

Two known problems, both a consequence of stopping after one section:

1. **Scaffold placeholder leak.** The "Clone target not yet built" `<p>` still
   renders, *beside* the hero. `README.md` line 190 acknowledges this. Commit
   `e09ad5f` added page-scaffold-leak detection to the skill in response.
2. **Wrong root layout for a real page.** `flex min-h-screen items-center
   justify-center` centers a single element. The target is a vertical stack of
   full-bleed sections. Phase 4 must replace this with a plain vertical flow
   before the second section lands, or every new section will be laid out
   side-by-side.

Neither is a hero bug. The hero itself is pixel-verified per `README.md` line 186.

## Assembly order for the remaining work

Suggested `section.meta.json` `order` values, leaving gaps of 10 per SKILL.md
line 283 so sections can be inserted without renumbering:

| Section | Proposed `order` | Notes |
|---|---|---|
| Header / nav | — | Fixed overlay. Mount outside the generated section block. |
| Hero | `10` | **Assigned and built.** |
| Products | `20` | Determine the video trigger first. |
| Proprietary technologies | `30` | Position unverified — confirm with `topology`. |
| Interviews | `40` | Needs the Embla dependency. |
| Careers CTA | `50` | May be two sections, not one. |
| Footer | `60` | 25 uncatalogued inline SVGs live somewhere; check here. |

**Before using any of this for assembly, run and save the capture that was
skipped:**

```bash
node "$H/scripts/inspect.mjs" topology https://www.bendingspoons.com > docs/research/topology.json
```

Then reconcile this file against it. Positions 2 through 6 are prose-ordered, not
measured, and this document should not be trusted past the hero until that gap is
closed.
