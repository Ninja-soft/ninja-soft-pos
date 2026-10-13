import type { MetadataRoute } from "next";

// Manifest de la PWA (H65, ADR-087): el POS se instala en celular o tablet y
// abre directo en /pos. Íconos generados desde public/brand/favicon.webp.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/pos",
    name: "NinjaSoft POS",
    short_name: "NinjaSoft",
    description: "Punto de venta de NinjaSoft. Sigue cobrando sin conexión.",
    lang: "es-AR",
    start_url: "/pos",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0a0518",
    theme_color: "#0a0518",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/brand/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
