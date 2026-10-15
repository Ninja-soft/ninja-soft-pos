"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronDown,
  FileCheck2,
  KeyRound,
  Lock,
  PlugZap,
  Rocket,
  ShieldCheck,
  Store,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  ARCA_LINKS,
  ENV_LABEL,
  PROD_STATE_LABEL,
  PROD_STEP_LABEL,
  aliasOf,
  arcaErrorMessage,
  connectionFor,
  currentProdStep,
  productionSteps,
  type ProdStep,
  type ProdStepKey,
  type WizardStepKey,
} from "@/lib/arca/labels";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import type { ArcaConfig } from "@/modules/arca/api";
import { arcaApi } from "@/modules/arca/api";
import { useArcaMutations } from "@/modules/arca/hooks";
import { CertificateFlow, defaultAlias } from "./CertificateFlow";
import { TestResults, useConnectionTest } from "./TestResults";
import { CopyValue, Dot, ExtLink, HowTo, Term, fmtDateTime } from "./shared";

// Pasar a facturar en real (ADR-153): guía paso a paso con el estado real de
// cada paso (lo guarda el servidor: se puede salir y volver), la acción
// exacta en ARCA y la verificación de cada cosa. El interruptor final sólo se
// habilita con la lista completa (el servidor lo exige igual).

const ICON: Record<ProdStepKey, LucideIcon> = {
  pruebas: FileCheck2,
  certificado: KeyRound,
  autorizar: ShieldCheck,
  punto_venta: Store,
  prueba_real: PlugZap,
  activar: Rocket,
};

