/**
 * Content types for the Bending Spoons clone.
 * Kept intentionally small — extend as sections get built.
 */

/** A product/company in the portfolio grid (Vimeo, Evernote, Remini, ...). */
export interface Product {
  /** Stable slug, e.g. "wetransfer". */
  slug: string;
  /** Display name, e.g. "WeTransfer". */
  name: string;
  /** Short blurb shown on the card. */
  description?: string;
  /** Path under /images to the wordmark SVG. */
  logoSrc: string;
  /** Accessible label for the logo image. */
  logoAlt: string;
  /** Path under /images to the looping card animation, when one exists. */
  videoSrc?: string;
  /** External product site. */
  href?: string;
}

/** In-house technology entries (Minerva, Juno, ...). */
export interface ProprietaryTech {
  slug: string;
  name: string;
  /** One-line summary of what the system does. */
  summary: string;
  /** Optional longer copy for expanded states. */
  detail?: string;
}

/** Navigation entry used by the header and footer. */
export interface NavLink {
  label: string;
  href: string;
  /** True for links that leave the site. */
  external?: boolean;
}

/** A labelled figure in the stats strips ("hundreds of millions of users"). */
export interface Stat {
  /** The headline value, e.g. "500M+". */
  value: string;
  /** What the value measures. */
  label: string;
}

/** A generic content section header (eyebrow + heading + body). */
export interface SectionIntro {
  eyebrow?: string;
  heading: string;
  body?: string;
}
