"use client";

import { useState } from "react";
import { Activity, AlertTriangle, FileText, ListChecks, Lock, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import {
  ENV_LABEL,
  arcaErrorMessage,
  certExpiry,
  certExpiryText,
  formatFiscalDate,
  type ArcaEnv,
  type WizardStepKey,
} from "@/lib/arca/labels";
import type { ArcaConfig } from "@/modules/arca/api";
import { useArcaConfig, useArcaMutations } from "@/modules/arca/hooks";
import { useTaxSettings } from "@/modules/tax/hooks";
import { ArcaWizard } from "./ArcaWizard";
import { ArcaMonitor } from "./ArcaMonitor";
import { ArcaRequirements, CertificateIsNotTheLetter, LetterGuide } from "./InvoiceLettersGuide";
import { Dot, Term } from "./shared";
import { ArcaIcon } from "@/components/settings/brandIcons";
import { ArcaModeCard } from "./ModeSwitch";
import { TicketModeCard } from "./TicketModeCard";

type Tab = "asistente" | "monitor" | "ajustes";

// Configuración > Facturación electrónica (F3 · ADR-072). Dueño o encargado;
// escribir pide la feature `facturacion_afip` (el servidor lo exige igual).
export function ArcaSettings() {
  const q = useArcaConfig();
  const tax = useTaxSettings();
  const [tab, setTab] = useState<Tab | null>(null);
  // Paso del asistente que abre la guía de requisitos ("Ver cómo y cargarlo").
  const [wizardStep, setWizardStep] = useState<WizardStepKey | null>(null);
  if (q.isLoading) return <SpinnerBlock className="py-16" />;
  if (q.error || !q.data) {
    return (
      <Callout tone="warning" icon={Lock} title="No disponible">
        {arcaErrorMessage(q.error)}
      </Callout>
    );
  }
  const config = q.data;
  const canWrite = config.feature;
  const active: Tab = tab ?? (config.settings?.enabled ? "monitor" : "asistente");
  return (
    <div className="space-y-5">
      <ArcaSummary config={config} />
      {config.settings && (
        <div className="grid gap-3 lg:grid-cols-2">
          <ArcaModeCard
            config={config}
            canWrite={canWrite}
            onGoStep={(step) => {
              setWizardStep(step);
              setTab("asistente");
            }}
          />
          <TicketModeCard config={config} canWrite={canWrite} />
        </div>
      )}
      <Disclosure
        title="Qué facturas vas a emitir y qué necesitás de ARCA"
        icon={<FileText size={15} />}
        defaultOpen={!config.settings?.enabled}
      >
        <div className="space-y-4">
          <LetterGuide condition={config.emitter.iva_condition} issuesM={Boolean(tax.data?.issues_cbte_m)} />
          <CertificateIsNotTheLetter />
          <ArcaRequirements
            config={config}
            canWrite={canWrite}
            onGo={(step) => {
              setWizardStep(step);
              setTab("asistente");
            }}
          />
        </div>
      </Disclosure>
      {!config.feature && (
        <Callout tone="warning" icon={Lock} title="Tu plan no incluye la facturación electrónica">
          Está en los planes Pro, Business y Enterprise. Podés ver lo que ya se emitió, pero no cambiar la configuración.
        </Callout>
      )}
      <Segmented
        value={active}
        onChange={setTab}
        aria-label="Sección"
        options={[
          { value: "asistente", label: "Asistente", icon: <ListChecks size={15} /> },
          { value: "monitor", label: "Monitor", icon: <Activity size={15} /> },
          { value: "ajustes", label: "Ajustes", icon: <SlidersHorizontal size={15} /> },
        ]}
      />
      {active === "asistente" && (
        <ArcaWizard key={wizardStep ?? "auto"} config={config} canWrite={canWrite} initialStep={wizardStep ?? undefined} />
      )}
      {active === "monitor" && <ArcaMonitor config={config} canWrite={canWrite} />}
      {active === "ajustes" && <ArcaAdjustments config={config} canWrite={canWrite} />}
    </div>
  );
}
ArcaSettings.displayName = "ArcaSettings";

/** Tarjeta resumen siempre visible: modo, contingencia y vencimiento del certificado. */
export function ArcaSummary({ config }: { config: ArcaConfig }) {
  const s = config.settings;
  const env: ArcaEnv = s?.environment ?? "homologacion";
  const cert = config.certificates.find((c) => c.environment === env && c.status === "active");
  const exp = s?.auth_mode === "delegado" ? null : certExpiry(cert?.not_after);
  const pending = (config.counts.pendiente ?? 0) + (config.counts.enviando ?? 0);
  const errors = (config.counts.rechazado ?? 0) + (config.counts.requiere_accion ?? 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ArcaIcon size={22} className="mt-1" />
          <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Facturación electrónica ARCA</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-base font-semibold">
            <Dot tone={!s?.enabled ? "neutral" : env === "produccion" ? "success" : "info"} />
            {!s?.enabled ? "Apagada" : ENV_LABEL[env]}
            {s?.enabled && env === "homologacion" && (
              <span className="text-sm font-normal text-muted-foreground">
                (<Term k="homologacion">sin validez fiscal</Term>)
              </span>
            )}
          </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s?.contingency_since && <Badge tone="warning">ARCA no responde: en contingencia</Badge>}
          {pending > 0 && <Badge tone="neutral">{pending} en cola</Badge>}
          {errors > 0 && <Badge tone="danger">{errors} para revisar</Badge>}
          {exp && exp.level !== "none" && (
            <Badge tone={exp.level === "ok" ? "neutral" : exp.level === "warn" ? "warning" : "danger"}>
              {certExpiryText(exp)}
            </Badge>
          )}
        </div>
      </div>
      {exp && (exp.level === "warn" || exp.level === "expired") && (
        <Callout tone={exp.level === "expired" ? "danger" : "warning"} icon={AlertTriangle} title={certExpiryText(exp)}>
          Renovalo desde el paso Certificado del asistente (vence el {formatFiscalDate(cert?.not_after)}). Sin certificado
          vigente las facturas quedan en cola.
        </Callout>
      )}
    </div>
  );
}
ArcaSummary.displayName = "ArcaSummary";

