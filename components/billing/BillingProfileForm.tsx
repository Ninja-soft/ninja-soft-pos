"use client";

import { useState } from "react";
import { AlertTriangle, Building2, Check, Info, Search, ShieldCheck, UserRound } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import {
  billingProfileError,
  checkCuit,
  formatCuit,
  type CompanyFiscal,
  type HolderType,
} from "@/lib/billing/fiscalProfile";
import {
  conditionLabel,
  letterExplanation,
  letterTitle,
  platformLetter,
  RECEPTOR_CONDITIONS,
  type PlatformLetterStatus,
} from "@/lib/billing/letter";
import { normalizeDigits } from "@/lib/tax/catalog";
import type {
  EffectiveProfile,
  PadronAvailability,
  PadronLookupResult,
  PadronPersona,
  ProfileInput,
  ProfileRow,
} from "@/modules/fiscalProfile/api";

// Formulario "¿A nombre de quién querés tu factura?" (F20-3 · spec §8.1).
// Lo usan el panel del dueño y el detalle del negocio en internal. Es
// controlado: el padre guarda. La base decide la verificación: el formulario
// sólo pide "usar lo que trajo ARCA" (use_padron) después de una consulta.

export interface BillingFormState {
  mode: "company" | "other";
  holderType: HolderType;
  docTipo: 80 | 86 | 96;
  docNro: string;
  razonSocial: string;
  ivaCondition: string;
  domicilio: string;
  email: string;
  /** Datos traídos de ARCA para el CUIT actual (se guardan con use_padron). */
  padron: PadronPersona | null;
}

export function initialFormState(current: ProfileRow | null, effective: EffectiveProfile | null): BillingFormState {
  const other = current && !current.use_company_data;
  return {
    mode: other ? "other" : "company",
    holderType: (other && current?.holder_type) || "empresa",
    docTipo: (other && (current?.doc_tipo as 80 | 86 | 96)) || 80,
    docNro: other && current?.doc_nro ? (current.doc_tipo === 96 ? current.doc_nro : formatCuit(current.doc_nro)) : "",
    razonSocial: (other && current?.razon_social) || "",
    ivaCondition: (other && current?.iva_condition) || "",
    domicilio: (other && current?.domicilio) || "",
    email: current?.email_facturacion ?? (effective?.email_is_default ? "" : (effective?.email ?? "")),
    padron: null,
  };
}

export function formToInput(s: BillingFormState): ProfileInput {
  const email = s.email.trim() || null;
  if (s.mode === "company") return { use_company_data: true, email_facturacion: email, use_padron: Boolean(s.padron) };
  const docTipo = s.holderType === "empresa" ? 80 : s.docTipo;
  return {
    use_company_data: false,
    holder_type: s.holderType,
    doc_tipo: docTipo,
    doc_nro: normalizeDigits(s.docNro),
    razon_social: s.padron?.razon_social ?? s.razonSocial.trim(),
    iva_condition: docTipo === 96 ? "consumidor_final" : (s.padron?.iva_condition ?? s.ivaCondition),
    domicilio: s.padron?.domicilio ?? (s.domicilio.trim() || null),
    email_facturacion: email,
    use_padron: Boolean(s.padron),
  };
}

/** Problemas que impiden guardar (null = se puede). */
export function formProblem(s: BillingFormState): string | null {
  if (s.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email.trim())) return "El email no es válido.";
  if (s.mode === "company") return null;
  const docTipo = s.holderType === "empresa" ? 80 : s.docTipo;
  if (docTipo === 96) {
    if (!/^\d{7,8}$/.test(normalizeDigits(s.docNro))) return "El DNI tiene que tener 7 u 8 números.";
  } else if (checkCuit(s.docNro) !== "ok") {
    return "Completá un CUIT válido.";
  }
  if (s.padron) return null;
  if (!s.razonSocial.trim()) return s.holderType === "empresa" ? "Completá la razón social." : "Completá el nombre y apellido.";
  if (docTipo !== 96 && !s.ivaCondition) return "Elegí la condición frente al IVA.";
  return null;
}

