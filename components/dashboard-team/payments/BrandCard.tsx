"use client";

import { useState } from "react";
import {
  ChevronDown,
  CreditCard,
  Link2,
  Lock,
  Percent,
  Plug,
  QrCode,
  Settings2,
  Smartphone,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { firstPlanWithFeature, type PlanForUpgrade } from "@/modules/saas/gating";
import { PROVIDER_FEATURE } from "@/lib/payments/providerFeature";
import { featureInfo } from "@/lib/saas/featureInfo";
import {
  PLANS_KEY_BY_CHANNEL,
  channelLabel,
  connectionKeyOf,
  surchargeModeOf,
  type BrandGroup,
  type ChannelEntry,
} from "@/lib/payments/catalog";
import { CHANNEL_INFO, CHANNEL_SUMMARY } from "./copy";
import { BrandLogo, StatusChip, type StatusTone } from "./ui";
import { mpEnvOf, type Method } from "./types";

export type ChannelHandlers = {
  onToggle: (key: string, enabled: boolean) => void;
  onSurcharge: (key: string, pct: number) => void;
  onOpenPlans: (planKey: string, brandName: string) => void;
  onConnect: (brandKey: string) => void;
  // Contenido extra del detalle de un canal (p. ej. caja QR de Mercado Pago).
  renderChannelExtra?: (channelKey: string, method: Method | undefined) => React.ReactNode;
};

type GateCtx = {
  features: Record<string, boolean> | undefined;
  plans: PlanForUpgrade[];
};

// Gating por plan de un canal. Optimista mientras `features` carga. Sólo se
// gatean canales implementados: los "Próximamente" no prometen upgrade.
function gateOf(c: ChannelEntry, g: GateCtx) {
  const featureKey = PROVIDER_FEATURE[c.key];
  const locked =
    c.implemented && featureKey !== undefined && g.features !== undefined && g.features[featureKey] !== true;
  const target = locked && featureKey ? firstPlanWithFeature(g.plans, featureKey) : null;
  return { featureKey, locked, planName: target?.name ?? featureInfo(featureKey ?? "")?.minPlan ?? "superior" };
}

function envOf(connKey: string | null, byKey: Map<string, Method>) {
  if (!connKey) return "prod";
  const m = byKey.get(connKey);
  return connKey === "mercadopago" ? mpEnvOf(m) : m?.sandbox ? "test" : "prod";
}

// =============================================================================
// BrandCard: una marca con su conexión y sus canales (QR + link · Point).
// =============================================================================
export function BrandCard({
  group,
  byKey,
  features,
  plans,
  handlers,
}: {
  group: BrandGroup;
  byKey: Map<string, Method>;
  features: Record<string, boolean> | undefined;
  plans: PlanForUpgrade[];
  handlers: ChannelHandlers;
}) {
  const { brand, channels } = group;
  const [upgradeKey, setUpgradeKey] = useState<string | null>(null);
  const gate: GateCtx = { features, plans };
  const connKey = connectionKeyOf(brand.key);
  const connected = Boolean(connKey && byKey.get(connKey)?.config?.connected);
  const env = envOf(connKey, byKey);
  const gates = channels.map((c) => ({ c, ...gateOf(c, gate) }));
  const live = gates.filter((x) => x.c.implemented);
  const allSoon = live.length === 0;
  // Marcas sin cuenta que conectar (Directo): se cobran en su portal.
  const noConnection = !connKey;
  const allLocked = live.length > 0 && live.every((x) => x.locked);
  const firstLocked = live.find((x) => x.locked);

  let tone: StatusTone = "idle";
  let label = "Sin conectar";
  if (allSoon) [tone, label] = ["soon", "Próximamente"];
  else if (allLocked) [tone, label] = ["locked", `Plan ${firstLocked?.planName}`];
  else if (noConnection) [tone, label] = ["idle", "Registro manual"];
  else if (connected && env === "test") [tone, label] = ["test", "Prueba"];
  else if (connected) [tone, label] = ["ok", "Conectado"];

  const action = allSoon ? null : allLocked ? (
    <Button size="sm" variant="secondary" onClick={() => setUpgradeKey(firstLocked?.featureKey ?? null)}>
      <Lock size={14} /> Mejorar plan
    </Button>
  ) : noConnection ? null : (
    <Button size="sm" variant="secondary" onClick={() => handlers.onConnect(brand.key)}>
      {connected ? <Settings2 size={14} /> : <Plug size={14} />}
      {connected ? "Administrar" : "Conectar"}
    </Button>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3.5 p-4 sm:px-5">
        <BrandLogo brandKey={brand.key} name={brand.name} size={48} muted={allSoon || allLocked} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-semibold leading-tight">{brand.name}</h3>
            <StatusChip tone={tone}>{label}</StatusChip>
          </div>
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{brand.tagline}</p>
        </div>
        {action && <div className="hidden shrink-0 sm:block">{action}</div>}
      </div>
      {action && <div className="-mt-1 px-4 pb-3.5 sm:hidden [&>button]:w-full">{action}</div>}

      {/* Marca entera "Próximamente": sin filas de canales (no hay nada que tocar). */}
      <div className={cn("divide-y divide-border border-t border-border", allSoon && "hidden")}>
        {gates.map(({ c, locked, planName, featureKey }) => (
          <ChannelRow
            key={c.key}
            channel={c}
            brandName={brand.name}
            brandKey={brand.key}
            method={byKey.get(c.key)}
            brandConnected={connected}
            locked={locked}
            planName={planName}
            onUpgrade={() => setUpgradeKey(featureKey ?? null)}
            handlers={handlers}
          />
        ))}
      </div>

      {upgradeKey && (
        <UpgradeModal
          open
          onOpenChange={(o) => !o && setUpgradeKey(null)}
          featureKey={upgradeKey}
          featureLabel={channels.find((c) => PROVIDER_FEATURE[c.key] === upgradeKey)?.name ?? brand.name}
        />
      )}
    </Card>
  );
}

// =============================================================================
// Cobros directos: efectivo y transferencia, en una sola tarjeta.
// =============================================================================
export function ManualCard({
  groups,
  byKey,
  handlers,
}: {
  groups: BrandGroup[];
  byKey: Map<string, Method>;
  handlers: ChannelHandlers;
}) {
  return (
    <Card className="divide-y divide-border overflow-hidden">
      {groups.flatMap((g) =>
        g.channels.map((c) => (
          <ChannelRow
            key={c.key}
            channel={c}
            brandName={g.brand.name}
            brandKey={g.brand.key}
            method={byKey.get(c.key)}
            brandConnected
            locked={false}
            planName=""
            onUpgrade={() => {}}
            handlers={handlers}
            manual
          />
        )),
      )}
    </Card>
  );
}

function ChannelIcon({ channel }: { channel: ChannelEntry["channel"] }) {
  const Icon = channel === "point" ? Smartphone : channel === "qr_link" ? QrCode : CreditCard;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-muted text-foreground">
      <Icon size={18} strokeWidth={1.8} />
    </span>
  );
}

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs text-muted-foreground", className)}>
      {children}
    </span>
  );
}

