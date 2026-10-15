"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { formatInt } from "@/lib/utils/format";
import { formatCuit } from "@/lib/arca/certUpload";
import { useInternalPadronMutations } from "@/modules/padron/hooks";
import type { PadronInternal } from "@/modules/padron/api";
import { ARCA_CERT_ENV } from "./env";

const fmtWhen = (iso: string) =>
  new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-base font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

// Pestaña "Configuración": encendido del padrón para los negocios, días de
// cache, cupos y uso (lo que antes era la tarjeta "Padrón de ARCA para los
// negocios"). Sólo super_admin cambia, con motivo (queda en la auditoría).
// Guardar siempre deja el padrón en producción (ARCA_CERT_ENV).
export function PadronConfigTab({ data, canEdit }: { data: PadronInternal; canEdit: boolean }) {
  const m = useInternalPadronMutations();
  const { toast } = useToast();
  const cfg = data.config;
  const [enabled, setEnabled] = useState(cfg.enabled);
  const [cacheDays, setCacheDays] = useState(String(cfg.cache_days));
  const [perHour, setPerHour] = useState(String(cfg.tenant_per_hour));
  const [perDay, setPerDay] = useState(String(cfg.tenant_per_day));
  const [globalHour, setGlobalHour] = useState(String(cfg.global_per_hour));
  const [reason, setReason] = useState("");

  useEffect(() => {
    setEnabled(cfg.enabled);
    setCacheDays(String(cfg.cache_days));
    setPerHour(String(cfg.tenant_per_hour));
    setPerDay(String(cfg.tenant_per_day));
    setGlobalHour(String(cfg.global_per_hour));
  }, [cfg]);

  const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  const nums = {
    cache_days: int(cacheDays),
    tenant_per_hour: int(perHour),
    tenant_per_day: int(perDay),
    global_per_hour: int(globalHour),
  };
  const errs = {
    cache_days: nums.cache_days >= 1 && nums.cache_days <= 30 ? null : "Entre 1 y 30 días.",
    tenant_per_hour: nums.tenant_per_hour >= 1 ? null : "Al menos 1.",
    tenant_per_day: nums.tenant_per_day >= 1 ? null : "Al menos 1.",
    global_per_hour: nums.global_per_hour >= 1 ? null : "Al menos 1.",
  };
  const numsOk = Object.values(errs).every((e) => e === null);
  const envChanges = cfg.environment !== ARCA_CERT_ENV;
  const dirty =
    envChanges ||
    enabled !== cfg.enabled ||
    nums.cache_days !== cfg.cache_days ||
    nums.tenant_per_hour !== cfg.tenant_per_hour ||
    nums.tenant_per_day !== cfg.tenant_per_day ||
    nums.global_per_hour !== cfg.global_per_hour;
  const cert = data.certificates[ARCA_CERT_ENV];
  const u = data.usage;

  const save = async () => {
    try {
      await m.save.mutateAsync({ p: { environment: ARCA_CERT_ENV, enabled, ...nums }, reason: reason.trim() });
      setReason("");
      toast({ title: "Configuración del padrón guardada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  };

  return (
    <div className="space-y-6">
      {envChanges && (
        <Callout tone="warning" icon={Info} title="El padrón apunta a homologación">
          Desde acá se usa sólo producción: al guardar, el padrón pasa a consultar ARCA en producción con el certificado de arriba.
        </Callout>
      )}

      <Section title="Padrón para los negocios">
        <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/50 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Activo para todos los negocios</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Apagado, los negocios cargan los datos de sus clientes a mano. La prueba con un CUIT funciona igual.
            </p>
            {enabled && !cert?.ready && (
              <p className="mt-1 text-[13px] text-warning">Falta un certificado vigente: hasta cargarlo, los negocios siguen con carga manual.</p>
            )}
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} label="Activo para todos los negocios" />
        </div>
        {cert?.cuit && (
          <p className="text-xs text-muted-foreground">
            Consulta como CUIT {formatCuit(cert.cuit)} (la del certificado).
          </p>
        )}
      </Section>

      <Section title="Cache y cupos" description="Lo que se guarda de cada CUIT y cuántas consultas llegan a ARCA.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Días que se guarda cada CUIT"
            inputMode="numeric"
            value={cacheDays}
            onChange={(e) => setCacheDays(e.target.value)}
            hint="De 1 a 30. Mientras dure, no se vuelve a preguntar a ARCA."
            error={errs.cache_days ?? undefined}
            disabled={!canEdit}
          />
          <Input
            label="Consultas por hora en total"
            inputMode="numeric"
            value={globalHour}
            onChange={(e) => setGlobalHour(e.target.value)}
            hint="Entre todos los negocios."
            error={errs.global_per_hour ?? undefined}
            disabled={!canEdit}
          />
          <Input
            label="Consultas por hora por negocio"
            inputMode="numeric"
            value={perHour}
            onChange={(e) => setPerHour(e.target.value)}
            error={errs.tenant_per_hour ?? undefined}
            disabled={!canEdit}
          />
          <Input
            label="Consultas por día por negocio"
            inputMode="numeric"
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
            hint="El día corta a medianoche de Argentina."
            error={errs.tenant_per_day ?? undefined}
            disabled={!canEdit}
          />
        </div>
      </Section>

      {canEdit ? (
        <div className="space-y-3 rounded-lg bg-muted/50 p-3">
          <Input
            label="Motivo del cambio"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: activar el padrón en producción"
            hint="Queda en la auditoría."
          />
          <div className="flex justify-end">
            <Button onClick={save} loading={m.save.isPending} disabled={!dirty || !numsOk || reason.trim().length < 3} className="w-full sm:w-auto">
              Guardar configuración
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Sólo un super admin puede cambiar esta configuración.</p>
      )}

      <Section title="Uso" description="Consultas de hoy (desde la medianoche de Argentina).">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <UsageStat label="A ARCA en la última hora" value={`${formatInt(u.arca_hour)} de ${formatInt(cfg.global_per_hour)}`} />
          <UsageStat label="A ARCA hoy" value={formatInt(u.arca_day)} />
          <UsageStat label="Resueltas con lo guardado" value={formatInt(u.cache_day)} />
          <UsageStat label="Con error hoy" value={formatInt(u.errors_day)} />
          <UsageStat label="Negocios que consultaron" value={formatInt(u.tenants_day)} />
          <UsageStat label="CUITs guardadas" value={formatInt(u.cache_entries)} />
        </dl>
      </Section>

      {data.recent.length > 0 && (
        <Section title="Últimas consultas">
          <ul className="divide-y divide-border rounded-lg bg-muted/50 px-3 text-[13px]">
            {data.recent.map((r, i) => (
              <li key={`${r.created_at}-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{r.tenant_name ?? "Negocio sin nombre"}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {formatCuit(r.cuit)} · {fmtWhen(r.created_at)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Badge tone="neutral">{r.source === "cache" ? "Guardada" : "ARCA"}</Badge>
                  <Badge tone={r.status === "ok" ? "success" : r.status === "error" ? "danger" : "warning"}>
                    {r.status === "ok" ? "OK" : r.status === "error" ? r.error_code ?? "Error" : "No encontrada"}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
PadronConfigTab.displayName = "PadronConfigTab";
