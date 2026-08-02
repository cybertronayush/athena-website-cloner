# Degradations

Values in the clone that could not be resolved to a measured token in
`docs/research/tokens.lock.json`. Each row corresponds to a `@clone-degraded:`
marker in the source. Anything not listed here is measured from the live site.

| File | Reason | Date |
|---|---|---|
| `src/app/globals.css` (`--shadow-card`) | The value `0 4px 8px 0 rgb(0 0 0 / 0.2)` is an exact transcription of the measured shadow `rgba(0, 0, 0, 0.2) 0px 4px 8px 0px` (tokens.lock.json `shadows`, count 2). It flags only because token-lint scans `.css` files with a colors-only rule, so the shadow's color component is compared against the `colors` bucket, where a shadow tint would never appear. Value is faithful, not invented. | 2026-08-02 |
| `src/app/globals.css` (`--destructive`, `:root`) | shadcn scaffold default kept. No error/destructive UI state is visible on the live site, so there is no measured value to derive one from. | 2026-08-02 |
| `src/app/globals.css` (`--destructive`, `.dark`) | Same as above — `.dark` mirrors `:root` because the site ships dark-only. | 2026-08-02 |