/** Datos que van a salir en la factura con lo que hay en el formulario. */
export function formPreview(
  s: BillingFormState,
  company: CompanyFiscal | null,
  issuerCondition: string | null,
): { name: string | null; doc: string | null; cond: string | null; letter: string | null; status: PlatformLetterStatus; fallbackCf: boolean } {
  if (s.mode === "company") {
    const cuit = company?.cuit ?? null;
    if (!cuit) {
      const l = platformLetter(issuerCondition, "consumidor_final");
      return { name: company?.razon_social ?? null, doc: null, cond: "consumidor_final", letter: l.letter, status: l.status, fallbackCf: true };
    }
    const cond = s.padron?.iva_condition ?? company?.iva_condition ?? null;
    const l = platformLetter(issuerCondition, cond);
    return {
      name: s.padron?.razon_social ?? company?.razon_social ?? null,
      doc: `CUIT ${formatCuit(cuit)}`,
      cond,
      letter: l.letter,
      status: l.status,
      fallbackCf: false,
    };
  }
  const docTipo = s.holderType === "empresa" ? 80 : s.docTipo;
  const cond = docTipo === 96 ? "consumidor_final" : s.padron?.iva_condition ?? (s.ivaCondition || null);
  const l = platformLetter(issuerCondition, cond);
  const digits = normalizeDigits(s.docNro);
  return {
    name: s.padron?.razon_social ?? (s.razonSocial.trim() || null),
    doc: digits ? `${docTipo === 96 ? "DNI" : docTipo === 86 ? "CUIL" : "CUIT"} ${docTipo === 96 ? digits : formatCuit(digits)}` : null,
    cond,
    letter: l.letter,
    status: l.status,
    fallbackCf: false,
  };
}

/** Recuadro de la letra, como en una factura impresa. */
export function LetterBox({ letter, status, size = "md" }: { letter: string | null; status: PlatformLetterStatus; size?: "sm" | "md" }) {
  const pending = status !== "ok" || !letter;
  return (
    <span
      aria-label={pending ? "Letra pendiente" : `Letra ${letter}`}
      className={cn(
        "grid shrink-0 place-items-center rounded-lg border-2 border-foreground/80 bg-card font-display font-bold leading-none text-foreground",
        size === "md" ? "h-14 w-14 text-3xl" : "h-9 w-9 text-lg",
        pending && "border-dashed border-muted-foreground/60 text-muted-foreground",
      )}
    >
      {pending ? "?" : letter}
    </span>
  );
}

export function VerificationBadge({ verification }: { verification: string }) {
  if (verification === "padron")
    return (
      <Badge tone="success">
        <ShieldCheck size={12} aria-hidden /> Verificado en ARCA
      </Badge>
    );
  if (verification === "staff")
    return (
      <Badge tone="success">
        <Check size={12} aria-hidden /> Verificado por NinjaSoft
      </Badge>
    );
  return <Badge tone="warning">Sin verificar</Badge>;
}

const PADRON_UNAVAILABLE: Record<string, string> = {
  certificate_missing:
    "La verificación automática con ARCA todavía no está disponible: NinjaSoft está terminando de configurar su certificado. Podés cargar los datos a mano; quedan como \"sin verificar\" y los revisamos.",
  issuer_missing: "La verificación automática con ARCA todavía no está disponible. Podés cargar los datos a mano.",
  disabled: "La verificación automática con ARCA está pausada. Podés cargar los datos a mano.",
};

