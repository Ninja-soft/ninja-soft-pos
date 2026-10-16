"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudOff, FlaskConical, Lock, Rocket, Store } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { ARCA_LINKS, arcaErrorMessage, type ArcaEnv, type WizardStepKey } from "@/lib/arca/labels";
import { caeaPosWarning, goLivePrereqs, padPos, reconcilePos, webServicePos } from "@/lib/arca/envSwitch";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import type { ArcaConfig, TestResult } from "@/modules/arca/api";
import { useArcaMutations } from "@/modules/arca/hooks";
import { ExtLink, HowTo, Term } from "./shared";

// Modo de facturación (ADR-155): Prueba o Real con un toque, con la
// verificación de los puntos de venta del modo real (FEParamGetPtosVenta) y
// la acción para dejarlos bien; y el respaldo CAEA (contingencia) prendido o
// apagado con la explicación de qué cambia. "Contingencia" NO es el modo
// prueba: es facturar con CAEA cuando ARCA no responde.

export function ArcaModeCard({
  config,
  canWrite,
  onGoStep,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  /** Abre un paso del asistente (guía de producción o contingencia). */
  onGoStep?: (k: WizardStepKey) => void;
}) {
  const s = config.settings;
  const env: ArcaEnv = s?.environment ?? "homologacion";
  const [goLive, setGoLive] = useState(false);
  const [back, setBack] = useState(false);
  const m = useArcaMutations();
  const { toast } = useToast();

  const options: { env: ArcaEnv; title: string; text: string; icon: typeof Rocket }[] = [
    { env: "homologacion", title: "Prueba", text: "Facturas sin validez fiscal, para probar.", icon: FlaskConical },
    { env: "produccion", title: "Real", text: "Cada factura vale ante ARCA.", icon: Rocket },
  ];

  return (
    <section className="rounded-md border border-border bg-card p-4" aria-labelledby="arca-mode-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="arca-mode-title" className="text-sm font-semibold">
          Modo de facturación
        </h3>
        <Badge tone={env === "produccion" ? "success" : "info"}>{env === "produccion" ? "Facturando en real" : "Modo prueba"}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Modo de facturación">
        {options.map((o) => {
          const on = env === o.env;
          const Icon = o.icon;
          return (
            <button
              key={o.env}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!canWrite || on}
              onClick={() => (o.env === "produccion" ? setGoLive(true) : setBack(true))}
              className={cn(
                "flex min-h-16 flex-col items-start gap-1 rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                on ? "choice-on" : "bg-fg-4 hover:bg-fg-6",
                !canWrite && !on && "cursor-not-allowed opacity-60",
                on && "cursor-default",
              )}
            >
              <span className="flex w-full items-center gap-1.5 font-semibold">
                <Icon size={15} aria-hidden /> {o.title}
                {on && (
                  <span className="ml-auto flex items-center gap-1 text-xs font-medium text-success">
                    <CheckCircle2 size={14} aria-hidden /> Activo
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{o.text}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {env === "produccion"
          ? "Para volver a probar tocá Prueba. Para volver a real, NinjaSoft revisa de nuevo tus puntos de venta."
          : "Al tocar Real, NinjaSoft revisa en ARCA tus puntos de venta del modo real y te dice qué hacer antes de aceptar."}
      </p>

      <ContingencyRow config={config} canWrite={canWrite} onGoStep={onGoStep} />

      {goLive && <GoLiveDialog config={config} canWrite={canWrite} onClose={() => setGoLive(false)} onGoStep={onGoStep} />}

      <ConfirmDialog
        open={back}
        onOpenChange={setBack}
        title="¿Volver al modo prueba?"
        description="Desde ahora las ventas generan facturas de prueba: no tienen validez fiscal y no sirven para tus clientes ni para ARCA. Lo que ya está en la cola sigue en real. Podés volver a real cuando quieras (se revisan de nuevo los puntos de venta)."
        confirmLabel="Sí, volver a prueba"
        loading={m.setEnvironment.isPending}
        onConfirm={async () => {
          try {
            await m.setEnvironment.mutateAsync({ env: "homologacion" });
            setBack(false);
            toast({ title: "Volviste al modo prueba", description: "Las facturas nuevas no tienen validez fiscal.", variant: "success" });
          } catch (e) {
            setBack(false);
            toast({ title: "No se pudo cambiar", description: arcaErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}
ArcaModeCard.displayName = "ArcaModeCard";

// ---------------------------------------------------------------------------
// Contingencia CAEA: prender o apagar con la explicación.
// ---------------------------------------------------------------------------
function ContingencyRow({
  config,
  canWrite,
  onGoStep,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  onGoStep?: (k: WizardStepKey) => void;
}) {
  const s = config.settings;
  const on = Boolean(s?.caea_enabled);
  const [ask, setAsk] = useState<boolean | null>(null);
  const m = useArcaMutations();
  const { toast } = useToast();
  const hasPv = s?.caea_pto_vta != null;
  return (
    <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3">
      <div className="min-w-0 text-sm">
        <p className="font-medium">
          <CloudOff size={15} className="mr-1.5 inline-block align-[-2px] text-muted-foreground" aria-hidden />
          Respaldo si ARCA no responde{" "}
          <span className="whitespace-nowrap font-normal text-muted-foreground">
            (<Term k="contingencia">contingencia</Term>)
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {on
            ? `Prendido: si ARCA se cae, la factura sale al instante con el CAEA (punto de venta ${padPos(s?.caea_pto_vta)}) y se informa después.`
            : "Apagado: si ARCA se cae, la venta se cobra igual y la factura espera en la cola hasta que vuelva."}{" "}
          No es el modo prueba.
        </p>
      </div>
      <Switch
        checked={on}
        onCheckedChange={(v) => {
          if (v && !hasPv) {
            onGoStep?.("contingencia");
            return;
          }
          setAsk(v);
        }}
        disabled={!canWrite || m.saveSettings.isPending}
        label="Respaldo CAEA"
      />
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={ask ? "¿Prender el respaldo CAEA?" : "¿Apagar el respaldo CAEA?"}
        description={
          ask
            ? `Si ARCA no responde, la factura sale al momento con el CAEA de la quincena en el punto de venta ${padPos(s?.caea_pto_vta)} y NinjaSoft la informa a ARCA cuando vuelve. Ese punto de venta tiene que existir en ARCA como CAEA.`
            : "Si ARCA no responde, la venta se cobra igual y la factura queda en la cola hasta que ARCA vuelva. Lo que ya se emitió con CAEA se sigue informando."
        }
        confirmLabel={ask ? "Sí, prender" : "Sí, apagar"}
        loading={m.saveSettings.isPending}
        onConfirm={async () => {
          const v = Boolean(ask);
          try {
            await m.saveSettings.mutateAsync({ caea_enabled: v });
            setAsk(null);
            toast({ title: v ? "Respaldo CAEA prendido" : "Respaldo CAEA apagado", variant: "success" });
          } catch (e) {
            setAsk(null);
            toast({ title: "No se pudo guardar", description: arcaErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pasar a real: verificar puntos de venta, arreglarlos y aceptar.
// ---------------------------------------------------------------------------
function GoLiveDialog({
  config,
  canWrite,
  onClose,
  onGoStep,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  onClose: () => void;
  onGoStep?: (k: WizardStepKey) => void;
}) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const prereqs = useMemo(() => goLivePrereqs(config.checklist.items), [config.checklist.items]);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const verify = async () => {
    setError(null);
    setTesting(true);
    try {
      const r = await m.testConexion.mutateAsync("produccion");
      setResult(r);
      setPicks({});
    } catch (e) {
      setResult(null);
      setError(arcaErrorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  // Se verifica solo al abrir (si no falta algo que se arregla en la guía).
  useEffect(() => {
    if (prereqs.length === 0 && canWrite) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listed = result?.pos ?? null;
  const ws = webServicePos(listed);
  const posStepOk = Boolean(result?.steps.find((x) => x.key === "ptos_venta")?.ok);
  const rows = posStepOk ? reconcilePos(config.stores, listed) : [];
  const missing = rows.filter((r) => !r.ok);
  const firstFail = result?.steps.find((x) => !x.ok) ?? null;
  const posOnlyProblem = Boolean(result && !result.ok && posStepOk && firstFail && ["pv_sucursales", "ultimo"].includes(firstFail.key) && missing.length > 0);
  const caeaWarn = posStepOk ? caeaPosWarning(Boolean(config.settings?.caea_enabled), config.settings?.caea_pto_vta ?? null, listed) : null;
  const fail = firstFail ? humanError(firstFail.code ?? null, firstFail.message ?? null) : null;

  const pickFor = (id: string, suggestion: number | null) => picks[id] ?? (suggestion != null ? String(suggestion) : "");

  const applyPos = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const r of missing) {
        const v = pickFor(r.id, r.suggestion);
        if (!v) continue;
        const n = Number(v);
        if (r.kind === "store") await m.setStorePos.mutateAsync({ id: r.id, n });
        else await m.setRegisterPos.mutateAsync({ id: r.id, n });
      }
      toast({ title: "Puntos de venta actualizados", description: "Verificando de nuevo en ARCA.", variant: "success" });
      await verify();
    } catch (e) {
      setError(arcaErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const accept = async () => {
    setError(null);
    try {
      await m.setEnvironment.mutateAsync({ env: "produccion" });
      toast({ title: "Listo: estás facturando en real", variant: "success" });
      onClose();
    } catch (e) {
      setError(arcaErrorMessage(e));
    }
  };

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Pasar a facturar en real">
      <div className="space-y-4 text-sm">
        <div className="rounded-md bg-muted p-3">
          <p className="font-medium text-foreground">Qué cambia</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            <li>Cada venta con factura sale con validez fiscal ante ARCA.</li>
            <li>Se usa el certificado real y los puntos de venta reales de cada sucursal.</li>
            <li>Las facturas de prueba no se convierten. Podés volver a prueba con un toque.</li>
          </ul>
        </div>

        {prereqs.length > 0 && (
          <Callout tone="warning" icon={Lock} title="Antes falta">
            <ul className="space-y-1">
              {prereqs.map((p) => (
                <li key={p.key}>
                  <span className="font-medium text-foreground">{p.label}.</span> {p.help}
                </li>
              ))}
            </ul>
            {onGoStep && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  onClose();
                  onGoStep("produccion");
                }}
              >
                Abrir la guía paso a paso
              </Button>
            )}
          </Callout>
        )}

        {prereqs.length === 0 && (
          <>
            {testing && (
              <p className="flex items-center gap-2 text-muted-foreground" role="status">
                <Store size={15} aria-hidden /> Revisando en ARCA (modo real) tu certificado y tus puntos de venta…
              </p>
            )}

            {error && (
              <Callout tone="danger" icon={AlertTriangle} title="No se pudo completar">
                {error}
              </Callout>
            )}

            {result?.ok && !testing && (
              <Callout tone="success" icon={CheckCircle2} title="Todo listo en ARCA">
                ARCA aceptó tu certificado y tus puntos de venta: {ws.map(padPos).join(", ")}.
              </Callout>
            )}

            {posStepOk && rows.length > 0 && !testing && (
              <div>
                <p className="font-medium text-foreground">Puntos de venta de tus sucursales</p>
                <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                  {rows.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 font-medium">{r.label}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{padPos(r.current)}</span>
                        {r.ok ? (
                          <Badge tone="success">En ARCA</Badge>
                        ) : ws.length > 0 ? (
                          <Select
                            value={pickFor(r.id, r.suggestion) || null}
                            onChange={(v) => setPicks((p) => ({ ...p, [r.id]: v }))}
                            options={ws.map((n) => ({ value: String(n), label: `Usar ${padPos(n)}` }))}
                            placeholder="Elegí uno"
                            aria-label={`Punto de venta para ${r.label}`}
                            disabled={!canWrite || saving}
                          />
                        ) : (
                          <Badge tone="danger">{r.current == null ? "Falta número" : "No está en ARCA"}</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {posOnlyProblem && ws.length > 0 && !testing && (
              <Callout tone="warning" icon={Store} title="Hay que actualizar el punto de venta">
                ARCA tiene estos puntos de venta para Web Services: {ws.map(padPos).join(", ")}. Aceptá el cambio y la sucursal
                pasa a usar el elegido (en modo prueba sirve cualquiera, así que no se rompe nada).
                <div className="mt-2">
                  <Button size="sm" onClick={applyPos} loading={saving} disabled={!canWrite}>
                    Aceptar y actualizar
                  </Button>
                </div>
              </Callout>
            )}

            {posStepOk && ws.length === 0 && !testing && (
              <Callout tone="warning" icon={Store} title="ARCA no tiene puntos de venta Web Services para tu CUIT">
                <HowTo
                  steps={[
                    { title: "Entrá a ARCA con tu clave fiscal", body: <ExtLink href={ARCA_LINKS.login}>Ingresar a ARCA</ExtLink> },
                    { title: "Administración de puntos de venta y domicilios", body: "A/B/M de Puntos de venta, Agregar." },
                    {
                      title: "Sistema Web Services",
                      body: "Elegí el de Web Services (RECE o Factura Electrónica Monotributo). Comprobantes en línea no sirve.",
                    },
                    { title: "Volvé acá y verificá de nuevo", body: "Si recién lo diste de alta, puede tardar unos minutos." },
                  ]}
                />
              </Callout>
            )}

            {result && !result.ok && !posOnlyProblem && !(posStepOk && ws.length === 0) && fail && !testing && (
              <Callout tone="danger" icon={AlertTriangle} title={fail.title}>
                {fail.action}
                {firstFail?.code && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">Código: {firstFail.code}</span>}
                {onGoStep && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    onClick={() => {
                      onClose();
                      onGoStep("produccion");
                    }}
                  >
                    Abrir la guía paso a paso
                  </Button>
                )}
              </Callout>
            )}

            {caeaWarn && !testing && (
              <Callout tone="warning" icon={CloudOff} title="Respaldo CAEA">
                {caeaWarn}
              </Callout>
            )}

            {!config.can_owner && (
              <Callout tone="neutral" icon={Lock} title="Sólo el dueño puede pasar a facturar en real" />
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancelar
              </Button>
              {!result?.ok && (
                <Button variant="secondary" onClick={() => void verify()} loading={testing} disabled={!canWrite || saving}>
                  Verificar de nuevo
                </Button>
              )}
              <Button
                onClick={accept}
                loading={m.setEnvironment.isPending}
                disabled={!canWrite || !config.can_owner || !result?.ok || testing}
              >
                <Rocket size={16} /> Aceptar y facturar en real
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
