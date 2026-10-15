"use client";

// Configuración de la aprobación de ajustes (ADR-137). Sólo el dueño
// (stock.settings). Prender la aprobación, quién aprueba (sólo el dueño, o el
// dueño y los auditores), el umbral en unidades o en pesos al costo, la foto
// obligatoria y quiénes son auditores (capacidad stock.adjust.approve). No es
// el editor de roles: sólo otorga o quita este permiso.

import { useEffect, useState } from "react";
import { Lock, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { grantBlockedReason } from "@/lib/permissions/capabilities";
import { adjustmentErrorMessage, type ApprovalPolicy, type Approver } from "@/lib/stock/adjustments";
import { useAdjustmentMutations, useAdjustmentPolicy, useCapabilityMembers } from "@/modules/stock/adjustments";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

const numOrNull = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

export function ApprovalSettings() {
  const { toast } = useToast();
  const { data: policy } = useAdjustmentPolicy();
  const m = useAdjustmentMutations();
  const [draft, setDraft] = useState<ApprovalPolicy | null>(null);
  const [units, setUnits] = useState("");
  const [value, setValue] = useState("");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { data: members = [] } = useCapabilityMembers(Boolean(policy?.feature));

  useEffect(() => {
    if (!policy) return;
    setDraft(policy);
    setUnits(policy.threshold_units == null ? "" : String(policy.threshold_units));
    setValue(policy.threshold_value == null ? "" : String(policy.threshold_value));
  }, [policy]);

  if (!draft) return null;

  if (!draft.feature) {
    return (
      <div className="rounded-lg bg-muted/40 p-5 text-center">
        <Lock className="mx-auto text-ninja-flameSoft" size={24} />
        <p className="mt-2 font-semibold">La aprobación de ajustes no está incluida en tu plan</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Con la aprobación, los ajustes grandes de tus empleados esperan a que los revises vos o un auditor antes de
          tocar el stock.
        </p>
        <Button className="mt-3" onClick={() => setUpgradeOpen(true)}>
          Ver planes
        </Button>
        <UpgradeModal
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
          featureKey="aprobacion_ajustes"
          featureLabel="Aprobación de ajustes de stock"
        />
      </div>
    );
  }

  async function save() {
    if (!draft) return;
    const u = numOrNull(units);
    const v = numOrNull(value);
    if (Number.isNaN(u) || Number.isNaN(v)) {
      toast({ title: "Los umbrales tienen que ser números mayores a cero", variant: "error" });
      return;
    }
    try {
      await m.savePolicy.mutateAsync({
        approval_enabled: draft.approval_enabled,
        approver: draft.approver,
        threshold_units: u,
        threshold_value: v,
        require_photo: draft.require_photo,
      });
      toast({ title: "Aprobación guardada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: adjustmentErrorMessage(e), variant: "error" });
    }
  }

  async function toggleAuditor(userId: string, granted: boolean) {
    try {
      await m.setCapability.mutateAsync({ userId, capability: "stock.adjust.approve", granted });
      toast({ title: granted ? "Ahora es auditor" : "Dejó de ser auditor", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo cambiar", description: adjustmentErrorMessage(e), variant: "error" });
    }
  }

  const set = (p: Partial<ApprovalPolicy>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const candidates = members.filter((mm) => mm.role !== "owner");

  return (
    <div className="space-y-5 pt-2">
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="block text-sm font-medium">Pedir aprobación para los ajustes</span>
          <span className="block text-xs text-muted-foreground">
            Apagado, todos los ajustes se aplican en el momento. Los tuyos (dueño) nunca esperan.
          </span>
        </span>
        <Switch
          checked={draft.approval_enabled}
          onCheckedChange={(v) => set({ approval_enabled: v })}
          label="Pedir aprobación para los ajustes"
        />
      </label>

      {draft.approval_enabled && (
        <>
          <div role="radiogroup" aria-label="Quién aprueba" className="grid gap-2 sm:grid-cols-2">
            {(
              [
                { v: "owner", t: "Sólo el dueño", d: "Vos revisás cada ajuste que supere el umbral." },
                { v: "auditor", t: "El dueño o un auditor", d: "Además del dueño, aprueban las personas que marques como auditores." },
              ] as { v: Approver; t: string; d: string }[]
            ).map((o) => (
              <ChoiceCard
                key={o.v}
                selected={draft.approver === o.v}
                indicator
                title={o.t}
                description={o.d}
                onClick={() => set({ approver: o.v })}
              />
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Desde cuántas unidades</span>
              <Input inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="Ej.: 10" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Desde qué valor al costo ($)</span>
              <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ej.: 50000" />
            </label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Alcanza con que llegue a uno de los dos. Si dejás los dos vacíos, todos los ajustes piden aprobación.
          </p>

          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Foto obligatoria para lo que va a aprobación</span>
              <span className="block text-xs text-muted-foreground">Quien pide el ajuste tiene que sacar una foto de respaldo.</span>
            </span>
            <Switch
              checked={draft.require_photo}
              onCheckedChange={(v) => set({ require_photo: v })}
              label="Foto obligatoria"
            />
          </label>
        </>
      )}

      <Button onClick={save} loading={m.savePolicy.isPending}>
        Guardar
      </Button>

      {draft.approval_enabled && draft.approver === "auditor" && (
        <section className="border-t border-border pt-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <UserCheck size={16} aria-hidden /> Auditores
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Pueden aprobar o rechazar los ajustes de otros (nunca los propios). Tienen que ser cajeros o encargados: el
            usuario de solo lectura no puede modificar stock.
          </p>
          {candidates.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Todavía no hay otras personas en el equipo.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {candidates.map((mm) => {
                const on = mm.capabilities.includes("stock.adjust.approve");
                const blocked = grantBlockedReason(mm.role, "stock.adjust.approve");
                return (
                  <li key={mm.user_id} className="flex items-center gap-3 py-2">
                    <Checkbox
                      checked={on}
                      disabled={Boolean(blocked) && !on}
                      busy={m.setCapability.isPending && m.setCapability.variables?.userId === mm.user_id}
                      onCheckedChange={(v) => toggleAuditor(mm.user_id, v)}
                      aria-label={`Auditor: ${mm.name ?? mm.email ?? ""}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{mm.name ?? mm.email}</span>
                      {blocked && !on && <span className="block text-xs text-muted-foreground">{blocked}</span>}
                    </span>
                    <Badge tone="neutral">{ROLE_LABEL[mm.role] ?? mm.role}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
