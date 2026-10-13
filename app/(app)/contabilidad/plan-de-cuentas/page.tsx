"use client";

import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, Pencil, Plus, Trash2 } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { exportXlsx } from "@/lib/utils/xlsx";
import { ACCOUNT_KIND_LABEL, compareCodes, type AccountKind } from "@/lib/accounting/journal";
import { accErrorMessage } from "@/lib/accounting/sources";
import { AccountingFrame, KindBadge, inputCls, selectCls } from "@/components/accounting/shared";
import { useAccAccounts, useAccountingMutations, useCostCenters } from "@/modules/accounting/hooks";
import type { AccAccount, AccountInput, CostCenter } from "@/modules/accounting/api";
import { useStores } from "@/modules/stock/hooks";

// Plan de cuentas (ADR-066): árbol editable, imputables, código del estudio y
// centros de costo por sucursal.
export default function PlanDeCuentasPage() {
  const [edit, setEdit] = useState<{ open: boolean; account: AccAccount | null; parent: AccAccount | null }>({
    open: false,
    account: null,
    parent: null,
  });
  return (
    <PageContainer size="xl">
      <AccountingFrame
        title="Plan de cuentas"
        description="Cuentas del negocio en árbol. Sólo las imputables reciben asientos; el código externo es el del sistema de tu estudio."
        actions={
          <Button onClick={() => setEdit({ open: true, account: null, parent: null })}>
            <Plus size={16} /> Cuenta
          </Button>
        }
      >
        <AccountsTree onEdit={(account, parent) => setEdit({ open: true, account, parent })} />
        <CostCentersSection />
        <AccountModal
          open={edit.open}
          account={edit.account}
          parent={edit.parent}
          onOpenChange={(o) => setEdit((s) => ({ ...s, open: o }))}
        />
      </AccountingFrame>
    </PageContainer>
  );
}

function depthOf(a: AccAccount, byId: Map<string, AccAccount>): number {
  let d = 0;
  let p = a.parent_id ? byId.get(a.parent_id) : undefined;
  while (p && d < 20) {
    d++;
    p = p.parent_id ? byId.get(p.parent_id) : undefined;
  }
  return d;
}