export function BillingProfileForm({
  value,
  onChange,
  company,
  ownerEmail,
  padron,
  issuerCondition,
  lookup,
  disabled,
}: {
  value: BillingFormState;
  onChange: (next: BillingFormState) => void;
  company: CompanyFiscal | null;
  ownerEmail: string | null;
  padron: PadronAvailability;
  issuerCondition: string | null;
  lookup: (cuit: string) => Promise<PadronLookupResult>;
  disabled?: boolean;
}) {
  const s = value;
  const set = (patch: Partial<BillingFormState>) => onChange({ ...s, ...patch });
  const [lookupMsg, setLookupMsg] = useState<{ tone: "warning" | "danger" | "info"; text: string } | null>(null);
  const [looking, setLooking] = useState(false);

  const docTipo = s.holderType === "empresa" ? 80 : s.docTipo;
  const cuitState = docTipo === 96 ? "ok" : checkCuit(s.docNro);
  const preview = formPreview(s, company, issuerCondition);

  const runLookup = async (cuit: string) => {
    setLookupMsg(null);
    if (!padron.available) {
      setLookupMsg({ tone: "info", text: PADRON_UNAVAILABLE[padron.reason ?? "certificate_missing"] ?? PADRON_UNAVAILABLE.certificate_missing! });
      return;
    }
    setLooking(true);
    try {
      const r = await lookup(cuit);
      if (r.ok && r.status === "ok") {
        onChange({ ...s, padron: r.persona });
        if (!r.persona.activa) setLookupMsg({ tone: "warning", text: `ARCA informa la CUIT como ${r.persona.estado_clave ?? "inactiva"}.` });
      } else if (r.ok && r.status === "no_encontrado") {
        setLookupMsg({ tone: "warning", text: "La CUIT no figura en el padrón de ARCA. Revisala o cargá los datos a mano." });
      } else if (!r.ok && r.error === "platform_not_configured") {
        setLookupMsg({ tone: "info", text: PADRON_UNAVAILABLE[r.reason ?? "certificate_missing"] ?? PADRON_UNAVAILABLE.certificate_missing! });
      } else {
        setLookupMsg({ tone: "danger", text: !r.ok && r.error === "padron_error" ? "ARCA no respondió. Probá de nuevo o cargá los datos a mano." : billingProfileError(!r.ok ? r.error : "") });
      }
    } catch (e) {
      setLookupMsg({ tone: "danger", text: billingProfileError(e) });
    } finally {
      setLooking(false);
    }
  };

  const companyCuit = company?.cuit ?? null;

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="A nombre de quién" className="grid gap-3 sm:grid-cols-2">
        <ChoiceCard
          selected={s.mode === "company"}
          disabled={disabled}
          onClick={() => set({ mode: "company", padron: null })}
          icon={<Building2 size={18} />}
          title="Los datos de mi negocio"
          description="La razón social, el CUIT y la condición frente al IVA que ya cargaste."
        />
        <ChoiceCard
          selected={s.mode === "other"}
          disabled={disabled}
          onClick={() => set({ mode: "other", padron: null })}
          icon={<UserRound size={18} />}
          title="Otro titular"
          description="Otra empresa (tu sociedad, un estudio contable) o una persona."
        />
      </div>

      {s.mode === "company" ? (
        <div className="rounded-xl bg-muted/50 p-4">
          {companyCuit ? (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Field label="Razón social" value={s.padron?.razon_social ?? company?.razon_social} />
              <Field label="CUIT" value={formatCuit(companyCuit)} />
              <Field label="Condición frente al IVA" value={conditionLabel(s.padron?.iva_condition ?? company?.iva_condition)} warn={!(s.padron?.iva_condition ?? company?.iva_condition)} />
              <Field label="Domicilio" value={s.padron?.domicilio ?? company?.domicilio} />
            </dl>
          ) : (
            <Callout tone="warning" icon={AlertTriangle} title="Tu negocio no tiene CUIT cargado">
              Mientras tanto la factura sale a consumidor final. Cargá el CUIT en Configuración, en Impuestos o en Marca, o elegí otro titular.
            </Callout>
          )}
          {companyCuit && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {s.padron ? (
                <Badge tone="success">
                  <ShieldCheck size={12} aria-hidden /> Datos de ARCA
                </Badge>
              ) : (
                <Button size="sm" variant="secondary" loading={looking} disabled={disabled} onClick={() => runLookup(companyCuit)}>
                  <Search size={15} aria-hidden /> Verificar en ARCA
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Segmented
            aria-label="Tipo de titular"
            value={s.holderType}
            onChange={(v) => set({ holderType: v, docTipo: v === "empresa" ? 80 : s.docTipo === 80 ? 80 : s.docTipo, padron: null })}
            options={[
              { value: "empresa", label: "Empresa" },
              { value: "persona", label: "Persona" },
            ]}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:max-w-md sm:flex-row sm:items-start">
              {s.holderType === "persona" && (
                <Segmented
                  aria-label="Documento"
                  className="shrink-0 self-start sm:mt-7"
                  value={String(s.docTipo) as "80" | "86" | "96"}
                  onChange={(v) => set({ docTipo: Number(v) as 80 | 86 | 96, padron: null })}
                  options={[
                    { value: "80", label: "CUIT" },
                    { value: "86", label: "CUIL" },
                    { value: "96", label: "DNI" },
                  ]}
                />
              )}
              <Input
                label={docTipo === 96 ? "DNI" : docTipo === 86 ? "CUIL" : "CUIT"}
                inputMode="numeric"
                autoComplete="off"
                placeholder={docTipo === 96 ? "12345678" : "30-12345678-9"}
                value={s.docNro}
                disabled={disabled}
                onChange={(e) => set({ docNro: e.target.value, padron: null })}
                error={
                  docTipo !== 96 && cuitState === "invalid"
                    ? "El dígito verificador no coincide: revisá el número."
                    : undefined
                }
                hint={docTipo !== 96 && cuitState === "ok" ? "Dígito verificador correcto." : undefined}
              />
            </div>
            {docTipo !== 96 && (
              <Button
                variant="secondary"
                className="sm:mt-7"
                loading={looking}
                disabled={disabled || cuitState !== "ok"}
                onClick={() => runLookup(normalizeDigits(s.docNro))}
              >
                <Search size={15} aria-hidden /> Buscar en ARCA
              </Button>
            )}
          </div>

          {s.padron ? (
            <div className="rounded-xl bg-muted/50 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <Badge tone="success">
                  <ShieldCheck size={12} aria-hidden /> Datos de ARCA
                </Badge>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set({ padron: null })}>
                  Cargar a mano
                </Button>
              </div>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Field label={s.holderType === "empresa" ? "Razón social" : "Nombre"} value={s.padron.razon_social} />
                <Field label="Condición frente al IVA" value={conditionLabel(s.padron.iva_condition)} />
                <Field label="Domicilio fiscal" value={s.padron.domicilio} />
                <Field label="Estado de la CUIT" value={s.padron.estado_clave ?? "Sin datos"} />
              </dl>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={s.holderType === "empresa" ? "Razón social" : "Nombre y apellido"}
                value={s.razonSocial}
                maxLength={200}
                disabled={disabled}
                onChange={(e) => set({ razonSocial: e.target.value })}
              />
              {docTipo === 96 ? (
                <Input label="Condición frente al IVA" value="Consumidor final" disabled readOnly />
              ) : (
                <Select
                  label="Condición frente al IVA"
                  value={s.ivaCondition || null}
                  placeholder="Elegí la condición"
                  disabled={disabled}
                  onChange={(v) => set({ ivaCondition: v })}
                  options={RECEPTOR_CONDITIONS.map((c) => ({ value: c, label: conditionLabel(c) }))}
                />
              )}
              <div className="sm:col-span-2">
                <Input
                  label="Domicilio (opcional)"
                  value={s.domicilio}
                  maxLength={300}
                  disabled={disabled}
                  onChange={(e) => set({ domicilio: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {lookupMsg && (
        <Callout tone={lookupMsg.tone} icon={lookupMsg.tone === "info" ? Info : AlertTriangle}>
          {lookupMsg.text}
        </Callout>
      )}

      <Input
        label="Email de facturación"
        type="email"
        autoComplete="email"
        placeholder={ownerEmail ?? "facturas@tuempresa.com"}
        value={s.email}
        disabled={disabled}
        onChange={(e) => set({ email: e.target.value })}
        hint={`A esta dirección te llegan las facturas y los avisos de cobro.${ownerEmail ? ` Si lo dejás vacío, usamos ${ownerEmail}.` : ""}`}
      />

      <div className="flex items-start gap-4 rounded-xl bg-muted/50 p-4" aria-live="polite">
        <LetterBox letter={preview.letter} status={preview.status} />
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Vas a recibir</p>
          <p className="mt-0.5 font-semibold text-foreground">
            {letterTitle({ status: preview.status, letter: preview.letter })}
            {preview.name ? ` a nombre de ${preview.name}` : ""}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[preview.doc, preview.cond ? conditionLabel(preview.cond) : null].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {letterExplanation({ status: preview.status, letter: preview.letter })}
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono, warn }: { label: string; value: string | null | undefined; mono?: boolean; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words font-medium text-foreground", mono && "tabular-nums", warn && "text-warning")}>
        {value || "Sin cargar"}
      </dd>
    </div>
  );
}
