"use client";

import { useEffect, useState } from "react";
import { SearchCheck, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { PadronResult } from "@/components/arca/PadronResult";
import { certExpiry, certExpiryText, formatFiscalDate, type ArcaEnv } from "@/lib/arca/labels";
import { isValidCuit } from "@/lib/tax/catalog";
import { padronErrorMessage } from "@/lib/customers/padron";
import { useMyStaffLevel } from "@/modules/internal/hooks";
import { useInternalPadron, useInternalPadronMutations } from "@/modules/padron/hooks";
import type { PadronLookup } from "@/modules/padron/api";

const fmtWhen = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "";

// Panel interno · ARCA (ADR-133): consulta al padrón para TODOS los negocios
// con el certificado de NinjaSoft (el de "ARCA plataforma" del ambiente
// elegido). Ambiente, encendido, cache y cupos (super_admin, con motivo),
// estado y vencimiento del certificado, "Probar con un CUIT" y el uso.
export function ArcaPadronCard() {
  const q = useInternalPadron();
  const m = useInternalPadronMutations();
  const { level } = useMyStaffLevel();
  const canEdit = level === "super_admin";
  const { toast } = useToast();
  const cfg = q.data?.config;
  const [env, setEnv] = useState<ArcaEnv>("homologacion");
  const [enabled, setEnabled] = useState(false);
  const [cacheDays, setCacheDays] = useState("7");
  const [perHour, setPerHour] = useState("30");
  const [perDay, setPerDay] = useState("200");
  const [globalHour, setGlobalHour] = useState("1000");
  const [reason, setReason] = useState("");
  const [testCuit, setTestCuit] = useState("");
  const [test, setTest] = useState<PadronLookup | null>(null);

  useEffect(() => {
    if (!cfg) return;
    setEnv(cfg.environment);
    setEnabled(cfg.enabled);
    setCacheDays(String(cfg.cache_days));
    setPerHour(String(cfg.tenant_per_hour));
    setPerDay(String(cfg.tenant_per_day));
    setGlobalHour(String(cfg.global_per_hour));
  }, [cfg]);

  if (q.isLoading) {
    return (
      <SettingsCard title="Padrón de ARCA para los negocios" icon={SearchCheck} padded>
        <SkeletonLines lines={5} />
      </SettingsCard>
    );
  }
  if (q.error || !q.data || !cfg) {
    return (
      <Callout tone="warning" title="Padrón no disponible">
        Falta aplicar la migración del padrón para los negocios o no tenés acceso.
      </Callout>
    );
  }

  const cert = q.data.certificates[cfg.environment];
  const exp = certExpiry(cert?.not_after);
  const u = q.data.usage;
  const state = !cfg.enabled ? "off" : cert?.ready ? "on" : "no_cert";
  const testDigits = testCuit.replace(/\D/g, "");
  const nums = { cache_days: Number(cacheDays), tenant_per_hour: Number(perHour), tenant_per_day: Number(perDay), global_per_hour: Number(globalHour) };
  const numsOk =
    nums.cache_days >= 1 && nums.cache_days <= 30 && nums.tenant_per_hour >= 1 && nums.tenant_per_day >= 1 && nums.global_per_hour >= 1;
  const dirty =
    env !== cfg.environment ||
    enabled !== cfg.enabled ||
    nums.cache_days !== cfg.cache_days ||
    nums.tenant_per_hour !== cfg.tenant_per_hour ||
    nums.tenant_per_day !== cfg.tenant_per_day ||
    nums.global_per_hour !== cfg.global_per_hour;

  const save = async () => {
    try {
      await m.save.mutateAsync({ p: { environment: env, enabled, ...nums }, reason: reason.trim() });
      setReason("");
      toast({ title: "Padrón guardado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  };

  const runTest = async () => {
    setTest(null);
    try {
      setTest(await m.test.mutateAsync(testDigits));
    } catch (e) {
      toast({ title: "No se pudo probar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  };

  return (
    <SettingsCard
      title="Padrón de ARCA para los negocios"
      icon={SearchCheck}
      description="Con el certificado de NinjaSoft, cualquier negocio verifica el CUIT de sus clientes y el suyo en ARCA (razón social, condición frente al IVA, domicilio y actividades). Usa el certificado de ARCA plataforma del ambiente elegido."
      actions={
        state === "on" ? (
          <Badge tone="success">Activo</Badge>
        ) : state === "no_cert" ? (
          <Badge tone="warning">Falta el certificado</Badge>
        ) : (
          <Badge tone="neutral">Apagado</Badge>
        )
      }
      padded
    >
      <div className="space-y-5">
        <div className="rounded-lg bg-muted p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck size={15} className={cert?.ready ? "text-success" : "text-muted-foreground"} aria-hidden />
            Certificado de {cfg.environment === "produccion" ? "producción" : "homologación"}
          </p>
          {cert?.has_cert ? (
            <p className="text-muted-foreground">
              CUIT representada {cert.cuit ?? "sin cargar"} · vence el {formatFiscalDate(cert.not_after)} · {certExpiryText(exp)}
            </p>
          ) : (
            <p className="text-muted-foreground">
              Sin certificado en este ambiente. Cargalo arriba, en ARCA plataforma (pedido generado acá o certificado y clave que ya tengas).
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            En ARCA, con la clave fiscal de NinjaSoft: Administrador de Relaciones de Clave Fiscal › Nueva relación › ARCA › WebServices ›
            {" "}<span className="font-medium text-foreground">ws_sr_constancia_inscripcion</span> (en homologación, desde WSASS), y asociarlo al
            certificado de arriba.
          </p>
        </div>

        <SettingRow label="Ambiente" description="Homologación sirve para probar con CUITs de prueba; producción consulta el padrón real.">
          <Segmented
            value={env}
            onChange={setEnv}
            aria-label="Ambiente del padrón"
            scrollOnMobile
            options={[
              { value: "homologacion", label: "Homologación" },
              { value: "produccion", label: "Producción" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Activo para los negocios" description="Apagado, los negocios cargan los datos a mano. La prueba de abajo funciona igual.">
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} label="Activo para los negocios" />
        </SettingRow>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Días de cache por CUIT" inputMode="numeric" value={cacheDays} onChange={(e) => setCacheDays(e.target.value)} hint="De 1 a 30. Mientras dure, no se vuelve a preguntar a ARCA." disabled={!canEdit} />
          <Input label="Consultas por hora por negocio" inputMode="numeric" value={perHour} onChange={(e) => setPerHour(e.target.value)} disabled={!canEdit} />
          <Input label="Consultas por día por negocio" inputMode="numeric" value={perDay} onChange={(e) => setPerDay(e.target.value)} hint="El día corta a medianoche de Argentina." disabled={!canEdit} />
          <Input label="Consultas por hora en total" inputMode="numeric" value={globalHour} onChange={(e) => setGlobalHour(e.target.value)} disabled={!canEdit} />
        </div>
        {canEdit ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input label="Motivo del cambio" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. activar en producción" />
            <Button onClick={save} loading={m.save.isPending} disabled={!dirty || !numsOk || reason.trim().length < 3}>
              Guardar
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Sólo un super admin puede cambiar esta configuración.</p>
        )}

        <section className="space-y-2 border-t border-border pt-5">
          <h4 className="text-sm font-semibold">Uso</h4>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <Stat label="A ARCA en la última hora" value={`${u.arca_hour} de ${cfg.global_per_hour}`} />
            <Stat label="A ARCA hoy" value={String(u.arca_day)} />
            <Stat label="Resueltas con la cache hoy" value={String(u.cache_day)} />
            <Stat label="Con error hoy" value={String(u.errors_day)} />
            <Stat label="Negocios que consultaron hoy" value={String(u.tenants_day)} />
            <Stat label="CUITs guardados" value={String(u.cache_entries)} />
          </dl>
        </section>

        <section className="space-y-2 border-t border-border pt-5">
          <h4 className="text-sm font-semibold">Probar con un CUIT</h4>
          <p className="text-xs text-muted-foreground">
            Consulta ARCA en el ambiente guardado, sin cache y aunque esté apagado. No crea ni modifica clientes.
            {cfg.last_test_at
              ? ` Última prueba: ${fmtWhen(cfg.last_test_at)} (${cfg.last_test_ok ? "OK" : "con error"}${cfg.last_test_message ? `: ${cfg.last_test_message}` : ""}).`
              : ""}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input
              label="CUIT"
              inputMode="numeric"
              value={testCuit}
              onChange={(e) => setTestCuit(e.target.value)}
              error={testDigits.length > 0 && !isValidCuit(testDigits) ? "CUIT inválida" : undefined}
            />
            <Button variant="secondary" onClick={runTest} loading={m.test.isPending} disabled={!isValidCuit(testDigits)}>
              <SearchCheck size={16} aria-hidden /> Probar
            </Button>
          </div>
          {test && test.ok && test.status === "ok" && <PadronResult persona={test.persona} fetchedAt={test.fetched_at} />}
          {test && test.ok && test.status === "no_encontrado" && (
            <Callout tone="info" title="Conexión OK">
              ARCA respondió pero no tiene esa CUIT{test.message ? `: ${test.message}` : "."}
            </Callout>
          )}
          {test && !test.ok && (
            <Callout tone="danger" title="La prueba falló">
              {test.message ?? padronErrorMessage(test.error, { reason: test.reason })}
              {test.code ? ` (${test.code})` : ""}
            </Callout>
          )}
        </section>

        {q.data.recent.length > 0 && (
          <section className="space-y-2 border-t border-border pt-5">
            <h4 className="text-sm font-semibold">Últimas consultas</h4>
            <ul className="divide-y divide-border text-[13px]">
              {q.data.recent.map((r, i) => (
                <li key={`${r.created_at}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.tenant_name ?? r.tenant_id}</span>
                    <span className="block text-muted-foreground">
                      {r.cuit} · {fmtWhen(r.created_at)}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Badge tone="neutral">{r.source === "cache" ? "Cache" : "ARCA"}</Badge>
                    <Badge tone={r.status === "ok" ? "success" : r.status === "error" ? "danger" : "warning"}>
                      {r.status === "ok" ? "OK" : r.status === "error" ? r.error_code ?? "Error" : "No encontrada"}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </SettingsCard>
  );
}
ArcaPadronCard.displayName = "ArcaPadronCard";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
