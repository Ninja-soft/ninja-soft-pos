"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CalendarCheck,
  Download,
  FileText,
  HandCoins,
  ListTodo,
  Mail,
  NotebookPen,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { headerActionsRow } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { NoData } from "@/components/ui/NoData";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { downloadCustomerStatement, movementConcept as concept, statementRows } from "@/components/account/statementExport";
import { todayIso } from "@/lib/account/terms";
import { interestConcept } from "@/lib/account/interest";
import { parseOverride, type AccountConfig } from "@/lib/account/config";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  useAccountMutations,
  useAccountStatement,
  useCustomerGroups,
  useTeamMembers,
} from "@/modules/customers/hooks";
import {
  accountErrorMessage,
  type AccountStatement,
  type CollectionItem,
  type StatementMovement,
} from "@/modules/customers/account";
import { AccountLocked } from "@/components/account/AccountLocked";
import { CollectModal } from "@/components/account/CollectModal";
import { AccountActionModal, type AccountAction } from "@/components/account/AccountActionModal";
import { CollectionItemModal, type CollectionItemType } from "@/components/account/CollectionItemModal";
import { AccountConfigForm, isConfigValid } from "@/components/account/AccountConfigForm";
import { InheritBadge } from "@/components/account/GroupAccountTermsCard";
import {
  CreditStatusPill,
  KIND_LABEL,
  METHOD_LABEL,
  WhatsAppLogo,
  fmtDate,
  fmtDateTime,
  waLink,
  whatsappDebtMessage,
} from "@/components/account/shared";

type Tab = "statement" | "pending" | "collection" | "terms";
type KindFilter = "all" | "charges" | "payments" | "interest" | "adjust";

const KIND_FILTER: Record<KindFilter, string[]> = {
  all: [],
  charges: ["charge", "reversal"],
  payments: ["payment"],
  interest: ["interest", "interest_waiver"],
  adjust: ["adjust_debit", "adjust_credit"],
};


function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-lg bg-card p-3 ring-1 ring-border">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-price text-lg font-black tabular-nums",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </div>
    </div>
  );
}

const ITEM_STATUS: Record<CollectionItem["status"], string> = {
  open: "Pendiente",
  done: "Hecha",
  kept: "Cumplida",
  broken: "Incumplida",
  cancelled: "Cancelada",
  sent: "Enviado",
  failed: "Falló",
};

