"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Building2, Check, ChevronDown, Copy, Layers, Lock, RotateCcw, Store as StoreIcon } from "lucide-react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import {
  CONFIG_FIELDS,
  configErrorMessage,
  copyPreview,
  fieldsFor,
  inheritState,
  parentTarget,
  resolveEffective,
  type ConfigDomain,
  type ConfigScope,
  type FieldDef,
  type ResolveTarget,
} from "@/lib/config/inheritance";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import { branchLabel, registerShort, type Branch } from "@/modules/branches/logic";
import {
  useConfigMutations,
  useConfigOverrides,
  useInheritanceFlags,
  usePaymentTerminals,
  usePrinters,
  useStoreGroupMap,
  useStoreGroups,
} from "@/modules/config/hooks";
import { posApi } from "@/modules/pos/api";
import { useTenantTicketBranding } from "@/modules/tickets/hooks";

// =============================================================================
// Configuración por sucursal y caja (F17 · H92/H93, ADR-049).
//
// Cada sección de Configuración que admite herencia se envuelve en
// <ScopedSection>: arriba el selector "Configurando: Todo el negocio ▾" (o un
// grupo, una sucursal o una caja). Con "Todo el negocio" se ve la tarjeta de
// siempre; con otro alcance, los campos que ese nivel puede pisar con el
// valor efectivo, la marca "heredado / personalizado" y "volver a heredar".
// "Copiar configuración de otra sucursal" comparte lo que pisa una sucursal
// con otra (con vista previa de los cambios).
// =============================================================================

export type ScopeSel =
  | { scope: "tenant" }
  | { scope: "store_group"; id: string }
  | { scope: "store"; id: string }
  | { scope: "register"; id: string; storeId: string };

const TENANT: ScopeSel = { scope: "tenant" };

function scopeKey(s: ScopeSel): string {
  return s.scope === "tenant" ? "tenant" : `${s.scope}:${s.id}`;
}

/** Nombre corto de un alcance. */
export function useScopeNamer() {
  const ctx = useBranchContext();
  const { data: groups } = useStoreGroups();
  return (scope: ConfigScope | "tenant", id?: string | null): string => {
    if (scope === "tenant" || !id) return "Todo el negocio";
    if (scope === "store_group") return `Grupo ${groups?.find((g) => g.id === id)?.name ?? ""}`.trim();
    if (scope === "store") {
      const b = ctx.all.find((x) => x.id === id);
      return b ? branchLabel(b) : "Sucursal";
    }
    for (const b of ctx.all) {
      const r = b.registers.find((x) => x.id === id);
      if (r) return `${branchLabel(b)} · ${r.name}`;
    }
    return "Caja";
  };
}

/** Destino de resolución para un alcance elegido. */
export function targetFor(sel: ScopeSel, groupMap: Record<string, string | null> | undefined): ResolveTarget {
  const flags = { multiStore: true, multiRegister: true };
  if (sel.scope === "tenant") return { ...flags };
  if (sel.scope === "store_group") return { ...flags, groupId: sel.id };
  if (sel.scope === "store") return { ...flags, storeId: sel.id, groupId: groupMap?.[sel.id] ?? null };
  return { ...flags, storeId: sel.storeId, registerId: sel.id, groupId: groupMap?.[sel.storeId] ?? null };
}

// ── Selector de alcance ──────────────────────────────────────────────────────

export function useScopeSelection(allowRegister: boolean) {
  const params = useSearchParams();
  const ctx = useBranchContext();
  const [sel, setSel] = useState<ScopeSel>(TENANT);
  // ?sucursal=<id> (link desde la ficha de la sucursal) y ?caja=<id>.
  const fromUrl = params.get("sucursal");
  const regFromUrl = params.get("caja");
  useEffect(() => {
    if (!ctx.ready) return;
    if (regFromUrl && allowRegister) {
      const b = ctx.all.find((x) => x.registers.some((r) => r.id === regFromUrl));
      if (b) return setSel({ scope: "register", id: regFromUrl, storeId: b.id });
    }
    if (fromUrl && ctx.all.some((b) => b.id === fromUrl)) setSel({ scope: "store", id: fromUrl });
  }, [ctx.ready, fromUrl, regFromUrl, allowRegister]); // eslint-disable-line react-hooks/exhaustive-deps
  return [sel, setSel] as const;
}

