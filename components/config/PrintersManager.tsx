"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Pencil, Plus, Printer as PrinterIcon, Trash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { cn } from "@/lib/utils/cn";
import {
  PRINTER_CONNECTION_LABEL,
  PRINTER_KIND_LABEL,
  kindsFor,
  paperOf,
  resolvePrintTarget,
  type Printer,
  type PrinterConnection,
  type PrinterKind,
} from "@/lib/print/printers";
import {
  ALL_PAPERS,
  PAPER_LABELS,
  PRINT_DOC_META,
  PRINT_DOC_TYPES,
  normalizePrintProfiles,
  type PrintDocType,
  type PrintProfile,
} from "@/lib/print/profiles";
import { webPrintCopies } from "@/lib/print/webPrint";
import { configErrorMessage, inheritState, parentTarget, resolveEffective } from "@/lib/config/inheritance";
import { lastSeenLabel } from "@/lib/payments/terminals";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import { branchLabel } from "@/modules/branches/logic";
import type { PrinterInput } from "@/modules/config/api";
import {
  useConfigMutations,
  useConfigOverrides,
  usePrinterMutations,
  usePrinters,
  useStoreGroupMap,
} from "@/modules/config/hooks";
import { InheritBadge, useScopeNamer, type ScopeSel } from "./ScopedConfig";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";

// =============================================================================
// Impresoras por sucursal y caja (F17 · ADR-049; extiende F10/H22).
//
// 1) Registro de impresoras de cada sucursal (térmicas, A4, etiquetadora,
//    comandera) con prueba de impresión y estado de la última prueba.
// 2) Perfiles por documento con herencia negocio ← grupo ← sucursal ← caja:
//    cada caja (o sucursal) elige la impresora y una de respaldo por tipo de
//    documento. Si la asignada no está, sale por la de respaldo, después por
//    una compatible de la caja o de la sucursal y, por último, por la del
//    equipo. La salida es por el diálogo del navegador.
// =============================================================================

type Draft = {
  id?: string;
  store_id: string;
  cash_register_id: string | null;
  name: string;
  kind: PrinterKind;
  connection: PrinterConnection;
  address: string;
  active: boolean;
  notes: string;
};

const KINDS: PrinterKind[] = ["thermal_80", "thermal_58", "a4", "label", "kitchen"];
const CONNECTIONS: PrinterConnection[] = ["browser", "network", "usb", "bluetooth"];