function AccountsTree({ onEdit }: { onEdit: (a: AccAccount | null, parent: AccAccount | null) => void }) {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: accounts = [], isLoading } = useAccAccounts();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<AccountKind | "">("");
  const [deleting, setDeleting] = useState<AccAccount | null>(null);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...accounts]
      .sort((a, b) => compareCodes(a.code, b.code))
      .filter((a) => (!kind || a.kind === kind) && (!s || a.code.includes(s) || a.name.toLowerCase().includes(s) || (a.external_code ?? "").toLowerCase().includes(s)));
  }, [accounts, q, kind]);

  async function remove() {
    if (!deleting) return;
    try {
      await m.deleteAccount.mutateAsync(deleting.id);
      toast({ title: "Cuenta dada de baja", variant: "success" });
      setDeleting(null);
    } catch (e) {
      toast({ title: "No se pudo dar de baja", description: accErrorMessage(e), variant: "error" });
    }
  }

  function xlsx() {
    void exportXlsx("plan-de-cuentas", [
      {
        name: "Plan de cuentas",
        columns: [
          { header: "Código", key: "code", width: 16 },
          { header: "Nombre", key: "name", width: 44 },
          { header: "Tipo", key: "kind", width: 18 },
          { header: "Imputable", key: "imputable", width: 10, options: ["Sí", "No"] },
          { header: "Código externo", key: "external_code", width: 16 },
          { header: "Activa", key: "active", width: 10, options: ["Sí", "No"] },
        ],
        rows: rows.map((a) => ({
          code: a.code,
          name: `${"  ".repeat(depthOf(a, byId))}${a.name}`,
          kind: ACCOUNT_KIND_LABEL[a.kind],
          imputable: a.imputable ? "Sí" : "No",
          external_code: a.external_code ?? "",
          active: a.is_active ? "Sí" : "No",
        })),
      },
    ]);
  }

  return (
    <div className="mt-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={q} onValueChange={setQ} placeholder="Buscar por código o nombre" className="min-w-[220px] flex-1" />
        <select aria-label="Tipo" className={cn(selectCls, "h-11 w-auto")} value={kind} onChange={(e) => setKind(e.target.value as AccountKind | "")}>
          <option value="" className="bg-popover text-popover-foreground">Todos los tipos</option>
          {(Object.keys(ACCOUNT_KIND_LABEL) as AccountKind[]).map((k) => (
            <option key={k} value={k} className="bg-popover text-popover-foreground">
              {ACCOUNT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <Button variant="secondary" onClick={xlsx} disabled={!rows.length}>
          <FileSpreadsheet size={16} /> XLSX
        </Button>
      </div>
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cuenta</th>
              <th className="hidden px-4 py-3 md:table-cell">Tipo</th>
              <th className="hidden px-4 py-3 sm:table-cell">Código externo</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={4} loading />}
            {rows.map((a) => {
              const depth = depthOf(a, byId);
              return (
                <tr key={a.id} className={cn(!a.is_active && "opacity-60", !a.imputable && "bg-muted/20")}>
                  <td className="py-2 pr-4" style={{ paddingLeft: `${16 + depth * 18}px` }}>
                    <span className="tabular-nums text-muted-foreground">{a.code}</span>{" "}
                    <span className={cn(!a.imputable && "font-semibold")}>{a.name}</span>
                    {!a.imputable && <span className="ml-2 text-xs text-muted-foreground">(agrupa)</span>}
                    {!a.is_active && <Badge tone="neutral" className="ml-2">Inactiva</Badge>}
                  </td>
                  <td className="hidden px-4 py-2 md:table-cell">
                    {depth === 0 || !a.imputable ? <KindBadge kind={a.kind} /> : null}
                  </td>
                  <td className="hidden px-4 py-2 tabular-nums text-muted-foreground sm:table-cell">{a.external_code ?? ""}</td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" aria-label="Agregar subcuenta" title="Agregar subcuenta" onClick={() => onEdit(null, a)}>
                        <Plus size={14} />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => onEdit(a, a.parent_id ? byId.get(a.parent_id) ?? null : null)}>
                        <Pencil size={14} />
                      </Button>
                      {!a.system_key && (
                        <Button size="sm" variant="ghost" className="text-danger" aria-label="Dar de baja" onClick={() => setDeleting(a)}>
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted-foreground">
        Las cuentas de la plantilla se pueden renombrar, recodificar o desactivar, pero no borrar: las usan los mapeos.
        Una cuenta con subcuentas deja de ser imputable.
      </p>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="¿Dar de baja la cuenta?"
        description="Sólo se puede si no tiene asientos, subcuentas ni mapeos."
        confirmLabel="Dar de baja"
        danger
        loading={m.deleteAccount.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function AccountModal({
  open,
  account,
  parent,
  onOpenChange,
}: {
  open: boolean;
  account: AccAccount | null;
  parent: AccAccount | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: accounts = [] } = useAccAccounts();
  const [v, setV] = useState<AccountInput>({
    code: "",
    name: "",
    parent_id: null,
    kind: "activo",
    imputable: true,
    external_code: null,
    is_active: true,
    notes: null,
  });

  useEffect(() => {
    if (!open) return;
    if (account) {
      setV({
        code: account.code,
        name: account.name,
        parent_id: account.parent_id,
        kind: account.kind,
        imputable: account.imputable,
        external_code: account.external_code,
        is_active: account.is_active,
        notes: account.notes,
      });
    } else {
      const siblings = accounts.filter((a) => a.parent_id === (parent?.id ?? null)).map((a) => a.code);
      setV({
        code: suggestCode(parent?.code ?? null, siblings),
        name: "",
        parent_id: parent?.id ?? null,
        kind: parent?.kind ?? "activo",
        imputable: true,
        external_code: null,
        is_active: true,
        notes: null,
      });
    }
  }, [open, account, parent, accounts]);

  async function save() {
    try {
      await m.saveAccount.mutateAsync({ id: account?.id ?? null, input: { ...v, code: v.code.trim(), name: v.name.trim() } });
      toast({ title: account ? "Cuenta actualizada" : "Cuenta creada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accErrorMessage(e), variant: "error" });
    }
  }

  const parents = accounts.filter((a) => a.id !== account?.id);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={account ? "Editar cuenta" : "Nueva cuenta"}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={!v.code.trim() || !v.name.trim()} loading={m.saveAccount.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium">Cuenta madre</span>
          <select
            className={cn(inputCls, "mt-1")}
            value={v.parent_id ?? ""}
            onChange={(e) => {
              const p = accounts.find((a) => a.id === e.target.value) ?? null;
              setV((s) => ({ ...s, parent_id: p?.id ?? null, kind: p?.kind ?? s.kind }));
            }}
          >
            <option value="" className="bg-popover text-popover-foreground">Ninguna (rubro principal)</option>
            {parents.map((a) => (
              <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <label className="block text-sm">
            <span className="font-medium">Código</span>
            <input className={cn(inputCls, "mt-1 tabular-nums")} value={v.code} onChange={(e) => setV((s) => ({ ...s, code: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Nombre</span>
            <input className={cn(inputCls, "mt-1")} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Tipo</span>
            <select
              className={cn(inputCls, "mt-1")}
              value={v.kind}
              disabled={Boolean(v.parent_id)}
              onChange={(e) => setV((s) => ({ ...s, kind: e.target.value as AccountKind }))}
            >
              {(Object.keys(ACCOUNT_KIND_LABEL) as AccountKind[]).map((k) => (
                <option key={k} value={k} className="bg-popover text-popover-foreground">
                  {ACCOUNT_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium">Código en el sistema del estudio</span>
            <input
              className={cn(inputCls, "mt-1")}
              placeholder="Opcional"
              value={v.external_code ?? ""}
              onChange={(e) => setV((s) => ({ ...s, external_code: e.target.value || null }))}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={v.imputable} onCheckedChange={(c) => setV((s) => ({ ...s, imputable: Boolean(c) }))} aria-label="Imputable" />
            Imputable (recibe asientos)
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={v.is_active} onCheckedChange={(c) => setV((s) => ({ ...s, is_active: Boolean(c) }))} aria-label="Activa" />
            Activa
          </label>
        </div>
      </div>
    </Modal>
  );
}

/** Próximo código libre bajo la madre (1.1.01 → 1.1.02). */
function suggestCode(parentCode: string | null, siblings: string[]): string {
  if (!parentCode) {
    const tops = siblings.map((c) => Number(c)).filter((n) => Number.isFinite(n));
    return String((tops.length ? Math.max(...tops) : 0) + 1);
  }
  const last = siblings
    .map((c) => c.slice(parentCode.length + 1))
    .filter((s) => /^\d+$/.test(s))
    .sort((a, b) => Number(a) - Number(b))
    .pop();
  const width = last ? last.length : 2;
  const next = String((last ? Number(last) : 0) + 1).padStart(width, "0");
  return `${parentCode}.${next}`;
}

function CostCentersSection() {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const { data: centers = [] } = useCostCenters();
  const { data: stores = [] } = useStores();
  const [edit, setEdit] = useState<{ open: boolean; cc: CostCenter | null }>({ open: false, cc: null });
  const [v, setV] = useState({ code: "", name: "", store_id: "" as string, is_active: true });

  useEffect(() => {
    if (!edit.open) return;
    setV(
      edit.cc
        ? { code: edit.cc.code, name: edit.cc.name, store_id: edit.cc.store_id ?? "", is_active: edit.cc.is_active }
        : { code: "", name: "", store_id: "", is_active: true },
    );
  }, [edit]);

  async function save() {
    try {
      await m.saveCostCenter.mutateAsync({
        id: edit.cc?.id ?? null,
        input: { code: v.code.trim(), name: v.name.trim(), store_id: v.store_id || null, is_active: v.is_active },
      });
      toast({ title: "Centro de costo guardado", variant: "success" });
      setEdit({ open: false, cc: null });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accErrorMessage(e), variant: "error" });
    }
  }

  return (
    <section className="mt-8 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Centros de costo</h2>
          <p className="text-sm text-muted-foreground">Uno por sucursal (se crean solos). Cada renglón de un asiento de la sucursal lleva el suyo.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setEdit({ open: true, cc: null })}>
          <Plus size={14} /> Centro de costo
        </Button>
      </div>
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Nombre</th>
              <th className="hidden px-4 py-3 sm:table-cell">Sucursal</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {centers.map((c) => (
              <tr key={c.id} className={cn(!c.is_active && "opacity-60")}>
                <td className="px-4 py-2 tabular-nums">{c.code}</td>
                <td className="px-4 py-2">{c.name}</td>
                <td className="hidden px-4 py-2 text-muted-foreground sm:table-cell">{stores.find((s) => s.id === c.store_id)?.name ?? "Sin sucursal"}</td>
                <td className="px-2 py-2 text-right">
                  <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEdit({ open: true, cc: c })}>
                    <Pencil size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <Modal
        open={edit.open}
        onOpenChange={(o) => setEdit((s) => ({ ...s, open: o }))}
        title={edit.cc ? "Editar centro de costo" : "Nuevo centro de costo"}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" onClick={() => setEdit({ open: false, cc: null })}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={!v.code.trim() || !v.name.trim()} loading={m.saveCostCenter.isPending}>
              Guardar
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
            <input aria-label="Código" placeholder="Código" className={inputCls} value={v.code} onChange={(e) => setV((s) => ({ ...s, code: e.target.value }))} />
            <input aria-label="Nombre" placeholder="Nombre" className={inputCls} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />
          </div>
          <select aria-label="Sucursal" className={inputCls} value={v.store_id} onChange={(e) => setV((s) => ({ ...s, store_id: e.target.value }))}>
            <option value="" className="bg-popover text-popover-foreground">Sin sucursal (unidad de negocio)</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={v.is_active} onCheckedChange={(c) => setV((s) => ({ ...s, is_active: Boolean(c) }))} aria-label="Activo" />
            Activo
          </label>
        </div>
      </Modal>
    </section>
  );
}
