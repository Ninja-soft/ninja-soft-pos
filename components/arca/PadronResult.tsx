"use client";

import { useState } from "react";
import { AlertTriangle, Building2, CalendarClock, MapPin, User } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { padronConditionLabel, type PadronPersona } from "@/lib/customers/padron";
import { formatCuit } from "@/lib/arca/certUpload";

// Respuesta del padrón de ARCA en criollo (ADR-133). La usan el alta de
// clientes, Configuración › Marca y la prueba del panel interno.
// Encabezado con nombre, CUIT y estados; datos en grilla (se apila en
// mobile); actividades con la principal destacada; avisos de ARCA.

const IVA_BADGE: Record<PadronPersona["iva_condition"], { label: string; tone: BadgeTone }> = {
  responsable_inscripto: { label: "Responsable inscripto", tone: "info" },
  monotributo: { label: "Monotributo", tone: "info" },
  exento: { label: "Exento de IVA", tone: "info" },
  consumidor_final: { label: "Sin IVA ni monotributo", tone: "neutral" },
};

const VISIBLE_ACTS = 4;

/** "2015-03-01" → "03/2015". */
function monthYear(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[2]}/${m[1]}` : null;
}

function fullDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Domicilio fiscal completo: calle, localidad, provincia (CP). */
export function padronFullAddress(p: Pick<PadronPersona, "domicilio" | "domicilio_partes" | "provincia">): string | null {
  const d = p.domicilio_partes;
  const parts = d
    ? [d.direccion, d.localidad, d.provincia ?? p.provincia]
    : [p.domicilio, p.provincia];
  const clean = parts.map((x) => (x ?? "").trim()).filter(Boolean);
  // Sin repetir la localidad cuando es igual a la provincia (CABA).
  const unique = clean.filter((x, i) => clean.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  if (unique.length === 0) return null;
  const cp = d?.cod_postal?.trim();
  return `${unique.join(", ")}${cp ? ` (CP ${cp})` : ""}`;
}

function Field({ label, icon: Icon, children, wide }: { label: string; icon?: typeof User; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon size={13} aria-hidden />}
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

export function PadronResult({
  persona,
  fetchedAt,
  cached,
  extra,
}: {
  persona: PadronPersona;
  fetchedAt?: string | null;
  cached?: boolean;
  /** Fila extra (p. ej. "Le vas a emitir Factura A"). */
  extra?: React.ReactNode;
}) {
  const [allActs, setAllActs] = useState(false);
  const acts = [...(persona.actividades ?? [])].sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99));
  const shownActs = allActs ? acts : acts.slice(0, VISIBLE_ACTS);
  const iva = IVA_BADGE[persona.iva_condition] ?? IVA_BADGE.consumidor_final;
  const address = padronFullAddress(persona);
  const start = monthYear(persona.inicio_actividades);
  const contract = fullDate(persona.fecha_contrato_social);
  const juridica = persona.tipo_persona === "JURIDICA";
  const when = fetchedAt
    ? new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(fetchedAt))
    : null;

  return (
    <div className="space-y-4 rounded-lg bg-muted/50 p-3 text-sm sm:p-4" data-testid="padron-result">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
          {juridica ? <Building2 size={18} /> : <User size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-base font-semibold leading-snug text-foreground">{persona.razon_social || "Sin nombre en ARCA"}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">CUIT {formatCuit(persona.cuit)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {persona.activa ? (
              <Badge tone="success">CUIT activa</Badge>
            ) : (
              <Badge tone="danger">CUIT {persona.estado_clave?.toLowerCase() || "inactiva"}</Badge>
            )}
            <Badge tone={iva.tone}>{iva.label}</Badge>
            {persona.iva_condition === "monotributo" && persona.monotributo_categoria && (
              <Badge tone="neutral">Categoría {persona.monotributo_categoria}</Badge>
            )}
          </div>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="Tipo de persona">{juridica ? "Persona jurídica (empresa o entidad)" : persona.tipo_persona === "FISICA" ? "Persona humana" : "Sin dato"}</Field>
        <Field label="Condición frente al IVA">{padronConditionLabel(persona)}</Field>
        <Field label="Domicilio fiscal" icon={MapPin} wide>
          {address ?? "ARCA no informa el domicilio"}
        </Field>
        <Field label="Inicio de actividades" icon={CalendarClock}>
          {start ? (
            <>
              {start} <span className="text-muted-foreground">(aproximado)</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                ARCA no lo informa: sale del alta más vieja de sus impuestos activos.
              </span>
            </>
          ) : (
            "ARCA no lo informa"
          )}
        </Field>
        {contract && <Field label="Contrato social">{contract}</Field>}
      </dl>

      {acts.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">Actividades ({acts.length})</p>
          <ul className="mt-1.5 space-y-1.5">
            {shownActs.map((a, i) => (
              <li key={`${a.id}-${a.descripcion}`} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[13px]">
                <span className={i === 0 ? "min-w-0 flex-1 break-words font-medium text-foreground" : "min-w-0 flex-1 break-words text-foreground"}>
                  {a.descripcion}
                  {a.id && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{a.id}</span>}
                </span>
                {i === 0 && <Badge tone="brand">Principal</Badge>}
              </li>
            ))}
          </ul>
          {acts.length > VISIBLE_ACTS && (
            <button
              type="button"
              onClick={() => setAllActs((v) => !v)}
              className="mt-1.5 text-xs font-medium text-ninja-flameSoft hover:underline"
            >
              {allActs ? "Ver menos" : acts.length - VISIBLE_ACTS === 1 ? "Ver 1 más" : `Ver las ${acts.length - VISIBLE_ACTS} restantes`}
            </button>
          )}
        </div>
      )}

      {persona.avisos.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-warning/10 p-2.5 text-[13px]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 break-words text-muted-foreground">
            <span className="font-medium text-foreground">ARCA avisa:</span> {persona.avisos.join(" · ")}
          </p>
        </div>
      )}

      {extra}

      {when && (
        <p className="text-xs text-muted-foreground">
          Dato de ARCA del {when}
          {cached ? " (guardado, sin volver a consultar)" : ""}
        </p>
      )}
    </div>
  );
}
PadronResult.displayName = "PadronResult";
