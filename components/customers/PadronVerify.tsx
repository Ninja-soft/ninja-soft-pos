"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, RefreshCw, SearchCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PadronResult } from "@/components/arca/PadronResult";
import {
  canVerifyDocument,
  padronErrorMessage,
  verificationLabel,
  type FiscalVerification,
  type PadronPersona,
} from "@/lib/customers/padron";
import { inferLetter } from "@/lib/tax/comprobante";
import { usePadronLookup, usePadronStatus } from "@/modules/padron/hooks";
import { useTaxSettings } from "@/modules/tax/hooks";

// "Verificar en ARCA" del alta y edición de clientes (ADR-133). Con un CUIT o
// CUIL válido consulta el padrón con el certificado de NinjaSoft, muestra lo
// que informa ARCA y la factura que le corresponde, y con "Usar estos datos"
// los vuelca al formulario. Que quede "verificado" lo decide el servidor
// (trigger de customers con la consulta real); acá sólo se pide.
export function PadronVerify({
  docType,
  docNumber,
  verification,
  verifiedAt,
  onApply,
}: {
  docType: string | null | undefined;
  docNumber: string | null | undefined;
  /** Estado guardado del cliente (para la etiqueta). */
  verification?: FiscalVerification;
  verifiedAt?: string | null;
  onApply: (persona: PadronPersona) => void;
}) {
  const status = usePadronStatus();
  const lookup = usePadronLookup();
  const tax = useTaxSettings();
  const [error, setError] = useState<string | null>(null);
  const valid = canVerifyDocument(docType, docNumber);
  const digits = String(docNumber ?? "").replace(/\D/g, "");

  // Otro documento: el resultado anterior ya no aplica.
  const reset = lookup.reset;
  useEffect(() => {
    reset();
    setError(null);
  }, [digits, reset]);

  const label = verificationLabel(verification ?? null, verifiedAt);
  const available = status.data?.available ?? false;

  async function run(refresh = false) {
    setError(null);
    try {
      const r = await lookup.mutateAsync({ cuit: digits, refresh });
      if (!r.ok) setError(padronErrorMessage(r.error, { scope: r.scope, reason: r.reason }));
      else if (r.status === "no_encontrado") setError(padronErrorMessage("no_encontrado"));
    } catch {
      setError(padronErrorMessage(null));
    }
  }

  const data = lookup.data && lookup.data.ok && lookup.data.status === "ok" ? lookup.data : null;
  const emitter = tax.data?.iva_condition ?? null;
  const letter = data ? inferLetter(emitter, data.persona.iva_condition, { issuesM: tax.data?.issues_cbte_m }) : null;

  if (!valid && !label) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {valid && available && (
          <Button type="button" variant="secondary" size="sm" loading={lookup.isPending} onClick={() => run(false)}>
            <SearchCheck size={15} aria-hidden /> Verificar en ARCA
          </Button>
        )}
        {label && (
          <Badge tone={verification === "padron" ? "success" : "neutral"}>
            {verification === "padron" && <BadgeCheck size={12} aria-hidden />} {label}
          </Badge>
        )}
      </div>
      {valid && !available && !status.isLoading && (
        <p className="text-xs text-muted-foreground">
          {status.data?.reason === "feature_not_in_plan"
            ? padronErrorMessage("feature_not_in_plan")
            : "La verificación en ARCA no está disponible ahora. Cargá la condición frente al IVA a mano."}
        </p>
      )}
      {error && (
        <Callout tone="warning" title="No pudimos verificar">
          {error}
        </Callout>
      )}
      {data && (
        <PadronResult
          persona={data.persona}
          fetchedAt={data.fetched_at}
          cached={data.cached}
          extra={
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              {letter ? (
                <Badge tone="info">Le vas a emitir Factura {letter}</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Cargá la condición frente al IVA de tu negocio para saber qué factura le corresponde.
                </span>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => run(true)} loading={lookup.isPending}>
                  <RefreshCw size={14} aria-hidden /> Volver a consultar
                </Button>
                <Button type="button" size="sm" onClick={() => onApply(data.persona)}>
                  Usar estos datos
                </Button>
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}
PadronVerify.displayName = "PadronVerify";
