import { JetBrains_Mono, Outfit, Plus_Jakarta_Sans } from "next/font/google";

/**
 * Stitch "Cryptographic Noir Deduction" type stack — scoped to /play so the
 * starter-kit landing page keeps Inter.
 */
const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-play-display",
  display: "swap",
});
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-play-body",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-play-mono",
  display: "swap",
});

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${outfit.variable} ${jakarta.variable} ${jetbrains.variable}`}>{children}</div>
  );
}
