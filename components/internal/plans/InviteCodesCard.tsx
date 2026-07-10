"use client";

import { useEffect, useState } from "react";
import { Dices, Plus, Power, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Heading } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import {
  useGlobalPlans,
  useInviteCodes,
  useInviteCodeMutations,
} from "@/modules/internal/hooks";
import type { InviteCode, InviteKind } from "@/modules/internal/api";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

const RANDOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomCode(len = 8): string {
  let out = "";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) {
    out += RANDOM_CHARS[(arr[i] ?? 0) % RANDOM_CHARS.length];
  }
  return out;
}

// Estado del código: vencido (valid_until pasó) tiene prioridad sobre inactivo.
function codeStatus(c: InviteCode): {
  label: string;
  cls: string;
  expired: boolean;
} {
  const expired =
    c.valid_until != null && new Date(c.valid_until) < new Date();
  if (expired)
    return {
      label: "Vencido",
      cls: "border-border bg-muted text-muted-foreground",
      expired: true,
    };
  if (!c.is_active)
    return {
      label: "Inactivo",
      cls: "border-border bg-muted text-muted-foreground",
      expired: false,
    };
  return {
    label: "Activo",
    cls: "border-emerald-400/30 bg-emerald-400/10 text-success",
    expired: false,
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-AR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function InviteCodesCard() {
  const { toast } = useToast();
  const { data: codes, isLoading } = useInviteCodes();
  const { data: plans } = useGlobalPlans();
  const { create, setActive, remove } = useInviteCodeMutations();

  const [open, setOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InviteCode | null>(null);

  // Form state.
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<InviteKind>("lifetime");
  const [planKey, setPlanKey] = useState("");
  const [days, setDays] = useState("30");
  const [maxUses, setMaxUses] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");

  useEffect(() => {
    if (!open) return;
    setCode("");
    setKind("lifetime");
    setPlanKey(plans?.[0]?.key ?? "");
    setDays("30");
    setMaxUses("");
    setValidFrom("");
    setValidUntil("");
  }, [open, plans]);

  async function handleCreate() {
    if (!code.trim()) {
      toast({ title: "Ingresá o generá un código", variant: "error" });
      return;
    }
    if (!planKey) {
      toast({ title: "Elegí un plan", variant: "error" });
      return;
    }
    const dayNum = kind === "trial_days" ? Number(days) : null;
    if (kind === "trial_days" && (!Number.isFinite(dayNum) || (dayNum ?? 0) <= 0)) {
      toast({ title: "Días inválidos", variant: "error" });
      return;
    }
    const maxNum = maxUses.trim() === "" ? null : Number(maxUses);
    if (maxNum !== null && (!Number.isFinite(maxNum) || maxNum <= 0)) {
      toast({ title: "Cupo de usos inválido", variant: "error" });
      return;
    }
    try {
      await create.mutateAsync({
        code: code.trim().toUpperCase(),
        kind,
        plan_key: planKey,
        trial_days: kind === "trial_days" ? dayNum : null,
        max_uses: maxNum,
        valid_from: validFrom || null,
        valid_until: validUntil || null,
      });
      toast({ title: "Código creado", variant: "success" });
      setOpen(false);
    } catch (e) {
      toast({
        title: "No se pudo crear",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function toggleActive(c: InviteCode) {
    setActive
      .mutateAsync({ id: c.id, active: !c.is_active })
      .then(() =>
        toast({
          title: c.is_active ? "Código desactivado" : "Código activado",
          variant: "success",
        }),
      )
      .catch((e) =>
        toast({
          title: "Error",
          description: e instanceof Error ? e.message : undefined,
          variant: "error",
        }),
      );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading as="h2">Códigos de invitación</Heading>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus size={15} /> Nuevo código
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Códigos canjeables en el registro: acceso vitalicio o días de prueba
        extendidos sobre un plan.
      </p>

      <Card className="mt-3">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Código</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Usos</th>
                  <th className="px-4 py-3">Vigencia</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-foreground">
                {isLoading && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      Cargando códigos…
                    </td>
                  </tr>
                )}
                {!isLoading && (codes?.length ?? 0) === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      Sin códigos todavía.
                    </td>
                  </tr>
                )}
                {(codes ?? []).map((c) => {
                  const st = codeStatus(c);
                  return (
                    <tr key={c.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3 font-mono text-sm font-semibold text-foreground">
                        {c.code}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {c.kind === "lifetime"
                          ? "Vitalicio"
                          : `Trial · ${c.trial_days ?? 0} días`}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {plans?.find((p) => p.key === c.plan_key)?.name ??
                          c.plan_key}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {c.used_count}
                        {c.max_uses != null ? ` / ${c.max_uses}` : " / ∞"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {c.valid_from || c.valid_until
                          ? `${fmtDate(c.valid_from)} → ${fmtDate(c.valid_until)}`
                          : "Sin límite"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${st.cls}`}
                        >
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => toggleActive(c)}
                            disabled={st.expired || setActive.isPending}
                            title={c.is_active ? "Desactivar" : "Activar"}
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                          >
                            <Power size={15} />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(c)}
                            title="Eliminar"
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Modal: nuevo código */}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Nuevo código de invitación"
        className="max-w-md"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Código
            </label>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="Ej. NINJA2026"
                className="font-mono uppercase"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCode(randomCode())}
              >
                <Dices size={15} /> Generar
              </Button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Tipo
            </label>
            <Segmented<InviteKind>
              value={kind}
              onChange={setKind}
              options={[
                { value: "lifetime", label: "Vitalicio" },
                { value: "trial_days", label: "Días de prueba" },
              ]}
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan
            </label>
            <select
              className={selectCls}
              value={planKey}
              onChange={(e) => setPlanKey(e.target.value)}
            >
              {(plans ?? []).map((p) => (
                <option
                  key={p.key}
                  value={p.key}
                  className="bg-ninja-deepViolet"
                >
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {kind === "trial_days" && (
            <Input
              label="Días de prueba"
              type="number"
              min="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}

          <Input
            label="Cupo de usos (vacío = ilimitado)"
            type="number"
            min="1"
            placeholder="∞"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />

          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Vigente desde (opcional)"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
            <Input
              label="Vigente hasta (opcional)"
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button loading={create.isPending} onClick={handleCreate}>
              Crear código
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Eliminar código"
        description={
          deleteTarget
            ? `¿Eliminar el código ${deleteTarget.code}? No se podrá canjear más.`
            : undefined
        }
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          remove
            .mutateAsync(deleteTarget.id)
            .then(() => {
              toast({ title: "Código eliminado", variant: "success" });
              setDeleteTarget(null);
            })
            .catch((e) =>
              toast({
                title: "Error",
                description: e instanceof Error ? e.message : undefined,
                variant: "error",
              }),
            );
        }}
      />
    </>
  );
}
