"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Inbox, MonitorSmartphone, Scale, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import {
  InheritBadge,
  ScopedSection,
  targetFor,
  useScopeNamer,
  type ScopeSel,
} from "@/components/config/ScopedConfig";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { cn } from "@/lib/utils/cn";
import { configErrorMessage, inheritState, parentTarget, resolveEffective } from "@/lib/config/inheritance";
import { parseScaleFormat, serializeScaleFormat, type ScaleLabelFormat } from "@/lib/barcode/scaleLabel";
import {
  STORE_HARDWARE_FIELDS,
  drawerDeviceProblem,
  emptyRegisterHardware,
  parseStoreHardware,
  scaleDeviceProblem,
  type RegisterHardware,
  type StoreHardware,
} from "@/lib/hardware/config";
import { NO_SALE_HINT, NO_SALE_LABEL, type DrawerNoSalePolicy } from "@/lib/hardware/drawer";
import { SCALE_PROTOCOLS } from "@/lib/hardware/scale/protocols";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import { branchLabel } from "@/modules/branches/logic";
import { useConfigMutations, useConfigOverrides, usePrinters, useStoreGroupMap } from "@/modules/config/hooks";
import { posApi } from "@/modules/pos/api";
import { useRegisterHardwareList } from "@/modules/hardware/hooks";
import { ScaleFormatEditor } from "./ScaleFormatEditor";
import { RegisterHardwareModal } from "./RegisterHardwareModal";

// =============================================================================
// Configuración > Hardware: balanza y cajón (ADR-063).
//
// Dos niveles bien separados para el dueño:
//   • Reglas del negocio (negocio, grupo o sucursal, con herencia): vende
//     pesables, formato de la etiqueta de balanza, cajón al cobrar y cajón sin
//     venta.
//   • Equipos de cada caja: la balanza y el cajón enchufados ahí.
// Y una tabla "Qué tiene cada caja" que junta las dos cosas.
// =============================================================================

export function HardwareSetup() {
  return (
    <section className="space-y-5">
      <HowItWorks />
      <ScopedSection domain="pos_settings" fields={STORE_HARDWARE_FIELDS} allowRegister={false} scopedExtra={(s) => <ScaleLabelScoped scope={s} />}>
        <StoreRulesCard />
      </ScopedSection>
      <RegistersTable />
    </section>
  );
}

function HowItWorks() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-lg bg-muted/50 p-4">
        <div className="flex items-center gap-2 font-semibold">
          <Building2 size={16} className="text-ninja-flameSoft" aria-hidden /> Por negocio o sucursal
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Las reglas. Valen para todas las cajas de la sucursal.</p>
        <ul className="mt-2 space-y-1 text-sm">
          <li>Si vende productos pesables con balanza.</li>
          <li>Cómo son las etiquetas de su balanza etiquetadora.</li>
          <li>Si el cajón se abre solo al cobrar en efectivo.</li>
          <li>Si se puede abrir el cajón sin venta: permitido, con PIN o prohibido.</li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Con varias sucursales, cada una puede pisar lo del negocio (Configurando: arriba).
        </p>
      </div>
      <div className="rounded-lg bg-muted/50 p-4">
        <div className="flex items-center gap-2 font-semibold">
          <MonitorSmartphone size={16} className="text-ninja-flameSoft" aria-hidden /> Por caja
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Los equipos. Lo que está enchufado en cada caja.</p>
        <ul className="mt-2 space-y-1 text-sm">
          <li>La balanza: modelo, cómo se conecta y su protocolo.</li>
          <li>La impresora que abre el cajón y el pulso, o que la caja no tiene cajón.</li>
          <li>El emparejamiento del USB en la PC de esa caja.</li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Se carga en la tabla Qué tiene cada caja, abajo. No depende del plan de varias cajas.
        </p>
      </div>
    </div>
  );
}

// ── Reglas: todo el negocio ──────────────────────────────────────────────────