export function ProductionGuide({
  config,
  canWrite,
  onGoStep,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  /** Abre otro paso del asistente (por ejemplo, Punto de venta). */
  onGoStep?: (k: WizardStepKey) => void;
}) {
  const steps = useMemo(() => productionSteps(config), [config]);
  const [open, setOpen] = useState<ProdStepKey | null>(() => currentProdStep(steps));
  const live = config.settings?.environment === "produccion";
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s])) as Record<ProdStepKey, ProdStep>;
  const deleg = config.settings?.auth_mode === "delegado";
  const done = steps.filter((s) => s.state === "ok").length;

  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md bg-muted p-3">
          <p className="font-semibold text-foreground">Modo prueba (homologación)</p>
          <p className="mt-0.5 text-muted-foreground">Las facturas no valen: sirve para probar sin riesgo.</p>
        </div>
        <div className="rounded-md bg-muted p-3">
          <p className="font-semibold text-foreground">Facturar en real (producción)</p>
          <p className="mt-0.5 text-muted-foreground">Cada factura vale ante ARCA. Pide certificado, permiso y punto de venta reales.</p>
        </div>
      </div>

      {live ? (
        <Callout tone="success" icon={Rocket} title="Estás facturando en real">
          Cada factura que sale tiene validez fiscal. Podés volver al modo prueba desde Ajustes.
        </Callout>
      ) : (
        <p className="text-muted-foreground">
          {done} de {steps.length} pasos listos. Hacelos en orden: cada uno se verifica y queda guardado, así podés salir y
          seguir después.
        </p>
      )}

      <ol className="space-y-2">
        {steps.map((s, i) => {
          const isOpen = open === s.key;
          const Icon = ICON[s.key];
          const st = PROD_STATE_LABEL[s.state];
          return (
            <li key={s.key} className="rounded-md border border-border bg-card" data-testid={`prod-step-${s.key}`} data-state={s.state}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : s.key)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-3 px-3 py-3 text-left sm:px-4"
              >
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    s.state === "ok" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {s.state === "ok" ? <CheckCircle2 size={16} /> : i + 1}
                </span>
                <Icon size={16} className="hidden shrink-0 text-muted-foreground sm:block" aria-hidden />
                <span className="min-w-0 flex-1 font-semibold text-foreground">{PROD_STEP_LABEL[s.key]}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
                <ChevronDown size={16} className={cn("shrink-0 text-muted-foreground transition", isOpen && "rotate-180")} aria-hidden />
              </button>
              {isOpen && (
                <div className="space-y-3 border-t border-border px-3 py-3 sm:px-4">
                  {s.state === "error" && (
                    <Callout tone="danger" icon={AlertTriangle} title={s.title ?? "Hay algo para revisar"}>
                      {s.action}
                      {s.code && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">Código: {s.code}</span>}
                    </Callout>
                  )}
                  {s.state === "locked" && (
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <Lock size={14} aria-hidden /> Primero completá los pasos anteriores.
                    </p>
                  )}
                  {s.key === "pruebas" && <PruebasBody config={config} step={s} />}
                  {s.key === "certificado" && (deleg ? <DelegCert /> : <CertificateFlow config={config} env="produccion" canWrite={canWrite} />)}
                  {s.key === "autorizar" && <AutorizarBody config={config} canWrite={canWrite} step={s} />}
                  {s.key === "punto_venta" && (
                    <PuntoVentaBody config={config} canWrite={canWrite} step={s} authReady={byKey.autorizar.state === "ok"} onGoStep={onGoStep} />
                  )}
                  {s.key === "prueba_real" && <PruebaRealBody config={config} canWrite={canWrite} step={s} />}
                  {s.key === "activar" && <ActivarBody config={config} canWrite={canWrite} steps={steps} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
ProductionGuide.displayName = "ProductionGuide";

function DelegCert() {
  return (
    <p className="text-muted-foreground">Delegando, NinjaSoft factura con su propio certificado: no necesitás uno propio.</p>
  );
}

// ---------------------------------------------------------------------------
function PruebasBody({ config, step }: { config: ArcaConfig; step: ProdStep }) {
  const item = config.checklist.items.find((i) => i.key === "homologacion_ok");
  if (config.settings?.auth_mode === "delegado") {
    return <p className="text-muted-foreground">Delegando no hacen falta facturas de prueba.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">
        ARCA tiene que haber aprobado al menos {item?.min ?? 3} facturas en modo prueba, para saber que todo funciona.
      </p>
      <p className="font-medium text-foreground">
        Aprobadas: {item?.count ?? 0} de {item?.min ?? 3}
      </p>
      {step.state !== "ok" && (
        <p className="text-muted-foreground">
          Con la facturación activada en modo prueba, hacé algunas ventas desde el POS. Cada una pide su factura sola.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function useProdIdentity(config: ArcaConfig) {
  const cert =
    config.certificates.find((c) => c.environment === "produccion" && c.status === "active") ??
    config.certificates.find((c) => c.environment === "produccion" && c.status === "pending_csr");
  return {
    alias: aliasOf(cert?.subject) ?? defaultAlias(config.emitter.cuit),
    cuit: config.emitter.cuit ?? "",
    hasCert: Boolean(cert),
  };
}

function AutorizarBody({ config, canWrite, step }: { config: ArcaConfig; canWrite: boolean; step: ProdStep }) {
  const t = useConnectionTest("produccion");
  const { alias, cuit } = useProdIdentity(config);
  const deleg = config.settings?.auth_mode === "delegado";
  const conn = connectionFor(config.settings, "produccion");
  if (deleg) {
    const platformCuit = config.platform.produccion?.cuit ?? "";
    return (
      <div className="space-y-3">
        <HowTo
          steps={[
            { title: "Entrá a ARCA con tu clave fiscal", body: <ExtLink href={ARCA_LINKS.login}>Ingresar a ARCA</ExtLink> },
            { title: "Administrador de Relaciones de Clave Fiscal", body: <>Tocá <strong>Nueva Relación</strong>.</> },
            { title: "Buscá el servicio", body: <>ARCA &gt; WebServices &gt; <strong>Facturación Electrónica</strong>.</> },
            { title: "Representante: la CUIT de NinjaSoft", body: "Escribila, confirmá y volvé acá." },
          ]}
        />
        <CopyValue label="CUIT de NinjaSoft" value={platformCuit} />
        <VerifyButton t={t} canWrite={canWrite} label="Ya lo hice: verificar" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        El certificado ya existe, pero ARCA todavía no sabe para qué lo vas a usar. Hay que darle permiso para el servicio{" "}
        <Term k="wsfe">Facturación Electrónica</Term>, a nombre de tu CUIT. Se hace una sola vez.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <CopyValue label="Computador Fiscal (alias)" value={alias} />
        <CopyValue label="CUIT" value={cuit} />
      </div>
      <HowTo
        steps={[
          {
            title: "Entrá a ARCA con tu clave fiscal",
            body: (
              <>
                <ExtLink href={ARCA_LINKS.login}>Ingresar a ARCA</ExtLink> con la CUIT <span className="font-mono">{cuit}</span>.
              </>
            ),
          },
          { title: "Abrí el Administrador de Relaciones de Clave Fiscal", body: "Está en Mis servicios. Si no lo ves, buscalo con el buscador de ARCA." },
          { title: "Tocá Nueva Relación", body: "Si representás a una empresa, primero elegí su CUIT arriba." },
          {
            title: "Tocá Buscar y elegí el servicio",
            body: (
              <>
                <strong>ARCA</strong> (o AFIP) &gt; <strong>WebServices</strong> &gt; <strong>Facturación Electrónica</strong>.
              </>
            ),
          },
          {
            title: "Representante: el Computador Fiscal",
            body: (
              <>
                Tocá <strong>Buscar</strong> en Representante, elegí <strong>Computador Fiscal</strong> y el alias{" "}
                <span className="font-mono text-foreground">{alias}</span>. No elijas otro alias ni otra CUIT.
              </>
            ),
          },
          { title: "Confirmá", body: "Tocá Confirmar. ARCA genera el formulario de la relación; no hace falta imprimirlo." },
        ]}
      />
      <Callout tone="info" title="Después de confirmar">
        A veces ARCA tarda unos minutos en tomar la relación. NinjaSoft pide un permiso de acceso que dura 12 horas y lo
        renueva solo: lo hacés una sola vez.
      </Callout>
      <VerifyButton t={t} canWrite={canWrite} label="Ya lo hice: verificar" />
      {!t.result && conn && step.state === "ok" && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Dot tone="success" /> ARCA aceptó el certificado{conn.at ? ` (verificado el ${fmtDateTime(conn.at)})` : ""}.
        </p>
      )}
      {!t.result && conn && step.state === "error" && conn.at && (
        <p className="text-xs text-muted-foreground">Última verificación: {fmtDateTime(conn.at)}.</p>
      )}
    </div>
  );
}

function VerifyButton({
  t,
  canWrite,
  label,
  disabled,
}: {
  t: ReturnType<typeof useConnectionTest>;
  canWrite: boolean;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <Button onClick={() => void t.run()} loading={t.pending} disabled={!canWrite || disabled}>
        <PlugZap size={16} /> {label}
      </Button>
      {t.error && (
        <Callout tone="danger" icon={AlertTriangle} title="No se pudo verificar">
          {t.error}
        </Callout>
      )}
      {t.result && <TestResults result={t.result} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function PuntoVentaBody({
  config,
  canWrite,
  step,
  authReady,
  onGoStep,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  step: ProdStep;
  authReady: boolean;
  onGoStep?: (k: WizardStepKey) => void;
}) {
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => arcaApi.puntosDeVenta("produccion"),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["arca"] }),
  });
  const r = verify.data;
  const item = config.checklist.items.find((i) => i.key === "puntos_de_venta");
  const listed = r?.ok ? (r.pos ?? []).filter((p) => !/caea/i.test(p.emisionTipo)) : null;
  const verified = new Set(listed ? listed.map((p) => p.nro) : item?.verified ?? []);
  const isRi = config.emitter.iva_condition === "responsable_inscripto";
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        Cada factura real lleva un <Term k="punto_venta" /> que tiene que existir en ARCA para Web Services y tener el mismo
        número que usa la sucursal en NinjaSoft.
      </p>
      <HowTo
        steps={[
          { title: "Entrá a ARCA con tu clave fiscal", body: <ExtLink href={ARCA_LINKS.login}>Ingresar a ARCA</ExtLink> },
          {
            title: "Administración de puntos de venta y domicilios",
            body: (
              <>
                Elegí tu nombre, entrá a <strong>A/B/M de Puntos de venta</strong> y tocá <strong>Agregar</strong>.
              </>
            ),
          },
          {
            title: "Número y sistema",
            body: (
              <>
                Número: el de la sucursal (abajo). Sistema:{" "}
                <strong>
                  {isRi
                    ? "RECE para aplicativo y web services"
                    : "Factura Electrónica - Monotributo - Web Services"}
                </strong>{" "}
                (ARCA a veces cambia el nombre: tiene que decir Web Services). <strong>Comprobantes en línea no sirve</strong>.
              </>
            ),
          },
          { title: "Elegí el domicilio y confirmá", body: "Volvé acá y tocá Verificar." },
        ]}
      />
      <ul className="divide-y divide-border rounded-md border border-border">
        {config.stores.map((s) => {
          const ok = s.afip_pos_number != null && verified.has(s.afip_pos_number);
          const missing = step.missing?.includes(s.afip_pos_number ?? -1);
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <Building2 size={14} className="text-muted-foreground" aria-hidden /> {s.name}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono">{s.afip_pos_number != null ? String(s.afip_pos_number).padStart(5, "0") : "Sin número"}</span>
                <Badge tone={ok ? "success" : missing || s.afip_pos_number == null ? "danger" : "neutral"}>
                  {ok ? "En ARCA" : s.afip_pos_number == null ? "Falta número" : missing ? "No está en ARCA" : "Sin verificar"}
                </Badge>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending} disabled={!canWrite || !authReady}>
          <Building2 size={16} /> Verificar puntos de venta en ARCA
        </Button>
        {onGoStep && (
          <Button variant="ghost" onClick={() => onGoStep("punto_venta")}>
            Cambiar el número de una sucursal
          </Button>
        )}
      </div>
      {!authReady && <p className="text-xs text-muted-foreground">Se habilita cuando ARCA acepte el certificado (paso anterior).</p>}
      {verify.error && (
        <Callout tone="danger" icon={AlertTriangle} title="No se pudo consultar">
          {arcaErrorMessage(verify.error)}
        </Callout>
      )}
      {r && !r.ok && (
        <Callout tone="danger" icon={AlertTriangle} title={humanError(r.error ?? null, r.message ?? null).title}>
          {humanError(r.error ?? null, r.message ?? null).action}
        </Callout>
      )}
      {listed && (
        <Callout tone={listed.length ? "info" : "warning"} title={listed.length ? "ARCA tiene estos puntos de venta Web Services" : "ARCA no lista ningún punto de venta Web Services"}>
          {listed.length
            ? listed.map((p) => `${String(p.nro).padStart(5, "0")} (${p.emisionTipo})`).join(" · ")
            : "Si recién lo diste de alta, esperá unos minutos y volvé a verificar. Si es de Comprobantes en línea, hay que dar de alta otro con Web Services."}
        </Callout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function PruebaRealBody({ config, canWrite, step }: { config: ArcaConfig; canWrite: boolean; step: ProdStep }) {
  const t = useConnectionTest("produccion");
  const conn = connectionFor(config.settings, "produccion");
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        NinjaSoft entra a ARCA en modo real y, sin emitir ninguna factura, revisa que el servicio responda (FEDummy), que tus
        puntos de venta estén y consulta el último número autorizado. Vale por 7 días.
      </p>
      <VerifyButton t={t} canWrite={canWrite} label="Probar conexión real" disabled={step.state === "locked"} />
      {!t.result && conn?.ok && conn.at && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Dot tone="success" /> Última prueba real correcta el {fmtDateTime(conn.at)}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ActivarBody({ config, canWrite, steps }: { config: ArcaConfig; canWrite: boolean; steps: ProdStep[] }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = config.settings?.environment === "produccion";
  const pending = steps.filter((s) => s.key !== "activar" && s.state !== "ok");
  const ready = config.checklist.ready && pending.length === 0;
  if (live) {
    return <p className="text-muted-foreground">Ya estás facturando en real. Desde Ajustes podés volver al modo prueba.</p>;
  }
  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <div>
          <p className="font-medium text-foreground">Para poder activarlo falta:</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {pending.map((p) => (
              <li key={p.key} className="flex items-center gap-2">
                <Dot tone={p.state === "error" ? "danger" : "warning"} /> {PROD_STEP_LABEL[p.key]}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!config.can_owner && <Callout tone="neutral" icon={Lock} title="Sólo el dueño puede pasar a facturar en real" />}
      <Button
        size="lg"
        className="w-full sm:w-auto"
        disabled={!canWrite || !ready || !config.can_owner}
        onClick={() => {
          setError(null);
          setConfirm(true);
        }}
      >
        <Rocket size={18} /> Facturar en real
      </Button>
      {error && (
        <Callout tone="danger" icon={AlertTriangle} title="No se pudo pasar a facturar en real">
          {error}
        </Callout>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="¿Pasar a facturar en real?"
        description={`Desde ahora cada venta genera una factura con validez fiscal ante ARCA (${ENV_LABEL.produccion.toLowerCase()}). Las facturas de prueba no se convierten. Podés volver al modo prueba cuando quieras.`}
        confirmLabel="Sí, facturar en real"
        withReason
        reasonLabel="Comentario (queda en la auditoría)"
        loading={m.setEnvironment.isPending}
        onConfirm={async (reason) => {
          try {
            await m.setEnvironment.mutateAsync({ env: "produccion", reason });
            setConfirm(false);
            toast({ title: "Listo: estás facturando en real", variant: "success" });
          } catch (e) {
            setConfirm(false);
            setError(arcaErrorMessage(e));
          }
        }}
      />
    </div>
  );
}
