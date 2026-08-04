# HeroSection Specification

## Overview
- **Target file:** `src/sections/hero/HeroSection.tsx`
- **Screenshot:** `docs/design-references/bendingspoons-desktop.png` (top of page, full-page capture — hero is the first ~900px)
- **Interaction model:** time-driven continuous rotation. The 10 cards sit on a 3D cylinder that spins continuously about its Y axis, driven by a `requestAnimationFrame` loop in the component. It is not scroll-linked and has no pointer interaction — the only motion driver is elapsed time. See **Animation & Motion** below for the measured values.

> **Correction note (spec was wrong, now fixed).** This line previously read: *"static — confirmed by testing, NOT time-driven autoplay (byte-identical card transforms at 200ms vs 3000ms wait)... Do not build carousel auto-rotation or scroll-triggered rotation logic — there is none."* That was a false negative, not a real finding. It came from the old two-snapshot extraction technique, which compared **card** transforms at two points in time. The per-card transforms really are static — each card holds a fixed position on the cylinder. The rotation lives one level up, on the `.carousel` parent, so diffing the cards was always going to report no motion. That failure is what prompted the `motion-check` command now in the toolchain (see `README.md`). The behavior documented below reflects the real, verified implementation in `src/sections/hero/HeroSection.tsx`.

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
  <div class="relative flex flex-col items-center justify-center [perspective:800px] [transform-style:preserve-3d]">
    <div class="carousel flex h-[33vh] w-1/2 items-center justify-center [transform-style:preserve-3d] [backface-visibility:hidden]"
         style="transform: translate3d(0,0,0) rotateY(<animated>deg)">   <!-- the spinning cylinder -->
      <!-- 10 cards on a cylinder, absolutely positioned. Card i is:
           translate3d(R*sin(36i), 0, -R*cos(36i)) rotateY(-36i deg)
           where R = carousel width * 1.6 -->
      <div class="card absolute box-border aspect-4/5 w-full [backface-visibility:hidden]">
        <video class="h-full w-full overflow-clip rounded-2xl object-cover" /> <!-- or <img> for card index 7 -->
      </div>
      <!-- repeat x10 — DOM index drives the 36deg step around the cylinder -->
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

## Animation & Motion

### Carousel rotation (the primary behavior)
- **Geometry:** 10 cards on a cylinder, one per 36 deg step (`360 / 10`). Card at DOM index `i` gets
  `translate3d(R*sin(36i), 0, -R*cos(36i)) rotateY(-36i deg)`, with `transformOrigin: 50% 50%`.
- **Radius:** `R = carousel width * 1.6` (`RADIUS_RATIO`). Measured 576px at a 360px desktop carousel and 312px at a 195px mobile carousel. It is recomputed on resize via a `ResizeObserver` and published as the `--hero-r` custom property, so the radius tracks the card width rather than being hardcoded.
- **Driver:** a `requestAnimationFrame` loop on the `.carousel` element writing
  `transform: translate3d(0px, 0px, 0px) rotateY(<angle>deg)`. Angle is a pure function of elapsed time since mount — there is no scroll input and no pointer input.
- **Steady-state rate:** `DEG_PER_SECOND = 5.284` deg/s (measured over a 20s window, +/- 0.02). One full revolution takes roughly 68s.
- **Spin-in easing:** an extra `SPIN_IN_DEGREES = 29.8` deg layered on top with an exponential ease-out, `SPIN_IN_DECAY_MS = 500`. Full angle formula:
  `angle = DEG_PER_SECOND * elapsedSeconds + SPIN_IN_DEGREES * (1 - exp(-elapsedMs / 500))`
  So it enters fast and settles into the constant rate within roughly 2s.
- **Pause conditions:** none. The loop never pauses — not on hover, not on click, not off-screen. It runs from mount until unmount, where it is cancelled in the effect cleanup.

### Reduced motion
`prefers-reduced-motion: reduce` is honored and is live-reactive (a `change` listener re-syncs, so toggling the OS setting takes effect without a reload). When reduced motion is on:
- The rAF loop is cancelled and the cylinder is parked at a fixed `rotateY(43deg)` resting composition.
- Both entrance animations are disabled via a `@media (prefers-reduced-motion: reduce)` block setting `animation: none`.

### Entrance animations (section-scoped CSS, one-shot on mount)
Both use `cubic-bezier(0.215, 0.61, 0.355, 1)` over `1000ms` with `both` fill.
- `.hero-rise` (the h1): opacity 0 -> 1, `translate3d(0, 50px, 0)` -> `0`. No delay.
- `.hero-rise-deep` (the carousel wrapper): opacity 0 -> 1, `translate3d(0, 150px, 0)` -> `0`, plus `blur(3px) grayscale(100%)` -> `blur(0) grayscale(0%)`. Delayed `200ms`.

### 3D setup (what makes the cylinder readable)
- `perspective: 800px` on the carousel wrapper.
- `transform-style: preserve-3d` on both the wrapper and the `.carousel`.
- `backface-visibility: hidden` on the `.carousel` and on every card. This is what hides the near half of the cylinder so only the far half reads.
- `will-change: transform` on the `.carousel`.

### Other states
No hover, click, focus, or drag states. Card videos are `autoPlay loop muted playsInline preload="metadata"` and play unconditionally.

## Assets
- 10 carousel cards: 9 are `<video>`, 1 is `<img>` — card index 7 (0-indexed, DOM order) is the image. Confirmed by extraction and matched by the built component. Resolved mapping, in DOM order (index drives the 36 deg cylinder step, so order matters):

  | # | Asset | Type |
  |---|---|---|
  | 0 | `/images/komoot.mp4` | video |
  | 1 | `/images/evernote.mp4` | video |
  | 2 | `/images/vimeo.mp4` | video |
  | 3 | `/images/wetransfer.mp4` | video |
  | 4 | `/images/remini.mp4` | video |
  | 5 | `/images/brightcove.mp4` | video |
  | 6 | `/images/meetup.mp4` | video |
  | 7 | `/images/eventbrite-card.jpg` | image |
  | 8 | `/images/streamyard.mp4` | video |
  | 9 | `/images/aol.mp4` | video |
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
- Signature slots: none claimed yet this run. The rotating cylinder is the section's motion centerpiece and is already specified above, so don't layer an additional signature pattern (magnetic cursor, pinned scroll section) on top of it.

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