export function ScopeBar({
  value,
  onChange,
  allowRegister = true,
  allowGroup = true,
  onCopy,
}: {
  value: ScopeSel;
  onChange: (s: ScopeSel) => void;
  allowRegister?: boolean;
  allowGroup?: boolean;
  onCopy?: () => void;
}) {
  const ctx = useBranchContext();
  const flags = useInheritanceFlags();
  const { data: groups } = useStoreGroups();
  const name = useScopeNamer();
  const [upgrade, setUpgrade] = useState<string | null>(null);
  const live = ctx.allowed;
  const liveGroups = (groups ?? []).filter((g) => !g.deleted_at);
  const label = value.scope === "tenant" ? "Todo el negocio" : name(value.scope, value.id);

  const pick = (s: ScopeSel) => {
    if ((s.scope === "store" || s.scope === "store_group") && !flags.multiStore) return setUpgrade("multi_sucursal");
    if (s.scope === "register" && !flags.multiRegister) return setUpgrade("multi_caja");
    onChange(s);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="shrink-0 text-muted-foreground">Configurando:</span>
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              type="button"
              className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 font-medium hover:bg-muted"
              aria-label={`Alcance de la configuración: ${label}`}
            >
              {value.scope === "tenant" ? (
                <Building2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
              ) : value.scope === "store_group" ? (
                <Layers size={15} className="shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <BranchDot branch={ctx.all.find((b) => b.id === (value.scope === "register" ? value.storeId : value.id)) ?? null} />
              )}
              <span className="min-w-0 truncate">{label}</span>
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </DropdownTrigger>
          <DropdownContent align="start" className="max-h-[60vh] w-[280px] overflow-y-auto">
            <DropdownItem onSelect={() => onChange(TENANT)}>
              <Building2 size={15} className="text-muted-foreground" aria-hidden />
              <span className="flex-1">Todo el negocio</span>
              {value.scope === "tenant" && <Check size={14} className="text-ninja-flameSoft" />}
            </DropdownItem>
            {allowGroup && liveGroups.length > 0 && (
              <>
                <DropdownSeparator />
                <DropdownLabel>Grupos</DropdownLabel>
                {liveGroups.map((g) => (
                  <DropdownItem key={g.id} onSelect={() => pick({ scope: "store_group", id: g.id })}>
                    <Layers size={15} className="text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{g.name}</span>
                    {!flags.multiStore && <Lock size={12} className="text-muted-foreground" />}
                    {value.scope === "store_group" && value.id === g.id && <Check size={14} className="text-ninja-flameSoft" />}
                  </DropdownItem>
                ))}
              </>
            )}
            <DropdownSeparator />
            <DropdownLabel>Sucursales{allowRegister ? " y cajas" : ""}</DropdownLabel>
            {live.map((b) => (
              <div key={b.id}>
                <DropdownItem onSelect={() => pick({ scope: "store", id: b.id })}>
                  <BranchDot branch={b} />
                  <span className="flex-1 truncate">{b.name}</span>
                  {!flags.multiStore && <Lock size={12} className="text-muted-foreground" />}
                  {value.scope === "store" && value.id === b.id && <Check size={14} className="text-ninja-flameSoft" />}
                </DropdownItem>
                {allowRegister &&
                  b.registers
                    .filter((r) => !r.deleted_at)
                    .map((r) => (
                      <DropdownItem
                        key={r.id}
                        onSelect={() => pick({ scope: "register", id: r.id, storeId: b.id })}
                        className="pl-9"
                      >
                        <span className="flex-1 truncate text-[13px]">{r.name}</span>
                        {!flags.multiRegister && <Lock size={12} className="text-muted-foreground" />}
                        {value.scope === "register" && value.id === r.id && (
                          <Check size={14} className="text-ninja-flameSoft" />
                        )}
                      </DropdownItem>
                    ))}
              </div>
            ))}
          </DropdownContent>
        </Dropdown>
      </div>
      {onCopy && value.scope !== "tenant" && (
        <Button variant="secondary" size="sm" onClick={onCopy}>
          <Copy size={14} /> Copiar de otra sucursal
        </Button>
      )}
      <UpgradeModal
        open={Boolean(upgrade)}
        onOpenChange={(o) => !o && setUpgrade(null)}
        featureKey={upgrade ?? "multi_sucursal"}
        featureLabel={upgrade === "multi_caja" ? "Configuración por caja" : "Configuración por sucursal"}
      />
    </div>
  );
}

