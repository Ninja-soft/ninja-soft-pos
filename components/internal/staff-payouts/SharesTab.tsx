"use client";

// Participaciones (F21 · ADR-121): personas, % con vigencia e historia,
// reglas por cliente, cuentas de cobro de cada uno y configuración general.

import { useMemo, useState } from "react";
import { Building2, History, Landmark, Pencil, Plus, Settings2, Star, Trash2, UserPlus, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { BankLogo } from "@/components/payments/BankLogo";
import { BankAccountEditor, bankAccountPayload, bankAccountValueOf } from "@/components/billing/BankAccountEditor";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { formatCbu } from "@/lib/payments/transfer";
import { shareOn, sharesOverflow, type ClientRuleKind, type StaffShare } from "@/supabase/functions/_shared/staff/settlement";
import { addDays } from "@/supabase/functions/_shared/staff/dates";
import {
  RULE_LABEL,
  formatBp,
  formatCents,
  formatDay,
  parsePercentToBp,
  parsePesosToCents,
  ruleText,
  staffErrorMessage,
} from "@/lib/staffPayouts/format";
import { todayAR } from "@/lib/billing/ledger";
import {
  useInternalStaffUsers,
  useStaffMutations,
  useTenantsForStaff,
  type BankAccountRow,
  type StaffData,
  type StaffMemberRow,
} from "@/modules/staffPayouts/api";
import { Card, FIELD_LABEL, NATIVE_SELECT } from "./parts";

const reasonOk = (r: string) => r.trim().length >= 5;

// ── Persona ──────────────────────────────────────────────────────────────────

function MemberModal({ open, onOpenChange, member }: { open: boolean; onOpenChange: (o: boolean) => void; member: StaffMemberRow | null }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const { data: users } = useInternalStaffUsers(open);
  const [name, setName] = useState(member?.display_name ?? "");
  const [userId, setUserId] = useState(member?.user_id ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [notes, setNotes] = useState(member?.notes ?? "");
  const [active, setActive] = useState(member?.is_active ?? true);
  const [reason, setReason] = useState(member ? "" : "Alta en la participación");
  const save = () =>
    mut.saveMember.mutate(
      { id: member?.id ?? null, user_id: userId || null, display_name: name.trim(), email: email.trim() || null, notes: notes.trim() || null, is_active: active, reason },
      {
        onSuccess: () => {
          toast({ title: member ? "Persona actualizada" : "Persona agregada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
      },
    );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={member ? "Editar persona" : "Agregar persona"}
      description="Quién participa del reparto. Si tiene usuario del staff, ve su participación en el panel."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={mut.saveMember.isPending} disabled={name.trim().length < 2 || !reasonOk(reason)}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <div>
          <label className={FIELD_LABEL} htmlFor="sm-user">
            Usuario del staff (opcional)
          </label>
          <select id="sm-user" className={NATIVE_SELECT} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Sin usuario (no ve el panel)</option>
            {(users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.email} · {u.email}
              </option>
            ))}
          </select>
        </div>
        <Input
          label="Email para avisarle los pagos"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Si lo dejás vacío, el del usuario"
        />
        <Input label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        {member && (
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={active} onCheckedChange={setActive} label="Activa" /> Activa
          </label>
        )}
        <ReasonField value={reason} onChange={setReason} />
      </div>
    </Modal>
  );
}

// ── Participación (nueva vigencia) ──────────────────────────────────────────

function ShareModal({
  open,
  onOpenChange,
  data,
  memberId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: StaffData;
  memberId: string | null;
}) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const today = todayAR();
  const current = memberId ? shareOn(data.shares, memberId, today) : null;
  const [member, setMember] = useState(memberId ?? data.members[0]?.id ?? "");
  const [pct, setPct] = useState(current ? String(current.share_bp / 100).replace(".", ",") : "");
  const [exp, setExp] = useState(current?.expense_bp !== null && current?.expense_bp !== undefined ? String(current.expense_bp / 100).replace(".", ",") : "");
  const [from, setFrom] = useState(today);
  const [reason, setReason] = useState("");
  const bp = parsePercentToBp(pct);
  const expBp = exp.trim() ? parsePercentToBp(exp) : null;
  // Cómo quedan las vigencias con el cambio (mismo criterio que la RPC) y si
  // algún día posterior pasa el 100 %.
  const simulated = useMemo(() => {
    if (bp === null || !member) return null;
    const next: StaffShare[] = data.shares
      .filter((s) => !(s.member_id === member && s.valid_from >= from))
      .map((s) => (s.member_id === member && (!s.valid_to || s.valid_to >= from) ? { ...s, valid_to: addDays(from, -1) } : s));
    if (bp > 0) next.push({ member_id: member, share_bp: bp, expense_bp: null, valid_from: from, valid_to: null });
    return sharesOverflow(next);
  }, [bp, member, from, data.shares]);
  const total = useMemo(() => {
    if (bp === null) return null;
    return data.members.reduce((acc, m) => acc + (m.id === member ? bp : (shareOn(data.shares, m.id, from)?.share_bp ?? 0)), 0);
  }, [bp, member, from, data.members, data.shares]);
  const locked = data.runs[0] ? `${data.runs[0].period.slice(0, 7)}-31` : null;
  const save = () =>
    mut.setShare.mutate(
      { member, share_bp: bp ?? 0, expense_bp: exp.trim() ? expBp : null, valid_from: from, reason },
      {
        onSuccess: () => {
          toast({ title: "Participación guardada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
      },
    );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Participación"
      description="Desde la fecha que elijas. La anterior se cierra el día antes y queda en el historial."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={save}
            loading={mut.setShare.isPending}
            disabled={!member || bp === null || (exp.trim() !== "" && expBp === null) || !reasonOk(reason) || (total ?? 0) > 10_000}
          >
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!memberId && (
          <div>
            <label className={FIELD_LABEL} htmlFor="sh-member">
              Persona
            </label>
            <select id="sh-member" className={NATIVE_SELECT} value={member} onChange={(e) => setMember(e.target.value)}>
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="% del cobrado neto" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="Ej. 40" error={pct && bp === null ? "Entre 0 y 100" : undefined} />
          <Input
            label="% de gastos (opcional)"
            inputMode="decimal"
            value={exp}
            onChange={(e) => setExp(e.target.value)}
            placeholder="Igual que su %"
            error={exp && expBp === null ? "Entre 0 y 100" : undefined}
          />
        </div>
        <Input label="Desde" type="date" value={from} min={locked ?? undefined} onChange={(e) => setFrom(e.target.value)} />
        {total !== null && (
          <Callout tone={total > 10_000 ? "danger" : "neutral"}>
            Con este cambio, el {formatDay(from)} se reparte {formatBp(total)} entre las personas y la casa se queda con{" "}
            {formatBp(Math.max(0, 10_000 - total))}.{total > 10_000 ? " No puede pasar el 100 %." : ""}
            {simulated && total <= 10_000 ? ` Ojo: el ${formatDay(simulated.day)} la suma llega a ${formatBp(simulated.total_bp)}.` : ""}
          </Callout>
        )}
        <p className="text-xs text-muted-foreground">
          0 % con el % de gastos vacío = deja de participar desde esa fecha. El % de gastos sirve para que alguien absorba menos (o más) gastos que lo que
          cobra; la diferencia la absorbe la casa.
        </p>
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: nuevo acuerdo de socios del 01/11" />
      </div>
    </Modal>
  );
}

// ── Regla por cliente ────────────────────────────────────────────────────────

function RuleModal({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data: StaffData }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const { data: tenants } = useTenantsForStaff(open);
  const [member, setMember] = useState(data.members[0]?.id ?? "");
  const [tenant, setTenant] = useState("");
  const [kind, setKind] = useState<ClientRuleKind>("bonus_bp");
  const [value, setValue] = useState("");
  const [from, setFrom] = useState(todayAR());
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const parsed = kind === "signup_fixed" ? parsePesosToCents(value) : parsePercentToBp(value);
  const save = () =>
    mut.saveRule.mutate(
      { member, tenant, kind, value: parsed ?? 0, valid_from: from, valid_to: to || null, reason },
      {
        onSuccess: () => {
          toast({ title: "Regla guardada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
      },
    );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Regla por cliente"
      description="Un porcentaje distinto para una persona en un negocio, o una comisión por haberlo traído."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={mut.saveRule.isPending} disabled={!member || !tenant || parsed === null || !reasonOk(reason)}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={FIELD_LABEL} htmlFor="rule-member">
              Persona
            </label>
            <select id="rule-member" className={NATIVE_SELECT} value={member} onChange={(e) => setMember(e.target.value)}>
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="rule-tenant">
              Cliente (negocio)
            </label>
            <select id="rule-tenant" className={NATIVE_SELECT} value={tenant} onChange={(e) => setTenant(e.target.value)}>
              <option value="">Elegí un negocio</option>
              {(tenants ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor="rule-kind">
            Tipo
          </label>
          <select id="rule-kind" className={NATIVE_SELECT} value={kind} onChange={(e) => setKind(e.target.value as ClientRuleKind)}>
            {(Object.keys(RULE_LABEL) as ClientRuleKind[]).map((k) => (
              <option key={k} value={k}>
                {RULE_LABEL[k]}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {kind === "bonus_bp" && "Suma puntos a su % sólo en este cliente. Ej.: el vendedor que lo trajo cobra +10 % de lo que paga este negocio. Sale de la parte de la casa."}
            {kind === "override_bp" && "Reemplaza su % en este cliente (puede ser menor o mayor)."}
            {kind === "signup_fixed" && "Un monto fijo, una sola vez, en la primera liquidación con un cobro de este negocio dentro de las fechas. Lo paga la casa."}
            {kind === "signup_bp" && "Un % del primer cobro neto de este negocio, una sola vez. Lo paga la casa."}
          </p>
        </div>
        <Input
          label={kind === "signup_fixed" ? "Monto ($)" : "Porcentaje"}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={kind === "signup_fixed" ? "Ej. 50.000" : "Ej. 10"}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="Hasta (opcional)" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: Ana trajo a este cliente en octubre" />
      </div>
    </Modal>
  );
}

// ── Configuración ────────────────────────────────────────────────────────────

function SettingsModal({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data: StaffData }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const s = data.settings;
  const [start, setStart] = useState(s?.start_period ?? todayAR().slice(0, 8) + "01");
  const [label, setLabel] = useState(s?.house_label ?? "NinjaSoft");
  const [absorbs, setAbsorbs] = useState(s?.house_absorbs_expenses ?? true);
  const [carry, setCarry] = useState(s?.negative_carry ?? true);
  const [reserve, setReserve] = useState(String((s?.income_tax_reserve_bp ?? 0) / 100).replace(".", ","));
  const [rate, setRate] = useState(String((s?.projection_collection_rate_bp ?? 10_000) / 100).replace(".", ","));
  const [tol, setTol] = useState(String((s?.mp_amount_tolerance_cents ?? 0) / 100));
  const [notify, setNotify] = useState(s?.notify_on_payment ?? true);
  const [reason, setReason] = useState("");
  const reserveBp = parsePercentToBp(reserve);
  const rateBp = parsePercentToBp(rate);
  const tolCents = tol.trim() === "0" || tol.trim() === "" ? 0 : parsePesosToCents(tol);
  const save = () =>
    mut.saveSettings.mutate(
      {
        patch: {
          start_period: start.slice(0, 8) + "01",
          house_label: label,
          house_absorbs_expenses: absorbs,
          negative_carry: carry,
          income_tax_reserve_bp: reserveBp ?? 0,
          projection_collection_rate_bp: rateBp ?? 10_000,
          mp_amount_tolerance_cents: tolCents ?? 0,
          notify_on_payment: notify,
        },
        reason,
      },
      {
        onSuccess: () => {
          toast({ title: "Configuración guardada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
      },
    );
  const row = "flex items-start justify-between gap-4 text-sm";
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Configuración del reparto"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={mut.saveSettings.isPending} disabled={!reasonOk(reason) || reserveBp === null || rateBp === null || tolCents === null}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Se liquida desde el mes"
            type="month"
            value={start.slice(0, 7)}
            disabled={data.runs.length > 0}
            onChange={(e) => setStart(`${e.target.value}-01`)}
          />
          <Input label="Nombre de la casa" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
        </div>
        <label className={row}>
          <span>
            <span className="font-medium">La casa absorbe gastos</span>
            <span className="block text-xs text-muted-foreground">Con su parte, como una persona más. Si no, los gastos proporcionales se reparten sólo entre las personas.</span>
          </span>
          <Switch checked={absorbs} onCheckedChange={setAbsorbs} label="La casa absorbe gastos" />
        </label>
        <label className={row}>
          <span>
            <span className="font-medium">Arrastrar saldos negativos</span>
            <span className="block text-xs text-muted-foreground">Si a alguien le da negativo, no cobra y se le descuenta el mes siguiente. Si no, lo condona la casa.</span>
          </span>
          <Switch checked={carry} onCheckedChange={setCarry} label="Arrastrar negativos" />
        </label>
        <label className={row}>
          <span>
            <span className="font-medium">Avisar por email cada pago</span>
            <span className="block text-xs text-muted-foreground">Se puede cambiar en cada pago.</span>
          </span>
          <Switch checked={notify} onCheckedChange={setNotify} label="Avisar por email" />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Reserva de impuestos (%)" inputMode="decimal" value={reserve} onChange={(e) => setReserve(e.target.value)} />
          <Input label="Tasa de cobro proyectada (%)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          <Input label="Tolerancia MP ($)" inputMode="decimal" value={tol} onChange={(e) => setTol(e.target.value)} />
        </div>
        <ReasonField value={reason} onChange={setReason} />
      </div>
    </Modal>
  );
}

// ── Cuentas de cobro ─────────────────────────────────────────────────────────

export function AccountsList({
  accounts,
  memberId,
  compact,
}: {
  accounts: BankAccountRow[];
  memberId: string;
  compact?: boolean;
}) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const [editing, setEditing] = useState<BankAccountRow | null | "new">(null);
  const [removing, setRemoving] = useState<BankAccountRow | null>(null);
  const mine = accounts.filter((a) => a.member_id === memberId);
  const current = editing && editing !== "new" ? editing : null;
  return (
    <div className="space-y-2">
      {mine.length === 0 && <p className="text-sm text-muted-foreground">Sin cuentas cargadas.</p>}
      {mine.map((a) => (
        <div key={a.id} className="flex items-center gap-3 rounded-lg bg-fg-4 p-2.5">
          <BankLogo slug={a.bank_slug} name={a.bank_name} size={compact ? 28 : 34} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
              {a.bank_name}
              {a.is_default && <Star size={12} className="shrink-0 fill-current text-warning" aria-label="Predeterminada" />}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {a.holder_name}
              {a.alias ? ` · ${a.alias}` : ""}
              {a.cbu ? ` · ${formatCbu(a.cbu)}` : ""}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Editar cuenta" onClick={() => setEditing(a)}>
            <Pencil size={14} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Quitar cuenta" onClick={() => setRemoving(a)}>
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setEditing("new")}>
        <Plus size={14} aria-hidden /> Agregar cuenta de cobro
      </Button>
      <BankAccountEditor
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        initial={current ? bankAccountValueOf(current) : null}
        isDefault={current ? current.is_default : mine.length === 0}
        lockDefault={current?.is_default}
        title={current ? "Editar cuenta de cobro" : "Nueva cuenta de cobro"}
        description="Adónde se le transfiere a esta persona."
        defaultLabel="Usar por defecto para pagarle"
        saving={mut.saveAccount.isPending}
        onSave={(v, o) =>
          mut.saveAccount.mutate(
            { id: current?.id ?? null, member: memberId, payload: bankAccountPayload(v), is_default: o.is_default },
            {
              onSuccess: () => {
                toast({ title: "Cuenta guardada", variant: "success" });
                setEditing(null);
              },
              onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
            },
          )
        }
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Quitar cuenta"
        description="Los pagos ya registrados conservan los datos de la cuenta."
        confirmLabel="Quitar"
        danger
        loading={mut.deleteAccount.isPending}
        onConfirm={() =>
          removing &&
          mut.deleteAccount.mutate(
            { id: removing.id },
            { onSuccess: () => setRemoving(null), onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }) },
          )
        }
      />
    </div>
  );
}

// ── Pestaña ──────────────────────────────────────────────────────────────────

export function SharesTab({ data }: { data: StaffData }) {
  const { toast } = useToast();
  const mut = useStaffMutations();
  const today = todayAR();
  const [memberModal, setMemberModal] = useState<StaffMemberRow | null | "new">(null);
  const [shareFor, setShareFor] = useState<string | null | "any">(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const total = data.members.reduce((acc, m) => acc + (shareOn(data.shares, m.id, today)?.share_bp ?? 0), 0);
  const name = (id: string) => data.members.find((m) => m.id === id)?.display_name ?? "Persona";
  const s = data.settings;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          icon={Users}
          title="Personas y participaciones"
          description={`Hoy se reparte ${formatBp(total)}; ${s?.house_label ?? "la casa"} se queda con ${formatBp(Math.max(0, 10_000 - total))}.`}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => setMemberModal("new")}>
                <UserPlus size={14} aria-hidden /> Agregar persona
              </Button>
              <Button size="sm" onClick={() => setShareFor("any")} disabled={data.members.length === 0}>
                <Plus size={14} aria-hidden /> Cambiar participación
              </Button>
            </>
          }
        />
        {data.members.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-card">
            <EmptyState compact icon={Users} title="Todavía no hay nadie" description="Agregá a las personas del staff que participan del reparto." />
          </div>
        ) : (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {data.members.map((m) => {
              const cur = shareOn(data.shares, m.id, today);
              const history = data.shares.filter((x) => x.member_id === m.id).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
              return (
                <Card key={m.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-semibold">
                        {m.display_name}
                        {!m.is_active && <Badge tone="neutral">Inactiva</Badge>}
                        {!m.user_id && <Badge tone="neutral">Sin usuario</Badge>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{m.email ?? "Sin email: no recibe avisos de pago"}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-display text-2xl font-bold tabular-nums">{formatBp(cur?.share_bp ?? 0)}</p>
                      {cur && cur.expense_bp !== null && <p className="text-xs text-muted-foreground">{formatBp(cur.expense_bp)} de gastos</p>}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setShareFor(m.id)}>
                      Cambiar %
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setMemberModal(m)}>
                      <Pencil size={14} aria-hidden /> Editar
                    </Button>
                  </div>
                  {history.length > 0 && (
                    <div className="mt-4">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <History size={13} aria-hidden /> Historial
                      </p>
                      <ul className="mt-1 divide-y divide-border/60 text-xs">
                        {history.map((h) => (
                          <li key={h.id} className="flex justify-between gap-2 py-1.5">
                            <span className="text-muted-foreground">
                              {formatDay(h.valid_from)} → {h.valid_to ? formatDay(h.valid_to) : "hoy"}
                              <span className="ml-1.5 hidden sm:inline">· {h.reason}</span>
                            </span>
                            <span className="tabular-nums">
                              {formatBp(h.share_bp)}
                              {h.expense_bp !== null ? ` (${formatBp(h.expense_bp)} gastos)` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-4">
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Landmark size={13} aria-hidden /> Cuentas de cobro
                    </p>
                    <AccountsList accounts={data.accounts} memberId={m.id} compact />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionHeader
          icon={Building2}
          title="Reglas por cliente"
          description="Más (o menos) % para una persona en un negocio, o una comisión de alta por haberlo traído."
          actions={
            <Button variant="secondary" size="sm" onClick={() => setRuleOpen(true)} disabled={data.members.length === 0}>
              <Plus size={14} aria-hidden /> Nueva regla
            </Button>
          }
        />
        {data.rules.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Sin reglas: todos cobran su % en todos los clientes.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {data.rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{name(r.member_id)}</span> en <span className="font-medium">{r.tenants?.name ?? "negocio"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {ruleText(r.kind, r.value, formatCents)} · desde {formatDay(r.valid_from)}
                    {r.valid_to ? ` hasta ${formatDay(r.valid_to)}` : ""} · {r.reason}
                  </span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => setEnding(r.id)}>
                  Terminar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader
          icon={Settings2}
          title="Configuración"
          actions={
            <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>
              Editar
            </Button>
          }
        />
        {s && (
          <dl className="mt-3 grid gap-x-6 gap-y-2 rounded-xl border border-border bg-card p-4 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Se liquida desde</dt>
              <dd>{formatDay(s.start_period).slice(3)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">La casa absorbe gastos</dt>
              <dd>{s.house_absorbs_expenses ? "Sí" : "No"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Saldos negativos</dt>
              <dd>{s.negative_carry ? "Pasan al mes siguiente" : "Los condona la casa"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Reserva de impuestos</dt>
              <dd className="tabular-nums">{formatBp(s.income_tax_reserve_bp)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Tasa de cobro proyectada</dt>
              <dd className="tabular-nums">{formatBp(s.projection_collection_rate_bp)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Email en cada pago</dt>
              <dd>{s.notify_on_payment ? "Sí" : "No"}</dd>
            </div>
          </dl>
        )}
      </section>

      {memberModal !== null && (
        <MemberModal open onOpenChange={(o) => !o && setMemberModal(null)} member={memberModal === "new" ? null : memberModal} />
      )}
      {shareFor !== null && <ShareModal open onOpenChange={(o) => !o && setShareFor(null)} data={data} memberId={shareFor === "any" ? null : shareFor} />}
      {ruleOpen && <RuleModal open onOpenChange={setRuleOpen} data={data} />}
      {settingsOpen && <SettingsModal open onOpenChange={setSettingsOpen} data={data} />}
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(o) => !o && setEnding(null)}
        title="Terminar regla"
        description="Deja de aplicar desde hoy (si todavía no empezó, se anula). Lo ya liquidado no cambia."
        confirmLabel="Terminar"
        withReason
        reasonLabel="Motivo"
        loading={mut.endRule.isPending}
        onConfirm={(reason) =>
          ending &&
          mut.endRule.mutate(
            { id: ending, end: today, reason },
            {
              onSuccess: () => setEnding(null),
              onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
            },
          )
        }
      />
    </div>
  );
}