export function PrintersManager({ storeFilter }: { storeFilter?: string | null }) {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  const { data: printers } = usePrinters();
  const mut = usePrinterMutations();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [archive, setArchive] = useState<Printer | null>(null);
  const [testing, setTesting] = useState<Printer | null>(null);
  const canManage = scope.data?.role === "owner" || scope.data?.role === "manager";
  const branches = ctx.allowed.filter((b) => !storeFilter || b.id === storeFilter);
  const registersOf = (storeId: string) =>
    (ctx.all.find((b) => b.id === storeId)?.registers ?? []).filter((r) => !r.deleted_at);

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim()) return toast({ title: "Poné un nombre (ej. Térmica Caja 1)", variant: "error" });
    const input: PrinterInput = {
      store_id: draft.store_id,
      cash_register_id: draft.cash_register_id,
      name: draft.name.trim(),
      kind: draft.kind,
      connection: draft.connection,
      address: draft.address.trim() || null,
      active: draft.active,
      notes: draft.notes.trim() || null,
    };
    const done = {
      onSuccess: () => {
        toast({ title: "Impresora guardada", variant: "success" });
        setDraft(null);
      },
      onError: (e: unknown) =>
        toast({
          title: String((e as Error)?.message ?? "").includes("printers_store_name_key")
            ? "Ya hay una impresora con ese nombre en la sucursal"
            : "No se pudo guardar la impresora",
          variant: "error",
        }),
    };
    if (draft.id) mut.update.mutate({ id: draft.id, patch: input }, done);
    else mut.create.mutate(input, done);
  };

  const runTest = (p: Printer) => {
    setTesting(p);
    // La página de prueba se imprime con el aislamiento .printer-test-print.
    setTimeout(() => webPrintCopies(1), 300);
  };

  return (
    <div className="space-y-4">
      {branches.map((b) => {
        const list = (printers ?? []).filter((p) => p.store_id === b.id);
        return (
          <SettingsCard
            key={b.id}
            icon={PrinterIcon}
            title={
              <span className="flex items-center gap-2">
                <BranchDot branch={b} /> Impresoras de {branchLabel(b)}
              </span>
            }
            description={list.length === 0 ? "Sin impresoras registradas: sale por la del equipo" : undefined}
            actions={
              canManage ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setDraft({
                      store_id: b.id,
                      cash_register_id: null,
                      name: "",
                      kind: "thermal_80",
                      connection: "browser",
                      address: "",
                      active: true,
                      notes: "",
                    })
                  }
                >
                  <Plus size={14} /> Agregar impresora
                </Button>
              ) : undefined
            }
          >
            {list.map((p) => {
              const reg = registersOf(b.id).find((r) => r.id === p.cash_register_id);
              return (
                <div key={p.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {p.name}
                      {!p.active && <Badge tone="warning">Pausada</Badge>}
                      {p.last_test_ok === true && <Badge tone="success">Prueba OK</Badge>}
                      {p.last_test_ok === false && <Badge tone="danger">Prueba con problema</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {PRINTER_KIND_LABEL[p.kind]} · {PRINTER_CONNECTION_LABEL[p.connection]}
                      {p.address ? ` · ${p.address}` : ""} · {reg ? reg.name : "Toda la sucursal"}
                      {p.last_test_at ? ` · Última prueba ${lastSeenLabel(p.last_test_at).toLowerCase()}` : ""}
                    </p>
                  </div>
                  <span className="flex shrink-0 flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => runTest(p)}>
                      <PrinterIcon size={13} /> Probar
                    </Button>
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Editar ${p.name}`}
                          onClick={() =>
                            setDraft({
                              id: p.id,
                              store_id: p.store_id,
                              cash_register_id: p.cash_register_id,
                              name: p.name,
                              kind: p.kind,
                              connection: p.connection,
                              address: p.address ?? "",
                              active: p.active,
                              notes: p.notes ?? "",
                            })
                          }
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Archivar ${p.name}`} onClick={() => setArchive(p)}>
                          <Trash2 size={13} />
                        </Button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </SettingsCard>
        );
      })}

      <Modal
        open={Boolean(draft)}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? "Editar impresora" : "Nueva impresora"}
        className="max-w-lg"
      >
        {draft && (
          <div className="space-y-3">
            <Input label="Nombre" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Térmica Caja 1" />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Tipo</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as PrinterKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {PRINTER_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Conexión</span>
                <select
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                  value={draft.connection}
                  onChange={(e) => setDraft({ ...draft, connection: e.target.value as PrinterConnection })}
                >
                  {CONNECTIONS.map((k) => (
                    <option key={k} value={k}>
                      {PRINTER_CONNECTION_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Caja</span>
              <select
                className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                value={draft.cash_register_id ?? ""}
                onChange={(e) => setDraft({ ...draft, cash_register_id: e.target.value || null })}
              >
                <option value="">Toda la sucursal</option>
                {registersOf(draft.store_id).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Dirección o nota de conexión (opcional)"
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
              placeholder="192.168.0.50 o USB de la PC de caja"
            />
            <Input label="Notas" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} label="Activa" />
              Activa
            </label>
            <Callout tone="neutral">
              Hoy la impresión sale por el diálogo del navegador: elegí esta impresora como predeterminada en el equipo de
              la caja. El tipo define el papel y el formato de cada documento.
            </Callout>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>
                Cancelar
              </Button>
              <Button onClick={save} disabled={mut.create.isPending || mut.update.isPending}>
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(testing)}
        onOpenChange={(o) => !o && setTesting(null)}
        title="¿Salió bien la prueba?"
        description="Revisá que el texto se lea completo y que el ancho sea el correcto."
        className="max-w-sm"
      >
        {testing && (
          <div className="space-y-3">
            <div className="printer-test-print hidden print:block">
              <div style={{ fontFamily: "monospace", fontSize: 12, width: paperOf(testing.kind) === "58" ? "48mm" : paperOf(testing.kind) === "80" ? "72mm" : "180mm" }}>
                <div style={{ fontWeight: 700 }}>PRUEBA DE IMPRESIÓN</div>
                <div>{testing.name}</div>
                <div>{PRINTER_KIND_LABEL[testing.kind]}</div>
                <div>{new Date().toLocaleString("es-AR")}</div>
                <div>{"-".repeat(paperOf(testing.kind) === "58" ? 32 : 42)}</div>
                <div>áéíóú ñ Ñ $ 1.234,56</div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  mut.markTest.mutate({ id: testing.id, ok: false }, { onSettled: () => setTesting(null) })
                }
              >
                <XCircle size={15} /> Con problema
              </Button>
              <Button
                onClick={() => mut.markTest.mutate({ id: testing.id, ok: true }, { onSettled: () => setTesting(null) })}
              >
                <CheckCircle2 size={15} /> Salió bien
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(archive)}
        onOpenChange={(o) => !o && setArchive(null)}
        title={`Archivar ${archive?.name ?? "impresora"}`}
        description="Los documentos que la tenían asignada salen por la de respaldo o por otra compatible."
        confirmLabel="Archivar"
        danger
        loading={mut.archive.isPending}
        onConfirm={() => archive && mut.archive.mutate(archive.id, { onSuccess: () => setArchive(null) })}
      />
    </div>
  );
}

// ── Perfiles por documento con alcance (sucursal / caja) ─────────────────────

export function ScopedPrintProfiles({ scope }: { scope: Exclude<ScopeSel, { scope: "tenant" }> }) {
  const { toast } = useToast();
  const { data: overrides } = useConfigOverrides();
  const { data: groupMap } = useStoreGroupMap();
  const { data: printers } = usePrinters();
  const mut = useConfigMutations();
  const name = useScopeNamer();
  const raw = useQuery({
    queryKey: ["print-profiles", "base"],
    queryFn: async () => {
      const t = await getCurrentTenantId();
      if (!t) return normalizePrintProfiles(null);
      const { data } = await createClient()
        .from("pos_settings")
        .select("print_profiles")
        .eq("tenant_id", t)
        .maybeSingle();
      return normalizePrintProfiles((data as { print_profiles?: unknown } | null)?.print_profiles);
    },
  });
  const storeId = scope.scope === "register" ? scope.storeId : scope.scope === "store" ? scope.id : null;
  const registerId = scope.scope === "register" ? scope.id : null;
  const target = {
    multiStore: true,
    multiRegister: true,
    storeId,
    registerId,
    groupId: scope.scope === "store_group" ? scope.id : storeId ? (groupMap?.[storeId] ?? null) : null,
  };
  const ovs = overrides ?? [];
  const base = { print_profiles: (raw.data ?? normalizePrintProfiles(null)) as unknown as Record<string, unknown> };
  const eff = normalizePrintProfiles(resolveEffective("pos_settings", "", base, ovs, target).value.print_profiles);
  const inherited = normalizePrintProfiles(
    resolveEffective("pos_settings", "", base, ovs, parentTarget(scope.scope, target)).value.print_profiles,
  );
  const own = ovs.find(
    (o) => !o.deleted_at && o.scope === scope.scope && o.scope_id === scope.id && o.domain === "pos_settings" && o.domain_key === "",
  );
  const ownProfiles = ((own?.patch?.print_profiles ?? {}) as Record<string, unknown>) ?? {};
  const custom = inheritState(ovs, scope.scope, scope.id, "pos_settings", "", "print_profiles") === "custom";
  const available = useMemo(
    () =>
      (printers ?? []).filter(
        (p) =>
          p.active &&
          (!storeId || p.store_id === storeId) &&
          (!p.cash_register_id || !registerId || p.cash_register_id === registerId),
      ),
    [printers, storeId, registerId],
  );

  const write = (doc: PrintDocType, profile: PrintProfile | null) => {
    const next = { ...ownProfiles };
    if (profile) next[doc] = profile;
    else delete next[doc];
    const done = { onError: (e: unknown) => toast({ title: configErrorMessage(e), variant: "error" }) };
    if (Object.keys(next).length === 0) {
      mut.set.mutate({ scope: scope.scope, scopeId: scope.id, domain: "pos_settings", clear: ["print_profiles"] }, done);
    } else {
      mut.set.mutate(
        { scope: scope.scope, scopeId: scope.id, domain: "pos_settings", patch: { print_profiles: next } },
        done,
      );
    }
  };

  return (
    <SettingsCard
      icon={PrinterIcon}
      title={`Impresión en ${name(scope.scope, scope.id)}`}
      description={custom ? "Algunos documentos tienen impresora o formato propio." : "Todo heredado"}
    >
      {PRINT_DOC_TYPES.map((doc) => {
        const p = eff[doc];
        const isOwn = Object.prototype.hasOwnProperty.call(ownProfiles, doc);
        const compatible = available.filter((x) => kindsFor(doc).includes(x.kind));
        const out = resolvePrintTarget(doc, p, printers ?? [], { storeId, registerId });
        const patch = (q: Partial<PrintProfile>) => {
          const nextProfile: PrintProfile = { ...p, ...q };
          if (!nextProfile.printer_id) delete nextProfile.printer_id;
          if (!nextProfile.fallback_printer_id) delete nextProfile.fallback_printer_id;
          write(doc, nextProfile);
        };
        return (
          <div key={doc} className="space-y-2 px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{PRINT_DOC_META[doc].label}</p>
              <InheritBadge
                custom={isOwn}
                source={isOwn ? undefined : "nivel superior"}
                onReset={() => write(doc, null)}
                busy={mut.set.isPending}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <select
                aria-label="Impresora"
                className="h-10 rounded-lg border border-border bg-card px-2 text-sm"
                value={p.printer_id ?? ""}
                onChange={(e) => patch({ printer_id: e.target.value || undefined })}
              >
                <option value="">Automática</option>
                {compatible.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Respaldo"
                className="h-10 rounded-lg border border-border bg-card px-2 text-sm"
                value={p.fallback_printer_id ?? ""}
                onChange={(e) => patch({ fallback_printer_id: e.target.value || undefined })}
              >
                <option value="">Sin respaldo</option>
                {compatible
                  .filter((x) => x.id !== p.printer_id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      Respaldo: {x.name}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Papel"
                className="h-10 rounded-lg border border-border bg-card px-2 text-sm"
                value={p.paper}
                onChange={(e) => patch({ paper: e.target.value as PrintProfile["paper"] })}
              >
                {ALL_PAPERS.filter((x) => PRINT_DOC_META[doc].papers.includes(x)).map((x) => (
                  <option key={x} value={x}>
                    {PAPER_LABELS[x]}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Copias"
                  type="number"
                  min={1}
                  max={20}
                  value={p.copies}
                  onChange={(e) => patch({ copies: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
                  className="h-10 w-20"
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <Switch checked={p.auto} onCheckedChange={(v) => patch({ auto: v })} label="Automática" />
                  Auto
                </label>
              </div>
            </div>
            <p className={cn("text-xs", out.degraded ? "text-warning" : "text-muted-foreground")}>
              {out.printer ? `Sale por ${out.printer.name}` : "Sale por la impresora del equipo"}
              {out.reason === "fallback" ? " (respaldo)" : out.reason.startsWith("auto") ? " (automática)" : ""}
              {!isOwn && inherited[doc].printer_id && !out.printer ? ". La heredada no es de este lugar." : ""}
            </p>
          </div>
        );
      })}
    </SettingsCard>
  );
}