// ── Badge heredado / personalizado ───────────────────────────────────────────

export function InheritBadge({
  custom,
  source,
  onReset,
  busy,
}: {
  custom: boolean;
  /** Origen del valor heredado ("Todo el negocio", "Grupo Norte"...). */
  source?: string;
  onReset?: () => void;
  busy?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {custom ? (
        <Badge tone="brand">Personalizado</Badge>
      ) : (
        <Badge tone="neutral" title={source ? `Viene de: ${source}` : undefined}>
          Heredado{source ? ` de ${source}` : ""}
        </Badge>
      )}
      {custom && onReset && (
        <button
          type="button"
          onClick={onReset}
          disabled={busy}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
        >
          <RotateCcw size={12} /> Volver a heredar
        </button>
      )}
    </span>
  );
}

// ── Bases del negocio por dominio ────────────────────────────────────────────

const PROVIDER_LABEL: Record<string, string> = {
  cash: "Efectivo",
  transfer: "Transferencia",
  mercadopago: "Mercado Pago QR",
  mercadopago_point: "Mercado Point",
  modo: "MODO",
  mobbex: "Mobbex",
  payway: "Payway",
  payway_point: "Payway Point",
  getnet: "Getnet",
  getnet_point: "Getnet Point",
  fiserv: "Fiserv Posnet / Clover",
  fiserv_point: "Clover Point",
  pagos360: "Pagos360",
  nave: "Nave",
  nave_point: "Nave Point",
  gocuotas: "GO Cuotas",
  directo: "Directo",
  account: "Cuenta corriente",
};

export function providerLabel(key: string): string {
  return PROVIDER_LABEL[key] ?? key;
}

function useDomainBases(domain: ConfigDomain) {
  const methods = useQuery({
    queryKey: ["pos", "payment-methods-status"],
    queryFn: () => posApi.paymentMethodsStatus(),
    enabled: domain === "payment_method",
    staleTime: 60_000,
  });
  const pos = useQuery({
    queryKey: ["pos", "settings"],
    queryFn: () => posApi.posSettingsRaw(),
    enabled: domain === "pos_settings",
  });
  const ticket = useTenantTicketBranding(domain === "ticket");
  return useMemo((): { key: string; label: string; base: Record<string, unknown> }[] => {
    if (domain === "payment_method") {
      const rows = methods.data ?? [];
      const keys = new Set(rows.map((r) => r.provider_key));
      const all = [
        ...rows,
        ...(["cash", "transfer"] as const)
          .filter((k) => !keys.has(k))
          .map((k) => ({ provider_key: k, enabled: true, surcharge_pct: 0, merchant_numbers: {}, plan_mode: null })),
      ];
      return all.map((r) => ({
        key: r.provider_key,
        label: providerLabel(r.provider_key),
        base: {
          enabled: r.enabled,
          surcharge_pct: r.surcharge_pct,
          plan_mode: r.plan_mode,
          merchant_numbers: r.merchant_numbers ?? {},
        },
      }));
    }
    if (domain === "pos_settings") return [{ key: "", label: "", base: { ...(pos.data ?? {}) } }];
    const b = (ticket.data ?? {}) as Record<string, unknown>;
    return [{ key: "", label: "", base: { use_store_contact: false, ...b } }];
  }, [domain, methods.data, pos.data, ticket.data]);
}

// ── Editor de un campo ───────────────────────────────────────────────────────

const CARD_BRANDS = ["visa", "master", "amex", "cabal", "naranja", "maestro"];
const ROLES: { key: string; label: string }[] = [
  { key: "manager", label: "Encargado" },
  { key: "cashier", label: "Cajero" },
  { key: "viewer", label: "Solo lectura" },
];

