#!/usr/bin/env node
/**
 * clone-website — Playwright inspection helper (opencode skill)
 *
 * Replaces the "browser MCP" requirement of the original skill with a real
 * headless Chromium driven via Playwright. Every subcommand launches a fresh
 * browser, navigates, optionally performs an action (scroll/hover/click) to
 * reach a STATE, then reads it — so multi-state extraction is just two calls
 * with different --scroll/--hover/--click flags, diffed by the caller.
 *
 * Subcommands:
 *   screenshot <url> <out.png> [--full] [--width N|--mobile] [--scroll Y] [--hover SEL] [--click SEL] [--wait MS]
 *   extract    <url> "<css-selector>"  [--width N|--mobile] [--scroll Y] [--hover SEL] [--click SEL] [--wait MS]
 *   assets     <url>                    [--width N|--mobile]
 *   download   <url> <outdir>           [--width N|--mobile]
 *   topology   <url>                    [--width N|--mobile]
 *   tokens     <url>                    [--responsive] [--width N|--mobile] [--min-count N] [--top N]
 *   motion-check <url> "<css-selector>" [--width N|--mobile] [--wait MS] [--duration MS]
 *                                       [--samples N] [--props a,b,c]
 *                                       [--no-scroll|--at-current-scroll] [--scroll Y]
 *
 * tokens --responsive is the RECOMMENDED way to build a token lock. A lock built
 * from the desktop viewport alone is incomplete: values that only exist at mobile
 * widths (a 45px h1 that is 72px on desktop, a mobile-only gap) are simply absent,
 * so a builder who correctly implements them later gets flagged for a "violation"
 * that is really a hole in the lock. --responsive runs the extraction twice in one
 * invocation (desktop, then 390x844 mobile), merges the buckets by exact value and
 * sums the counts, THEN applies --min-count/--top to the merged totals.
 *
 * motion-check answers ONE question: "is this element moving on its own, with no
 * interaction?" It exists because the two-invocation trick (extract at --wait 200
 * vs extract at --wait 3000, diff the transforms) has a demonstrated blind spot:
 * two separate page loads with short waits can both land BEFORE a slow-starting
 * requestAnimationFrame loop begins (hydration, video preload, lazy JS), so a
 * continuously-rotating carousel reads as byte-identical and therefore "static".
 * motion-check instead does ONE page load, waits a generous settle (default
 * 3000ms) for JS to boot, scrolls the target into view, waits a short settle for
 * any entry trigger to fire, then takes N samples spaced across a long
 * observation window (default 5 samples over 8000ms) and diffs consecutive
 * samples. No hover and no click is applied, and nothing scrolls DURING the
 * window — the one scroll happens before sampling starts.
 *
 * That pre-sample scrollIntoView is not optional politeness, it is the fix for a
 * demonstrated false negative. Scroll-triggered motion (GSAP ScrollTrigger, an
 * IntersectionObserver-gated rAF loop) does not start until the element enters
 * the viewport. Sampling at whatever scroll position the page happened to load
 * at therefore reported a genuinely-animating element as `animating: false`,
 * purely because it sat below the fold and its trigger had never fired. Scroll
 * into view first, and the same element reports true.
 * Opt out with --no-scroll (alias --at-current-scroll) when you specifically
 * want the element measured at the page's initial scroll position, or pass an
 * explicit --scroll Y to park the page at a chosen offset instead.
 *
 * Flags:
 *   --width N      viewport width (default 1440; ignored with --mobile)
 *   --height N     viewport height (default 900; 844 with --mobile)
 *   --mobile       use a 390x844 mobile viewport + touch + mobile UA
 *   --scale N      deviceScaleFactor for screenshots (default 1)
 *   --scroll Y     scroll to vertical position Y (px) before reading
 *   --hover SEL    hover this selector before reading
 *   --click SEL    click this selector before reading (e.g. a tab/pill)
 *   --wait MS      settle time after load/action (default 800; default 3000 for
 *                  motion-check, where it is the pre-observation hydration wait)
 *   --duration MS  motion-check only: total observation window (default 8000)
 *   --samples N    motion-check only: samples taken across the window (default 5,
 *                  minimum 2) — 5 over 8000ms is one sample every ~2s
 *   --props a,b,c  motion-check only: comma-separated camelCase CSS properties to
 *                  watch (default transform,opacity,backgroundPosition)
 *   --no-scroll    motion-check only (alias --at-current-scroll): do NOT scroll
 *                  the target into view before sampling. Default is to scroll it
 *                  into view, because scroll-triggered animations never start
 *                  while the element is off-screen. Use this only when you
 *                  deliberately want the element measured at the page's initial
 *                  scroll position. Overrides --scroll if both are passed.
 *                  With motion-check, --scroll Y parks the page at Y instead of
 *                  scrolling the element into view.
 *   --full         full-page screenshot (screenshot only)
 *   --timeout MS   navigation timeout (default 60000)
 *   --min-count N  tokens only: drop values seen fewer than N times (default 2).
 *                  A value that appears exactly once is more likely a one-off
 *                  than an intentional design-system token.
 *   --top N        tokens only: keep at most N values per bucket after the
 *                  min-count filter, highest frequency first (default 40)
 *   --responsive   tokens only: scan BOTH the desktop viewport (--width/--height,
 *                  default 1440x900) and a 390x844 mobile viewport in the same
 *                  invocation, then merge the two result sets per bucket (counts
 *                  summed for values seen in both). Curation runs after the merge.
 *                  Output shape is identical to the single-viewport form.
 *                  Omitting the flag keeps the old single-viewport behaviour.
 *
 * Resolves `playwright` from this script's own node_modules.
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

// ---- arg parsing -----------------------------------------------------------
const [, , cmd, ...rest] = process.argv
const positional = []
const flags = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const nx = rest[i + 1]
    if (nx === undefined || nx.startsWith('--')) flags[k] = true
    else { flags[k] = nx; i++ }
  } else positional.push(a)
}
const N = (v, d) => (v === undefined || v === true ? d : Number(v))
const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

// Pause after motion-check scrolls the target into view, before the first sample.
// A ScrollTrigger/IntersectionObserver callback fires on the next frame or two,
// and the animation it starts needs a moment more to produce a measurable delta,
// so sampling instantly after the scroll can still read the pre-animation value.
// 800ms deliberately matches the post-scroll settle applyActions() uses for every
// other subcommand (the default --wait), so "how long does this tool wait after a
// scroll before reading" has exactly one answer across the whole file.
const MOTION_SCROLL_SETTLE_MS = 800

const COMMANDS = ['screenshot', 'extract', 'assets', 'download', 'topology', 'tokens', 'motion-check']
const USAGE = `Usage: inspect.mjs <${COMMANDS.join('|')}> <url> [args] [--flags]

  screenshot   <url> <out.png> [--full] [--width N|--mobile] [--scroll Y] [--hover SEL] [--click SEL] [--wait MS]
  extract      <url> "<css-selector>" [--width N|--mobile] [--scroll Y] [--hover SEL] [--click SEL] [--wait MS]
  assets       <url> [--width N|--mobile]
  download     <url> <outdir> [--width N|--mobile]
  topology     <url> [--width N|--mobile]
  tokens       <url> [--responsive] [--width N|--mobile] [--min-count N] [--top N]
  motion-check <url> "<css-selector>" [--width N|--mobile] [--wait MS] [--duration MS]
                     [--samples N] [--props a,b,c] [--no-scroll|--at-current-scroll] [--scroll Y]

motion-check answers "is this element moving on its own?". By DEFAULT it scrolls
the target into view before sampling, then waits ${MOTION_SCROLL_SETTLE_MS}ms for any entry trigger
to fire. Without that, scroll-triggered motion (GSAP ScrollTrigger,
IntersectionObserver-gated loops) never starts and the element is wrongly
reported as static.
  --no-scroll / --at-current-scroll  sample at the page's initial scroll
                                     position instead (overrides --scroll)
  --scroll Y                         park the page at offset Y instead of
                                     scrolling the element into view`
if (!cmd || !COMMANDS.includes(cmd)) {
  die(USAGE, 2)
}
const url = positional[0]
if (!url) die('Error: <url> is required', 2)

const isMobile = !!flags.mobile
const width = N(flags.width, isMobile ? 390 : 1440)
const height = N(flags.height, isMobile ? 844 : 900)
// motion-check needs a generous default settle: the whole point is to let
// hydration / rAF startup finish before the first sample, so 800ms is too short.
const settle = N(flags.wait, cmd === 'motion-check' ? 3000 : 800)
const scale = N(flags.scale, 1)
const navTimeout = N(flags.timeout, 60000)
// tokens-only curation knobs
const minCount = N(flags['min-count'], 2)
const topN = N(flags.top, 40)
// motion-check-only knobs
const motionDuration = N(flags.duration, 8000)
const motionSamples = Math.max(2, N(flags.samples, 5))
const MOTION_DEFAULT_PROPS = ['transform', 'opacity', 'backgroundPosition']
const motionProps = typeof flags.props === 'string'
  ? flags.props.split(',').map((p) => p.trim()).filter(Boolean)
  : MOTION_DEFAULT_PROPS
// Scroll-into-view is the DEFAULT for motion-check; --no-scroll (or the more
// explicit alias --at-current-scroll) is the opt-out for callers who really do
// want the element measured wherever the page happens to load.
const motionNoScroll = !!flags['no-scroll'] || !!flags['at-current-scroll']

// ---- in-page functions (serialized into the browser) -----------------------
// These must be fully self-contained (no closure over Node-side variables).

function pageExtract(selector) {
  const props = [
    'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'color',
    'textTransform', 'textDecoration', 'backgroundColor', 'background',
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight',
    'display', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
    'gridTemplateColumns', 'gridTemplateRows',
    'borderRadius', 'border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
    'boxShadow', 'overflow', 'overflowX', 'overflowY',
    'position', 'top', 'right', 'bottom', 'left', 'zIndex',
    'opacity', 'transform', 'transition', 'cursor',
    'objectFit', 'objectPosition', 'mixBlendMode', 'filter', 'backdropFilter',
    'whiteSpace', 'textOverflow', 'WebkitLineClamp',
  ]
  const el = document.querySelector(selector)
  if (!el) return { error: 'Element not found: ' + selector }
  const clean = (v) => v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)'
  function extractStyles(element) {
    const cs = getComputedStyle(element)
    const styles = {}
    props.forEach((p) => { const v = cs[p]; if (clean(v)) styles[p] = v })
    return styles
  }
  function walk(element, depth) {
    if (depth > 4) return null
    const children = [...element.children]
    const cls = element.className && element.className.toString ? element.className.toString().split(' ').slice(0, 5).join(' ') : ''
    return {
      tag: element.tagName.toLowerCase(),
      classes: cls,
      text: element.childNodes.length === 1 && element.childNodes[0].nodeType === 3 ? element.textContent.trim().slice(0, 200) : null,
      styles: extractStyles(element),
      image: element.tagName === 'IMG' ? { src: element.currentSrc || element.src, alt: element.alt, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight } : null,
      childCount: children.length,
      children: children.slice(0, 20).map((c) => walk(c, depth + 1)).filter(Boolean),
    }
  }
  return walk(el, 0)
}

function pageAssets() {
  const cls = (el) => (el.className && el.className.toString ? el.className.toString() : '')
  return {
    images: [...document.querySelectorAll('img')].map((img) => ({
      src: img.currentSrc || img.src,
      alt: img.alt,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      parentClasses: img.parentElement ? cls(img.parentElement).slice(0, 80) : '',
      position: getComputedStyle(img).position,
      zIndex: getComputedStyle(img).zIndex,
    })),
    videos: [...document.querySelectorAll('video')].map((v) => ({
      src: v.src || (v.querySelector('source') && v.querySelector('source').src) || '',
      poster: v.poster, autoplay: v.autoplay, loop: v.loop, muted: v.muted,
    })),
    backgroundImages: [...document.querySelectorAll('*')].filter((el) => {
      const bg = getComputedStyle(el).backgroundImage
      return bg && bg !== 'none'
    }).slice(0, 250).map((el) => ({
      url: getComputedStyle(el).backgroundImage,
      element: el.tagName.toLowerCase() + '.' + (cls(el).split(' ')[0] || ''),
    })),
    svgCount: document.querySelectorAll('svg').length,
    fonts: [...new Set([...document.querySelectorAll('*')].slice(0, 400).map((el) => getComputedStyle(el).fontFamily))].filter(Boolean),
    favicons: [...document.querySelectorAll('link[rel*="icon"], link[rel*="apple-touch"], link[rel="manifest"]')].map((l) => ({ href: l.href, rel: l.rel, sizes: l.sizes ? l.sizes.toString() : '' })),
  }
}

function pageTopology() {
  const body = document.body
  const main = document.querySelector('main') || body
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) } }
  const cls = (el) => (el.className && el.className.toString ? el.className.toString() : '')
  const sections = [...main.children].map((el, i) => ({
    index: i,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: cls(el).slice(0, 120),
    box: box(el),
    position: getComputedStyle(el).position,
    zIndex: getComputedStyle(el).zIndex,
    childCount: el.children.length,
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
  }))
  return {
    title: document.title,
    pageHeight: document.documentElement.scrollHeight,
    sectionCount: sections.length,
    sections,
    headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 60).map((h) => ({ tag: h.tagName.toLowerCase(), text: (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) })),
  }
}

// Playwright's page.evaluate passes exactly one argument, so curation options
// arrive as a single object rather than two positional params.
// opts.raw = true skips curation entirely and returns the full frequency table.
// The --responsive path needs that, because min-count/top must be applied to the
// MERGED desktop+mobile counts, not per-viewport before the merge.
function pageTokens(opts) {
  const raw = !!(opts && opts.raw)
  const minCount = opts && opts.minCount !== undefined ? opts.minCount : 2
  const topN = opts && opts.topN !== undefined ? opts.topN : 40
  // same filter as pageExtract — inlined because in-page fns must be self-contained
  const clean = (v) => v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent' && v !== '0' && v !== '0px 0px'
  const COLOR_PROPS = ['color', 'backgroundColor', 'borderColor']
  const SPACE_PROPS = [
    'gap',
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  ]
  const buckets = { colors: new Map(), spacing: new Map(), radii: new Map(), fonts: new Map(), shadows: new Map(), fontSizes: new Map() }
  const bump = (bucket, v) => { if (!clean(v)) return; const m = buckets[bucket]; m.set(v, (m.get(v) || 0) + 1) }
  const els = [...document.querySelectorAll('*')].slice(0, 3000)
  for (const el of els) {
    const cs = getComputedStyle(el)
    COLOR_PROPS.forEach((p) => bump('colors', cs[p]))
    SPACE_PROPS.forEach((p) => bump('spacing', cs[p]))
    bump('radii', cs.borderRadius)
    bump('fonts', cs.fontFamily)
    bump('shadows', cs.boxShadow)
    bump('fontSizes', cs.fontSize)
  }
  // rank = frequency-sorted, then curated: drop rare one-offs, cap per bucket.
  // Without this the output is an unfiltered frequency dump, not a token lock.
  const rank = (m) => {
    const sorted = [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
    return raw ? sorted : sorted.filter((e) => e.count >= minCount).slice(0, topN)
  }
  return {
    elementsSampled: els.length,
    colors: rank(buckets.colors),
    spacing: rank(buckets.spacing),
    radii: rank(buckets.radii),
    fonts: rank(buckets.fonts),
    shadows: rank(buckets.shadows),
    fontSizes: rank(buckets.fontSizes),
  }
}

// Single motion sample: read the watched properties off the target element.
// Kept deliberately tiny so the read itself costs ~nothing and the sample
// timestamps stay close to the intended schedule.
function pageMotionSample(opts) {
  const selector = opts.selector
  const props = opts.props
  const el = document.querySelector(selector)
  if (!el) return { found: false, t: Date.now(), values: null }
  const cs = getComputedStyle(el)
  const values = {}
  for (const p of props) values[p] = String(cs[p])
  return { found: true, t: Date.now(), values }
}

// ---- token merging (Node-side) ---------------------------------------------
const TOKEN_BUCKETS = ['colors', 'spacing', 'radii', 'fonts', 'shadows', 'fontSizes']

// Fold N raw pageTokens results into one, then curate. Values are matched
// EXACTLY (a computed '45px' from mobile and '45px' from desktop are the same
// token; counts add up), and the distinct set is the union of both viewports —
// that union is the whole point, since a mobile-only value has no desktop entry.
// Curation deliberately runs here, after the fold, so --min-count judges true
// combined usage instead of dropping a value twice for being rare in each pass.
function mergeTokenPasses(passes) {
  const merged = { elementsSampled: passes.reduce((n, p) => n + (p.elementsSampled || 0), 0) }
  for (const bucket of TOKEN_BUCKETS) {
    const m = new Map()
    for (const p of passes) {
      for (const entry of p[bucket] || []) m.set(entry.value, (m.get(entry.value) || 0) + entry.count)
    }
    merged[bucket] = [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .filter((e) => e.count >= minCount)
      .slice(0, topN)
  }
  return merged
}

// ---- driver ----------------------------------------------------------------
async function applyActions(page) {
  if (flags.scroll !== undefined) {
    await page.evaluate((y) => window.scrollTo(0, y), N(flags.scroll, 0))
    await page.waitForTimeout(settle)
  }
  if (flags.hover) { await page.hover(flags.hover).catch(() => {}); await page.waitForTimeout(settle) }
  if (flags.click) { await page.click(flags.click).catch(() => {}); await page.waitForTimeout(settle) }
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const browser = await chromium.launch({ headless: true })

// One navigated, settled page at the given viewport. Factored out of the old
// top-level context/page creation so --responsive can do it twice in a row.
async function openPage(vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: scale,
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    ...(vp.isMobile ? { userAgent: MOBILE_UA } : {}),
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'load', timeout: navTimeout })
    .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }))
  await page.waitForTimeout(settle)
  return { context, page }
}

// Desktop pass honours --width/--height (falling back to the normal desktop
// defaults even if --mobile was also passed, since the mobile pass covers that).
const RESPONSIVE_VIEWPORTS = [
  { width: N(flags.width, 1440), height: N(flags.height, 900), isMobile: false },
  { width: 390, height: 844, isMobile: true },
]
const responsiveTokens = cmd === 'tokens' && !!flags.responsive

let page = null
try {
  if (!responsiveTokens) ({ page } = await openPage({ width, height, isMobile }))

  if (responsiveTokens) {
    // Two full page loads in one invocation: navigate + extract at each viewport,
    // closing each context before opening the next so only one is ever live.
    const passes = []
    for (const vp of RESPONSIVE_VIEWPORTS) {
      const pass = await openPage(vp)
      try {
        await applyActions(pass.page)
        passes.push(await pass.page.evaluate(pageTokens, { raw: true }))
      } finally {
        await pass.context.close()
      }
    }
    console.log(JSON.stringify(mergeTokenPasses(passes), null, 2))
  } else if (cmd === 'screenshot') {
    const out = positional[1] || 'screenshot.png'
    await applyActions(page)
    await page.screenshot({ path: out, fullPage: !!flags.full })
    console.log(JSON.stringify({ ok: true, out, width, height, scale, fullPage: !!flags.full }))
  } else if (cmd === 'extract') {
    const selector = positional[1]
    if (!selector) die('Error: extract needs a <css-selector>', 2)
    await applyActions(page)
    console.log(JSON.stringify(await page.evaluate(pageExtract, selector), null, 2))
  } else if (cmd === 'assets') {
    console.log(JSON.stringify(await page.evaluate(pageAssets), null, 2))
  } else if (cmd === 'topology') {
    console.log(JSON.stringify(await page.evaluate(pageTopology), null, 2))
  } else if (cmd === 'motion-check') {
    const selector = positional[1]
    if (!selector) die('Error: motion-check needs a <css-selector>', 2)
    // NOTE: still no applyActions() here — no hover, no click, and nothing moves
    // DURING the observation window; that is what keeps this a measurement of
    // self-driven motion. The post-goto `settle` above served as the hydration
    // wait. What DOES happen first, exactly once, is a scroll to bring the target
    // into the viewport, because a scroll-triggered animation (ScrollTrigger,
    // IntersectionObserver-gated rAF) never starts while the element is off-screen
    // — sampling it where the page happened to load reports real motion as static.
    let scrollMode = 'none'
    if (!motionNoScroll) {
      if (flags.scroll !== undefined) {
        // Explicit --scroll Y wins over auto scroll-into-view: the caller has
        // named the exact page offset they want the element observed at.
        await page.evaluate((y) => window.scrollTo(0, y), N(flags.scroll, 0))
        scrollMode = 'explicit'
      } else {
        // scrollIntoViewIfNeeded is a no-op when the element is already visible,
        // so the common case costs nothing but the settle below.
        await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: navTimeout })
          .catch(() => {})
        scrollMode = 'intoView'
      }
      // Let the trigger fire and the animation actually get moving before sample 0.
      await page.waitForTimeout(MOTION_SCROLL_SETTLE_MS)
    }
    const gap = motionDuration / (motionSamples - 1)
    const samples = []
    for (let i = 0; i < motionSamples; i++) {
      if (i > 0) await page.waitForTimeout(gap)
      samples.push(await page.evaluate(pageMotionSample, { selector, props: motionProps }))
    }
    if (!samples[0].found) {
      console.log(JSON.stringify({ error: 'Element not found: ' + selector, selector }, null, 2))
      process.exitCode = 1
    } else {
      const t0 = samples[0].t
      // Diff CONSECUTIVE samples only: any single change anywhere in the window
      // proves motion, even if the element happens to return to its start value.
      const changed = new Set()
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]
        const b = samples[i]
        if (!a.found || !b.found) { changed.add('__elementPresence__'); continue }
        for (const p of motionProps) if (a.values[p] !== b.values[p]) changed.add(p)
      }
      const changedProperties = [...changed]
      console.log(JSON.stringify({
        animating: changedProperties.length > 0,
        changedProperties,
        sampleCount: samples.length,
        totalDurationMs: samples[samples.length - 1].t - t0,
        selector,
        watchedProperties: motionProps,
        settleMs: settle,
        // Recorded so an `animating: false` result is self-explaining: "none"
        // means the element was never scrolled into view, which is the one
        // condition under which a false negative for scroll-triggered motion is
        // still expected.
        scrollMode,
        scrollSettleMs: scrollMode === 'none' ? 0 : MOTION_SCROLL_SETTLE_MS,
        requestedDurationMs: motionDuration,
        samples: samples.map((s) => ({ atMs: s.t - t0, found: s.found, ...s.values })),
      }, null, 2))
    }
  } else if (cmd === 'tokens') {
    await applyActions(page)
    console.log(JSON.stringify(await page.evaluate(pageTokens, { minCount, topN }), null, 2))
  } else if (cmd === 'download') {
    const outdir = positional[1] || 'public/images'
    await mkdir(outdir, { recursive: true })
    const data = await page.evaluate(pageAssets)
    const urls = new Set()
    for (const im of data.images) if (im.src) urls.add(im.src)
    for (const v of data.videos) if (v.src) urls.add(v.src)
    for (const f of data.favicons) if (f.href) urls.add(f.href)
    for (const b of data.backgroundImages) {
      const m = /url\(["']?(.*?)["']?\)/.exec(b.url || '')
      if (m && m[1] && !m[1].startsWith('data:')) { try { urls.add(new URL(m[1], url).href) } catch {} }
    }
    const list = [...urls].filter((u) => u && !u.startsWith('data:'))
    const used = new Set()
    const uniqueName = (u, i) => {
      let name = ''
      try { name = basename(new URL(u).pathname).split('?')[0] } catch {}
      if (!name) name = 'asset-' + i
      let final = name; let n = 1
      while (used.has(final)) { const dot = name.lastIndexOf('.'); final = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`; n++ }
      used.add(final); return final
    }
    const manifest = []
    let idx = 0
    const worker = async () => {
      while (idx < list.length) {
        const i = idx++
        const u = list[i]
        try {
          const res = await fetch(u)
          if (!res.ok) { manifest.push({ url: u, ok: false, status: res.status }); continue }
          const buf = Buffer.from(await res.arrayBuffer())
          const dest = join(outdir, uniqueName(u, i))
          await writeFile(dest, buf)
          manifest.push({ url: u, ok: true, file: dest, bytes: buf.length })
        } catch (e) { manifest.push({ url: u, ok: false, error: String((e && e.message) || e) }) }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    console.log(JSON.stringify({ outdir, total: list.length, downloaded: manifest.filter((m) => m.ok).length, manifest }, null, 2))
  }
} catch (e) {
  console.error(JSON.stringify({ error: String((e && e.message) || e) }))
  process.exitCode = 1
} finally {
  await browser.close()
}
