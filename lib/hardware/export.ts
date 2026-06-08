"use client";

import { exportXlsx, type XlsxSheet } from "@/lib/utils/xlsx";
import type { Capability, EnvInfo } from "./capabilities";
import {
  AREA_LABELS,
  RESULT_LABELS,
  type DiagEntry,
} from "./diagnosticsLog";

// =============================================================================
// Centro de diagnóstico de hardware (F10 · H26) — export para soporte
// -----------------------------------------------------------------------------
// Arma un paquete de diagnóstico (XLSX o JSON) con: identidad del negocio/caja
// (solo nombre/slug, NO tokens ni datos de clientes), capacidades reales del
// navegador, datos del entorno y el historial de pruebas guiadas. Es lo que el
// dueño le manda a soporte NinjaSoft para saber qué periférico falla sin
// conectarse a la máquina.
//
// SEGURIDAD: el paquete NUNCA incluye API keys, tokens, contraseñas, ni datos
// de clientes/ventas. Solo metadatos del equipo y resultados de pruebas.
// =============================================================================

export interface DiagnosticContext {
  tenantName: string | null;
  tenantSlug: string | null;
  registerName: string | null;
  appVersion: string | null;
}

const CAP_STATUS_LABEL: Record<Capability["status"], string> = {
  ok: "Disponible",
  partial: "Limitado",
  unavailable: "No disponible",
};

export interface DiagnosticPayload {
  generatedAt: string;
  context: DiagnosticContext;
  environment: EnvInfo | null;
  capabilities: Capability[];
  tests: DiagEntry[];
}

// Construye el objeto del diagnóstico (separado del download para testearlo).
export function buildDiagnosticPayload(args: {
  context: DiagnosticContext;
  environment: EnvInfo | null;
  capabilities: Capability[];
  tests: DiagEntry[];
}): DiagnosticPayload {
  return {
    generatedAt: new Date().toISOString(),
    context: args.context,
    environment: args.environment,
    capabilities: args.capabilities,
    tests: args.tests,
  };
}

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function baseName(ctx: DiagnosticContext): string {
  const slug = (ctx.tenantSlug || ctx.tenantName || "ninjapos")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `diagnostico-hardware-${slug || "ninjapos"}-${fileStamp()}`;
}

// Descarga el diagnóstico como XLSX con varias hojas (resumen + capacidades +
// entorno + pruebas). Reusa el helper de export con diseño de marca.
export async function exportDiagnosticXlsx(payload: DiagnosticPayload): Promise<void> {
  const { context, environment, capabilities, tests } = payload;

  const resumen: XlsxSheet = {
    name: "Resumen",
    title: "Diagnóstico de hardware · NinjaPos",
    columns: [
      { header: "Dato", key: "k", width: 26 },
      { header: "Valor", key: "v", width: 60 },
    ],
    rows: [
      { k: "Generado", v: new Date(payload.generatedAt).toLocaleString("es-AR") },
      { k: "Negocio", v: context.tenantName ?? "—" },
      { k: "Identificador (slug)", v: context.tenantSlug ?? "—" },
      { k: "Caja", v: context.registerName ?? "—" },
      { k: "Versión de la app", v: context.appVersion ?? "—" },
      {
        k: "Pruebas registradas",
        v: String(tests.length),
      },
      {
        k: "Capacidades OK",
        v: `${capabilities.filter((c) => c.status === "ok").length} de ${capabilities.length}`,
      },
    ],
  };

  const caps: XlsxSheet = {
    name: "Capacidades",
    title: "Capacidades del navegador",
    columns: [
      { header: "Capacidad", key: "label", width: 28 },
      { header: "Estado", key: "status", width: 16 },
      { header: "Detalle", key: "detail", width: 80 },
    ],
    rows: capabilities.map((c) => ({
      label: c.label,
      status: CAP_STATUS_LABEL[c.status],
      detail: c.detail,
    })),
  };

  const entorno: XlsxSheet = {
    name: "Entorno",
    title: "Entorno del equipo",
    columns: [
      { header: "Dato", key: "k", width: 26 },
      { header: "Valor", key: "v", width: 80 },
    ],
    rows: environment
      ? [
          { k: "Navegador (user agent)", v: environment.userAgent },
          { k: "Plataforma", v: environment.platform },
          { k: "Idioma", v: environment.language },
          { k: "Pantalla", v: environment.screen },
          { k: "Ventana", v: environment.viewport },
          { k: "Densidad de píxeles", v: String(environment.devicePixelRatio) },
          { k: "Conexión", v: environment.online ? "En línea" : "Sin conexión" },
          {
            k: "Núcleos lógicos",
            v: environment.hardwareConcurrency != null ? String(environment.hardwareConcurrency) : "—",
          },
          {
            k: "Memoria aprox. (GB)",
            v: environment.deviceMemoryGb != null ? String(environment.deviceMemoryGb) : "—",
          },
          { k: "Pantalla táctil", v: environment.touch ? "Sí" : "No" },
          { k: "Origen seguro (HTTPS)", v: environment.secureContext ? "Sí" : "No" },
        ]
      : [{ k: "Entorno", v: "No disponible" }],
  };

  const pruebas: XlsxSheet = {
    name: "Pruebas",
    title: "Historial de pruebas guiadas",
    columns: [
      { header: "Fecha y hora", key: "at", width: 22 },
      { header: "Periférico", key: "area", width: 22 },
      { header: "Prueba", key: "action", width: 34 },
      { header: "Resultado", key: "result", width: 16 },
      { header: "Detalle", key: "detail", width: 70 },
    ],
    rows: tests.map((t) => ({
      at: new Date(t.at).toLocaleString("es-AR"),
      area: AREA_LABELS[t.area],
      action: t.action,
      result: RESULT_LABELS[t.result],
      detail: t.detail,
    })),
  };

  await exportXlsx(baseName(context), [resumen, caps, entorno, pruebas]);
}

// Descarga el diagnóstico como JSON (alternativa "cruda" para soporte técnico).
export function exportDiagnosticJson(payload: DiagnosticPayload): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName(payload.context)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