function FieldEditor({
  def,
  value,
  onSave,
  disabled,
}: {
  def: FieldDef;
  value: unknown;
  onSave: (v: unknown) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
    if (value && typeof value === "object") {
      setMapDraft(Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])));
    } else setMapDraft({});
  }, [value]);

  if (def.type === "bool") {
    return <Switch checked={value === true} onCheckedChange={(c) => onSave(c)} disabled={disabled} label={def.label} />;
  }
  if (def.type === "text" && def.options) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {def.options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onSave(o.value)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-xs",
              value === o.value ? "border-ninja-flame bg-ninja-flame/10 font-semibold" : "border-border hover:bg-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (def.type === "num" || def.type === "text") {
    const commit = () => {
      if (def.type === "num") {
        const n = Number(draft.replace(",", "."));
        if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(value == null ? "" : String(value));
        if (n !== Number(value)) onSave(n);
      } else if (draft !== (value ?? "")) {
        onSave(draft.trim() === "" ? null : draft.trim());
      }
    };
    return (
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          inputMode={def.type === "num" ? "decimal" : undefined}
          disabled={disabled}
          aria-label={def.label}
          className={def.type === "num" ? "w-28" : "w-full sm:w-72"}
        />
        {def.unit && <span className="text-sm text-muted-foreground">{def.unit}</span>}
      </div>
    );
  }
  if (def.type === "map_text" || def.type === "map_num") {
    const keys =
      def.type === "map_num"
        ? ROLES.map((r) => r.key)
        : [...new Set([...CARD_BRANDS, ...Object.keys((value as Record<string, unknown>) ?? {})])];
    const labelOf = (k: string) => ROLES.find((r) => r.key === k)?.label ?? k.charAt(0).toUpperCase() + k.slice(1);
    const commit = () => {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const raw = (mapDraft[k] ?? "").trim();
        if (def.type === "map_num") {
          if (raw === "") continue;
          const n = Number(raw.replace(",", "."));
          if (Number.isFinite(n)) out[k] = n;
        } else {
          out[k] = raw.replace(/[^0-9a-z]/gi, "").slice(0, 20);
        }
      }
      if (JSON.stringify(out) !== JSON.stringify(value ?? {})) onSave(out);
    };
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {keys.map((k) => (
          <Input
            key={k}
            label={labelOf(k)}
            value={mapDraft[k] ?? ""}
            onChange={(e) => setMapDraft({ ...mapDraft, [k]: e.target.value })}
            onBlur={commit}
            inputMode={def.type === "map_num" ? "decimal" : "text"}
            placeholder={def.type === "map_text" ? "Sin número" : def.unit}
            disabled={disabled}
          />
        ))}
      </div>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Se configura en su pantalla (con este alcance elegido) o copiando de otra sucursal.
    </p>
  );
}

// ── Panel de campos de un alcance ────────────────────────────────────────────

