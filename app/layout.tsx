import type { Metadata } from "next";
import {
  Inter,
  Sora,
  Bricolage_Grotesque,
  Syne,
  Outfit,
  Space_Mono,
  IBM_Plex_Mono,
  JetBrains_Mono,
} from "next/font/google";
import { themeInitScript } from "@/lib/theme/ThemeProvider";
import { appearanceInitScript } from "@/lib/theme/AppearanceProvider";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

// Fuentes candidatas para títulos/destacados (elegibles en Configuración).
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});
const syne = Syne({ subsets: ["latin"], variable: "--font-syne", display: "swap" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });

// Fuentes candidatas para precios/números.
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-spacemono",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plexmono",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

const fontVars = [
  inter,
  sora,
  bricolage,
  syne,
  outfit,
  spaceMono,
  plexMono,
  jetbrains,
]
  .map((f) => f.variable)
  .join(" ");

export const metadata: Metadata = {
  title: "NinjaSoft POS",
  description: "Software seguro para negocios inteligentes.",
  icons: {
    icon: "/brand/favicon.webp",
    apple: "/brand/apple-icon.webp",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" suppressHydrationWarning className={fontVars}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: appearanceInitScript }} />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
