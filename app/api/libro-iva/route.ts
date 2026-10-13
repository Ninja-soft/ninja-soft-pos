import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { PERIOD_RE, buildLibroIva, zipName, type LibroData } from "@/lib/tax/libroIva";
import { createZip } from "@/lib/utils/zip";

// Libro IVA Digital (F18 · H108, ADR-076). Server-side: lee el período con la
// sesión del usuario (libro_iva_data exige dueño o encargado y la feature
// facturacion_afip con tenant_has_feature_for), arma los archivos de ancho
// fijo y el zip, y audita en audit_logs (libro_iva_log) ANTES de entregar.
//   GET ?period=2026-10            → revisión: resumen y problemas (JSON).
//   GET ?period=2026-10&download=1 → zip (sólo sin errores).
export const dynamic = "force-dynamic";

type RpcRes = { data: unknown; error: { message: string; code?: string } | null };

function errorStatus(msg: string): number {
  if (/forbidden|42501/.test(msg)) return 403;
  if (/feature_not_in_plan/.test(msg)) return 402;
  if (/no_tenant|JWT|not authenticated/i.test(msg)) return 401;
  if (/period_invalid/.test(msg)) return 400;
  return 500;
}

function friendly(msg: string): string {
  if (/forbidden|42501/.test(msg)) return "Sólo el dueño o un encargado pueden generar el Libro IVA Digital.";
  if (/feature_not_in_plan/.test(msg)) return "Tu plan no incluye facturación electrónica (Libro IVA Digital).";
  if (/no_tenant|JWT|not authenticated/i.test(msg)) return "Iniciá sesión de nuevo.";
  if (/period_invalid/.test(msg)) return "Elegí un mes válido (no puede ser futuro).";
  if (/function .*libro_iva.* does not exist|Could not find the function/i.test(msg)) {
    return "Falta aplicar la migración del Libro IVA Digital en la base.";
  }
  return "No se pudo armar el Libro IVA Digital. Probá de nuevo.";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? "";
  const download = url.searchParams.get("download") === "1";
  if (!PERIOD_RE.test(period)) {
    return NextResponse.json({ error: "Elegí un mes válido." }, { status: 400 });
  }

  const supabase = createClient();
  const rpc = (fn: string, args: Record<string, unknown>) =>
    supabase.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

  const { data, error } = await rpc("libro_iva_data", { p_period: `${period}-01` });
  if (error) {
    return NextResponse.json({ error: friendly(error.message) }, { status: errorStatus(error.message) });
  }
  const libro = data as LibroData;
  let result;
  try {
    result = buildLibroIva(libro);
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo armar el archivo: ${e instanceof Error ? e.message : String(e)}` },
      { status: 422 },
    );
  }

  if (!download) {
    return NextResponse.json(
      { summary: result.summary, issues: result.issues, emitter: libro.emitter },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (result.summary.errors > 0) {
    return NextResponse.json(
      { error: "Hay problemas que resolver antes de generar el libro.", issues: result.issues, summary: result.summary },
      { status: 422 },
    );
  }

  const log = await rpc("libro_iva_log", {
    p_period: `${period}-01`,
    p_summary: {
      ventas: result.summary.ventas,
      compras: result.summary.compras,
      warnings: result.summary.warnings,
      files: result.files.map((f) => ({ name: f.name, bytes: f.content.length })),
    },
  });
  if (log.error) {
    return NextResponse.json({ error: friendly(log.error.message) }, { status: errorStatus(log.error.message) });
  }

  const zip = createZip(result.files.map((f) => ({ name: f.name, data: f.content })));
  return new Response(zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName(libro.emitter?.cuit, period)}"`,
      "Cache-Control": "no-store",
    },
  });
}
