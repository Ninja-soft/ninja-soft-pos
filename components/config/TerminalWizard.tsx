"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Info, QrCode, Radar, Store } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { TenderLogo } from "@/components/pos/ui/TenderLogo";
import { ACQUIRERS, acquirerLabel, acquirerLogo, isAcquirerKey } from "@/lib/payments/acquirers";
import { paymentIcon } from "@/lib/payments/logos";
import {
  DEFAULT_INTEGRATION,
  isIntegratedKind,
  parseIntegration,
  withIntegration,
  type IntegrationConfig,
} from "@/lib/payments/terminal/config";
import {
  PROVIDER_SHORT,
  SETUP_TYPES,
  WIZARD_STEPS,
  defaultAcquirer,
  idHelp,
  providerLogoKey,
  setupTypeDef,
  setupTypeOf,
  stepProblem,
  suggestLabel,
  type SetupType,
  type WizardStep,
} from "@/lib/payments/terminalSetup";
import {
  TERMINAL_KIND_LABEL,
  kindForProvider,
  terminalExternalIdError,
  type PaymentTerminal,
  type TerminalKind,
} from "@/lib/payments/terminals";
import type { Branch, BranchRegister } from "@/modules/branches/logic";
import { terminalErrorMessage, type TerminalInput } from "@/modules/config/api";
import { useTerminalMutations } from "@/modules/config/hooks";
import { posApi } from "@/modules/pos/api";
import { cn } from "@/lib/utils/cn";
import { IntegratedTerminalFields } from "./IntegratedTerminalFields";
import { providerLabel } from "./ScopedConfig";

// Alta y edición guiada de una terminal (Configuración, Terminales). Cinco
// pasos: tipo, ubicación, identificación, detalles y resumen. Escribe lo mismo
// que el formulario anterior en payment_terminals (ADR-049 y ADR-053).

export type TerminalDraft = {
  id?: string;
  type: SetupType | null;
  store_id: string;
  cash_register_id: string | null;
  provider_key: string;
  kind: TerminalKind;
  integration: IntegrationConfig;
  meta: Record<string, unknown> | null;
  external_id: string;
  environment: "prod" | "test" | null;
  label: string;
  labelTouched: boolean;
  merchant_number: string;
  acquirer: string;
  is_default: boolean;
  active: boolean;
  notes: string;
  /** Posnet sin integrar: el dueño eligió registrarlo igual. */
  registerManual: boolean;
};

export function newTerminalDraft(storeId: string, registerId: string | null = null): TerminalDraft {
  return {
    type: null,
    store_id: storeId,
    cash_register_id: registerId,
    provider_key: "",
    kind: "point",
    integration: DEFAULT_INTEGRATION,
    meta: null,
    external_id: "",
    environment: null,
    label: "",
    labelTouched: false,
    merchant_number: "",
    acquirer: "",
    is_default: Boolean(registerId),
    active: true,
    notes: "",
    registerManual: false,
  };
}

export function draftFromTerminal(t: PaymentTerminal): TerminalDraft {
  return {
    id: t.id,
    type: setupTypeOf(t.kind),
    store_id: t.store_id,
    cash_register_id: t.cash_register_id,
    provider_key: t.provider_key,
    kind: t.kind,
    integration: parseIntegration(t.external_meta),
    meta: t.external_meta ?? null,
    external_id: t.external_id ?? "",
    environment: t.environment,
    label: t.label,
    labelTouched: true,
    merchant_number: t.merchant_number ?? "",
    acquirer: t.acquirer ?? "",
    is_default: t.is_default,
    active: t.active,
    notes: t.notes ?? "",
    registerManual: true,
  };
}

type Detected = { id: string; label: string };

