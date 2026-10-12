"use client";

import { useState } from "react";
import {
  ChevronDown,
  CreditCard,
  Globe,
  Lock,
  Percent,
  Plug,
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
  MANUAL_FALLBACK,
  PLANS_KEY_BY_CHANNEL,
  connectionKeyOf,
  surchargeModeOf,
  type BrandGroup,
  type ChannelEntry,
} from "@/lib/payments/catalog";
import { CHANNEL_CAPS, CHANNEL_INFO, CHANNEL_SUMMARY, CHANNEL_TITLE, type ChannelCap } from "./copy";
import { BrandLogo, CapBadge, StatusChip, type StatusTone } from "./ui";
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

const capsOf = (c: ChannelEntry): ChannelCap[] =>
  CHANNEL_CAPS[c.key] ?? (c.channel === "point" ? ["point"] : c.channel === "qr_link" ? ["qr", "link"] : []);

// Grupo de la marca en la lista: conectadas primero, después las disponibles,
// las de otro plan y al final las que todavía no existen.
export type BrandBucket = "active" | "available" | "locked" | "soon";

export function brandBucket(
  group: BrandGroup,
  byKey: Map<string, Method>,
  features: Record<string, boolean> | undefined,
  plans: PlanForUpgrade[],
): BrandBucket {
  const live = group.channels.filter((c) => c.implemented);
  if (live.length === 0) return "soon";
  if (live.every((c) => gateOf(c, { features, plans }).locked)) return "locked";
  const connKey = connectionKeyOf(group.brand.key);
  // Directo sin API pero con el registro manual habilitado: ya cobra.
  if (connKey && MANUAL_FALLBACK.has(group.brand.key) && live.some((c) => byKey.get(c.key)?.enabled)) {
    return "active";
  }
  if (connKey) return byKey.get(connKey)?.config?.connected ? "active" : "available";
  // Sin cuenta que conectar: activa si algún canal está habilitado.
  return live.some((c) => byKey.get(c.key)?.enabled) ? "active" : "available";
}

