import type { Metadata } from "next";
import {
  Fragment_Mono,
  Instrument_Sans,
  Instrument_Serif,
} from "next/font/google";
import "./globals.css";

// Instrument Sans is variable (400–700) — no explicit weight needed.
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

// Instrument Serif ships a single 400 weight.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

// Fragment Mono ships a single 400 weight.
const fragmentMono = Fragment_Mono({
  variable: "--font-fragment-mono",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.bendingspoons.com"),
  title: "Bending Spoons | Impossible. Maybe.",
  description:
    "We acquire and improve iconic products, and turn them into thriving digital businesses used by hundreds of millions of people.",
  icons: {
    icon: "/seo/favicon.ico",
    shortcut: "/seo/favicon.ico",
  },
  openGraph: {
    title: "Bending Spoons | Impossible. Maybe.",
    description:
      "We acquire and improve iconic products, and turn them into thriving digital businesses used by hundreds of millions of people.",
    siteName: "Bending Spoons",
    type: "website",
    locale: "en_US",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${instrumentSans.variable} ${instrumentSerif.variable} ${fragmentMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
