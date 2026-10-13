import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderServiceWorker, swVersion } from "@/lib/pwa/version";

// Service worker del POS (H65, ADR-087) en /sw.js. Se genera en el build
// (estático): el código vive en lib/pwa/sw.worker.js y lleva la versión del
// deploy. Sin cookies ni datos: es el mismo archivo para todos.
export const dynamic = "force-static";

const BUILT_AT = Date.now().toString(36);

export function GET() {
  const source = readFileSync(join(process.cwd(), "lib/pwa/sw.worker.js"), "utf8");
  const body = renderServiceWorker(source, swVersion(process.env, BUILT_AT));
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // El navegador revisa si hay versión nueva en cada navegación.
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
