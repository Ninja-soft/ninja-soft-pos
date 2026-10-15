"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  CloudOff,
  Lock,
  PlugZap,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { FISCAL_CONDITION_LABEL } from "@/lib/tax/catalog";
import {
  ARCA_LINKS,
  CHECKLIST_LABEL,
  ENV_LABEL,
  WIZARD_STEPS,
  arcaErrorMessage,
  currentWizardStep,
  formatFiscalDate,
  wizardProgress,
  wizardStepsDone,
  type ArcaEnv,
  type WizardStepKey,
} from "@/lib/arca/labels";
import type { ArcaConfig, TestResult } from "@/modules/arca/api";
import { arcaApi } from "@/modules/arca/api";
import { useArcaMutations } from "@/modules/arca/hooks";
import { CertificateFlow, aliasFromSubject, defaultAlias } from "./CertificateFlow";
import { ProductionGuide } from "./ProductionGuide";
import { SavedConnection, TestResults, useConnectionTest } from "./TestResults";
import { CopyValue, Dot, ExtLink, HowTo, Term } from "./shared";

// Asistente de Configuración > Facturación electrónica (ADR-072): un paso por
// pantalla, barra de progreso, lenguaje simple y glosario en cada término.

export function ArcaWizard({
  config,
  canWrite,
  initialStep,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  /** Paso a abrir (desde la guía de requisitos); si no, el primero pendiente. */
  initialStep?: WizardStepKey;
}) {
  const done = useMemo(() => wizardStepsDone(config), [config]);
  const [step, setStep] = useState<WizardStepKey>(() => initialStep ?? currentWizardStep(config));
  const idx = WIZARD_STEPS.findIndex((s) => s.key === step);
  const progress = wizardProgress(config);
  const go = (d: number) => {
    const next = WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, Math.max(0, idx + d))];
    if (next) setStep(next.key);
  };
  const env: ArcaEnv = config.settings?.environment ?? "homologacion";

  return (
    <div className="space-y-4">
      {/* Progreso */}
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-semibold">
            Paso {idx + 1} de {WIZARD_STEPS.length}
          </span>
          <span className="text-muted-foreground">{progress}% listo</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-[var(--pos-solid)] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <ol className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {WIZARD_STEPS.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => setStep(s.key)}
                aria-current={s.key === step ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs transition",
                  s.key === step ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                {done[s.key] ? (
                  <CheckCircle2 size={14} className="text-success" aria-hidden />
                ) : (
                  <span className="flex h-3.5 w-3.5 items-center justify-center text-[10px]">{i + 1}</span>
                )}
                {s.short}
                {s.optional && <span className="text-[10px] text-muted-foreground">(opcional)</span>}
              </button>
            </li>
          ))}
        </ol>
      </div>

      {/* Paso */}
      <div className="rounded-md border border-border border-t-2 border-t-ninja-flame bg-card p-4 sm:p-5">
        <h3 className="text-base font-semibold">{WIZARD_STEPS[idx]?.title}</h3>
        <div className="mt-3">
          {step === "datos" && <StepDatos config={config} />}
          {step === "camino" && <StepCamino config={config} canWrite={canWrite} onDone={() => go(1)} />}
          {step === "certificado" && <StepCertificado config={config} canWrite={canWrite} env={env} />}
          {step === "autorizar" && <StepAutorizar config={config} canWrite={canWrite} env={env} />}
          {step === "punto_venta" && <StepPuntoVenta config={config} canWrite={canWrite} env={env} />}
          {step === "prueba" && <StepPrueba config={config} canWrite={canWrite} env={env} />}
          {step === "contingencia" && <StepContingencia config={config} canWrite={canWrite} />}
          {step === "produccion" && <ProductionGuide config={config} canWrite={canWrite} onGoStep={setStep} />}
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => go(-1)} disabled={idx === 0}>
            <ArrowLeft size={16} /> Atrás
          </Button>
          {idx < WIZARD_STEPS.length - 1 && (
            <Button variant={done[step] ? "primary" : "secondary"} onClick={() => go(1)}>
              {done[step] || WIZARD_STEPS[idx]?.optional ? "Siguiente" : "Saltear por ahora"} <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
ArcaWizard.displayName = "ArcaWizard";

// ---------------------------------------------------------------------------
// 1. Datos
// ---------------------------------------------------------------------------
function StepDatos({ config }: { config: ArcaConfig }) {
  const ok = Boolean(config.emitter.cuit && config.emitter.iva_condition);
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Con la facturación electrónica, cada venta genera su factura oficial con el <Term k="cae" /> de ARCA, sin
        hacer nada en la caja: si ARCA tarda o no responde, la venta se cobra igual y la factura se pide sola en segundo
        plano.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          { t: "Tu clave fiscal", d: "Nivel 3 o superior, para entrar a ARCA." },
          { t: "15 minutos", d: "La primera vez. Después no hay que tocar nada." },
          { t: "Probar sin riesgo", d: "Empezás en modo prueba: las facturas no valen hasta que pases a real." },
        ].map((x) => (
          <div key={x.t} className="rounded-md bg-muted p-3">
            <p className="font-semibold text-foreground">{x.t}</p>
            <p className="mt-0.5 text-muted-foreground">{x.d}</p>
          </div>
        ))}
      </div>
      {ok ? (
        <Callout tone="success" icon={CheckCircle2} title="Datos fiscales cargados">
          CUIT <span className="font-mono">{config.emitter.cuit}</span> ·{" "}
          {FISCAL_CONDITION_LABEL[config.emitter.iva_condition as keyof typeof FISCAL_CONDITION_LABEL] ??
            config.emitter.iva_condition}
        </Callout>
      ) : (
        <Callout
          tone="warning"
          icon={AlertTriangle}
          title="Faltan los datos fiscales del negocio"
          actions={
            <Link href={"/configuracion?seccion=impuestos" as never}>
              <Button size="sm">Cargar CUIT y condición</Button>
            </Link>
          }
        >
          La factura lleva tu CUIT y depende de tu condición frente al IVA (responsable inscripto factura A o B;
          monotributo, C).
        </Callout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Camino
// ---------------------------------------------------------------------------
function StepCamino({ config, canWrite, onDone }: { config: ArcaConfig; canWrite: boolean; onDone: () => void }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const env: ArcaEnv = config.settings?.environment ?? "homologacion";
  const delegReady = Boolean(config.platform[env]?.ready);
  const mode = config.settings?.auth_mode ?? "propio";
  const choose = async (auth_mode: "propio" | "delegado") => {
    try {
      await m.saveSettings.mutateAsync({ auth_mode });
      onDone();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: arcaErrorMessage(e), variant: "error" });
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">Hay dos formas de autorizar a NinjaSoft a facturar por vos. Elegí una:</p>
      <div className="grid gap-3 md:grid-cols-2">
        {/* A: delegar */}
        <div className={cn("rounded-md border border-border p-4", !delegReady && "opacity-70")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">Delegar en NinjaSoft</p>
            {delegReady ? <Badge tone="success">La más simple</Badge> : <Badge tone="neutral">Disponible próximamente</Badge>}
          </div>
          <p className="mt-1 text-muted-foreground">
            {delegReady
              ? "Autorizás a NinjaSoft desde ARCA en un solo trámite y listo: sin certificado propio."
              : "Va a ser la opción más simple: un solo trámite en ARCA, sin certificado. Todavía no está habilitada."}
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>+ Un solo paso en ARCA (<Term k="delegacion" />).</li>
            <li>+ No vence ni hay que renovar nada.</li>
            <li>- NinjaSoft factura en tu nombre con su certificado.</li>
          </ul>
          <Button
            className="mt-3 w-full"
            variant={mode === "delegado" ? "primary" : "secondary"}
            disabled={!canWrite || !delegReady}
            loading={m.saveSettings.isPending && mode !== "delegado"}
            onClick={() => choose("delegado")}
          >
            {delegReady ? (mode === "delegado" ? "Elegida" : "Elegir delegar") : "Próximamente"}
          </Button>
        </div>
        {/* B: propio */}
        <div className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">Certificado propio</p>
            {!delegReady && <Badge tone="brand">Recomendado</Badge>}
          </div>
          <p className="mt-1 text-muted-foreground">
            NinjaSoft genera todo lo técnico. Vos pegás un texto en ARCA y traés de vuelta el <Term k="certificado" />.
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>+ El certificado es tuyo y queda a tu nombre.</li>
            <li>+ La clave se genera y se guarda cifrada en NinjaSoft.</li>
            <li>- Vence cada 2 años (te avisamos 30 días antes).</li>
          </ul>
          <Button
            className="mt-3 w-full"
            variant={config.settings && mode === "propio" ? "primary" : "secondary"}
            disabled={!canWrite}
            loading={m.saveSettings.isPending}
            onClick={() => choose("propio")}
          >
            {config.settings && mode === "propio" ? "Elegido" : "Elegir certificado propio"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Certificado
// ---------------------------------------------------------------------------
function StepCertificado({ config, canWrite, env }: { config: ArcaConfig; canWrite: boolean; env: ArcaEnv }) {
  if (config.settings?.auth_mode === "delegado") {
    return (
      <Callout tone="success" icon={ShieldCheck} title="No necesitás certificado">
        Delegando, NinjaSoft factura con su propio certificado. En el paso siguiente autorizás la delegación en ARCA.
      </Callout>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Empezamos por el certificado de <Term k="homologacion">prueba</Term>. El real se carga al final, en el paso Pasar a
        facturar en real.
      </p>
      <CertificateFlow config={config} env={env} canWrite={canWrite} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Autorizar
// ---------------------------------------------------------------------------
function AuthorizeHowTo({ config, env }: { config: ArcaConfig; env: ArcaEnv }) {
  const cert = config.certificates.find((c) => c.environment === env && c.status === "active");
  const alias = aliasFromSubject(cert?.subject) ?? defaultAlias(config.emitter.cuit);
  const cuit = config.emitter.cuit ?? "";
  if (config.settings?.auth_mode === "delegado") {
    const platformCuit = config.platform[env]?.cuit ?? "";
    return (
      <div className="space-y-3">
        <HowTo
          steps={[
            { title: "Entrá a ARCA", body: <ExtLink href={ARCA_LINKS.login}>Ingresar con clave fiscal</ExtLink> },
            { title: "Administrador de Relaciones de Clave Fiscal", body: <>Tocá <strong>Nueva relación</strong>.</> },
            {
              title: "Elegí el servicio",
              body: (
                <>
                  ARCA &gt; WebServices &gt; <strong>Facturación Electrónica</strong> (<Term k="wsfe" />).
                </>
              ),
            },
            { title: "Representante: la CUIT de NinjaSoft", body: <>Buscala, confirmá y listo.</> },
          ]}
        />
        <CopyValue label="CUIT de NinjaSoft" value={platformCuit} />
      </div>
    );
  }
  const isHomo = env === "homologacion";
  return (
    <div className="space-y-3">
      <HowTo
        steps={
          isHomo
            ? [
                { title: "Abrí WSASS", body: <ExtLink href={ARCA_LINKS.wsass}>Abrir WSASS</ExtLink> },
                { title: "Crear autorización a servicio", body: "Es la opción del menú de la izquierda." },
                { title: "Completá con estos valores", body: "Alias (nombre simbólico del DN), CUIT representada y servicio." },
                { title: "Tocá Crear autorización", body: "Listo: volvé y probá." },
              ]
            : [
                { title: "Entrá a ARCA", body: <ExtLink href={ARCA_LINKS.login}>Ingresar con clave fiscal</ExtLink> },
                { title: "Administrador de Relaciones de Clave Fiscal", body: <>Tocá <strong>Nueva Relación</strong>.</> },
                {
                  title: "Buscar el servicio",
                  body: "ARCA > WebServices > Facturación Electrónica.",
                },
                {
                  title: "Representante: Computador Fiscal",
                  body: (
                    <>
                      Elegí el Computador Fiscal con el alias <span className="font-mono text-foreground">{alias}</span> y
                      confirmá.
                    </>
                  ),
                },
              ]
        }
      />
      <div className="grid gap-2 sm:grid-cols-3">
        <CopyValue label="Alias" value={alias} />
        <CopyValue label="CUIT representada" value={cuit} />
        <CopyValue label="Servicio" value="wsfe" />
      </div>
    </div>
  );
}

function StepAutorizar({ config, canWrite, env }: { config: ArcaConfig; canWrite: boolean; env: ArcaEnv }) {
  const t = useConnectionTest(env);
  const deleg = config.settings?.auth_mode === "delegado";
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        {deleg ? (
          <>Ahora autorizás a NinjaSoft en ARCA (<Term k="delegacion" />).</>
        ) : (
          <>
            El certificado ya existe, pero ARCA tiene que saber para qué servicio sirve: hay que autorizar{" "}
            <Term k="wsfe" /> para tu <Term k="cuit_representada" />.
          </>
        )}
      </p>
      <AuthorizeHowTo config={config} env={env} />
      <div className="rounded-md bg-muted p-3">
        <SavedConnection settings={config.settings} env={env} />
      </div>
      <Button onClick={() => void t.run()} loading={t.pending} disabled={!canWrite}>
        <PlugZap size={16} /> {deleg ? "Verificar delegación" : "Ya lo hice: verificar"}
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
// 5. Punto de venta
// ---------------------------------------------------------------------------
function PosSelect({
  value,
  options,
  onSave,
  disabled,
}: {
  value: number | null;
  options: { nro: number; emisionTipo: string }[];
  onSave: (n: number | null) => void;
  disabled?: boolean;
}) {
  const [manual, setManual] = useState(value != null ? String(value) : "");
  useEffect(() => setManual(value != null ? String(value) : ""), [value]);
  if (options.length > 0) {
    return (
      <Select
        value={value != null ? String(value) : null}
        options={options.map((p) => ({ value: String(p.nro), label: String(p.nro).padStart(5, "0"), description: p.emisionTipo }))}
        onChange={(v) => onSave(Number(v))}
        disabled={disabled}
        placeholder="Elegí el punto de venta"
        aria-label="Punto de venta"
      />
    );
  }
  return (
    <div className="flex gap-2">
      <Input
        inputMode="numeric"
        value={manual}
        onChange={(e) => setManual(e.target.value.replace(/\D/g, "").slice(0, 5))}
        placeholder="Ej.: 1"
        aria-label="Número de punto de venta"
        disabled={disabled}
      />
      <Button
        variant="secondary"
        onClick={() => onSave(manual ? Number(manual) : null)}
        disabled={disabled || (manual ? Number(manual) : null) === value}
      >
        Guardar
      </Button>
    </div>
  );
}

function StepPuntoVenta({ config, canWrite, env }: { config: ArcaConfig; canWrite: boolean; env: ArcaEnv }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const [list, setList] = useState<{ nro: number; emisionTipo: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const query = async (e: ArcaEnv) => {
    setLoading(true);
    try {
      const r = await arcaApi.puntosDeVenta(e);
      setList(r.pos ?? []);
      if (!r.ok) toast({ title: "ARCA no devolvió puntos de venta", description: r.message ?? r.error, variant: "error" });
    } catch (err) {
      toast({ title: "No se pudo consultar", description: arcaErrorMessage(err), variant: "error" });
    } finally {
      setLoading(false);
    }
  };
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async (fn: Promise<unknown>) => {
    setSaveError(null);
    try {
      await fn;
      toast({ title: "Punto de venta guardado", variant: "success" });
    } catch (e) {
      setSaveError(arcaErrorMessage(e));
    }
  };
  const options = (list ?? []).filter((p) => !/caea/i.test(p.emisionTipo));
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Cada factura lleva el número de <Term k="punto_venta" /> adelante. Cada sucursal usa uno (y una caja puede tener
        el suyo propio).
      </p>
      <Disclosure title="Cómo dar de alta un punto de venta en ARCA" variant="help">
        <HowTo
          steps={[
            { title: "Entrá a ARCA", body: <ExtLink href={ARCA_LINKS.login}>Ingresar con clave fiscal</ExtLink> },
            {
              title: "Administración de puntos de venta y domicilios",
              body: <>Entrá a <strong>A/B/M de Puntos de venta</strong> y tocá <strong>Agregar</strong>.</>,
            },
            {
              title: "Elegí el sistema Web Services",
              body: (
                <>
                  <strong>Factura Electrónica - Monotributo - Web Services</strong> o <strong>RECE para aplicativo y web
                  services</strong> (responsable inscripto). Otro tipo no sirve para NinjaSoft.
                </>
              ),
            },
            { title: "Asigná el domicilio y confirmá", body: "Anotá el número que te dio ARCA." },
          ]}
        />
      </Disclosure>
      {env === "homologacion" && (
        <Callout tone="info" title="En modo prueba">
          ARCA acepta cualquier número de punto de venta (por ejemplo 1) y muchas veces no lista ninguno. Los reales los
          verifica NinjaSoft al pasar a facturar en real.
        </Callout>
      )}
      <Button variant="secondary" onClick={() => query(env)} loading={loading} disabled={!canWrite}>
        <Building2 size={16} /> Consultar mis puntos de venta en ARCA
      </Button>
      {list && list.length === 0 && <p className="text-muted-foreground">ARCA no listó puntos de venta Web Services. Escribí el número a mano.</p>}
      {saveError && (
        <Callout tone="danger" icon={AlertTriangle} title="El punto de venta no se guardó">
          {saveError}
        </Callout>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {config.stores.map((s) => (
          <li key={s.id} className="space-y-2 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 font-medium">
                <Dot tone={s.afip_pos_number != null ? "success" : "warning"} /> {s.name}
                {s.is_default && <span className="text-xs text-muted-foreground">(principal)</span>}
              </p>
              <div className="sm:w-56">
                <PosSelect
                  value={s.afip_pos_number}
                  options={options}
                  disabled={!canWrite}
                  onSave={(n) => save(m.setStorePos.mutateAsync({ id: s.id, n }))}
                />
              </div>
            </div>
            {s.registers.length > 1 && (
              <Disclosure title="Punto de venta propio por caja (opcional)">
                <ul className="space-y-2">
                  {s.registers.map((r) => (
                    <li key={r.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-muted-foreground">{r.name}</span>
                      <div className="sm:w-56">
                        <PosSelect
                          value={r.afip_pos_number}
                          options={options}
                          disabled={!canWrite}
                          onSave={(n) => save(m.setRegisterPos.mutateAsync({ id: r.id, n }))}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Prueba y activación
// ---------------------------------------------------------------------------
function StepPrueba({ config, canWrite, env }: { config: ArcaConfig; canWrite: boolean; env: ArcaEnv }) {
  const t = useConnectionTest(env);
  const m = useArcaMutations();
  const { toast } = useToast();
  const [toggleError, setToggleError] = useState<string | null>(null);
  const enabled = Boolean(config.settings?.enabled);
  const approved = config.checklist.items.find((i) => i.key === "homologacion_ok")?.count ?? config.counts.aprobado ?? 0;
  const min = config.settings?.homo_min_approved ?? 3;
  const toggle = async (v: boolean) => {
    setToggleError(null);
    try {
      await m.saveSettings.mutateAsync({ enabled: v });
      toast({ title: v ? "Facturación activada y guardada" : "Facturación pausada", variant: "success" });
    } catch (e) {
      setToggleError(arcaErrorMessage(e));
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Probá la conexión: NinjaSoft pide el permiso de acceso a ARCA, revisa que sus servidores respondan y consulta el
        último número autorizado. No emite ninguna factura.
      </p>
      <div className="rounded-md bg-muted p-3">
        <SavedConnection settings={config.settings} env={env} />
      </div>
      <Button onClick={() => void t.run()} loading={t.pending} disabled={!canWrite}>
        <PlugZap size={16} /> Probar conexión
      </Button>
      {t.error && (
        <Callout tone="danger" icon={AlertTriangle} title="No se pudo probar">
          {t.error}
        </Callout>
      )}
      {t.result && <TestResults result={t.result} />}
      <div className="flex items-start justify-between gap-4 rounded-md bg-muted p-3">
        <div>
          <p className="font-semibold text-foreground">Activar la facturación electrónica</p>
          <p className="text-muted-foreground">
            {enabled ? "Activada: cada venta nueva genera su factura sola." : "Desde que la activás, cada venta nueva genera su factura sola."}
            {env === "homologacion" && " En modo prueba no tienen validez fiscal."}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={toggle} disabled={!canWrite || m.saveSettings.isPending} label="Activar" />
      </div>
      {toggleError && (
        <Callout tone="danger" icon={AlertTriangle} title="No se pudo cambiar">
          {toggleError}
        </Callout>
      )}
      {enabled && env === "homologacion" && (
        <Callout tone={approved >= min ? "success" : "info"} title={`Facturas de prueba aprobadas: ${approved} de ${min}`}>
          {approved >= min
            ? "Listo: ya podés seguir con el paso Real."
            : `Hacé algunas ventas de prueba desde el POS. Cuando ARCA apruebe ${min}, vas a poder pasar a facturar en real.`}
        </Callout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. Contingencia (opcional)
// ---------------------------------------------------------------------------
function StepContingencia({ config, canWrite }: { config: ArcaConfig; canWrite: boolean }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const s = config.settings;
  const [pv, setPv] = useState(s?.caea_pto_vta != null ? String(s.caea_pto_vta) : "");
  const [timeout, setTimeoutS] = useState(String(s?.caea_timeout_seconds ?? 10));
  const on = Boolean(s?.caea_enabled);
  const save = async (enable: boolean) => {
    try {
      await m.saveSettings.mutateAsync({
        caea_enabled: enable,
        caea_pto_vta: pv ? Number(pv) : null,
        caea_timeout_seconds: Number(timeout),
      });
      toast({ title: enable ? "Contingencia activada" : "Contingencia apagada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: arcaErrorMessage(e), variant: "error" });
    }
  };
  const env: ArcaEnv = s?.environment ?? "homologacion";
  const current = config.caea.find((c) => c.environment === env);
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Si ARCA no responde, la venta se cobra igual y la factura queda en cola hasta que vuelva. Con la{" "}
        <Term k="contingencia" /> activada, además, la factura sale al instante con el <Term k="caea" /> de la quincena
        y NinjaSoft la informa a ARCA después, solo.
      </p>
      <Callout tone="info" icon={CloudOff} title="Necesitás un punto de venta extra, sólo para contingencia">
        ARCA exige que las facturas con CAEA usen un punto de venta distinto de los de todos los días.
      </Callout>
      <Disclosure title="Cómo dar de alta el punto de venta de contingencia" variant="help">
        <HowTo
          steps={[
            { title: "Entrá a ARCA", body: <ExtLink href={ARCA_LINKS.login}>Ingresar con clave fiscal</ExtLink> },
            {
              title: "Administración de puntos de venta y domicilios",
              body: <>A/B/M de Puntos de venta &gt; <strong>Agregar</strong>.</>,
            },
            {
              title: "Sistema: RECE para aplicativo y web services - CAEA",
              body: "Es el tipo de emisión anticipada. Anotá el número.",
            },
            { title: "Cargalo acá abajo", body: "NinjaSoft pide el CAEA de cada quincena por adelantado." },
          ]}
        />
      </Disclosure>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Punto de venta de contingencia"
          inputMode="numeric"
          value={pv}
          onChange={(e) => setPv(e.target.value.replace(/\D/g, "").slice(0, 5))}
          disabled={!canWrite}
        />
        <Select
          label="Pasar a contingencia si ARCA no responde en"
          value={timeout}
          onChange={setTimeoutS}
          options={["5", "10", "15", "30"].map((v) => ({ value: v, label: `${v} segundos` }))}
          disabled={!canWrite}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => save(true)} loading={m.saveSettings.isPending} disabled={!canWrite || !pv}>
          {on ? "Guardar cambios" : "Activar contingencia"}
        </Button>
        {on && (
          <Button variant="ghost" onClick={() => save(false)} disabled={!canWrite}>
            Apagar
          </Button>
        )}
      </div>
      {on && (
        <div className="rounded-md bg-muted p-3">
          {current ? (
            <p>
              CAEA vigente <span className="font-mono">{current.caea}</span> del {formatFiscalDate(current.fch_vig_desde)}{" "}
              al {formatFiscalDate(current.fch_vig_hasta)}. Las facturas se informan hasta el{" "}
              {formatFiscalDate(current.fch_tope_inf)}.
            </p>
          ) : (
            <p className="text-muted-foreground">
              Todavía no hay CAEA. NinjaSoft lo pide solo (dentro de los 5 días anteriores a cada quincena).
              {s?.caea_last_message ? ` Último intento: ${s.caea_last_message}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. Producción: guía paso a paso (ProductionGuide, ADR-153).
// ---------------------------------------------------------------------------