// =============================================================================
// BrandCard: una marca con su conexión y sus canales (celular · terminal).
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
  // Marcas sin cuenta que conectar: se cobran a mano.
  const noConnection = !connKey;
  const allLocked = live.length > 0 && live.every((x) => x.locked);
  const firstLocked = live.find((x) => x.locked);

  let tone: StatusTone = "idle";
  let label = "Sin conectar";
  if (allLocked) [tone, label] = ["locked", `Plan ${firstLocked?.planName}`];
  else if (noConnection) [tone, label] = ["idle", "Registro manual"];
  else if (connected && env === "test") [tone, label] = ["test", "En prueba"];
  else if (connected) [tone, label] = ["ok", "Conectado"];
  else if (MANUAL_FALLBACK.has(brand.key)) [tone, label] = ["idle", "Registro manual"];

  const action = allLocked ? (
    <Button size="sm" variant="secondary" onClick={() => setUpgradeKey(firstLocked?.featureKey ?? null)}>
      <Lock size={14} /> Mejorar plan
    </Button>
  ) : noConnection ? null : (
    <Button size="sm" variant="secondary" onClick={() => handlers.onConnect(brand.key)}>
      {connected ? <Settings2 size={14} /> : <Plug size={14} />}
      {connected ? "Administrar" : "Conectar"}
    </Button>
  );

  // Todas las capacidades de la marca (para la tira de las bloqueadas).
  const allCaps = Array.from(new Set(channels.flatMap(capsOf)));

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3.5 p-4 sm:px-5">
        <BrandLogo brandKey={brand.key} name={brand.name} size={44} muted={allLocked} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-semibold leading-tight">{brand.name}</h3>
            <StatusChip tone={tone}>{label}</StatusChip>
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{brand.tagline}</p>
        </div>
        {action && <div className="hidden shrink-0 sm:block">{action}</div>}
      </div>
      {action && <div className="-mt-1 px-4 pb-4 sm:hidden [&>button]:w-full">{action}</div>}

      {allLocked ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3 sm:px-5">
          <span className="mr-1 text-xs text-muted-foreground">Incluye</span>
          {allCaps.map((cap) => (
            <CapBadge key={cap} cap={cap} muted />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-border border-t border-border">
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
      )}

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
// Próximamente: marcas sin ningún canal implementado, en una lista compacta.
// =============================================================================
export function SoonList({ groups }: { groups: BrandGroup[] }) {
  return (
    <Card className="divide-y divide-border overflow-hidden">
      {groups.map((g) => (
        <div key={g.brand.key} className="flex items-center gap-3 px-4 py-3 sm:px-5">
          <BrandLogo brandKey={g.brand.key} name={g.brand.name} size={36} muted />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-muted-foreground">{g.brand.name}</p>
            <p className="truncate text-xs text-muted-foreground">{g.brand.tagline}</p>
          </div>
          <div className="hidden gap-1.5 sm:flex">
            {Array.from(new Set(g.channels.flatMap(capsOf))).map((cap) => (
              <CapBadge key={cap} cap={cap} muted />
            ))}
          </div>
        </div>
      ))}
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

const CHANNEL_ICON = { qr_link: Smartphone, point: CreditCard, manual: Globe } as const;

function ChannelIcon({ channel, muted }: { channel: ChannelEntry["channel"]; muted?: boolean }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
        muted ? "bg-muted text-muted-foreground" : "bg-fg-6 text-foreground",
      )}
    >
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
  const title = manual ? brandName : CHANNEL_TITLE[c.channel];
  const isPoint = c.channel === "point";
  const hasConnection = connectionKeyOf(brandKey) !== null;
  const caps = manual ? [] : capsOf(c);

  // Canal "Próximamente": una línea compacta, sin controles.
  if (soon) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <ChannelIcon channel={c.channel} muted />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-muted-foreground">{title}</span>
            {caps.map((cap) => (
              <CapBadge key={cap} cap={cap} muted />
            ))}
          </div>
        </div>
        <StatusChip tone="soon">Próximamente</StatusChip>
      </div>
    );
  }

  return (
    <div className="px-4 py-3.5 sm:px-5">
      <div className="flex items-start gap-3">
        {manual ? <BrandLogo brandKey={brandKey} name={brandName} size={36} /> : <ChannelIcon channel={c.channel} />}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-sm font-semibold">{title}</span>
            {locked && <StatusChip tone="locked">Plan {planName}</StatusChip>}
          </div>
          {caps.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {caps.map((cap) => (
                <CapBadge key={cap} cap={cap} />
              ))}
            </div>
          )}
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{CHANNEL_SUMMARY[c.key] ?? c.name}</p>

          {!locked && (
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-fg-6 px-2.5 text-xs font-semibold text-foreground transition hover:bg-fg-10"
                >
                  <Percent size={13} /> Cuotas y recargos
                </button>
              )}
              {mode === "shared" && <Pill>Recargo en los planes de Point</Pill>}
              {mode === "terminal" && <Pill>Cuotas en la terminal</Pill>}
              {isPoint && hasConnection && !brandConnected && (
                  <button
                    type="button"
                    onClick={() => handlers.onConnect(brandKey)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-warning/15 px-2.5 text-xs font-semibold text-warning"
                  >
                    <Plug size={12} /> Conectá {brandName} para usarlo
                  </button>
              )}
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
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-fg-4 px-3 py-2.5">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock size={13} className="shrink-0" />
                <span>
                  Disponible desde el plan <strong className="text-foreground">{planName}</strong>
                </span>
              </span>
              <button type="button" onClick={onUpgrade} className="text-xs font-semibold text-foreground hover:underline">
                Mejorar plan
              </button>
            </div>
          )}

          {open && !locked && (
            <div className="mt-3 space-y-3 rounded-xl bg-fg-4 p-3.5 text-sm">
              {extra}
              {info && (
                <>
                  <p className="text-muted-foreground">{info.activa}</p>
                  {info.pasos && (
                    <ol className="space-y-1.5">
                      {info.pasos.map((step, i) => (
                        <li key={i} className="flex gap-2.5 text-muted-foreground">
                          <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-fg-10 text-[10px] font-bold text-foreground">
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
              checked={m?.enabled ?? false}
              onCheckedChange={(v) => handlers.onToggle(c.key, v)}
              label={`Habilitar ${brandName} ${title} en el POS`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