export function ScopedFieldsPanel({
  domain,
  scope,
  fields,
  title,
}: {
  domain: ConfigDomain;
  scope: Exclude<ScopeSel, { scope: "tenant" }>;
  /** Subconjunto de campos (default: todos los del alcance). */
  fields?: string[];
  title?: string;
}) {
  const { toast } = useToast();
  const { data: overrides } = useConfigOverrides();
  const { data: groupMap } = useStoreGroupMap();
  const bases = useDomainBases(domain);
  const mut = useConfigMutations();
  const name = useScopeNamer();
  const defs = fieldsFor(domain, scope.scope).filter((f) => !fields || fields.includes(f.key));
  const target = targetFor(scope, groupMap);
  const parent = parentTarget(scope.scope, target);
  const ovs = overrides ?? [];

  const save = (domainKey: string, field: string, v: unknown) =>
    mut.set.mutate(
      { scope: scope.scope, scopeId: scope.id, domain, domainKey, patch: { [field]: v } },
      { onError: (e) => toast({ title: configErrorMessage(e), variant: "error" }) },
    );
  const reset = (domainKey: string, field: string) =>
    mut.set.mutate(
      { scope: scope.scope, scopeId: scope.id, domain, domainKey, clear: [field] },
      { onError: (e) => toast({ title: configErrorMessage(e), variant: "error" }) },
    );

  if (defs.length === 0) {
    return (
      <Callout tone="neutral">
        Esta configuración no se puede personalizar a nivel {scope.scope === "register" ? "caja" : "sucursal"}.
      </Callout>
    );
  }

  return (
    <div className="space-y-4">
      {bases.map(({ key, label, base }) => {
        const eff = resolveEffective(domain, key, base, ovs, target);
        const inherited = resolveEffective(domain, key, base, ovs, parent);
        const customCount = defs.filter((d) => inheritState(ovs, scope.scope, scope.id, domain, key, d.key) === "custom").length;
        return (
          <SettingsCard
            key={key || "_"}
            title={label || title || name(scope.scope, scope.id)}
            description={customCount > 0 ? `${customCount} dato${customCount > 1 ? "s" : ""} propio${customCount > 1 ? "s" : ""}` : "Todo heredado"}
          >
            {defs.map((def) => {
              const custom = inheritState(ovs, scope.scope, scope.id, domain, key, def.key) === "custom";
              const src = inherited.sources[def.key];
              const srcName = !src || src === "tenant" ? "Todo el negocio" : name(src.split(":")[0] as ConfigScope, src.split(":")[1]);
              return (
                <div key={def.key} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 sm:max-w-[45%]">
                    <p className="text-sm font-medium">{def.label}</p>
                    <div className="mt-1">
                      <InheritBadge
                        custom={custom}
                        source={custom ? undefined : srcName}
                        onReset={() => reset(key, def.key)}
                        busy={mut.set.isPending}
                      />
                    </div>
                    {def.hint && <p className="mt-1 text-xs text-muted-foreground">{def.hint}</p>}
                    {custom && def.type !== "map_any" && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Valor heredado: {formatValue(inherited.value[def.key])}
                      </p>
                    )}
                  </div>
                  <div className={cn("min-w-0", !custom && "opacity-80")}>
                    <FieldEditor def={def} value={eff.value[def.key]} onSave={(v) => save(key, def.key, v)} disabled={mut.set.isPending} />
                  </div>
                </div>
              );
            })}
          </SettingsCard>
        );
      })}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === true) return "Sí";
  if (v === false) return "No";
  if (v == null || v === "") return "Sin dato";
  if (typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== "" && x != null);
    return e.length ? e.map(([k, x]) => `${k} ${String(x)}`).join(", ") : "Sin datos";
  }
  return String(v);
}

// ── Diferencias por sucursal ─────────────────────────────────────────────────

export function OverridesSummary({ domain, onPick }: { domain: ConfigDomain; onPick?: (s: ScopeSel) => void }) {
  const { data: overrides } = useConfigOverrides();
  const ctx = useBranchContext();
  const name = useScopeNamer();
  const rows = (overrides ?? []).filter((o) => o.domain === domain && Object.keys(o.patch ?? {}).length > 0);
  if (rows.length === 0) return null;
  const labelOf = (k: string) => CONFIG_FIELDS[domain].find((f) => f.key === k)?.label ?? k;
  return (
    <SettingsCard title="Diferencias por sucursal" description="Lo que cada lugar pisa del negocio. Tocá una fila para editarla.">
      {rows.map((o) => {
        const storeOfRegister =
          o.scope === "register" ? ctx.all.find((b) => b.registers.some((r) => r.id === o.scope_id))?.id : undefined;
        const sel: ScopeSel =
          o.scope === "register"
            ? { scope: "register", id: o.scope_id, storeId: storeOfRegister ?? "" }
            : { scope: o.scope, id: o.scope_id };
        return (
          <button
            key={`${o.scope}:${o.scope_id}:${o.domain_key}`}
            type="button"
            onClick={() => onPick?.(sel)}
            className="flex w-full flex-col gap-1 px-5 py-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="text-sm font-medium">
              {name(o.scope, o.scope_id)}
              {o.domain_key ? <span className="text-muted-foreground"> · {providerLabel(o.domain_key)}</span> : null}
            </span>
            <span className="flex flex-wrap gap-1">
              {Object.keys(o.patch).map((k) => (
                <Badge key={k} tone="brand">
                  {labelOf(k)}
                </Badge>
              ))}
            </span>
          </button>
        );
      })}
    </SettingsCard>
  );
}

// ── Copiar configuración de otra sucursal ────────────────────────────────────

