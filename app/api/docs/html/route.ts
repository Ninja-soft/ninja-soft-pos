import { buildDocsHtml, DOCS_FILE_NAME } from "@/lib/api/docsHtml";

// GET /api/docs/html (ADR-163): documentación de la API v1 en un HTML
// autocontenido generado desde lib/api/spec.ts. Pública y sin datos de ningún
// negocio, como /api/openapi.json.
//   ?download=1 -> adjunto (ninjasoft-api-v1.html)
//   ?print=1    -> abre el diálogo de impresión para guardarla como PDF
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const html = buildDocsHtml({ origin: url.origin, autoPrint: url.searchParams.get("print") === "1" });
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
  if (url.searchParams.get("download") === "1") headers["Content-Disposition"] = `attachment; filename="${DOCS_FILE_NAME}"`;
  return new Response(html, { status: 200, headers });
}
