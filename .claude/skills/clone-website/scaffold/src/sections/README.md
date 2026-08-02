# Sections

One folder per page section. **Each folder is owned exclusively by the builder that built it** — nobody else edits inside it. That ownership is what keeps parallel builders from fighting over `globals.css`, the icons barrel, and `page.tsx`.

## Folder shape

```
src/sections/<section-name>/
  Component.tsx        the section component (filename is free, export is named)
  section.css          OPTIONAL — scoped rules only, wrapped by codegen in @layer components
  section.meta.json    required manifest
```

`section.meta.json`:

```json
{
  "order": 10,
  "componentName": "Hero",
  "importPath": "../sections/hero/Hero"
}
```

- `order` — ascending position on the page. Must be unique across sections. Leave gaps (10, 20, 30) so a section can be inserted later without renumbering.
- `componentName` — the exact named export from the `.tsx`.
- `importPath` — path to the `.tsx`, relative to `src/app/page.tsx`.

## After adding or changing a section

```bash
node ../../scripts/codegen.mjs .
```

Run it from the project root. It regenerates, inside their BEGIN/END markers only:

- `src/app/globals.css` — one `@import` per `section.css`, alphabetical
- `src/components/icons/index.ts` — barrel for `src/components/icons/*.tsx`
- `src/app/page.tsx` — section imports + JSX mounts, in `order` sequence

Everything outside the markers is preserved. **Never hand-edit inside the markers** — the next codegen run overwrites it.

`node ../../scripts/codegen.mjs . --check` verifies the generated files match the fragments and exits 1 on drift. Use it in CI or before merging.

## Rules

- `section.css` may not contain `:root` or `@theme`. Design tokens are frozen earlier in the pipeline; sections only add scoped component rules. codegen flags violations.
- New icons go in `src/components/icons/<IconName>.tsx`, one named export per file.