export function CopyConfigModal({
  open,
  onOpenChange,
  target,
  domains,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: Exclude<ScopeSel, { scope: "tenant" }>;
  domains?: ConfigDomain[];
}) {
  const ctx = useBranchContext();
  const { data: groups } = useStoreGroups();
  const { data: overrides } = useConfigOverrides();
  const mut = useConfigMutations();
  const name = useScopeNamer();
  const { toast } = useToast();
  const [fromKey, setFromKey] = useState<string>("");
  const [mode, setMode] = useState<"replace" | "merge">("replace");

  const sources: { key: string; scope: ConfigScope; id: string; label: string }[] = [
    ...(groups ?? []).filter((g) => !g.deleted_at).map((g) => ({ key: `store_group:${g.id}`, scope: "store_group" as const, id: g.id, label: `Grupo ${g.name}` })),
    ...ctx.allowed.map((b) => ({ key: `store:${b.id}`, scope: "store" as const, id: b.id, label: b.name })),
    ...ctx.allowed.flatMap((b) =>
      b.registers
        .filter((r) => !r.deleted_at)
        .map((r) => ({ key: `register:${r.id}`, scope: "register" as const, id: r.id, label: `${branchLabel(b)} · ${r.name}` })),
    ),
  ].filter((s) => s.key !== scopeKey(target));
  const from = sources.find((s) => s.key === fromKey) ?? null;
  const changes = from
    ? copyPreview(overrides ?? [], { scope: from.scope, id: from.id }, { scope: target.scope, id: target.id }, mode, domains)
    : [];
  const labelOf = (d: ConfigDomain, k: string) => CONFIG_FIELDS[d].find((f) => f.key === k)?.label ?? k;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Copiar configuración a ${name(target.scope, target.id)}`}
      description="Comparte lo que otra sucursal o caja tiene personalizado. Lo que no está personalizado sigue heredando del negocio."
      className="max-w-lg"
    >
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Copiar desde</span>
          <select
            className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
            value={fromKey}
            onChange={(e) => setFromKey(e.target.value)}
          >
            <option value="">Elegí una sucursal, grupo o caja</option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2 text-sm">
          {(
            [
              ["replace", "Dejarla igual (reemplaza lo propio)"],
              ["merge", "Sólo sumar lo del origen"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              onClick={() => setMode(k)}
              className={cn(
                "rounded-lg border px-3 py-1.5",
                mode === k ? "border-ninja-flame bg-ninja-flame/10 font-semibold" : "border-border hover:bg-muted",
              )}
            >
              {l}
            </button>
          ))}
        </div>
        {from && (
          <div className="max-h-56 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm">
            {changes.length === 0 ? (
              <p className="text-muted-foreground">No hay diferencias: quedaría igual.</p>
            ) : (
              <ul className="space-y-1">
                {changes.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={c.kind === "set" ? "brand" : "neutral"}>{c.kind === "set" ? "Toma" : "Vuelve a heredar"}</Badge>
                    <span>
                      {c.domainKey ? `${providerLabel(c.domainKey)} · ` : ""}
                      {labelOf(c.domain, c.field)}
                      {c.kind === "set" ? `: ${formatValue(c.to)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!from || changes.length === 0 || mut.copy.isPending}
            onClick={() =>
              from &&
              mut.copy.mutate(
                { from: { scope: from.scope, id: from.id }, to: { scope: target.scope, id: target.id }, domains, mode },
                {
                  onSuccess: () => {
                    toast({ title: "Configuración copiada", variant: "success" });
                    onOpenChange(false);
                  },
                  onError: (e) => toast({ title: configErrorMessage(e), variant: "error" }),
                },
              )
            }
          >
            <Copy size={15} /> Copiar {changes.length > 0 ? `(${changes.length})` : ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Sección con alcance ──────────────────────────────────────────────────────

/**
 * Envuelve una sección de Configuración: con "Todo el negocio" muestra
 * `children` (la tarjeta de siempre) y el resumen de diferencias; con un
 * grupo, sucursal o caja, el panel de campos pisables. Sin varias sucursales
 * (ni varias cajas) el selector no aparece: cero ruido para un kiosco.
 */
export function ScopedSection({
  domain,
  fields,
  allowRegister = true,
  children,
  scopedExtra,
}: {
  domain: ConfigDomain;
  fields?: string[];
  allowRegister?: boolean;
  children: React.ReactNode;
  /** Contenido extra con alcance (p. ej. logo de la sucursal). */
  scopedExtra?: (scope: Exclude<ScopeSel, { scope: "tenant" }>) => React.ReactNode;
}) {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  // fields = [] → la sección sólo usa scopedExtra (p. ej. impresión).
  const canRegister =
    allowRegister &&
    (fields?.length === 0 || fieldsFor(domain, "register").some((f) => !fields || fields.includes(f.key)));
  const [sel, setSel] = useScopeSelection(canRegister);
  const [copyOpen, setCopyOpen] = useState(false);
  const manyRegisters = ctx.allowed.some((b) => b.registers.filter((r) => !r.deleted_at).length > 1);
  const isManager = scope.data?.role === "owner" || scope.data?.role === "manager";
  const show = ctx.ready && isManager && (ctx.isMulti || (canRegister && manyRegisters));

  if (!show) return <>{children}</>;
  return (
    <div className="space-y-4">
      <ScopeBar value={sel} onChange={setSel} allowRegister={canRegister} onCopy={() => setCopyOpen(true)} />
      {sel.scope === "tenant" ? (
        <>
          {children}
          <OverridesSummary domain={domain} onPick={setSel} />
        </>
      ) : (
        <>
          {fields?.length !== 0 && <ScopedFieldsPanel domain={domain} scope={sel} fields={fields} />}
          {scopedExtra?.(sel)}
          <CopyConfigModal open={copyOpen} onOpenChange={setCopyOpen} target={sel} domains={[domain]} />
        </>
      )}
    </div>
  );
}

// ── Resumen embebible en la ficha de la sucursal ─────────────────────────────

/**
 * Resumen de lo que una sucursal tiene propio (medios, operación, ticket,
 * terminales e impresoras) con links a cada sección de Configuración con la
 * sucursal ya elegida (?sucursal=<id>). Pensado para la ficha de la sucursal.
 */
export function BranchConfigSummary({ storeId, className }: { storeId: string; className?: string }) {
  const { data: overrides } = useConfigOverrides();
  const { data: terminals } = usePaymentTerminals();
  const { data: printers } = usePrinters();
  const ctx = useBranchContext();
  const branch: Branch | undefined = ctx.all.find((b) => b.id === storeId);
  const regIds = new Set((branch?.registers ?? []).map((r) => r.id));
  const own = (overrides ?? []).filter(
    (o) => (o.scope === "store" && o.scope_id === storeId) || (o.scope === "register" && regIds.has(o.scope_id)),
  );
  const count = (d: ConfigDomain) => own.filter((o) => o.domain === d).reduce((n, o) => n + Object.keys(o.patch).length, 0);
  const items: { label: string; value: string; href: string }[] = [
    { label: "Medios de pago", value: plural(count("payment_method"), "dato propio", "datos propios", "Hereda todo"), href: `/configuracion?seccion=pagos&sucursal=${storeId}` },
    { label: "Operación del POS", value: plural(count("pos_settings"), "dato propio", "datos propios", "Hereda todo"), href: `/configuracion?seccion=operacion&sucursal=${storeId}` },
    { label: "Ticket y marca", value: plural(count("ticket"), "dato propio", "datos propios", "Hereda todo"), href: `/configuracion?seccion=marca&sucursal=${storeId}` },
    {
      label: "Terminales de cobro",
      value: plural((terminals ?? []).filter((t) => t.store_id === storeId).length, "terminal", "terminales", "Sin terminales"),
      href: `/configuracion?seccion=terminales&sucursal=${storeId}`,
    },
    {
      label: "Impresoras",
      value: plural((printers ?? []).filter((p) => p.store_id === storeId).length, "impresora", "impresoras", "Sin impresoras"),
      href: `/configuracion?seccion=impresion&sucursal=${storeId}`,
    },
  ];
  return (
    <div className={cn("grid gap-2 sm:grid-cols-2", className)}>
      {items.map((it) => (
        <Link
          key={it.label}
          href={it.href as Route}
          className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <span className="flex items-center gap-2">
            <StoreIcon size={14} className="text-muted-foreground" aria-hidden />
            {it.label}
          </span>
          <span className="text-xs text-muted-foreground">{it.value}</span>
        </Link>
      ))}
      {branch && branch.registers.length > 0 && (
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Cajas: {branch.registers.filter((r) => !r.deleted_at).map((r) => registerShort(r)).join(", ")}. Cada una puede
          pisar medios habilitados, cierre, pantalla del cliente e impresión.
        </p>
      )}
    </div>
  );
}

function plural(n: number, one: string, many: string, zero: string): string {
  if (n === 0) return zero;
  return `${n} ${n === 1 ? one : many}`;
}
