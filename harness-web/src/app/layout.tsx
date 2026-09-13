import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HARNESS — OpenZeppelin Wizard for DeFi",
  description:
    "Vaults over Aave, Morpho and Compound, launchpads, and flash-loan receivers — generated hardened, audited against documented incidents, and shipped with the attacks on them.",
};

/**
 * Applies the stored theme before the first paint, so a dark-theme user never
 * sees a light flash. Runs before hydration; the toggle reads the same attribute.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('harness-theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
