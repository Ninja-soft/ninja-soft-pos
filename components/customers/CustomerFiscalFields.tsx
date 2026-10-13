"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { JURISDICTIONS, documentError, jurisdictionName } from "@/lib/tax/catalog";
import { inferLetter } from "@/lib/tax/comprobante";
import { taxErrorMessage, type RegimeTax } from "@/modules/tax/api";
import { useExemptionMutations, useExemptions, usePadronLookup, useTaxSettings } from "@/modules/tax/hooks";

// Ficha del cliente · Datos fiscales (F18 · H104, ADR-068): jurisdicción de
// IIBB, comprobante que le corresponde, alícuotas del padrón cargado y
// certificados de exclusión (con percepciones_retenciones).

const TAX_LABEL: Record<RegimeTax, string> = { iva: "IVA", iibb: "IIBB", ganancias: "Ganancias", suss: "SUSS" };

export function CustomerFiscalFields({
  customerId,
  docType,
  docNumber,
  ivaCondition,
  jurisdiction,
  onJurisdiction,
  selectCls,
}: {
  customerId: string | null;
  docType: string | null | undefined;
  docNumber: string | null | undefined;
  ivaCondition: string | null | undefined;
  jurisdiction: string | null | undefined;
  onJurisdiction: (v: string) => void;
  selectCls: string;
}) {
  const settings = useTaxSettings();
  const perc = Boolean(settings.data?.features.percepciones);
  const isCuit = (docType === "cuit" || docType === "cuil") && !documentError(docType, docNumber);
  const padron = usePadronLookup(isCuit ? (docNumber ?? null) : null, perc);
  const letter = inferLetter(settings.data?.iva_condition ?? null, ivaCondition || null, {
    issuesM: settings.data?.issues_cbte_m,
  });
  const needsCuit = (letter === "A" || letter === "M") && !isCuit;

  return (
    <div className="space-y-3 rounded-lg bg-muted/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Datos fiscales</p>
        {letter && (
          <Badge tone={needsCuit ? "warning" : "neutral"}>
            Le corresponde factura {letter}
            {needsCuit ? " · falta CUIT" : ""}
          </Badge>
        )}
      </div>
      <div>
        <label className="mb-2 block text-sm font-medium text-muted-foreground">Jurisdicción de IIBB</label>
        <select className={selectCls} value={jurisdiction ?? ""} onChange={(e) => onJurisdiction(e.target.value)}>
          <option value="">Sin especificar</option>
          {JURISDICTIONS.map((j) => (
            <option key={j.code} value={j.code} className="bg-popover text-popover-foreground">
              {j.name}
            </option>
          ))}
        </select>
      </div>
      {perc && isCuit && (padron.data ?? []).length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-muted-foreground">
          {(padron.data ?? []).map((p) => (
            <li key={p.jurisdiction}>
              Padrón {p.name}: percepción {p.perception_rate ?? "–"} % · retención {p.retention_rate ?? "–"} %
            </li>
          ))}
        </ul>
      )}
      {perc && customerId && <Exemptions customerId={customerId} />}
    </div>
  );
}

function Exemptions({ customerId }: { customerId: string }) {
  const q = useExemptions("customer", customerId);
  const { add, remove } = useExemptionMutations("customer", customerId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [tax, setTax] = useState<RegimeTax>("iibb");
  const [jur, setJur] = useState("902");
  const [pct, setPct] = useState("100");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState("");
  const [cert, setCert] = useState("");
  const sel = "h-10 w-full rounded-lg border border-border bg-background px-2 text-sm";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-muted-foreground">Exclusiones (certificados)</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          <Plus size={14} /> Agregar
        </Button>
      </div>
      {(q.data ?? []).map((e) => (
        <div key={e.id} className="flex items-center justify-between gap-2 text-[13px]">
          <span>
            {TAX_LABEL[e.tax]}
            {e.jurisdiction ? ` ${jurisdictionName(e.jurisdiction)}` : ""} · {e.pct} % · desde {e.valid_from}
            {e.valid_to ? ` hasta ${e.valid_to}` : ""}
            {e.certificate ? ` · cert. ${e.certificate}` : ""}
          </span>
          <Button type="button" variant="ghost" size="sm" aria-label="Quitar" onClick={() => remove.mutate(e.id)}>
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      {open && (
        <div className="grid gap-2 sm:grid-cols-3">
          <select className={sel} value={tax} onChange={(e) => setTax(e.target.value as RegimeTax)} aria-label="Impuesto">
            {(Object.keys(TAX_LABEL) as RegimeTax[]).map((t) => (
              <option key={t} value={t}>
                {TAX_LABEL[t]}
              </option>
            ))}
          </select>
          {tax === "iibb" ? (
            <select className={sel} value={jur} onChange={(e) => setJur(e.target.value)} aria-label="Jurisdicción">
              {JURISDICTIONS.map((j) => (
                <option key={j.code} value={j.code}>
                  {j.name}
                </option>
              ))}
            </select>
          ) : (
            <span />
          )}
          <Input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" aria-label="Porcentaje" placeholder="%" />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
          <Input value={cert} onChange={(e) => setCert(e.target.value)} placeholder="N° de certificado" />
          <Button
            type="button"
            size="sm"
            className="sm:col-span-3"
            loading={add.isPending}
            onClick={() =>
              add.mutate(
                {
                  party: "customer",
                  party_id: customerId,
                  tax,
                  jurisdiction: tax === "iibb" ? jur : null,
                  pct: Number(pct.replace(",", ".")) || 100,
                  valid_from: from,
                  valid_to: to || null,
                  certificate: cert.trim() || null,
                },
                {
                  onSuccess: () => setOpen(false),
                  onError: (e) => toast({ title: "No se guardó", description: taxErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            Guardar exclusión
          </Button>
        </div>
      )}
    </div>
  );
}
