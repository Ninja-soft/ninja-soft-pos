"use client";

import { Callout } from "@/components/ui/Callout";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import type { TestResult } from "@/modules/arca/api";
import { Dot } from "./shared";
import { CheckCircle2, AlertTriangle } from "lucide-react";

// Resultado de "Probar conexión" en lenguaje simple: cada paso con lo que
// pasó y, si falló, qué hacer.
const STEP_LABEL: Record<string, string> = {
  certificado: "Certificado guardado",
  wsaa: "Acceso a ARCA (permiso de 12 horas)",
  dummy: "Servidores de ARCA funcionando",
  ultimo: "Servicio de facturación autorizado para tu CUIT",
  ptos_venta: "Puntos de venta en ARCA",
};

export function TestResults({ result }: { result: TestResult }) {
  return (
    <div className="space-y-3">
      {result.ok ? (
        <Callout tone="success" icon={CheckCircle2} title="Todo bien: NinjaSoft puede facturar con ARCA">
          {result.cuit ? `Se probó con la CUIT ${result.cuit}.` : null}
        </Callout>
      ) : (
        <Callout tone="warning" icon={AlertTriangle} title="Hay algo para revisar">
          {result.message ?? "Mirá abajo qué paso falló y qué hacer."}
        </Callout>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {result.steps.map((s) => {
          const h = s.ok ? null : humanError(s.code ?? null, s.title ?? s.message ?? null);
          return (
            <li key={s.key} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-1.5">
                <Dot tone={s.ok ? "success" : "danger"} />
              </span>
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">{STEP_LABEL[s.key] ?? s.key}</p>
                {s.ok ? (
                  s.message && <p className="text-muted-foreground">{s.message}</p>
                ) : (
                  <>
                    <p className="text-foreground">{s.title ?? h?.title}</p>
                    <p className="text-muted-foreground">{s.action ?? h?.action}</p>
                    {s.code && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">Código ARCA: {s.code}</p>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
TestResults.displayName = "TestResults";
