# HeroSection Specification

## Overview
- **Target file:** `src/sections/hero/HeroSection.tsx`
- **Screenshot:** `docs/design-references/bendingspoons-desktop.png` (top of page, full-page capture — hero is the first ~900px)
- **Interaction model:** static — confirmed by testing, NOT time-driven autoplay (byte-identical card transforms at 200ms vs 3000ms wait, no interaction) and NOT scroll-linked (byte-identical transforms at scroll 0 vs scroll 300). This is a fixed 3D-fanned card arrangement, purely decorative positioning. Do not build carousel auto-rotation or scroll-triggered rotation logic — there is none.

## DOM Structure
```
<section class="gradient-overlay relative flex min-h-screen flex-col"> (bg black, 1440x900 desktop)
  <div class="flex items-center justify-center pb-30 md:pt-30">        (padding-top: 120px)
    <h1 class="px-4 text-center text-45 leading-none text-white">
      <em class="font-serif tracking-tight text-accent">acquire</em>
      <br class="md:hidden" />
      <em class="font-serif tracking-tight text-accent">improve</em>
      <br />
      (verbatim text continues — see Text Content below for full headline)
    </h1>
  </div>
  <div class="relative flex flex-col items-center justify-center">
    <div class="carousel flex h-[33vh] w-1/2 items-center">
      <!-- ~10 cards, absolutely positioned, 3D-fanned via matrix3d transform -->
      <div class="card absolute box-border aspect-4/5 w-full">
        <video class="h-full w-full overflow-clip rounded-2xl object-cover" /> <!-- or <img> for one card -->
      </div>
      <!-- repeat x10 -->
    </div>
  </div>
</section>
```

## Computed Styles (exact values from getComputedStyle)

### Section (root)
- backgroundColor: `rgb(0, 0, 0)`
- minHeight: `900px` (desktop; effectively `min-h-screen`)
- display: flex, flexDirection: column
- position: relative
- classes carry `gradient-overlay` — a custom utility class already referenced in the extracted class list; if not already defined in `globals.css`, treat as a radial/linear black gradient overlay decoration (common pattern for this kind of hero) — do not invent a specific gradient value; if `gradient-overlay` isn't already a defined class in this project's globals.css, flag it in your completion message rather than guessing its exact stops.

### H1 wrapper div
- padding: `120px 0px 0px` (paddingTop 120px only)
- display: flex, flexDirection: row, justifyContent: center, alignItems: center
- width: 1440px (desktop, full-bleed within section)