function useStoreRulesBase() {
  return useQuery({ queryKey: ["pos", "settings"], queryFn: () => posApi.posSettingsRaw() });
}

function StoreRulesCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const scope = useBranchScope();
  const isOwner = scope.data?.role === "owner";
  const { data: raw, isFetched } = useStoreRulesBase();
  const [draft, setDraft] = useState<StoreHardware>(() => parseStoreHardware(null));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (isFetched) setDraft(parseStoreHardware(raw ?? null));
  }, [raw, isFetched]);
  const saved = useMemo(() => parseStoreHardware(raw ?? null), [raw]);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  async function save() {
    setSaving(true);
    try {
      const tenantId = await getCurrentTenantId();
      if (!tenantId) throw new Error("no_tenant");
      const { error } = await createClient()
        .from("pos_settings")
        .upsert(
          {
            tenant_id: tenantId,
            scale_enabled: draft.scaleEnabled,
            scale_label: serializeScaleFormat(draft.scaleFormat),
            drawer_open_on_cash: draft.drawer.openOnCash,
            drawer_no_sale: draft.drawer.noSale,
          } as never,
          { onConflict: "tenant_id" },
        );
      if (error) throw new Error(error.message);
      await qc.invalidateQueries({ queryKey: ["pos", "settings"] });
      toast({ title: "Reglas de balanza y cajón guardadas", variant: "success" });
    } catch (e) {
      toast({ title: configErrorMessage(e), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      title="Reglas de balanza y cajón"
      description="Para todo el negocio. Con varias sucursales, cada una puede tener las suyas."
      actions={
        isOwner ? (
          <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
            Guardar
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5 px-5 py-4">
        {!isOwner && scope.data && (
          <Callout tone="neutral">Sólo el dueño cambia las reglas de todo el negocio.</Callout>
        )}
        <StoreRulesFields value={draft} onChange={setDraft} disabled={!isOwner} />
      </div>
    </SettingsCard>
  );
}

function StoreRulesFields({
  value,
  onChange,
  disabled,
}: {
  value: StoreHardware;
  onChange: (v: StoreHardware) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 font-medium">
              <Scale size={15} aria-hidden /> Vende productos pesables con balanza
            </p>
            <p className="text-sm text-muted-foreground">
              El POS lee las etiquetas de la balanza etiquetadora y el peso en vivo en las cajas con balanza.
            </p>
          </div>
          <Switch
            checked={value.scaleEnabled}
            onCheckedChange={(c) => onChange({ ...value, scaleEnabled: c })}
            disabled={disabled}
            label="Vende productos pesables con balanza"
          />
        </div>
        {value.scaleEnabled && (
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="mb-3 text-sm font-medium">Formato de la etiqueta de balanza</p>
            <ScaleFormatEditor
              value={value.scaleFormat}
              onChange={(f) => onChange({ ...value, scaleFormat: f })}
              disabled={disabled}
            />
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <p className="flex items-center gap-2 font-medium">
          <Inbox size={15} aria-hidden /> Cajón de dinero
        </p>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm">Abrir el cajón al cobrar en efectivo</p>
            <p className="text-xs text-muted-foreground">Al cerrar una venta con un cobro en efectivo.</p>
          </div>
          <Switch
            checked={value.drawer.openOnCash}
            onCheckedChange={(c) => onChange({ ...value, drawer: { ...value.drawer, openOnCash: c } })}
            disabled={disabled}
            label="Abrir el cajón al cobrar en efectivo"
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm">Abrir el cajón sin venta</p>
          <Segmented<DrawerNoSalePolicy>
            aria-label="Abrir el cajón sin venta"
            value={value.drawer.noSale}
            onChange={(v) => !disabled && onChange({ ...value, drawer: { ...value.drawer, noSale: v } })}
            options={(["allow", "pin", "deny"] as DrawerNoSalePolicy[]).map((p) => ({ value: p, label: NO_SALE_LABEL[p] }))}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">{NO_SALE_HINT[value.drawer.noSale]}</p>
        </div>
      </div>
    </>
  );
}

// ── Reglas: formato de etiqueta por grupo o sucursal ────────────────────────

function ScaleLabelScoped({ scope }: { scope: Exclude<ScopeSel, { scope: "tenant" }> }) {
  const { toast } = useToast();
  const { data: raw } = useStoreRulesBase();
  const { data: overrides } = useConfigOverrides();
  const { data: groupMap } = useStoreGroupMap();
  const mut = useConfigMutations();
  const name = useScopeNamer();
  const target = targetFor(scope, groupMap);
  const ovs = overrides ?? [];
  const eff = resolveEffective("pos_settings", "", raw ?? {}, ovs, target);
  const inherited = resolveEffective("pos_settings", "", raw ?? {}, ovs, parentTarget(scope.scope, target));
  const current = parseScaleFormat(eff.value.scale_label);
  const [draft, setDraft] = useState<ScaleLabelFormat>(current);
  const currentKey = JSON.stringify(current);
  useEffect(() => setDraft(JSON.parse(currentKey) as ScaleLabelFormat), [currentKey]);
  if (scope.scope === "register") return null;
  const custom = inheritState(ovs, scope.scope, scope.id, "pos_settings", "", "scale_label") === "custom";
  const src = inherited.sources.scale_label;
  const srcName = !src || src === "tenant" ? "Todo el negocio" : name(src.split(":")[0] as "store_group" | "store", src.split(":")[1]);
  const scaleOn = eff.value.scale_enabled === true;
  const dirty = JSON.stringify(draft) !== currentKey;

  const save = () =>
    mut.set.mutate(
      { scope: scope.scope, scopeId: scope.id, domain: "pos_settings", patch: { scale_label: serializeScaleFormat(draft) } },
      {
        onSuccess: () => toast({ title: "Formato guardado para este lugar", variant: "success" }),
        onError: (e) => toast({ title: configErrorMessage(e), variant: "error" }),
      },
    );
  const reset = () =>
    mut.set.mutate(
      { scope: scope.scope, scopeId: scope.id, domain: "pos_settings", clear: ["scale_label"] },
      { onError: (e) => toast({ title: configErrorMessage(e), variant: "error" }) },
    );

  return (
    <SettingsCard
      title="Formato de la etiqueta de balanza"
      description={name(scope.scope, scope.id)}
      actions={
        <Button size="sm" onClick={save} disabled={!dirty} loading={mut.set.isPending}>
          Guardar
        </Button>
      }
    >
      <div className="space-y-3 px-5 py-4">
        <InheritBadge custom={custom} source={custom ? undefined : srcName} onReset={reset} busy={mut.set.isPending} />
        {!scaleOn && (
          <p className="text-xs text-muted-foreground">
            Este lugar no vende pesables (el formato se usa cuando se prenda).
          </p>
        )}
        <ScaleFormatEditor value={draft} onChange={setDraft} />
      </div>
    </SettingsCard>
  );
}

// ── Qué tiene cada caja ──────────────────────────────────────────────────────

function useRulesFor() {
  const { data: raw } = useStoreRulesBase();
  const { data: overrides } = useConfigOverrides();
  const { data: groupMap } = useStoreGroupMap();
  return (storeId: string): StoreHardware => {
    const t = targetFor({ scope: "store", id: storeId }, groupMap);
    return parseStoreHardware(resolveEffective("pos_settings", "", raw ?? {}, overrides ?? [], t).value);
  };
}

function RegistersTable() {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  const canEdit = scope.data?.role === "owner" || scope.data?.role === "manager";
  const { data: list } = useRegisterHardwareList();
  const { data: printers } = usePrinters();
  const rulesFor = useRulesFor();
  const [editing, setEditing] = useState<{ hw: RegisterHardware; label: string } | null>(null);

  const rows = ctx.allowed
    .filter((b) => !b.deleted_at)
    .flatMap((b) =>
      b.registers
        .filter((r) => !r.deleted_at)
        .map((r) => ({
          store: b,
          register: r,
          hw: list?.find((h) => h.registerId === r.id) ?? emptyRegisterHardware(r.id, b.id),
          rules: rulesFor(b.id),
          label: ctx.isMulti ? `${branchLabel(b)} · ${r.name}` : r.name,
        })),
    );
  const printerName = (id: string | null) => (id ? (printers ?? []).find((p) => p.id === id)?.name ?? "Impresora" : null);

  return (
    <SettingsCard
      title="Qué tiene cada caja"
      description="Equipos enchufados en cada caja y las reglas que le tocan por su sucursal."
    >
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">Todavía no hay cajas cargadas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Caja</th>
                <th className="px-3 py-2.5 font-medium">Balanza (de la caja)</th>
                <th className="px-3 py-2.5 font-medium">Cajón (de la caja)</th>
                <th className="px-3 py-2.5 font-medium">Reglas (de la sucursal)</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ register, hw, rules, label }) => {
                const scaleIssue = scaleDeviceProblem(hw.scale);
                const drawerIssue = drawerDeviceProblem(hw.drawer);
                return (
                  <tr key={register.id} className="border-b border-border/60 align-top last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium">{label}</p>
                      {!register.is_active && <p className="text-xs text-muted-foreground">Inactiva</p>}
                    </td>
                    <td className="px-3 py-3">
                      {hw.scale.enabled ? (
                        <>
                          <p>{hw.scale.model || SCALE_PROTOCOLS[hw.scale.protocol.protocol].label}</p>
                          <p className="text-xs text-muted-foreground">
                            {hw.scale.transport === "simulator"
                              ? "Simulador"
                              : hw.scale.transport === "bridge"
                                ? "Puente local"
                                : "USB / serie"}
                            {" · "}
                            {hw.scale.protocol.mode === "poll" ? "a pedido" : "continua"}
                          </p>
                          {scaleIssue && <p className="text-xs text-warning">{scaleIssue}</p>}
                          {!rules.scaleEnabled && (
                            <p className="text-xs text-warning">La sucursal no vende pesables: no se usa.</p>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">Sin balanza</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {!hw.drawer.hasDrawer ? (
                        <span className="text-muted-foreground">Sin cajón</span>
                      ) : (
                        <>
                          <p>{printerName(hw.drawer.printerId) ?? "Cajón"}</p>
                          <p className="text-xs text-muted-foreground">
                            {hw.drawer.transport === "none" ? "Sin configurar" : `Pin ${hw.drawer.pin} · ${hw.drawer.onMs} ms`}
                          </p>
                          {drawerIssue && hw.drawer.transport !== "none" && (
                            <p className="text-xs text-warning">{drawerIssue}</p>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={rules.scaleEnabled ? "success" : "neutral"}>
                          {rules.scaleEnabled ? `Pesables: etiqueta con ${rules.scaleFormat.embed === "weight" ? "peso" : "precio"}` : "Sin pesables"}
                        </Badge>
                        <Badge tone="neutral">{rules.drawer.openOnCash ? "Abre al cobrar efectivo" : "No abre al cobrar"}</Badge>
                        <Badge tone={rules.drawer.noSale === "deny" ? "danger" : rules.drawer.noSale === "pin" ? "warning" : "neutral"}>
                          Sin venta: {NO_SALE_LABEL[rules.drawer.noSale].toLowerCase()}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!canEdit}
                        onClick={() => setEditing({ hw, label })}
                      >
                        <Settings2 size={14} /> Equipos
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={cn("border-t border-border px-5 py-3 text-xs text-muted-foreground")}>
        Las reglas se cambian arriba (por negocio o sucursal). Los equipos y las pruebas, con Equipos en cada caja.
      </p>
      {editing && (
        <RegisterHardwareModal
          open
          onOpenChange={(o) => !o && setEditing(null)}
          hw={list?.find((h) => h.registerId === editing.hw.registerId) ?? editing.hw}
          label={editing.label}
        />
      )}
    </SettingsCard>
  );
}