// Ficha de cuenta corriente del cliente: estado de cuenta con saldo corrido,
// pendientes, cobranza (promesas, notas, tareas, recordatorios) y condiciones
// propias. Todas las escrituras por RPC (auditadas).
export default function CustomerAccountPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const enabled = useFeature("cuenta_corriente");
  const cobranza = useFeature("cc_cobranza");
  const punitorios = useFeature("cc_punitorios");
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);

  const [tab, setTab] = useState<Tab>("statement");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const { data: st, isLoading, isError, refetch } = useAccountStatement(enabled === false ? null : id, {
    from: from || null,
    to: to || null,
  });
  const m = useAccountMutations();
  const [collectOpen, setCollectOpen] = useState(false);
  const [action, setAction] = useState<AccountAction | null>(null);
  const [itemType, setItemType] = useState<CollectionItemType | null>(null);

  const openById = useMemo(() => new Map((st?.open_items ?? []).map((i) => [i.id, i])), [st]);
  const movements = useMemo(() => {
    const kinds = KIND_FILTER[kindFilter];
    return (st?.movements ?? []).filter((x) => kinds.length === 0 || kinds.includes(x.kind));
  }, [st, kindFilter]);

  async function sendStatement() {
    if (!st) return;
    try {
      await m.sendStatement.mutateAsync({ customerId: st.customer.id });
      toast({ title: `Estado de cuenta enviado a ${st.customer.email}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo enviar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  const exportRows = (s: AccountStatement) => statementRows(s).map((r) => ({ ...r }));

  async function exportPdf() {
    if (!st) return;
    await downloadCustomerStatement(st);
  }

  async function exportXls() {
    if (!st) return;
    await exportXlsx(`estado-de-cuenta-${st.customer.name.replace(/\W+/g, "-").toLowerCase()}`, [
      {
        name: "Estado de cuenta",
        title: `${st.customer.name} · ${fmtDate(st.from)} al ${fmtDate(st.to)} • NinjaPos`,
        columns: [
          { header: "Fecha", key: "date" },
          { header: "Concepto", key: "concept" },
          { header: "Vence", key: "due" },
          { header: "Débito", key: "debit", type: "money" },
          { header: "Crédito", key: "credit", type: "money" },
          { header: "Saldo", key: "running", type: "money" },
        ],
        rows: [
          { date: "", concept: "Saldo inicial", due: "", debit: null, credit: null, running: Number(st.opening_balance) },
          ...exportRows(st),
        ],
      },
    ]);
  }

  if (enabled === false) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <AccountLocked />
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link
          href="/clientes/cuentas"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Cuentas corrientes
        </Link>

        {isLoading && !st ? (
          <SpinnerBlock className="py-20" />
        ) : isError || !st ? (
          <div className="mt-8 rounded-xl bg-red-400/10 p-6 text-center text-sm text-danger">
            No se pudo cargar la cuenta.{" "}
            <button onClick={() => refetch()} className="underline">
              Reintentar
            </button>
          </div>
        ) : (
          <>
            <div className="mt-2 flex flex-col gap-4">
              <div className="min-w-0">
                <Eyebrow>Cuenta corriente</Eyebrow>
                <Display className="mt-3 break-words text-3xl md:text-4xl">{st.customer.name}</Display>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <CreditStatusPill status={st.customer.credit_status} />
                  {st.max_days_overdue > 0 && (
                    <span className="font-medium text-danger">{st.max_days_overdue} días de mora</span>
                  )}
                  {st.customer.account_config && <span>Condiciones propias</span>}
                </div>
              </div>
              <div className={headerActionsRow}>
                <Button onClick={() => setCollectOpen(true)}>
                  <HandCoins size={16} /> Cobrar
                </Button>
                {canManage && (
                  <Button variant="secondary" onClick={() => setAction({ type: "adjust", customerId: st.customer.id })}>
                    <SlidersHorizontal size={16} /> Ajuste
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Saldo" value={formatCurrency(st.balance)} tone={st.balance < 0 ? "success" : undefined} />
              <Stat
                label="Disponible"
                value={st.available != null ? formatCurrency(st.available) : "Sin límite"}
              />
              <Stat label="Vencido" value={formatCurrency(st.overdue)} tone={st.overdue > 0 ? "danger" : undefined} />
              <Stat label="Punitorios pendientes" value={formatCurrency(st.interest_open)} />
            </div>

            <div className="mt-6 overflow-x-auto [scrollbar-width:none]">
              <Segmented scrollOnMobile
                value={tab}
                onChange={setTab}
                options={[
                  { value: "statement", label: "Estado de cuenta" },
                  { value: "pending", label: `Pendientes (${st.open_items.length})` },
                  { value: "collection", label: "Cobranza" },
                  { value: "terms", label: "Condiciones" },
                ]}
              />
            </div>

            {tab === "statement" && (
              <section className="mt-4 space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-muted-foreground">
                    Desde
                    <input
                      type="date"
                      value={from}
                      max={to || todayIso()}
                      onChange={(e) => setFrom(e.target.value)}
                      className="mt-1 block h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                    />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    Hasta
                    <input
                      type="date"
                      value={to}
                      min={from || undefined}
                      onChange={(e) => setTo(e.target.value)}
                      className="mt-1 block h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                    />
                  </label>
                  <Segmented scrollOnMobile
                    value={kindFilter}
                    onChange={setKindFilter}
                    options={[
                      { value: "all", label: "Todo" },
                      { value: "charges", label: "Compras" },
                      { value: "payments", label: "Cobros" },
                      { value: "interest", label: "Punitorios" },
                      { value: "adjust", label: "Ajustes" },
                    ]}
                  />
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="secondary" onClick={exportPdf}>
                      <FileText size={15} /> PDF
                    </Button>
                    <Button size="sm" variant="secondary" onClick={exportXls}>
                      <Download size={15} /> XLSX
                    </Button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border">
                  <div className="flex justify-between bg-muted/50 px-4 py-2 text-sm">
                    <span className="text-muted-foreground">Saldo inicial al {fmtDate(st.from)}</span>
                    <span className="font-semibold tabular-nums">{formatCurrency(st.opening_balance)}</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {movements.length === 0 && (
                      <li className="px-4 py-8 text-center text-sm text-muted-foreground">Sin movimientos en el período.</li>
                    )}
                    {movements.map((x) => {
                      const open = openById.get(x.id);
                      return (
                        <li key={x.id} className={cn("px-4 py-3 text-sm", x.voided_at && "opacity-50")}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium">
                                {concept(x)}
                                {x.voided_at && <span className="ml-2 text-xs text-danger">anulado</span>}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {fmtDateTime(x.created_at)}
                                {x.due_date && x.delta > 0 ? ` · vence ${fmtDate(x.due_date)}` : ""}
                                {open ? ` · pendiente ${formatCurrency(open.open)}` : ""}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className={cn("tabular-nums", x.delta < 0 ? "text-success" : "text-foreground")}>
                                {x.delta < 0 ? "−" : "+"}
                                {formatCurrency(Math.abs(x.delta))}
                              </div>
                              <div className="text-xs tabular-nums text-muted-foreground">
                                Saldo {formatCurrency(x.running)}
                              </div>
                            </div>
                          </div>
                          {canManage && !x.voided_at && (
                            <div className="mt-1 flex gap-3">
                              {x.kind === "payment" && (
                                <button
                                  className="text-xs font-medium text-muted-foreground hover:text-danger"
                                  onClick={() =>
                                    setAction({
                                      type: "void",
                                      movementId: x.id,
                                      amount: Math.abs(x.delta),
                                      receiptNo: x.receipt_no,
                                    })
                                  }
                                >
                                  Anular cobro
                                </button>
                              )}
                              {x.kind === "interest" && open && punitorios && (
                                <button
                                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                                  onClick={() => setAction({ type: "waive", movementId: x.id, open: Number(open.open) })}
                                >
                                  Condonar
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            )}

            {tab === "pending" && (
              <section className="mt-4">
                <ul className="space-y-2">
                  {st.open_items.length === 0 && (
                    <li className="rounded-xl bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                      No hay saldos pendientes.
                    </li>
                  )}
                  {st.open_items.map((it) => (
                    <li
                      key={it.id}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm",
                        it.days_overdue > 0 ? "bg-red-400/10" : "bg-card ring-1 ring-border",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="font-medium">
                          {it.kind === "interest"
                            ? interestConcept(it.period, it.accrued_through)
                            : it.reason ?? KIND_LABEL[it.kind]}
                        </div>
                        <div className={cn("text-xs", it.days_overdue > 0 ? "text-danger" : "text-muted-foreground")}>
                          {it.due_date ? `Vence ${fmtDate(it.due_date)}` : <NoData />}
                          {it.days_overdue > 0 ? ` · ${it.days_overdue} días vencido` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold tabular-nums">{formatCurrency(it.open)}</div>
                        {Number(it.open) !== Number(it.amount) && (
                          <div className="text-xs text-muted-foreground">de {formatCurrency(it.amount)}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {st.open_items.length > 0 && (
                  <div className="mt-3 flex justify-end">
                    <Button onClick={() => setCollectOpen(true)}>
                      <HandCoins size={16} /> Cobrar
                    </Button>
                  </div>
                )}
              </section>
            )}

            {tab === "collection" && (
              <section className="mt-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  {st.customer.email && (
                    <Button variant="secondary" size="sm" loading={m.sendStatement.isPending} onClick={sendStatement}>
                      <Mail size={15} /> Enviar estado de cuenta
                    </Button>
                  )}
                  {st.customer.phone && (
                    <a
                      href={waLink(
                        st.customer.phone,
                        whatsappDebtMessage({
                          name: st.customer.name,
                          balance: formatCurrency(st.balance),
                          overdue: st.overdue > 0 ? formatCurrency(st.overdue) : null,
                          oldestDue: st.open_items.find((i) => i.days_overdue > 0)?.due_date
                            ? fmtDate(st.open_items.find((i) => i.days_overdue > 0)!.due_date)
                            : null,
                        }),
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() =>
                        cobranza &&
                        m.addItem.mutate({
                          customerId: st.customer.id,
                          type: "reminder_log",
                          channel: "whatsapp",
                          body: "Recordatorio por WhatsApp",
                        })
                      }
                      className={buttonVariants({ variant: "secondary", size: "sm" })}
                    >
                      <WhatsAppLogo size={15} /> WhatsApp
                    </a>
                  )}
                  {cobranza && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => setItemType("promise")}>
                        <CalendarCheck size={15} /> Promesa
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setItemType("note")}>
                        <NotebookPen size={15} /> Nota
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setItemType("task")}>
                        <ListTodo size={15} /> Tarea
                      </Button>
                    </>
                  )}
                </div>
                {cobranza === false && (
                  <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    Promesas de pago, notas, tareas y recordatorios automáticos vienen con la gestión de cobranza de
                    tu plan.
                  </p>
                )}
                <ul className="space-y-2">
                  {st.items.length === 0 && (
                    <li className="rounded-xl bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                      Sin gestiones de cobranza todavía.
                    </li>
                  )}
                  {st.items.map((it) => (
                    <CollectionRow key={it.id} item={it} />
                  ))}
                </ul>
              </section>
            )}

            {tab === "terms" && <TermsTab st={st} canManage={canManage} cobranza={Boolean(cobranza)} />}
          </>
        )}
      </div>

      <CollectModal
        open={collectOpen}
        onOpenChange={setCollectOpen}
        customerId={st?.customer.id ?? null}
        customerName={st?.customer.name ?? ""}
      />
      <AccountActionModal action={action} onOpenChange={(o) => !o && setAction(null)} />
      <CollectionItemModal
        type={itemType}
        customerId={st?.customer.id ?? null}
        customerName={st?.customer.name ?? ""}
        suggestedAmount={st ? Number(st.overdue) || Number(st.balance) : undefined}
        onOpenChange={(o) => !o && setItemType(null)}
      />
    </>
  );
}

function CollectionRow({ item }: { item: CollectionItem }) {
  const { toast } = useToast();
  const { updateItem } = useAccountMutations();
  const today = todayIso();
  const broken = item.type === "promise" && item.status === "open" && (item.promise_date ?? "") < today;

  async function set(status: CollectionItem["status"], remove = false) {
    try {
      await updateItem.mutateAsync({ id: item.id, status, remove });
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  const icon =
    item.type === "promise" ? (
      <CalendarCheck size={15} />
    ) : item.type === "task" ? (
      <ListTodo size={15} />
    ) : item.type === "note" ? (
      <NotebookPen size={15} />
    ) : item.channel === "whatsapp" ? (
      <WhatsAppLogo size={15} />
    ) : (
      <Mail size={15} />
    );

  return (
    <li className={cn("rounded-lg px-4 py-3 text-sm", broken ? "bg-red-400/10" : "bg-card ring-1 ring-border")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-ninja-flameSoft">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {item.type === "promise"
              ? `Promete ${formatCurrency(item.promise_amount)} el ${fmtDate(item.promise_date)}`
              : item.type === "reminder_log"
                ? item.body ?? "Recordatorio"
                : item.body}
          </div>
          <div className="text-xs text-muted-foreground">
            {fmtDateTime(item.created_at)}
            {item.type === "promise" && item.body ? ` · ${item.body}` : ""}
            {item.type === "task" && item.due_at ? ` · para el ${fmtDate(item.due_at.slice(0, 10))}` : ""}
            {item.type !== "note" ? ` · ${broken ? "Incumplida" : ITEM_STATUS[item.status]}` : ""}
          </div>
        </div>
        {item.type !== "reminder_log" && (
          <button
            onClick={() => set(item.status, true)}
            title="Eliminar"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {item.status === "open" && (item.type === "promise" || item.type === "task") && (
        <div className="mt-2 flex flex-wrap gap-2 pl-7">
          {item.type === "promise" ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => set("kept")}>
                Cumplida
              </Button>
              <Button size="sm" variant="ghost" onClick={() => set("broken")}>
                Incumplida
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => set("done")}>
              Hecha
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function TermsTab({ st, canManage, cobranza }: { st: AccountStatement; canManage: boolean; cobranza: boolean }) {
  const { toast } = useToast();
  const { setTerms } = useAccountMutations();
  const { data: groups } = useCustomerGroups();
  const { data: team } = useTeamMembers(cobranza);
  const group = (groups ?? []).find((g) => g.id === st.customer.group_id);
  const groupOwn = Boolean(group && parseOverride(group.account_config));
  const [own, setOwn] = useState(Boolean(st.customer.account_config));
  const [cfg, setCfg] = useState<AccountConfig>(st.config);
  const [limit, setLimit] = useState(String(st.customer.credit_limit ?? 0));
  const [status, setStatus] = useState(st.customer.credit_status);
  const [collector, setCollector] = useState(st.customer.collector_user_id ?? "");

  useEffect(() => {
    setOwn(Boolean(st.customer.account_config));
    setCfg(st.config);
    setLimit(String(st.customer.credit_limit ?? 0));
    setStatus(st.customer.credit_status);
    setCollector(st.customer.collector_user_id ?? "");
  }, [st]);

  async function save() {
    try {
      await setTerms.mutateAsync({
        customerId: st.customer.id,
        config: own ? cfg : null,
        creditLimit: Math.max(0, Number(limit) || 0),
        creditStatus: status,
        collector: collector || null,
      });
      toast({ title: "Condiciones guardadas", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  return (
    <section className="mt-4 space-y-4">
      {!canManage && (
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Sólo el dueño o un encargado pueden cambiar las condiciones del cliente.
        </p>
      )}
      <fieldset disabled={!canManage} className="space-y-3 rounded-lg bg-card p-4 ring-1 ring-border">
        <label className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <span className="block text-sm font-medium">Límite de crédito</span>
            <span className="block text-xs text-muted-foreground">0 = sin límite.</span>
          </span>
          <input
            type="number"
            min="0"
            step="100"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="h-10 w-36 rounded-lg border border-input bg-background px-3 text-right text-sm outline-none focus:border-ninja-flameSoft"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <span className="block text-sm font-medium">Estado de la cuenta</span>
            <span className="block text-xs text-muted-foreground">Bloqueada no permite vender a cuenta.</span>
          </span>
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: "ok", label: "Al día" },
              { value: "watch", label: "En observación" },
              { value: "blocked", label: "Bloqueada" },
            ]}
          />
        </div>
        {cobranza && (
          <label className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Cobrador asignado</span>
            <select
              value={collector}
              onChange={(e) => setCollector(e.target.value)}
              className="h-10 w-56 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft"
            >
              <option value="">Sin asignar</option>
              {(team ?? []).map((t) => (
                <option key={t.user_id} value={t.user_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center justify-between gap-2 pt-1">
          <span>
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
              Condiciones propias
              <InheritBadge
                own={own}
                label={own ? undefined : groupOwn ? `Hereda del grupo ${group!.name}` : "Hereda del negocio"}
              />
            </span>
            <span className="block text-xs text-muted-foreground">
              {groupOwn
                ? "Apagado, el cliente usa las condiciones de su grupo."
                : "Apagado, el cliente usa las condiciones del negocio."}
            </span>
          </span>
          <Switch
            checked={own}
            onCheckedChange={(v) => {
              setOwn(v);
              if (v && !st.customer.account_config) setCfg(st.config);
            }}
            label="Condiciones propias"
          />
        </label>
      </fieldset>

      {own && <AccountConfigForm value={cfg} onChange={setCfg} disabled={!canManage} />}

      {canManage && (
        <div className="flex justify-end">
          <Button loading={setTerms.isPending} disabled={own && !isConfigValid(cfg)} onClick={save}>
            Guardar condiciones
          </Button>
        </div>
      )}
    </section>
  );
}
