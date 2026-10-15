"use client";

import { Badge } from "@/components/ui/Badge";
import {
  padronAddress,
  padronConditionLabel,
  personTypeLabel,
  type PadronPersona,
} from "@/lib/customers/padron";

// Respuesta del padrón de ARCA en criollo (ADR-133). La usan el alta de
// clientes, Configuración › Marca y la prueba del panel interno.
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
  const acts = persona.actividades ?? [];
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
    <div className="space-y-2 rounded-lg bg-muted/60 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 font-semibold text-foreground">{persona.razon_social || "Sin nombre"}</p>
        {persona.activa ? <Badge tone="success">CUIT activa</Badge> : <Badge tone="danger">CUIT {persona.estado_clave?.toLowerCase() || "inactiva"}</Badge>}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Tipo</dt>
        <dd>{personTypeLabel(persona.tipo_persona)}</dd>
        <dt className="text-muted-foreground">Frente al IVA</dt>
        <dd>{padronConditionLabel(persona)}</dd>
        <dt className="text-muted-foreground">Domicilio fiscal</dt>
        <dd>{[padronAddress(persona), persona.provincia].filter(Boolean).join(", ") || "Sin dato"}</dd>
        {acts.length > 0 && (
          <>
            <dt className="text-muted-foreground">Actividades</dt>
            <dd>
              <ul className="space-y-0.5">
                {acts.slice(0, 3).map((a) => (
                  <li key={`${a.id}-${a.descripcion}`} className="truncate">
                    {a.descripcion}
                  </li>
                ))}
                {acts.length > 3 && <li className="text-muted-foreground">y {acts.length - 3} más</li>}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {persona.avisos.length > 0 && (
        <p className="text-[13px] text-warning">ARCA avisa: {persona.avisos.join(" · ")}</p>
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
