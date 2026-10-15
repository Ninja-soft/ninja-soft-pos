"use client";

import { useEffect, useRef, useState } from "react";
import { BadgeCheck, Check, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PadronResult } from "@/components/arca/PadronResult";
import {
  jurisdictionFromProvince,
  padronErrorMessage,
  type PadronPersona,
} from "@/lib/customers/padron";
import { FISCAL_CONDITION_LABEL, isValidCuit, jurisdictionName, type FiscalCondition } from "@/lib/tax/catalog";
import { usePadronLookup, usePadronStatus } from "@/modules/padron/hooks";

/** Campos del negocio que puede completar el padrón. */
export type BrandingPadronField = "legal_name" | "iva_condition" | "address" | "activity_start" | "iibb_jurisdiction";

export interface BrandingPadronValues {
  legal_name: string | null;
  iva_condition: string | null;
  address: string | null;
  activity_start: string | null;
  iibb_jurisdiction: string | null;
}

/** Lo que ARCA propone para cada campo (null = no lo informa). */
export function brandingFromPadron(p: PadronPersona): BrandingPadronValues {
  const full = [p.domicilio_partes?.direccion, p.domicilio_partes?.localidad, p.provincia].filter(Boolean).join(", ");
  return {
    legal_name: p.razon_social || null,
    // El negocio emite como RI, monotributo o exento; "sin IVA" no es una condición de emisor.
    iva_condition: p.iva_condition === "consumidor_final" ? null : p.iva_condition,
    address: full || p.domicilio || null,
    activity_start: p.inicio_actividades ?? null,
    iibb_jurisdiction: jurisdictionFromProvince(p.domicilio_partes?.id_provincia ?? null, p.provincia),
  };
}

const LABELS: Record<BrandingPadronField, string> = {
  legal_name: "Razón social",
  iva_condition: "Condición frente al IVA",
  address: "Domicilio fiscal",
  activity_start: "Inicio de actividades",
  iibb_jurisdiction: "Jurisdicción de Ingresos Brutos",
};

function show(field: BrandingPadronField, v: string | null): string {
  if (!v) return "No lo informa";
  if (field === "iva_condition") return FISCAL_CONDITION_LABEL[v as FiscalCondition] ?? v;
  if (field === "iibb_jurisdiction") return jurisdictionName(v);
  if (field === "activity_start") {
    const [y, m] = v.split("-");
    return `${m}/${y} (aproximado)`;
  }
  return v;
}

// Configuración › Marca (ADR-133): al completar un CUIT válido trae solo los
// datos del negocio del padrón de ARCA y deja aceptarlos todos o campo por
// campo; todo sigue editable a mano. El origen "ARCA" lo confirma el servidor
// con la consulta real (trigger de tenant_branding).
export function BrandingPadron({
  cuit,
  current,
  onAccept,
  source,
  verifiedAt,
}: {
  cuit: string | null;
  current: BrandingPadronValues;
  /** Aplica los campos elegidos al formulario (verified = vienen de ARCA). */
  onAccept: (values: Partial<BrandingPadronValues>, persona: PadronPersona) => void;
  source: "padron" | "manual" | null;
  verifiedAt: string | null;
}) {
  const status = usePadronStatus();
  const lookup = usePadronLookup();
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const digits = String(cuit ?? "").replace(/\D/g, "");
  const valid = isValidCuit(digits);
  const available = status.data?.available ?? false;

  const run = async (refresh: boolean) => {
    setError(null);
    try {
      const r = await lookup.mutateAsync({ cuit: digits, refresh });
      if (!r.ok) setError(padronErrorMessage(r.error, { scope: r.scope, reason: r.reason }));
      else if (r.status === "no_encontrado") setError(padronErrorMessage("no_encontrado"));
    } catch {
      setError(padronErrorMessage(null));
    }
  };

  // Autoconsulta una vez por CUIT válido.
  const mutate = lookup.mutateAsync;
  useEffect(() => {
    if (!valid || !available || asked.current === digits) return;
    asked.current = digits;
    setError(null);
    void mutate({ cuit: digits, refresh: false })
      .then((r) => {
        if (!r.ok) setError(padronErrorMessage(r.error, { scope: r.scope, reason: r.reason }));
        else if (r.status === "no_encontrado") setError(padronErrorMessage("no_encontrado"));
      })
      .catch(() => setError(padronErrorMessage(null)));
  }, [digits, valid, available, mutate]);

  const data = lookup.data && lookup.data.ok && lookup.data.status === "ok" && asked.current === digits ? lookup.data : null;
  const proposal = data ? brandingFromPadron(data.persona) : null;
  const fields = (Object.keys(LABELS) as BrandingPadronField[]).filter((f) => proposal?.[f]);
  const pending = proposal ? fields.filter((f) => (proposal[f] ?? null) !== (current[f] ?? null)) : [];

  const sourceBadge =
    source === "padron" ? (
      <Badge tone="success">
        <BadgeCheck size={12} aria-hidden /> Datos de ARCA
        {verifiedAt
          ? ` del ${new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(verifiedAt))}`
          : ""}
      </Badge>
    ) : source === "manual" ? (
      <Badge tone="neutral">Cargados a mano</Badge>
    ) : null;

  if (!valid) return sourceBadge ? <div>{sourceBadge}</div> : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {sourceBadge}
        {available && (
          <Button type="button" variant="ghost" size="sm" loading={lookup.isPending} onClick={() => run(true)}>
            <RefreshCw size={14} aria-hidden /> Volver a consultar
          </Button>
        )}
      </div>
      {!available && !status.isLoading && (
        <p className="text-xs text-muted-foreground">
          La consulta automática a ARCA no está disponible ahora: completá los datos a mano.
        </p>
      )}
      {error && <Callout tone="warning" title="No pudimos traer tus datos de ARCA">{error}</Callout>}
      {data && proposal && (
        <PadronResult
          persona={data.persona}
          fetchedAt={data.fetched_at}
          cached={data.cached}
          extra={
            <div className="space-y-2 pt-1">
              {pending.length > 0 ? (
                <>
                  <ul className="divide-y divide-border rounded-lg bg-background">
                    {pending.map((f) => (
                      <li key={f} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                        <span className="min-w-0">
                          <span className="block text-muted-foreground">{LABELS[f]}</span>
                          <span className="block font-medium">{show(f, proposal[f])}</span>
                        </span>
                        <Button type="button" variant="ghost" size="sm" onClick={() => onAccept({ [f]: proposal[f] }, data.persona)}>
                          Usar
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onAccept(Object.fromEntries(pending.map((f) => [f, proposal[f]])), data.persona)}
                  >
                    <Check size={14} aria-hidden /> Usar todo
                  </Button>
                </>
              ) : (
                <p className="text-[13px] text-success">Tus datos coinciden con los de ARCA.</p>
              )}
              <p className="text-xs text-muted-foreground">
                ARCA no informa el número de Ingresos Brutos ni si estás en Convenio Multilateral: cargalos a mano. El inicio de
                actividades es aproximado (alta del primer impuesto): confirmalo con tu constancia.
              </p>
            </div>
          }
        />
      )}
    </div>
  );
}
BrandingPadron.displayName = "BrandingPadron";