### H1
- fontSize: `100px`
- fontWeight: `400`
- fontFamily: Instrument Sans (already wired as `--font-instrument-sans` / Tailwind `font-sans` in this project's layout.tsx)
- lineHeight: `100px` (i.e. `leading-none`, ratio 1:1 — use the `--display-lg` token already set up in globals.css, which is exactly 100px/line-height:1)
- letterSpacing: `-6px` (use the `--tracking-display: -0.06em` token already in globals.css — matches: -6px / 100px font-size = -0.06em)
- color: `rgb(255, 255, 255)` → use `text-foreground` (mapped to white in this project's tokens)
- classes: `px-4 text-center text-45 leading-none text-white`

### H1 `<em>` emphasis spans ("acquire", "improve")
- classes: `font-serif tracking-tight text-accent`
- font-serif → use the `--font-instrument-serif` variable already wired (Tailwind `font-serif`)
- text-accent → this project's `--accent` token is currently white/5% (a background wash token, NOT a text color) — that is very likely wrong for this specific usage. The emphasis words visually use the brand lime green (`rgb(199, 255, 159)`, mapped to `--primary` / `--brand` in this project's globals.css). Use `text-primary` (or `text-brand` if you prefer the explicit brand token) for these `<em>` spans, NOT `text-accent` — the class name on the live site collides with a different Tailwind config than this project's, don't copy the literal class name if it maps to the wrong actual color here. Verify against the screenshot: the two emphasis words should render in lime green, not white or transparent-white.

## States & Behaviors
### N/A — confirmed static
No hover, scroll, click, or time-driven behavior found on this section during testing (see Interaction Model above). If you notice something during implementation that contradicts this (e.g. the cards ARE draggable/clickable), note it in your completion message rather than silently building interactivity that wasn't specified — the extraction found none, but a headless crawl can miss pointer-drag-specific behavior.

## Per-State Content
N/A — no states.

## Assets
- 10 carousel cards: 9 are `<video>`, 1 is `<img>` (confirmed by extraction — card #7 in DOM order, 0-indexed, is the image one; the rest are video). Real downloaded files are in `public/images/`, including at least these confirmed downloads relevant to this section (verify against the full `public/images/` listing yourself, filenames have CDN hash suffixes — do not rename them):
  - `aol.mp4`, `brightcove.mp4`, `evernote.mp4` (partner-branded product videos — likely 3 of the 9 carousel videos)
  - Check `public/images/` for additional `.mp4`/product-card-style assets not yet enumerated here — the full download manifest has 47 files, only a subset were named in this spec; do your own `ls public/images/` and match by content/aspect-ratio (4:5 aspect, `aspect-4/5` class) to find the remaining carousel media.
- Card styling: `rounded-2xl` (use `--radius-xl` token, 40px, from this project's radius ladder — close to the shadcn default 2xl mapping, verify against `globals.css`), `object-cover`, `overflow-clip`.

## Text Content (verbatim)
H1 full text (from topology extraction): **"We acquire and improve iconic products"** — with "acquire" and "improve" as the styled `<em>` spans per the DOM structure above. Reconstruct the exact word wrapping: "We " + em("acquire") + " and " + em("improve") + " iconic products" (verify exact spacing/line-break points against the screenshot — there's a `<br class="md:hidden">` after the first em and a plain `<br>` after the second, suggesting the headline wraps across 3 lines on mobile and differently on desktop; check the desktop screenshot for the actual desktop line-break arrangement since `md:hidden` means that specific break only applies below the md breakpoint).

## Responsive Behavior
- **Desktop (1440px):** hero section 1440×900, h1 at 100px font-size, carousel `w-1/2` of section width, `h-[33vh]`.
- **Mobile (390px):** check the `bendingspoons-mobile.png` screenshot (already captured in `docs/design-references/`) for actual mobile hero layout — the `md:pt-30` / `pb-30` classes and `md:hidden` break suggest the mobile layout stacks differently (padding-bottom instead of padding-top, extra line break). Verify against the mobile screenshot rather than assuming desktop proportions scale down linearly.
- **Breakpoint:** Tailwind `md` (768px) is the switch point per the classes observed (`md:justify-around`, `md:pt-30`, `md:hidden`).

## Shared-Scope Contract
- Global infra: none installed yet (no Lenis/WebGL/page-transition found on this site — confirmed via interaction sweep). You don't need to import or check for any shared runtime provider for this section.
- You may NOT edit `src/app/globals.css`, `src/app/layout.tsx`, or `src/app/page.tsx` directly (these are POSIX-locked, mode 0444 — attempts will fail at the OS level). If you need a new CSS custom property or token that genuinely doesn't exist yet (e.g. if `gradient-overlay` turns out to need a new utility), report the exact CSS you need added in your completion message instead.
- Signature slots: none claimed yet this run. This section doesn't obviously need a magnetic-cursor or pinned-scroll-section signature pattern (it's static), so don't reach for one.

## Your Deliverable
1. Create `src/sections/hero/HeroSection.tsx` — the component, using only tokens/classes already defined in this project's `globals.css` (check it yourself for the exact token names — `--font-instrument-sans`, `--font-instrument-serif`, `--display-lg`, `--tracking-display`, `--primary`/`--brand`, `--foreground`, etc.) plus real asset paths from `public/images/`.
2. Create `src/sections/hero/section.meta.json` with this exact shape (all 3 fields required):
```json
{
  "order": 10,
  "componentName": "HeroSection",
  "importPath": "../sections/hero/HeroSection"
}
```
3. Any literal color/px/font-family value you use must come from `docs/research/tokens.lock.json`'s vocabulary (already reconciled into `globals.css` as named tokens — prefer using those token names like `text-foreground`/`bg-background` over raw arbitrary values wherever a token exists for it).
4. Verify `npx tsc --noEmit` passes before finishing.
5. Report: files written, any uncertainty (especially the `gradient-overlay` class definition and the exact carousel video/image file mapping), and confirm whether you found any interactivity the extraction missed.