function ArcaAdjustments({ config, canWrite }: { config: ArcaConfig; canWrite: boolean }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const s = config.settings;
  const save = async (p: Parameters<typeof m.saveSettings.mutateAsync>[0]) => {
    try {
      await m.saveSettings.mutateAsync(p);
      toast({ title: "Guardado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: arcaErrorMessage(e), variant: "error" });
    }
  };
  return (
    <div className="space-y-5">
      <SettingsCard title="Funcionamiento">
        <SettingRow label="Facturación electrónica activa" description="Apagada, las ventas nuevas no generan factura (las que están en cola esperan).">
          <Switch
            checked={Boolean(s?.enabled)}
            onCheckedChange={(v) => save({ enabled: v })}
            disabled={!canWrite || m.saveSettings.isPending}
            label="Activa"
          />
        </SettingRow>
        <SettingRow label="Reintentos antes de pedir ayuda" description="Si ARCA falla, se reintenta con esperas crecientes (1, 2, 4, 8 minutos...). Después de estos intentos queda para revisar.">
          <Select
            value={String(s?.max_attempts ?? 10)}
            onChange={(v) => save({ max_attempts: Number(v) })}
            options={["5", "10", "15", "20", "30"].map((v) => ({ value: v, label: `${v} intentos` }))}
            disabled={!canWrite}
            aria-label="Reintentos"
          />
        </SettingRow>
        <SettingRow label="Facturas de prueba antes de pasar a real" description="Cuántas facturas aprobadas en modo prueba pide la lista de producción (certificado propio).">
          <Select
            value={String(s?.homo_min_approved ?? 3)}
            onChange={(v) => save({ homo_min_approved: Number(v) })}
            options={["1", "3", "5", "10"].map((v) => ({ value: v, label: v }))}
            disabled={!canWrite}
            aria-label="Facturas de prueba"
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Certificados" description="La clave privada nunca se muestra: queda cifrada en el servidor.">
        {config.certificates.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Todavía no hay certificados.</p>
        ) : (
          config.certificates.map((c) => {
            const e = certExpiry(c.not_after);
            return (
              <div key={c.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">
                    {c.environment === "produccion" ? "Real" : "Prueba"} · CUIT {c.cuit ?? "Sin dato"}
                  </p>
                  <p className="text-muted-foreground">
                    {c.status === "pending_csr" ? "Pedido generado, esperando el certificado de ARCA" : `Vence el ${formatFiscalDate(c.not_after)}`}
                  </p>
                </div>
                {c.status === "active" && (
                  <Badge tone={e.level === "ok" ? "success" : e.level === "warn" ? "warning" : "danger"}>{certExpiryText(e)}</Badge>
                )}
              </div>
            );
          })
        )}
      </SettingsCard>

    </div>
  );
}
