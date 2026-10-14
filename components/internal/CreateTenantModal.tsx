"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { useCreateTenant, useGlobalPlans } from "@/modules/internal/hooks";
import { VERTICALS, VERTICAL_LABELS, type Vertical } from "@/lib/verticals/config";
import {
  MAX_REASON_LENGTH,
  TRIAL_DAY_OPTIONS,
  parseCreateTenantInput,
  slugifyTenantName,
} from "@/supabase/functions/_shared/tenantAdmin";

const ERRORS: Record<string, string> = {
  invalid_name: "El nombre tiene que tener entre 2 y 120 caracteres.",
  invalid_industry: "Elegí un rubro.",
  invalid_email: "El email del dueño no es válido.",
  invalid_plan: "Elegí un plan.",
  plan_not_found: "El plan no existe o está inactivo.",
  invalid_trial_days: "Los días de prueba van de 0 a 90.",
  reason_too_long: "La nota es demasiado larga.",
  invite_failed: "No se pudo enviar la invitación al dueño. Revisá el email.",
  owner_not_found: "No se encontró la cuenta del dueño.",
  slug_taken: "No hay un identificador libre para ese nombre. Probá con otro.",
  forbidden: "Tu nivel de staff no permite dar de alta negocios.",
  forbidden_support_level: "Soporte no puede dar de alta negocios.",
};

type TrialKey = "0" | "7" | "14" | "30";

// Alta manual de negocio (ADR-073): nombre, rubro, dueño por email (se lo
// invita si no tiene cuenta), plan y días de prueba. Todo pasa por la Edge
// internal_create_tenant y queda auditado.
export function CreateTenantModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: plans } = useGlobalPlans();
  const create = useCreateTenant();

  const [name, setName] = useState("");
  const [industry, setIndustry] = useState<Vertical>("kiosco");
  const [email, setEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [trial, setTrial] = useState<TrialKey>("14");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setIndustry("kiosco");
    setEmail("");
    setOwnerName("");
    setTrial("14");
    setNote("");
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!planKey && plans && plans.length > 0) setPlanKey(plans[0]!.key);
  }, [plans, planKey]);

  const payload = {
    name,
    industry,
    owner_email: email,
    owner_name: ownerName || null,
    plan_key: planKey ?? "",
    trial_days: Number(trial),
    reason: note || null,
  };
  const parsed = parseCreateTenantInput(payload);

  function submit() {
    if (!parsed.ok) {
      setError(ERRORS[parsed.error] ?? parsed.error);
      return;
    }
    setError(null);
    create.mutate(payload, {
      onSuccess: (res) => {
        toast({
          title: "Negocio creado",
          description: res.ownerInvited
            ? "Se envió la invitación al dueño."
            : "El dueño ya tenía cuenta: lo ve al entrar.",
          variant: "success",
        });
        onOpenChange(false);
        router.push(`/internal/tenants/${res.tenantId}`);
      },
      onError: (e) => setError(ERRORS[e.message] ?? `No se pudo crear: ${e.message}`),
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nuevo negocio"
      description="Alta manual. El dueño recibe una invitación por email si todavía no tiene cuenta."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={create.isPending} disabled={!parsed.ok} onClick={submit}>
            Crear negocio
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Nombre del negocio"
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint={name.trim().length >= 2 ? `Identificador: ${slugifyTenantName(name)}` : undefined}
          autoFocus
          maxLength={120}
        />
        <Select<Vertical>
          label="Rubro"
          value={industry}
          onChange={setIndustry}
          options={VERTICALS.map((v) => ({ value: v, label: VERTICAL_LABELS[v] }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Email del dueño"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          <Input
            label="Nombre del dueño (opcional)"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            maxLength={80}
          />
        </div>
        <Select<string>
          label="Plan"
          value={planKey}
          onChange={setPlanKey}
          placeholder={plans ? "Elegí un plan" : "Buscando planes"}
          options={(plans ?? []).map((p) => ({ value: p.key, label: p.name }))}
        />
        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">Prueba gratis</div>
          <Segmented<TrialKey>
            value={trial}
            onChange={setTrial}
            aria-label="Días de prueba"
            options={TRIAL_DAY_OPTIONS.map((d) => ({
              value: String(d) as TrialKey,
              label: d === 0 ? "Sin trial (activo)" : `${d} días`,
            }))}
          />
        </div>
        <div>
          <label htmlFor="create-tenant-note" className="mb-2 block text-sm font-medium text-muted-foreground">
            Nota para la auditoría (opcional)
          </label>
          <textarea
            id="create-tenant-note"
            rows={2}
            maxLength={MAX_REASON_LENGTH}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ej.: venta cerrada por teléfono, migración desde otro sistema…"
            className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
