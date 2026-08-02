"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

/**
 * Hero for the Bending Spoons clone.
 *
 * Every number below was read off the live site with getComputedStyle /
 * element.style rather than estimated from a screenshot:
 *
 *  - 10 cards sit on a cylinder. Card i is
 *      translate3d(R*sin(36i), 0, -R*cos(36i)) rotateY(-36i deg)
 *    and R = (carousel width) * 1.6  (desktop 360 -> 576, mobile 195 -> 312).
 *  - The cylinder spins. Steady-state angular velocity is 5.284 deg/s, with an
 *    extra ~29.8 deg of eased spin-in during the first ~2s.
 *  - `perspective: 800px` lives on the wrapper, `preserve-3d` on the wrapper and
 *    the carousel, and `backface-visibility: hidden` on every card, which is what
 *    hides the near half of the cylinder and leaves the far half readable.
 */

/** Card media in DOM order. Index drives the 36 deg step around the cylinder. */
const CARDS = [
  { src: "/images/komoot.mp4", type: "video" },
  { src: "/images/evernote.mp4", type: "video" },
  { src: "/images/vimeo.mp4", type: "video" },
  { src: "/images/wetransfer.mp4", type: "video" },
  { src: "/images/remini.mp4", type: "video" },
  { src: "/images/brightcove.mp4", type: "video" },
  { src: "/images/meetup.mp4", type: "video" },
  { src: "/images/eventbrite-card.jpg", type: "image" },
  { src: "/images/streamyard.mp4", type: "video" },
  { src: "/images/aol.mp4", type: "video" },
] as const;

/** Cylinder radius as a multiple of the card width (measured 576/360 = 312/195). */
const RADIUS_RATIO = 1.6;
/** Steady-state rotation, measured over a 20s window (5.284 deg/s, +/- 0.02). */
const DEG_PER_SECOND = 5.284;
/** Extra eased rotation during the spin-in, and its decay constant. */
const SPIN_IN_DEGREES = 29.8;
const SPIN_IN_DECAY_MS = 500;

const CARD_MEDIA_CLASS =
  "h-full w-full overflow-clip rounded-card object-cover [backface-visibility:hidden] md:rounded-lg";

export function HeroSection() {
  const carouselRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    // Radius tracks the card width, exactly like the live site does in JS.
    const setRadius = () => {
      const width = carousel.getBoundingClientRect().width;
      carousel.style.setProperty("--hero-r", `${width * RADIUS_RATIO}px`);
    };
    setRadius();
    const observer = new ResizeObserver(setRadius);
    observer.observe(carousel);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const angle =
        (DEG_PER_SECOND * elapsed) / 1000 +
        SPIN_IN_DEGREES * (1 - Math.exp(-elapsed / SPIN_IN_DECAY_MS));
      carousel.style.transform = `translate3d(0px, 0px, 0px) rotateY(${angle}deg)`;
      frame = requestAnimationFrame(tick);
    };

    const sync = () => {
      cancelAnimationFrame(frame);
      if (reduceMotion.matches) {
        // Hold the resting composition instead of spinning.
        carousel.style.transform = "translate3d(0px, 0px, 0px) rotateY(43deg)";
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    sync();
    reduceMotion.addEventListener("change", sync);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reduceMotion.removeEventListener("change", sync);
    };
  }, []);

  return (
    <section className="gradient-overlay relative flex min-h-screen flex-col justify-center bg-background md:justify-around">
      <style href="hero-section" precedence="default">
        {HERO_CSS}
      </style>

      <div className="flex items-center justify-center pb-30 md:pt-30 md:pb-0">
        <h1 className="hero-rise px-4 text-center text-display-mobile tracking-display-sm text-foreground md:px-0 md:text-display-lg md:tracking-display">
          We <em className="font-serif tracking-tight text-primary">acquire</em>{" "}
          <br className="md:hidden" />
          and <em className="font-serif tracking-tight text-primary">improve</em>{" "}
          <br />
          {" iconic products"}
        </h1>
      </div>

      <div className="hero-rise-deep relative flex flex-col items-center justify-center gap-10 overflow-x-clip [perspective:800px] [transform-style:preserve-3d] md:gap-0 md:py-30">
        <div
          ref={carouselRef}
          className="carousel flex h-[33vh] w-1/2 items-center justify-center bg-transparent [backface-visibility:hidden] [transform-style:preserve-3d] will-change-transform md:w-1/4"
        >
          {CARDS.map((card, index) => {
            const radians = (index * 36 * Math.PI) / 180;
            const x = Math.sin(radians).toFixed(6);
            const z = (-Math.cos(radians)).toFixed(6);

            return (
              <div
                key={card.src}
                className="card absolute box-border aspect-4/5 w-full [backface-visibility:hidden]"
                style={{
                  transformOrigin: "50% 50%",
                  transform: `translate3d(calc(var(--hero-r, 576px) * ${x}), 0px, calc(var(--hero-r, 576px) * ${z})) rotateY(${-36 * index}deg)`,
                }}
              >
                {card.type === "video" ? (
                  <video
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                    className={CARD_MEDIA_CLASS}
                  >
                    <source src={card.src} type="video/mp4" />
                  </video>
                ) : (
                  <Image
                    alt=""
                    src={card.src}
                    width={864}
                    height={1080}
                    className={CARD_MEDIA_CLASS}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * Section-scoped entrance animations. The edge fade this section also needs now
 * lives in `globals.css` as the shared `.gradient-overlay` utility.
 */
const HERO_CSS = `
@keyframes hero-rise {
  from { opacity: 0; transform: translate3d(0, 50px, 0); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes hero-rise-deep {
  from { opacity: 0; transform: translate3d(0, 150px, 0); filter: blur(3px) grayscale(100%); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); filter: blur(0) grayscale(0%); }
}
.hero-rise { animation: hero-rise 1000ms cubic-bezier(0.215, 0.61, 0.355, 1) both; }
.hero-rise-deep { animation: hero-rise-deep 1000ms cubic-bezier(0.215, 0.61, 0.355, 1) 200ms both; }
@media (prefers-reduced-motion: reduce) {
  .hero-rise, .hero-rise-deep { animation: none; }
}
`;
