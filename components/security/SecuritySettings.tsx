"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, FileSearch, KeyRound, Lock, LockOpen, Save, ShieldCheck, Trash2, Users, Wallet } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { CHOICE_ON } from "@/components/ui/ChoiceCard";
import { AuditLogViewer } from "@/components/security/AuditLogViewer";
import { EYEBROW, FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import { useBranchScope } from "@/modules/branches/hooks";
import {
  useMyPinsMutations,
  usePinMutations,
  usePinStatus,
  useSaveSecuritySettings,
  useSecuritySettings,
  useSupervisors,
} from "@/modules/security/hooks";
import { MyPinsPanel } from "@/components/security/MyPins";
import { useStaffPeople } from "@/modules/staff/hooks";
import {
  ACTION_INFO,
  ALWAYS_PIN,
  PIN_ACTIONS,
  modesProblem,
  type PinAction,
  type SecuritySettings as Settings,
} from "@/lib/security/pinPolicy";
import { ONE_TIME_MINUTES_OPTIONS, PIN_MODES, PIN_MODE_INFO, ROTATION_HOURS_OPTIONS, type PinMode } from "@/lib/security/otp";
import { capitalizeName, formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Tab = "mispines" | "politicas" | "supervisores" | "auditoria";

function fmtDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" }) : "";
}

// Configuración · Seguridad y auditoría (F17 · H116 + H117, ADR-051).
export function SecuritySettings() {
  const scope = useBranchScope();
  const role = scope.data?.role ?? null;
  const isOwner = role === "owner";
  const isManager = role === "owner" || role === "manager";
  const [tab, setTab] = useState<Tab>("politicas");
  const pinStatus = usePinStatus();
  const canHavePin = Boolean(pinStatus.data?.can_have_pin);

  return (
    <div className="space-y-5">
      <Segmented
        value={tab}
        onChange={setTab}
        aria-label="Sección"
        options={[
          ...(canHavePin ? [{ value: "mispines" as const, label: "Mis PINes", icon: <KeyRound size={15} /> }] : []),
          { value: "politicas", label: "PIN y políticas", icon: <ShieldCheck size={15} /> },
          { value: "supervisores", label: "Supervisores", icon: <Users size={15} /> },
          ...(isManager ? [{ value: "auditoria" as const, label: "Auditoría", icon: <FileSearch size={15} /> }] : []),
        ]}
      />
      {tab === "mispines" && canHavePin && <MyPinsPanel />}
      {tab === "politicas" && <PolicyPanel editable={isOwner} />}
      {tab === "supervisores" && <SupervisorsPanel isOwner={isOwner} />}
      {tab === "auditoria" && isManager && <AuditLogViewer />}
    </div>
  );
}
SecuritySettings.displayName = "SecuritySettings";

function PolicyPanel({ editable }: { editable: boolean }) {
  const { toast } = useToast();
  const { data, isLoading } = useSecuritySettings();
  const save = useSaveSecuritySettings();
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data), [draft, data]);
  if (isLoading || !draft) return <SpinnerBlock className="py-10" />;

  const setRule = (a: PinAction, patch: Partial<{ enabled: boolean; threshold: number }>) =>
    setDraft((d) => (d ? { ...d, pin_policy: { ...d.pin_policy, [a]: { ...d.pin_policy[a], ...patch } } } : d));

  const problem = modesProblem(draft);
  const auth = draft.pin_autenticador;
  const customHours = !(ROTATION_HOURS_OPTIONS as readonly number[]).includes(draft.pin_rotation_hours);

  const toggleMode = (m: PinMode) =>
    setDraft((d) => {
      if (!d) return d;
      const on = d.pin_modes.includes(m);
      const modes = on ? d.pin_modes.filter((x) => x !== m) : PIN_MODES.filter((x) => x === m || d.pin_modes.includes(x));
      return { ...d, pin_modes: modes, pin_default_mode: modes.includes(d.pin_default_mode) ? d.pin_default_mode : (modes[0] ?? "fixed") };
    });
  const toggleActionMode = (a: PinAction, m: PinMode) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = d.pin_policy[a].modes ?? [];
      const next = cur.includes(m) ? cur.filter((x) => x !== m) : PIN_MODES.filter((x) => x === m || cur.includes(x));
      const rule = { ...d.pin_policy[a] };
      if (next.length) rule.modes = next;
      else delete rule.modes;
      return { ...d, pin_policy: { ...d.pin_policy, [a]: rule } };
    });

  async function submit() {
    if (!draft) return;
    if (problem) {
      toast({ title: "Revisá los modos de PIN", description: problem, variant: "error" });
      return;
    }
    try {
      await save.mutateAsync({
        pin_policy: draft.pin_policy,
        pin_max_attempts: draft.pin_max_attempts,
        pin_lock_minutes: draft.pin_lock_minutes,
        pin_rotation_days: draft.pin_rotation_days,
        shared_shift: draft.shared_shift,
        pin_modes: draft.pin_modes,
        pin_default_mode: draft.pin_default_mode,
        pin_rotation_hours: draft.pin_rotation_hours,
        pin_one_time_max_minutes: draft.pin_one_time_max_minutes,
      });
      toast({ title: "Guardado", description: "Rige desde ya en todas las cajas.", variant: "success" });
    } catch {
      toast({ title: "No se pudo guardar", variant: "error" });
    }
  }

  return (
    <div className="space-y-5">
      {!editable && (
        <Callout tone="neutral" icon={Lock}>
          Sólo el dueño cambia estas reglas. Las ves para saber cuándo se pide PIN.
        </Callout>
      )}

      <section className={FLAT_PANEL}>
        <header className="flex items-start gap-3 border-b border-border p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
            <ShieldCheck size={18} aria-hidden />
          </span>
          <div>
            <h3 className="font-semibold">Qué acciones piden PIN de supervisor</h3>
            <p className="text-sm text-muted-foreground">
              Si quien lo hace no es supervisor, el sistema pide el PIN de uno antes de seguir. El servidor lo exige aunque
              alguien intente saltearlo.
            </p>
          </div>
        </header>
        <ul className="divide-y divide-border">
          {PIN_ACTIONS.map((a) => {
            const info = ACTION_INFO[a];
            const r = draft.pin_policy[a];
            const always = ALWAYS_PIN.includes(a);
            return (
              <li key={a} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{info.label}</span>
                    {always && <Badge tone="neutral">Siempre</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{info.desc}</p>
                  {auth && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={`Modos que acepta ${info.label}`}>
                      <span className="text-xs text-muted-foreground">Acepta:</span>
                      {draft.pin_modes.map((m) => {
                        const on = (r.modes ?? []).includes(m);
                        return (
                          <button
                            key={m}
                            type="button"
                            aria-pressed={on}
                            disabled={!editable}
                            onClick={() => toggleActionMode(a, m)}
                            className={cn(
                              "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition disabled:opacity-60",
                              on ? cn(CHOICE_ON, "text-foreground") : "bg-muted text-muted-foreground hover:bg-secondary",
                            )}
                          >
                            {on && <Check size={12} aria-hidden />}
                            {PIN_MODE_INFO[m].short}
                          </button>
                        );
                      })}
                      {!(r.modes ?? []).length && <span className="text-xs text-muted-foreground">(cualquiera)</span>}
                    </div>
                  )}
                </div>
                {info.unit !== "none" && (
                  <label className={cn("flex items-center gap-2 text-sm", !r.enabled && "opacity-50")}>
                    <span className="text-muted-foreground">{info.unit === "pct" ? "Más de" : "Desde"}</span>
                    <span className="relative">
                      {info.unit === "money" && (
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                      )}
                      <input
                        type="number"
                        min={0}
                        max={info.unit === "pct" ? 100 : undefined}
                        step={info.unit === "pct" ? 1 : 100}
                        disabled={!editable || !r.enabled}
                        value={r.threshold}
                        onChange={(e) => setRule(a, { threshold: Math.max(0, Number(e.target.value) || 0) })}
                        aria-label={`Umbral de ${info.label}`}
                        className={cn(
                          "h-10 w-28 rounded-md border border-border bg-background pr-2 text-right tabular-nums",
                          info.unit === "money" ? "pl-6" : "pl-2",
                        )}
                      />
                      {info.unit === "pct" && <span className="ml-1 text-muted-foreground">%</span>}
                    </span>
                  </label>
                )}
                <Switch
                  checked={always || r.enabled}
                  disabled={!editable || always}
                  onCheckedChange={(v) => setRule(a, { enabled: v })}
                  label={info.label}
                />
              </li>
            );
          })}
        </ul>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          Los topes de descuento por rol (Operación) siguen rigiendo; el PIN pide autorización por encima del umbral y
          hasta ese tope. Un monto de $0 pide PIN siempre.
          {draft.pin_policy.sale_void.enabled && draft.pin_policy.sale_void.threshold > 0
            ? ` Anular desde ${formatCurrency(draft.pin_policy.sale_void.threshold)} pide PIN.`
            : ""}
        </p>
      </section>

      <section className={FLAT_PANEL}>
        <header className="flex items-start gap-3 border-b border-border p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
            <KeyRound size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">Modos de PIN</h3>
              {!auth && <Badge tone="neutral">Desde Pro</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              Además del PIN fijo, los supervisores pueden autorizar con un PIN que cambia solo, con uno de un uso generado en
              el momento o con una app autenticadora. Cada supervisor los activa en Mis PINes.
            </p>
          </div>
        </header>
        <div className={cn("space-y-4 p-4", !auth && "opacity-60")}>
          <div>
            <p className={cn(EYEBROW, "mb-2")}>Modos permitidos</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {PIN_MODES.map((m) => {
                const on = draft.pin_modes.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    disabled={!editable || !auth}
                    onClick={() => toggleMode(m)}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md p-3 text-left text-sm transition disabled:cursor-not-allowed",
                      on ? cn(CHOICE_ON, "text-foreground") : "bg-muted text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center">{on && <Check size={14} aria-hidden />}</span>
                    <span className="min-w-0">
                      <span className="block font-medium text-foreground">{PIN_MODE_INFO[m].label}</span>
                      <span className="block text-xs">{PIN_MODE_INFO[m].desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">Modo por defecto</span>
              <select
                disabled={!editable || !auth}
                value={draft.pin_default_mode}
                onChange={(e) => setDraft((d) => (d ? { ...d, pin_default_mode: e.target.value as PinMode } : d))}
                className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              >
                {draft.pin_modes.map((m) => (
                  <option key={m} value={m}>
                    {PIN_MODE_INFO[m].label}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-1.5 block text-sm text-muted-foreground">El PIN rotativo cambia cada</span>
              <div className="flex items-center gap-2">
                <select
                  disabled={!editable || !auth}
                  value={customHours ? 0 : draft.pin_rotation_hours}
                  onChange={(e) => setDraft((d) => (d ? { ...d, pin_rotation_hours: Number(e.target.value) || 8 } : d))}
                  aria-label="Período del PIN rotativo"
                  className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm"
                >
                  {ROTATION_HOURS_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h} horas
                    </option>
                  ))}
                  <option value={0}>A medida</option>
                </select>
                {customHours && (
                  <span className="flex items-center gap-1 text-sm">
                    <input
                      type="number"
                      min={1}
                      max={168}
                      disabled={!editable || !auth}
                      value={draft.pin_rotation_hours}
                      onChange={(e) =>
                        setDraft((d) =>
                          d ? { ...d, pin_rotation_hours: Math.min(168, Math.max(1, Math.round(Number(e.target.value) || 1))) } : d,
                        )
                      }
                      aria-label="Horas del PIN rotativo"
                      className="h-11 w-20 rounded-md border border-border bg-background px-2 text-right tabular-nums"
                    />
                    h
                  </span>
                )}
              </div>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">PIN de un uso, máximo</span>
              <select
                disabled={!editable || !auth}
                value={draft.pin_one_time_max_minutes}
                onChange={(e) => setDraft((d) => (d ? { ...d, pin_one_time_max_minutes: Number(e.target.value) } : d))}
                className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              >
                {ONE_TIME_MINUTES_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m === 1 ? "1 minuto" : `${m} minutos`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {problem && <Callout tone="warning">{problem}</Callout>}
        </div>
      </section>

      <section className={cn(FLAT_PANEL, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
            <Wallet size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">Caja compartida</h3>
            <p className="text-sm text-muted-foreground">
              Apagado (recomendado): cada persona vende sólo en la caja que abrió. Encendido: cualquiera habilitado en la
              sucursal vende en una caja abierta por otro, pero los retiros, ingresos y el cierre siguen siendo de quien la
              abrió.
            </p>
          </div>
          <Switch
            checked={draft.shared_shift}
            disabled={!editable}
            onCheckedChange={(v) => setDraft((d) => (d ? { ...d, shared_shift: v } : d))}
            label="Caja compartida"
          />
        </div>
      </section>

      <section className={cn(FLAT_PANEL, "grid gap-4 p-4 sm:grid-cols-3")}>
        <div className="sm:col-span-3">
          <h3 className="font-semibold">Reglas del PIN</h3>
          <p className="text-sm text-muted-foreground">Bloqueo por intentos fallidos y cada cuánto hay que cambiarlo.</p>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted-foreground">Intentos antes de bloquear</span>
          <select
            disabled={!editable}
            value={draft.pin_max_attempts}
            onChange={(e) => setDraft((d) => (d ? { ...d, pin_max_attempts: Number(e.target.value) } : d))}
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
          >
            {[3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n} intentos
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted-foreground">Bloqueo</span>
          <select
            disabled={!editable}
            value={draft.pin_lock_minutes}
            onChange={(e) => setDraft((d) => (d ? { ...d, pin_lock_minutes: Number(e.target.value) } : d))}
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
          >
            {[5, 15, 30, 60, 240, 1440].map((n) => (
              <option key={n} value={n}>
                {n < 60 ? `${n} minutos` : n === 1440 ? "1 día" : `${n / 60} ${n === 60 ? "hora" : "horas"}`}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted-foreground">Cambiar el PIN cada</span>
          <select
            disabled={!editable}
            value={draft.pin_rotation_days ?? 0}
            onChange={(e) => setDraft((d) => (d ? { ...d, pin_rotation_days: Number(e.target.value) || null } : d))}
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
          >
            <option value={0}>Nunca vence</option>
            {[30, 60, 90, 180, 365].map((n) => (
              <option key={n} value={n}>
                {n} días
              </option>
            ))}
          </select>
        </label>
      </section>

      {editable && (
        <div className="flex justify-end">
          <Button className={SOLID_CTA} disabled={!dirty} loading={save.isPending} onClick={submit}>
            <Save size={16} /> Guardar cambios
          </Button>
        </div>
      )}
    </div>
  );
}

function SupervisorsPanel({ isOwner }: { isOwner: boolean }) {
  const { toast } = useToast();
  const { data: settings } = useSecuritySettings();
  const save = useSaveSecuritySettings();
  const { data: supervisors = [], isLoading } = useSupervisors();
  const { data: people = [] } = useStaffPeople(isOwner);
  const { clearPin } = usePinMutations();
  const { unlock, resetMethods } = useMyPinsMutations();
  const [confirmClear, setConfirmClear] = useState<{ id: string; name: string } | null>(null);

  const roles = settings?.supervisor_roles ?? ["owner", "manager"];
  const chosen = settings?.supervisor_user_ids ?? [];
  const candidates = people.filter((p) => p.kind === "user" && p.role !== "owner" && p.state.status !== "terminated");

  async function patch(p: Partial<Settings>) {
    try {
      await save.mutateAsync(p);
      toast({ title: "Guardado", variant: "success" });
    } catch {
      toast({ title: "No se pudo guardar", variant: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <section className={FLAT_PANEL}>
        <header className="border-b border-border p-4">
          <h3 className="font-semibold">Quién puede autorizar</h3>
          <p className="text-sm text-muted-foreground">El dueño siempre. Sumá roles o personas puntuales (por ejemplo, el cajero más antiguo).</p>
        </header>
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {(["manager", "cashier"] as const).map((r) => {
              const on = roles.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  disabled={!isOwner || save.isPending}
                  aria-pressed={on}
                  onClick={() =>
                    patch({ supervisor_roles: on ? roles.filter((x) => x !== r) : [...roles, r] })
                  }
                  className={cn(
                    "inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm transition disabled:opacity-60",
                    on ? cn(CHOICE_ON, "text-foreground") : "bg-muted text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {on && <Check size={14} aria-hidden />}
                  {r === "manager" ? "Todos los encargados" : "Todos los cajeros"}
                </button>
              );
            })}
          </div>
          {isOwner && candidates.length > 0 && (
            <div>
              <p className={cn(EYEBROW, "mb-2")}>Personas puntuales</p>
              <div className="flex flex-wrap gap-2">
                {candidates.map((p) => {
                  const on = chosen.includes(p.user_id!);
                  return (
                    <button
                      key={p.user_id!}
                      type="button"
                      aria-pressed={on}
                      disabled={save.isPending}
                      onClick={() =>
                        patch({ supervisor_user_ids: on ? chosen.filter((x) => x !== p.user_id) : [...chosen, p.user_id!] })
                      }
                      className={cn(
                        "inline-flex h-10 items-center gap-2 rounded-md pl-1.5 pr-3 text-sm transition",
                        on ? cn(CHOICE_ON, "text-foreground") : "bg-muted text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      <Avatar name={p.name} avatar={p.avatar} size={26} />
                      {capitalizeName(p.name)}
                      {on && <Check size={14} aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={FLAT_PANEL}>
        <header className="border-b border-border p-4">
          <h3 className="font-semibold">Supervisores</h3>
          <p className="text-sm text-muted-foreground">
            {isOwner ? "Todos los que pueden autorizar y el estado de su PIN." : "Los que tienen PIN cargado."}
          </p>
        </header>
        {isLoading ? (
          <SpinnerBlock className="py-8" />
        ) : supervisors.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nadie cargó su PIN todavía.</p>
        ) : (
          <ul className="divide-y divide-border">
            {supervisors.map((s) => (
              <li key={s.user_id} className="flex items-center gap-3 p-4">
                <Avatar name={s.name} avatar={s.avatar} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{capitalizeName(s.name)}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.role === "owner" ? "Dueño" : s.role === "manager" ? "Encargado" : "Cajero"}
                    {s.pin_set_at ? ` · PIN del ${fmtDate(s.pin_set_at)}` : ""}
                    {s.methods?.length ? ` · ${s.methods.map((m) => PIN_MODE_INFO[m]?.short ?? m).join(", ")}` : ""}
                  </p>
                </div>
                {s.locked ? (
                  <Badge tone="danger">Bloqueado</Badge>
                ) : !s.has_pin ? (
                  <Badge tone="warning">Sin PIN</Badge>
                ) : s.expired ? (
                  <Badge tone="warning">PIN vencido</Badge>
                ) : (
                  <Badge tone="success">PIN listo</Badge>
                )}
                {isOwner && s.locked && (
                  <button
                    type="button"
                    disabled={unlock.isPending}
                    onClick={async () => {
                      try {
                        await unlock.mutateAsync(s.user_id);
                        toast({ title: "Desbloqueado", variant: "success" });
                      } catch {
                        toast({ title: "No se pudo desbloquear", variant: "error" });
                      }
                    }}
                    className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Desbloquear a ${s.name}`}
                    title="Desbloquear"
                  >
                    <LockOpen size={16} />
                  </button>
                )}
                {isOwner && s.has_pin && (
                  <button
                    type="button"
                    onClick={() => setConfirmClear({ id: s.user_id, name: s.name })}
                    className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Borrar los PINes de ${s.name}`}
                    title="Borrar PINes (también desbloquea)"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(confirmClear)}
        onOpenChange={(o) => !o && setConfirmClear(null)}
        title={confirmClear ? `Borrar los PINes de ${confirmClear.name}` : "Borrar PINes"}
        description="Borra su PIN fijo y su PIN rotativo, desvincula su app y revoca sus PIN de un uso activos. Tendrá que configurarlos de nuevo para autorizar. Sirve también para desbloquearlo."
        confirmLabel="Borrar PINes"
        danger
        loading={clearPin.isPending || resetMethods.isPending}
        onConfirm={async () => {
          if (!confirmClear) return;
          try {
            await clearPin.mutateAsync(confirmClear.id);
            // Base sin ADR-060: la RPC no existe y alcanza con el PIN fijo.
            await resetMethods.mutateAsync(confirmClear.id).catch(() => undefined);
            toast({ title: "PIN borrado", variant: "success" });
          } catch {
            toast({ title: "No se pudo borrar", variant: "error" });
          }
          setConfirmClear(null);
        }}
      />
    </div>
  );
}
