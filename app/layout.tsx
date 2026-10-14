import type { Metadata, Viewport } from "next";
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

// Precarga sólo las fuentes por defecto (Inter para el texto y Sora para los
// títulos). Las candidatas que se eligen en Apariencia no se precargan: antes se
// precargaban 11 archivos (~276 KB) en cada primera carga, más que todo el JS,
// compitiendo con el bundle del POS. Si el negocio elige otra, el navegador la
// baja recién cuando el CSS la usa (display: swap).
// (next/font exige literales: por eso `preload: false` va escrito en cada una.)

// Fuentes candidatas para títulos/destacados (elegibles en Configuración).
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
  preload: false,
});
const syne = Syne({ subsets: ["latin"], variable: "--font-syne", display: "swap", preload: false });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap", preload: false });

// Fuentes candidatas para precios/números.
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-spacemono",
  display: "swap",
  preload: false,
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plexmono",
  display: "swap",
  preload: false,
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  // Monoespaciada por defecto (PLU, códigos): chica y fuera del primer pintado.
  display: "swap",
  preload: false,
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
  // PWA (H65, ADR-087): el manifest sale de app/manifest.ts.
  appleWebApp: { capable: true, title: "NinjaSoft POS", statusBarStyle: "black-translucent" },
};

// viewport-fit=cover habilita env(safe-area-inset-*) en iPhone (notch y home
// indicator); el layout ya reserva esos márgenes donde hace falta.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0518",
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
