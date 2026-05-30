import type { Metadata } from "next";
import { Inter, Nunito, JetBrains_Mono } from "next/font/google";
import { themeInitScript } from "@/lib/theme/ThemeProvider";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const nunito = Nunito({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-nunito",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

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
    <html
      lang="es"
      suppressHydrationWarning
      className={`${inter.variable} ${nunito.variable} ${jetbrains.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
