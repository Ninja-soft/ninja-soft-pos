"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import { arcaErrorMessage, connectionFor, type ArcaEnv, type ConnectionSettingsLike } from "@/lib/arca/labels";
import type { TestResult } from "@/modules/arca/api";
import { useArcaMutations } from "@/modules/arca/hooks";
import { Dot, fmtDateTime } from "./shared";

// Resultado de "Probar conexión" en lenguaje simple: cada paso con lo que
// pasó y, si falló, qué hacer.
export const STEP_LABEL: Record<string, string> = {
  certificado: "Certificado guardado",
  wsaa: "Acceso a ARCA (permiso de 12 horas)",
  dummy: "Servidores de ARCA funcionando",
  ptos_venta: "Puntos de venta en ARCA",
  pv_sucursales: "Puntos de venta de tus sucursales",
  ultimo: "Servicio de facturación autorizado para tu CUIT",
};

export function TestResults({ result }: { result: TestResult }) {
  const failed = result.steps.find((s) => !s.ok);
  const failedHelp = failed ? humanError(failed.code ?? null, failed.title ?? failed.message ?? null) : null;
  return (
    <div className="space-y-3">
      {result.ok ? (
        <Callout tone="success" icon={CheckCircle2} title="Todo bien: NinjaSoft puede facturar con ARCA">
          {result.cuit ? `Se probó con la CUIT ${result.cuit}. Quedó guardado.` : "Quedó guardado."}
        </Callout>
      ) : (
        <Callout tone="warning" icon={AlertTriangle} title={failedHelp?.title ?? "Hay algo para revisar"}>
          {result.message ?? failedHelp?.action ?? "Mirá abajo qué paso falló y qué hacer."}
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
                    <p className="text-foreground">{h?.title ?? s.title}</p>
                    <p className="text-muted-foreground">{h?.action ?? s.action}</p>
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

/**
 * Prueba de conexión con el resultado y el error en pantalla (nunca sólo en
 * un toast que se va): si la Edge falla, el error queda en el paso.
 */
export function useConnectionTest(env: ArcaEnv) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      const r = await m.testConexion.mutateAsync(env);
      setResult(r);
      toast({
        title: r.ok ? "Conexión verificada y guardada" : "La prueba encontró algo para revisar",
        variant: r.ok ? "success" : "error",
      });
      return r;
    } catch (e) {
      setResult(null);
      setError(arcaErrorMessage(e));
      return null;
    }
  };
  return { result, error, run, pending: m.testConexion.isPending };
}

/** Última prueba guardada de un ambiente (persiste aunque se salga y se vuelva). */
export function SavedConnection({ settings, env }: { settings: ConnectionSettingsLike | null; env: ArcaEnv }) {
  const conn = connectionFor(settings, env);
  if (!conn) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock size={14} aria-hidden /> Todavía no se probó en este modo.
      </p>
    );
  }
  const h = conn.ok ? null : humanError(conn.code, conn.message);
  return (
    <div className="flex items-start gap-2 text-sm" data-testid={`saved-connection-${env}`}>
      <span className="mt-1.5">
        <Dot tone={conn.ok ? "success" : "danger"} />
      </span>
      <div className="min-w-0">
        <p className="font-medium text-foreground">
          {conn.ok ? "Verificado" : "Última prueba con error"}
          {conn.at ? ` el ${fmtDateTime(conn.at)}` : ""}
        </p>
        {h && (
          <p className="text-muted-foreground">
            {h.title}. {h.action}
          </p>
        )}
      </div>
    </div>
  );
}
SavedConnection.displayName = "SavedConnection";
