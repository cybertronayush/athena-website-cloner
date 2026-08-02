# Icons

One file per icon, one self-contained named export per file:

```
src/components/icons/
  SearchIcon.tsx    export function SearchIcon(props: SVGProps<SVGSVGElement>) { ... }
  ArrowIcon.tsx     export function ArrowIcon(props: SVGProps<SVGSVGElement>) { ... }
  index.ts          GENERATED — do not edit
```

This replaces the old single-file `src/components/icons.tsx` barrel, which every builder had to edit at once. Now each builder adds its own file and nobody touches a shared one.

After adding an icon, run from the project root:

```bash
node ../../scripts/codegen.mjs .
```

That regenerates `index.ts` with one re-export per file, sorted alphabetically. Import from the barrel:

```ts
import { SearchIcon } from "@/components/icons";
```

Export names must be unique across files — codegen fails on collisions.