const DETECT: Record<string, () => Promise<Detected[]>> = {
  mercadopago_point: async () =>
    (await posApi.pointDevices()).map((d) => ({
      id: d.id,
      label: d.operating_mode === "PDV" ? "Modo integrado (PDV)" : `Modo ${d.operating_mode || "autónomo"}`,
    })),
  nave_point: async () => (await posApi.navePointDevices()).map((d) => ({ id: d.id, label: d.label })),
  fiserv_point: async () => (await posApi.cloverDevices()).map((d) => ({ id: d.id, label: d.label })),
};

function BrandLogo({ provider, size = 24 }: { provider: string; size?: number }) {
  // Decorativo: siempre va junto al nombre de la marca o del tipo.
  return <TenderLogo source={{ logo: paymentIcon(providerLogoKey(provider)) }} alt="" size={size} fallback="card" />;
}

export function TerminalWizard({
  initial,
  onClose,
  branches,
  registersOf,
  terminals,
  integratedAllowed,
  onCreateQr,
  onCreatedIntegrated,
}: {
  initial: TerminalDraft;
  onClose: () => void;
  branches: Branch[];
  registersOf: (storeId: string) => BranchRegister[];
  terminals: PaymentTerminal[];
  integratedAllowed: boolean;
  /** Crea la caja QR de Mercado Pago de la caja (Edge mp_qr). */
  onCreateQr: (registerId: string) => void;
  /** Terminal integrada recién creada: se abre Conectar. */
  onCreatedIntegrated: (t: PaymentTerminal) => void;
}) {
  const { toast } = useToast();
  const mut = useTerminalMutations();
  const editing = Boolean(initial.id);
  const [d, setD] = useState<TerminalDraft>(initial);
  const [step, setStep] = useState<WizardStep>(editing ? 1 : 0);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const set = (patch: Partial<TerminalDraft>) => {
    setError(null);
    setD((prev) => ({ ...prev, ...patch }));
  };

  const store = branches.find((b) => b.id === d.store_id) ?? null;
  const registers = registersOf(d.store_id);
  const register = registers.find((r) => r.id === d.cash_register_id) ?? null;
  const integrated = isIntegratedKind(d.kind);
  const simulator = integrated && d.integration.adapter === "simulator";
  const help = d.provider_key ? idHelp(d.provider_key, d.kind, simulator) : null;
  const others = terminals.filter((t) => t.id !== d.id && !t.deleted_at);
  const manualOnly = d.type === "manual" && !d.registerManual;

  const pickType = (type: SetupType) => {
    if (editing) return;
    const def = setupTypeDef(type);
    const provider = def.providers.length === 1 ? def.providers[0]! : "";
    set({
      type,
      provider_key: provider,
      kind: type === "integrated" ? "posnet_integrado" : provider ? kindForProvider(provider) : type === "manual" ? "posnet_manual" : "point",
      integration: { ...DEFAULT_INTEGRATION },
      external_id: "",
      environment: type === "qr" ? "prod" : null,
      registerManual: false,
    });
    setDetected(null);
    if (type === "integrated" && !integratedAllowed) {
      setError("La terminal conectada viene desde el plan Pro. Mientras tanto, el posnet sin integrar funciona en cualquier plan.");
    }
  };

  const pickProvider = (provider: string) => {
    if (editing) return;
    set({
      provider_key: provider,
      kind: d.type === "integrated" ? d.kind : kindForProvider(provider),
      external_id: "",
    });
    setDetected(null);
  };

  const suggestion = () =>
    suggestLabel({
      provider: d.provider_key,
      kind: d.kind,
      registerName: register?.name,
      storeName: store?.short_name || store?.name,
      taken: others.map((t) => t.label),
    });

  const goTo = (next: WizardStep) => {
    // Al entrar a Detalles se propone nombre y adquirente si no los tocó.
    if (next >= 3) {
      setD((prev) => ({
        ...prev,
        label: prev.labelTouched ? prev.label : suggestion(),
        acquirer: prev.acquirer || (editing ? "" : (defaultAcquirer(prev.provider_key) ?? "")),
      }));
    }
    setError(null);
    setStep(next);
  };

  const next = () => {
    const draftForCheck = {
      ...d,
      label: step >= 3 ? d.label : d.label || "x",
      simulator,
    };
    if (step === 0 && d.type && !d.provider_key) return setError("Elegí la marca.");
    if (step === 0 && d.type === "integrated" && !integratedAllowed && !editing) {
      return setError("La terminal conectada viene desde el plan Pro. Mientras tanto, el posnet sin integrar funciona en cualquier plan.");
    }
    const problem = stepProblem(step, draftForCheck);
    if (problem) return setError(problem);
    if (step < 4) goTo((step + 1) as WizardStep);
  };

  const detect = async () => {
    const fn = DETECT[d.provider_key];
    if (!fn) return;
    setDetecting(true);
    setError(null);
    try {
      const list = await fn();
      setDetected(list);
      if (list.length === 1 && !d.external_id) set({ external_id: list[0]!.id });
    } catch (e) {
      setDetected(null);
      setError(
        e instanceof Error && e.message
          ? `No se pudo detectar: ${e.message}`
          : "No se pudo detectar. Revisá que la cuenta esté conectada en Medios de pago.",
      );
    } finally {
      setDetecting(false);
    }
  };

  const save = () => {
    const kind: TerminalKind = d.kind;
    // El simulador no tiene n° de terminal real: se le pone uno propio.
    const externalId =
      integrated && !d.external_id.trim() && simulator ? `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}` : d.external_id;
    const err = terminalExternalIdError(kind, externalId);
    if (err) return setError(err);
    if (!d.label.trim()) return setError("Poné un nombre para reconocerla.");
    const input: TerminalInput = {
      store_id: d.store_id,
      cash_register_id: d.cash_register_id,
      provider_key: d.provider_key,
      kind,
      external_id: externalId.trim() || null,
      ...(integrated ? { external_meta: withIntegration(d.meta, parseIntegration({ integration: d.integration })) } : {}),
      environment: kind === "qr_caja" ? (d.environment ?? "prod") : null,
      label: d.label.trim(),
      merchant_number: d.merchant_number.replace(/[^0-9a-z]/gi, "").slice(0, 20) || null,
      acquirer: d.acquirer.trim().slice(0, 40) || null,
      is_default: d.is_default && Boolean(d.cash_register_id),
      active: d.active,
      notes: d.notes.trim() || null,
    };
    const fail = (e: unknown) => setError(terminalErrorMessage(e));
    if (d.id) {
      mut.update.mutate(
        { id: d.id, patch: input },
        {
          onSuccess: () => {
            toast({ title: "Terminal guardada", variant: "success" });
            onClose();
          },
          onError: fail,
        },
      );
      return;
    }
    mut.create.mutate(input, {
      onSuccess: (id) => {
        toast({ title: "Terminal guardada", variant: "success" });
        onClose();
        if (integrated) {
          onCreatedIntegrated({
            id,
            ...input,
            external_meta: input.external_meta ?? null,
            label: input.label,
            is_default: input.is_default,
            active: input.active,
            last_seen_at: null,
          } as PaymentTerminal);
        }
      },
      onError: fail,
    });
  };

  const saving = mut.create.isPending || mut.update.isPending;

  // ── Encabezado con los pasos ─────────────────────────────────────────────
  const header = (
    <div>
      <p className="text-lg font-bold tracking-tight">{editing ? `Editar ${initial.label}` : "Nueva terminal"}</p>
      <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="Pasos">
        {WIZARD_STEPS.map((name, i) => {
          const done = i < step;
          const current = i === step;
          const reachable = editing || done;
          return (
            <li key={name}>
              <button
                type="button"
                disabled={!reachable || manualOnly}
                onClick={() => goTo(i as WizardStep)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition disabled:cursor-default",
                  current
                    ? "choice-on text-foreground"
                    : done
                      ? "border-border text-foreground hover:bg-muted"
                      : "border-transparent text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold",
                    done ? "bg-[var(--pos-solid)] text-white" : current ? "bg-foreground text-background" : "bg-muted",
                  )}
                  aria-hidden
                >
                  {done ? <Check size={10} strokeWidth={3.5} /> : i + 1}
                </span>
                <span className={cn(!current && "hidden sm:inline")}>{name}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );

  // ── Pie ──────────────────────────────────────────────────────────────────
  const footer = (
    <>
      {step === 0 ? (
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => goTo((step - 1) as WizardStep)}>
          <ArrowLeft size={15} /> Atrás
        </Button>
      )}
      {manualOnly ? (
        <Link
          href={"/configuracion?seccion=posnet" as never}
          onClick={onClose}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--pos-solid)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--pos-solid-hover)]"
        >
          Ir a Tarjeta en posnet <ArrowRight size={15} />
        </Link>
      ) : step < 4 ? (
        <Button onClick={next}>
          Siguiente <ArrowRight size={15} />
        </Button>
      ) : (
        <Button onClick={save} loading={saving} disabled={saving}>
          {editing ? "Guardar cambios" : integrated ? "Guardar y conectar" : "Guardar terminal"}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={editing ? "Editar terminal" : "Nueva terminal"}
      header={header}
      footer={footer}
      className="sm:max-w-2xl"
    >
      <div className="space-y-5">
        {step === 0 && (
          <StepType
            d={d}
            editing={editing}
            integratedAllowed={integratedAllowed}
            pickType={pickType}
            pickProvider={pickProvider}
            set={set}
          />
        )}

        {step === 1 && (
          <section className="space-y-4">
            <StepTitle title="¿Dónde está?" text="Elegí la sucursal y la caja donde se usa." />
            <Select
              label="Sucursal"
              value={d.store_id}
              options={branches.map((b) => ({
                value: b.id,
                label: b.name,
                icon: <BranchDot branch={b} />,
                description: b.address ?? undefined,
              }))}
              onChange={(id) => set({ store_id: id, cash_register_id: null, is_default: false })}
            />
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">Caja</p>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Caja">
                {registers.map((r) => {
                  const own = others.filter((t) => t.cash_register_id === r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={d.cash_register_id === r.id}
                      onClick={() => set({ cash_register_id: r.id, is_default: editing ? d.is_default : true })}
                      className={choiceClass(d.cash_register_id === r.id, "flex items-start gap-3 rounded-lg p-3 pr-9")}
                    >
                      <Store size={16} className="mt-0.5 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{r.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {own.length === 0
                            ? "Sin terminales"
                            : `Ya tiene ${own.length === 1 ? own[0]!.label : `${own.length} terminales`}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="radio"
                  aria-checked={d.cash_register_id === null}
                  onClick={() => set({ cash_register_id: null, is_default: false })}
                  className={choiceClass(d.cash_register_id === null, "flex items-start gap-3 rounded-lg p-3 pr-9")}
                >
                  <Store size={16} className="mt-0.5 text-muted-foreground" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">Toda la sucursal</span>
                    <span className="block text-xs text-muted-foreground">
                      Para cualquier caja sin una propia, por ejemplo un Point que va y viene.
                    </span>
                  </span>
                </button>
              </div>
            </div>
            <Callout tone="neutral" icon={Info} className="text-sm">
              Si la caja tiene una sola terminal, el POS la usa sola. Si tiene dos del mismo medio, ofrece primero la que
              marques por defecto.
            </Callout>
          </section>
        )}

        {step === 2 && help && (
          <section className="space-y-4">
            <StepTitle
              title={d.type === "qr" ? "Caja QR de Mercado Pago" : "Identificá la terminal"}
              text={
                d.type === "qr"
                  ? "Cada caja puede tener su propio QR fijo."
                  : "Con este dato el POS sabe a qué equipo mandar el cobro."
              }
            />

            {d.type === "qr" && !editing && d.cash_register_id && (
              <Callout
                tone="brand"
                icon={QrCode}
                title="Crear la caja QR en Mercado Pago"
                actions={
                  <Button
                    size="sm"
                    onClick={() => {
                      onClose();
                      onCreateQr(d.cash_register_id!);
                    }}
                  >
                    <QrCode size={14} /> Crear para {register?.name ?? "la caja"}
                  </Button>
                }
              >
                NinjaSoft la da de alta con la dirección de la sucursal y la registra acá. No hace falta cargar nada más.
              </Callout>
            )}

            {integrated && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Empezá con el <strong className="text-foreground">simulador</strong> para probar el circuito completo sin
                  cobrar. Cuando tengas la terminal en modo integrado, cambiá el protocolo por el de la marca.
                </p>
                <IntegratedTerminalFields
                  provider={d.provider_key}
                  value={d.integration}
                  onChange={(integration) => set({ integration })}
                />
              </div>
            )}

            <div className="rounded-lg bg-muted/50 p-4">
              <p className="mb-2 text-sm font-semibold">
                {d.type === "qr" && d.cash_register_id && !editing ? "Si ya la creaste en Mercado Pago" : "Dónde encontrarlo"}
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                {help.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>

            <div className="flex items-end gap-2">
              <Input
                label={help.label}
                value={d.external_id}
                placeholder={help.placeholder}
                onChange={(e) => set({ external_id: e.target.value.trim() })}
                autoComplete="off"
              />
              {help.detect && (
                <Button variant="secondary" onClick={detect} loading={detecting} disabled={detecting} className="shrink-0">
                  <Radar size={15} /> Detectar
                </Button>
              )}
            </div>

            {detected && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {detected.length === 0 ? "No encontramos equipos en la cuenta." : "Equipos de tu cuenta"}
                </p>
                <div className="grid gap-2" role="radiogroup" aria-label="Equipos detectados">
                  {detected.map((x) => {
                    const used = others.find((t) => t.external_id === x.id);
                    return (
                      <button
                        key={x.id}
                        type="button"
                        role="radio"
                        aria-checked={d.external_id === x.id}
                        disabled={Boolean(used)}
                        onClick={() => set({ external_id: x.id })}
                        className={choiceClass(d.external_id === x.id, "flex items-center gap-3 rounded-lg p-3 pr-9")}
                      >
                        <BrandLogo provider={d.provider_key} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-sm">{x.id}</span>
                          <span className="block text-xs text-muted-foreground">
                            {used ? `Ya registrada como ${used.label}` : x.label}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {d.type === "qr" && (
              <div>
                <p className="mb-2 text-sm font-medium text-muted-foreground">Ambiente</p>
                <Segmented
                  aria-label="Ambiente"
                  value={d.environment ?? "prod"}
                  options={[
                    { value: "prod", label: "Producción" },
                    { value: "test", label: "Prueba" },
                  ]}
                  onChange={(v) => set({ environment: v })}
                />
              </div>
            )}

            {integrated && !editing && (
              <p className="text-sm text-muted-foreground">
                Al guardar se abre <strong className="text-foreground">Conectar</strong>: emparejás la terminal con esta PC
                y hacés una venta de prueba.
              </p>
            )}
          </section>
        )}

        {step === 3 && (
          <section className="space-y-4">
            <StepTitle title="Detalles" text="Cómo la ve el cajero y qué datos van al cupón." />
            <Input
              label="Nombre"
              value={d.label}
              onChange={(e) => set({ label: e.target.value, labelTouched: true })}
              hint="Así aparece en la lista y en el POS si hay que elegir. Te propusimos uno."
              maxLength={60}
            />
            <Input
              label="N° de comercio (opcional)"
              inputMode="numeric"
              value={d.merchant_number}
              onChange={(e) => set({ merchant_number: e.target.value })}
              hint="Aparece en el cupón y sirve para conciliar las ventas con la liquidación del adquirente."
            />
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">Adquirente (opcional)</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Adquirente">
                {ACQUIRERS.map((a) => {
                  const on = d.acquirer === a.key;
                  return (
                    <button
                      key={a.key}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => set({ acquirer: on ? "" : a.key })}
                      className={choiceClass(on, "flex min-h-[48px] items-center gap-2.5 rounded-md px-3 py-2 pr-8")}
                    >
                      <TenderLogo source={{ logo: acquirerLogo(a.key) }} alt="" size={22} fallback="card" />
                      <span className="min-w-0 text-[13px] font-semibold leading-tight">{a.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Quién procesa los cobros de esta terminal. Con eso se busca el n° de comercio y se agrupa en Conciliación.
                {d.acquirer && !isAcquirerKey(d.acquirer) && ` Antes figuraba "${d.acquirer}".`}
              </p>
            </div>
            <Input label="Notas (opcional)" value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
            <div className="divide-y divide-border rounded-lg border border-border">
              {d.cash_register_id && (
                <ToggleRow
                  label="Usar por defecto en esta caja"
                  text="Si la caja tiene otra terminal del mismo medio, el POS ofrece esta primero."
                  checked={d.is_default}
                  onChange={(v) => set({ is_default: v })}
                />
              )}
              <ToggleRow
                label="Activa"
                text="Pausada queda registrada pero el POS no la ofrece."
                checked={d.active}
                onChange={(v) => set({ active: v })}
              />
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="space-y-4">
            <StepTitle title="Revisá y guardá" text="Así queda la terminal." />
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-4">
              <BrandLogo provider={d.provider_key} size={36} />
              <div className="min-w-0">
                <p className="truncate font-semibold">{d.label}</p>
                <p className="text-sm text-muted-foreground">
                  {providerLabel(d.provider_key)} · {TERMINAL_KIND_LABEL[d.kind]}
                </p>
              </div>
            </div>
            <dl className="divide-y divide-border rounded-lg border border-border text-sm">
              <SummaryRow k="Tipo" v={d.type ? setupTypeDef(d.type).title : ""} />
              <SummaryRow k="Sucursal" v={store?.name ?? ""} />
              <SummaryRow k="Caja" v={register?.name ?? "Toda la sucursal"} />
              <SummaryRow
                k="Identificador"
                v={d.external_id || (simulator ? "Se genera uno para el simulador" : "Sin cargar")}
                mono={Boolean(d.external_id)}
              />
              {integrated && <SummaryRow k="Protocolo" v={simulator ? "Simulador (no cobra)" : providerLabel(d.provider_key)} />}
              {d.type === "qr" && <SummaryRow k="Ambiente" v={d.environment === "test" ? "Prueba" : "Producción"} />}
              <SummaryRow k="N° de comercio" v={d.merchant_number || "Sin cargar"} />
              <SummaryRow k="Adquirente" v={d.acquirer ? acquirerLabel(d.acquirer) : "Sin elegir"} />
              {d.cash_register_id && <SummaryRow k="Por defecto en la caja" v={d.is_default ? "Sí" : "No"} />}
              <SummaryRow k="Estado" v={d.active ? "Activa" : "Pausada"} />
            </dl>
            <Callout tone="neutral" icon={Info} className="text-sm">
              {!d.active
                ? "Queda pausada: el POS no la ofrece hasta que la actives."
                : d.cash_register_id
                  ? `Cuando cobres en ${register?.name ?? "esta caja"} con ${PROVIDER_SHORT[d.provider_key] ?? providerLabel(d.provider_key)}, el POS usa esta terminal${d.is_default ? " primero" : ""}.`
                  : `Cualquier caja de ${store?.name ?? "la sucursal"} sin una terminal propia de este medio la va a usar.`}
            </Callout>
          </section>
        )}

        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Paso 1 ───────────────────────────────────────────────────────────────────

function StepType({
  d,
  editing,
  integratedAllowed,
  pickType,
  pickProvider,
  set,
}: {
  d: TerminalDraft;
  editing: boolean;
  integratedAllowed: boolean;
  pickType: (t: SetupType) => void;
  pickProvider: (p: string) => void;
  set: (patch: Partial<TerminalDraft>) => void;
}) {
  const types = editing ? SETUP_TYPES.filter((t) => t.key === d.type) : SETUP_TYPES;
  const def = d.type ? setupTypeDef(d.type) : null;
  const showBrands = def && def.providers.length > 1 && (d.type !== "manual" || d.registerManual);
  return (
    <section className="space-y-5">
      <StepTitle
        title="¿Qué tipo de terminal?"
        text={editing ? "El tipo y la marca no se cambian: para otro equipo, archivá esta y creá una nueva." : "Elegí cómo cobra el equipo."}
      />
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Tipo de terminal">
        {types.map((t) => {
          const on = d.type === t.key;
          const locked = t.key === "integrated" && !integratedAllowed && !editing;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => pickType(t.key)}
              className={choiceClass(on, "flex flex-col gap-2 rounded-lg p-3.5 pr-9")}
            >
              <span className="flex items-center gap-1.5">
                {(t.key === "manual" ? ["payway", "fiserv", "getnet"] : t.providers).map((p) => (
                  <BrandLogo key={p} provider={p} size={22} />
                ))}
                {locked && (
                  <Badge tone="brand" className="ml-1">
                    Plan Pro
                  </Badge>
                )}
              </span>
              <span>
                <span className="block text-sm font-semibold">{t.title}</span>
                <span className="mt-0.5 block text-sm text-foreground/90">{t.line}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t.brands}</span>
              </span>
            </button>
          );
        })}
      </div>

      {d.type === "manual" && !d.registerManual && (
        <Callout tone="neutral" icon={Info} title="No hace falta registrarlo">
          <p>
            En el POS el cajero elige Tarjeta en posnet, cobra en el posnet y carga lote, cupón y autorización. Qué datos
            pide y cómo se configura en Tarjeta en posnet.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            <Link
              href={"/configuracion?seccion=posnet" as never}
              className="inline-flex items-center gap-1 text-sm font-semibold text-foreground hover:underline"
            >
              Configurar Tarjeta en posnet <ExternalLink size={13} />
            </Link>
            <button
              type="button"
              onClick={() => set({ registerManual: true })}
              className="text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Registrarlo igual (para tener su n° de comercio a mano)
            </button>
          </div>
        </Callout>
      )}

      {showBrands && (
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Marca</p>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Marca">
            {def!.providers.map((p) => {
              const on = d.provider_key === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={editing && !on}
                  onClick={() => pickProvider(p)}
                  className={choiceClass(on, "flex min-h-[52px] items-center gap-2.5 rounded-md px-3 py-2 pr-8")}
                >
                  <BrandLogo provider={p} />
                  <span className="min-w-0 text-[13px] font-semibold leading-tight">
                    {d.type === "point" ? providerLabel(p) : PROVIDER_SHORT[p]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {d.type === "integrated" && d.provider_key && (
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Equipo</p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Equipo">
            {(
              [
                ["posnet_integrado", "Posnet", "Terminal de mostrador o móvil, conectada a la PC por cable o por red."],
                ["pinpad", "Pinpad", "Lector chico conectado a la PC: el cliente pasa la tarjeta y pone el PIN."],
              ] as const
            ).map(([kind, title, text]) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={d.kind === kind}
                disabled={editing && d.kind !== kind}
                onClick={() => set({ kind })}
                className={choiceClass(d.kind === kind, "rounded-lg p-3.5 pr-9")}
              >
                <span className="block text-sm font-semibold">{title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function StepTitle({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function ToggleRow({
  label,
  text,
  checked,
  onChange,
}: {
  label: string;
  text: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-3.5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{text}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </div>
  );
}

function SummaryRow({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3.5 py-2.5">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("min-w-0 break-all text-right font-medium", mono && "font-mono text-[13px]")}>{v}</dd>
    </div>
  );
}
