# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Hero section: pixel-verified recreation with the site's real rotating 3D card carousel (10 cards on a measured cylinder, 5.284 deg/s with an eased spin-in), the "acquire" / "improve" serif accent headline, and staggered entrance animations with a `prefers-reduced-motion` resting state
- Design token system extracted from the live site (colors, typography, spacing, radii) reconciled against `docs/research/tokens.lock.json`
- `docs/research/DEGRADATIONS.md` recording every value that could not resolve back to a measured token, with justification
- Per-section spec workflow: `docs/research/components/hero-section.spec.md` plus the `src/sections/<name>/` fragment-folder convention with `section.meta.json` driving page assembly
- Real assets downloaded from the source site (product card videos, brand logos, imagery, favicon)

### Changed
- Renamed the `radius-2xs` token and cleared a stale degradation marker after reconciliation

## [0.1.0] - 2026-08-02

### Added
- Project foundation: Next.js 16 + shadcn/ui + Tailwind CSS v4 scaffold
- Fonts (Instrument Sans, Instrument Serif, Fragment Mono) and the full color and typography token system extracted from bendingspoons.com
- `.gradient-overlay` shared utility and design token additions for mobile-specific values
- Desktop, tablet and mobile reference screenshots of the source site