function ChannelRow({
  channel: c,
  brandName,
  brandKey,
  method: m,
  brandConnected,
  locked,
  planName,
  onUpgrade,
  handlers,
  manual = false,
}: {
  channel: ChannelEntry;
  brandName: string;
  brandKey: string;
  method: Method | undefined;
  brandConnected: boolean;
  locked: boolean;
  planName: string;
  onUpgrade: () => void;
  handlers: ChannelHandlers;
  manual?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const soon = !c.implemented;
  const mode = surchargeModeOf(c.key, c.channel);
  const planKey = PLANS_KEY_BY_CHANNEL[c.key];
  const info = CHANNEL_INFO[c.key];
  const needs = featureInfo(PROVIDER_FEATURE[c.key] ?? "")?.needs;
  const extra = !soon && !locked ? handlers.renderChannelExtra?.(c.key, m) : null;
  const title = manual ? brandName : c.channel === "manual" ? "Cobro en su portal" : channelLabel(c.channel);
  const isPoint = c.channel === "point";
  const hasConnection = connectionKeyOf(brandKey) !== null;

  return (
    <div className={cn("px-4 py-3.5 sm:px-5")}>
      <div className="flex items-start gap-3">
        {manual ? <BrandLogo brandKey={brandKey} name={brandName} size={36} /> : <ChannelIcon channel={c.channel} />}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-sm font-semibold", soon && "text-muted-foreground")}>{title}</span>
            {soon && (
              <StatusChip tone="soon">Próximamente</StatusChip>
            )}
            {locked && <StatusChip tone="locked">Plan {planName}</StatusChip>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{CHANNEL_SUMMARY[c.key] ?? c.name}</p>

          {!soon && !locked && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {mode === "flat" && (
                <label className="inline-flex h-8 items-center gap-1 rounded-lg bg-muted pl-2.5 pr-2 text-xs text-muted-foreground">
                  Recargo
                  <input
                    key={m?.surcharge_pct ?? 0}
                    type="number"
                    inputMode="decimal"
                    step="0.5"
                    min="0"
                    defaultValue={m?.surcharge_pct ?? 0}
                    aria-label={`Recargo de ${brandName} ${title}`}
                    onBlur={(e) => {
                      const v = Number(e.target.value) || 0;
                      if (v !== (m?.surcharge_pct ?? 0)) handlers.onSurcharge(c.key, v);
                    }}
                    className="w-11 appearance-none bg-transparent text-right text-sm font-semibold text-foreground outline-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="font-semibold text-foreground">%</span>
                </label>
              )}
              {mode === "plans" && planKey && (
                <button
                  type="button"
                  onClick={() => handlers.onOpenPlans(planKey, brandName)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ninja-flame/10 px-2.5 text-xs font-semibold text-ninja-flameSoft transition hover:bg-ninja-flame/15"
                >
                  <Percent size={13} /> Planes · {brandName}
                </button>
              )}
              {mode === "shared" && <Pill>Recargo en Planes de Point</Pill>}
              {mode === "terminal" && <Pill>Cuotas en la terminal</Pill>}
              {isPoint &&
                hasConnection &&
                (brandConnected ? (
                  <Pill>
                    <Link2 size={12} /> Usa la conexión de {brandName}
                  </Pill>
                ) : (
                  <button
                    type="button"
                    onClick={() => handlers.onConnect(brandKey)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-warning/15 px-2.5 text-xs font-semibold text-warning"
                  >
                    <Link2 size={12} /> Conectá {brandName} para usarlo
                  </button>
                ))}
              {(info || extra) && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                  className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                >
                  {extra && info ? "Configurar" : "Cómo funciona"}
                  <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
                </button>
              )}
            </div>
          )}

          {locked && (
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ninja-flame/[0.07] px-3 py-2.5">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock size={13} className="shrink-0 text-ninja-flameSoft" />
                <span>
                  Disponible desde el plan <strong className="text-foreground">{planName}</strong>
                </span>
              </span>
              <button
                type="button"
                onClick={onUpgrade}
                className="text-xs font-semibold text-ninja-flameSoft hover:underline"
              >
                Mejorar plan
              </button>
            </div>
          )}

          {open && !soon && !locked && (
            <div className="mt-3 space-y-3 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-3.5 text-sm">
              {extra}
              {info && (
                <>
                  <p className="text-muted-foreground">{info.activa}</p>
                  {info.pasos && (
                    <ol className="space-y-1.5">
                      {info.pasos.map((step, i) => (
                        <li key={i} className="flex gap-2.5 text-muted-foreground">
                          <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] text-[10px] font-bold text-foreground">
                            {i + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {needs && (
                    <p className="text-xs text-muted-foreground">
                      <strong className="text-foreground">Requiere:</strong> {needs}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Switch: habilitar en el POS. Bloqueado por plan: atenuado y abre el
            upgrade (un <button disabled> traga el click, por eso el overlay). */}
        <div className="pt-1.5">
          {locked ? (
            <span className="relative inline-flex">
              <span aria-hidden className="pointer-events-none opacity-50">
                <Switch checked={false} onCheckedChange={() => {}} disabled />
              </span>
              <button
                type="button"
                onClick={onUpgrade}
                aria-label={`${brandName} ${title}: disponible desde el plan ${planName}. Tocá para mejorar tu plan.`}
                className="absolute inset-0 cursor-pointer rounded-full"
              />
            </span>
          ) : (
            <Switch
              checked={!soon && (m?.enabled ?? false)}
              disabled={soon}
              onCheckedChange={(v) => handlers.onToggle(c.key, v)}
              label={`Habilitar ${brandName} ${title} en el POS`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
