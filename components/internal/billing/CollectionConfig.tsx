"use client";

// =============================================================================
// Cobranzas › Cuentas y avisos (F20-8 · ADR-120, spec docs/40 §9.3 y §22 #13).
//   · Cuentas para cobrar: CBU / CVU / alias de NinjaSoft con el mismo editor
//     que el medio de pago Transferencia (selector de bancos con logos).
//   · Comprobantes y avisos: a qué email y WhatsApp mandan el comprobante los
//     clientes, y cuándo sale el aviso de cobro por defecto, con vista previa
//     del email real.
// Sólo super_admin edita (el servidor lo valida); el resto mira.
// =============================================================================

import { useMemo, useState } from "react";
import { BellRing, Eye, Landmark, Mail, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { BankAccountEditor } from "@/components/billing/BankAccountEditor";
import { BankAccountDetails } from "@/components/billing/BankAccountDetails";
import { billingErrorMessage } from "@/lib/billing/ledger";
import { EMAIL_TEMPLATES, renderTemplate } from "@/lib/email/templates";
import {
  STATEMENT_FREQUENCY_LABELS,
  bankBlockHtml,
  formatArsCents,
  proofContactHtml,
  type StatementFrequency,
} from "@/lib/billing/paymentNotice";
import { digitsOnly, formatCuit, type TransferAccountInput } from "@/lib/payments/transfer";
import {
  useCollectionMutations,
  type CollectionSettings,
  type CollectionView,
  type PlatformBankAccount,
} from "@/modules/billing/collection";

// ── Cuentas para cobrar ─────────────────────────────────────────────────────

function toInput(a: PlatformBankAccount): TransferAccountInput {
  return {
    bank_slug: a.bank_slug,
    bank_name: a.bank_name,
    holder_name: a.holder_name,
    cuit: a.cuit ? formatCuit(a.cuit) : "",
    cbu: a.cbu ?? "",
    alias: a.alias ?? "",
    account_type: a.account_type,
    currency: "ARS",
    note: a.note ?? "",
  };
}

export function PlatformBankAccountsCard({ view, canEdit }: { view: CollectionView; canEdit: boolean }) {
  const { toast } = useToast();
  const m = useCollectionMutations();
  const [editing, setEditing] = useState<PlatformBankAccount | "new" | null>(null);
  const [pending, setPending] = useState<{ id: string | null; data: Record<string, unknown>; label: string } | null>(null);
  const [deleting, setDeleting] = useState<PlatformBankAccount | null>(null);
  const accounts = view.bank_accounts;
  const current = editing && editing !== "new" ? editing : null;

  return (
    <section>
      <SectionHeader
        title="Cuentas para cobrar"
        icon={Landmark}
        description="Donde los clientes en cuenta corriente transfieren. Salen en el aviso de cobro y en su panel, la de por defecto primero."
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden /> Agregar cuenta
            </Button>
          ) : undefined
        }
      />
      {accounts.length === 0 ? (
        <div className="mt-3 rounded-xl border border-border bg-card">
          <EmptyState
            compact
            icon={Landmark}
            title="Todavía no hay cuentas"
            description="Sin cuentas, el aviso de cobro sale sin datos para transferir."
            action={
              canEdit ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                  <Plus size={15} aria-hidden /> Agregar cuenta
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {accounts.map((a) => (
            <BankAccountDetails
              key={a.id}
              account={a}
              actions={
                canEdit ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(a)} aria-label={`Editar ${a.bank_name}`} className="h-9 w-9 px-0">
                      <Pencil size={15} aria-hidden />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(a)} aria-label={`Quitar ${a.bank_name}`} className="h-9 w-9 px-0">
                      <Trash2 size={15} aria-hidden />
                    </Button>
                  </>
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      <BankAccountEditor
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        initial={current ? toInput(current) : null}
        initialDefault={current ? current.is_default : accounts.length === 0}
        defaultLocked={current?.is_default}
        saving={false}
        showCurrency={false}
        title={current ? "Editar cuenta de cobro" : "Nueva cuenta de cobro"}
        pickDescription="Elegí el banco o la billetera donde NinjaSoft recibe las transferencias."
        formDescription="Los clientes en cuenta corriente ven estos datos en el aviso de cobro y en su panel."
        defaultLabel="Cuenta por defecto (sale primera)"
        noteLabel="Nota para el cliente (opcional)"
        notePlaceholder="Ej. Poné la referencia NS en el concepto"
        submitLabel="Continuar"
        onSave={(input, extra) => {
          setPending({
            id: current?.id ?? null,
            label: input.bank_name,
            data: {
              bank_slug: input.bank_slug,
              bank_name: input.bank_name,
              holder_name: input.holder_name,
              cuit: digitsOnly(input.cuit) || null,
              cbu: digitsOnly(input.cbu) || null,
              alias: input.alias.trim() || null,
              account_type: input.account_type,
              note: input.note.trim() || null,
              is_default: extra.isDefault,
              is_active: true,
            },
          });
          setEditing(null);
        }}
      />

      <ReasonDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.id ? "Guardar cambios de la cuenta" : "Agregar cuenta de cobro"}
        description={pending ? `${pending.label}. Los avisos que salgan desde ahora la incluyen.` : undefined}
        confirmLabel="Guardar"
        loading={m.saveBankAccount.isPending}
        onConfirm={async (reason) => {
          if (!pending) return;
          try {
            await m.saveBankAccount.mutateAsync({ id: pending.id, data: pending.data, reason });
            toast({ title: pending.id ? "Cuenta actualizada" : "Cuenta agregada", variant: "success" });
            setPending(null);
          } catch (e) {
            toast({ title: "No se pudo guardar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />

      <ReasonDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Quitar cuenta de cobro"
        description={deleting ? `${deleting.bank_name} deja de salir en los avisos y en el panel de los clientes. Las transferencias ya informadas a esta cuenta no cambian.` : undefined}
        confirmLabel="Quitar cuenta"
        danger
        loading={m.deleteBankAccount.isPending}
        onConfirm={async (reason) => {
          if (!deleting) return;
          try {
            await m.deleteBankAccount.mutateAsync({ id: deleting.id, reason });
            toast({ title: "Cuenta quitada", variant: "success" });
            setDeleting(null);
          } catch (e) {
            toast({ title: "No se pudo quitar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}
PlatformBankAccountsCard.displayName = "PlatformBankAccountsCard";

// ── Vista previa del aviso ──────────────────────────────────────────────────

export function noticePreviewHtml(settings: Pick<CollectionSettings, "payment_proof_email" | "payment_proof_whatsapp">, accounts: PlatformBankAccount[]) {
  const tpl = EMAIL_TEMPLATES.find((t) => t.key === "platform_payment_notice");
  if (!tpl) return { subject: "", html: "" };
  const vars = {
    negocio: "Almacén Don Pepe",
    logo_url: "",
    monto: formatArsCents(5400000),
    vence: "10/11/2026",
    periodo: "Suscripción Plan Pro del 01/11/2026 al 30/11/2026",
    referencia: "NS-ALMACEN-DON-PEPE",
    datos_bancarios: bankBlockHtml(accounts),
    comprobante: proofContactHtml(settings.payment_proof_email, settings.payment_proof_whatsapp),
    link: "https://pos.soft.ninja/dashboard-team#estado-de-cuenta",
  };
  return { subject: renderTemplate(tpl.defaultSubject, vars), html: renderTemplate(tpl.defaultHtml, vars) };
}

export function NoticePreviewModal({
  open,
  onOpenChange,
  view,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  view: CollectionView;
}) {
  const preview = useMemo(() => noticePreviewHtml(view.settings, view.bank_accounts), [view]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Así llega el aviso de cobro"
      description={`Asunto: ${preview.subject}`}
      className="max-w-2xl"
    >
      <iframe
        title="Vista previa del aviso de cobro"
        srcDoc={preview.html}
        sandbox=""
        className="h-[70dvh] w-full rounded-lg bg-muted"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Con datos de ejemplo. La plantilla se edita en Emails (clave platform_payment_notice).
      </p>
    </Modal>
  );
}

// ── Comprobantes y avisos ───────────────────────────────────────────────────

const FREQ_OPTIONS = (Object.keys(STATEMENT_FREQUENCY_LABELS) as StatementFrequency[]).map((v) => ({
  value: v,
  label: v === "per_period" ? "Una vez" : v === "every_n_days" ? "Repetir" : "Resumen mensual",
}));

export function CollectionSettingsCard({ view, canEdit }: { view: CollectionView; canEdit: boolean }) {
  const { toast } = useToast();
  const m = useCollectionMutations();
  const s = view.settings;
  const [email, setEmail] = useState(s.payment_proof_email ?? "");
  const [whatsapp, setWhatsapp] = useState(s.payment_proof_whatsapp ?? "");
  const [enabled, setEnabled] = useState(s.notices_enabled);
  const [lead, setLead] = useState(String(s.notice_lead_days_default));
  const [freq, setFreq] = useState<StatementFrequency>(s.statement_frequency_default);
  const [every, setEvery] = useState(String(s.statement_every_days_default));
  const [day, setDay] = useState(String(s.statement_day_default));
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState(false);

  const emailOk = email.trim() === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const waOk = whatsapp.trim() === "" || /^\+?[0-9 ()-]{8,20}$/.test(whatsapp.trim());
  const leadN = Number(lead);
  const everyN = Number(every);
  const dayN = Number(day);
  const numsOk =
    Number.isInteger(leadN) && leadN >= 0 && leadN <= 30 && Number.isInteger(everyN) && everyN >= 1 && everyN <= 60 && Number.isInteger(dayN) && dayN >= 1 && dayN <= 31;
  const dirty =
    email.trim() !== (s.payment_proof_email ?? "") ||
    whatsapp.trim() !== (s.payment_proof_whatsapp ?? "") ||
    enabled !== s.notices_enabled ||
    leadN !== s.notice_lead_days_default ||
    freq !== s.statement_frequency_default ||
    everyN !== s.statement_every_days_default ||
    dayN !== s.statement_day_default;

  const summary =
    freq === "monthly_day"
      ? `Un resumen el día ${dayN || "?"} de cada mes con todo lo que se debe.`
      : freq === "every_n_days"
        ? `El primero ${leadN} ${leadN === 1 ? "día" : "días"} antes del vencimiento y después cada ${everyN} ${everyN === 1 ? "día" : "días"} hasta que pague.`
        : `Uno por cuota, ${leadN} ${leadN === 1 ? "día" : "días"} antes del vencimiento.`;

  return (
    <section>
      <SectionHeader
        title="Comprobantes y avisos de cobro"
        icon={BellRing}
        description="A dónde mandan el comprobante los clientes y cuándo sale el aviso de cobro. Cada negocio puede tener lo suyo desde su cuenta corriente."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setPreview(true)}>
            <Eye size={15} aria-hidden /> Ver el email
          </Button>
        }
      />
      <div className="mt-3 min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Email que recibe los comprobantes"
            type="email"
            value={email}
            disabled={!canEdit}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="cobranzas@soft.ninja"
            error={emailOk ? undefined : "Email inválido"}
            hint="También le avisamos cuando un cliente informa una transferencia."
          />
          <Input
            label="WhatsApp para comprobantes (opcional)"
            inputMode="tel"
            value={whatsapp}
            disabled={!canEdit}
            onChange={(e) => setWhatsapp(e.target.value)}
            placeholder="+54 341 555 1234"
            error={waOk ? undefined : "Teléfono inválido"}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/50 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Mandar avisos de cobro automáticos</p>
            <p className="text-xs text-muted-foreground">
              A los negocios en cuenta corriente, todos los días a las 9. Apagado no sale ninguno (el staff puede mandarlo a mano).
            </p>
          </div>
          <Switch checked={enabled} disabled={!canEdit} onCheckedChange={setEnabled} label="Avisos automáticos" />
        </div>

        <div className="space-y-3">
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Cada cuánto</span>
            <div className="slim-scrollbar -mx-1 overflow-x-auto px-1">
              <Segmented<StatementFrequency> value={freq} onChange={(v) => canEdit && setFreq(v)} options={FREQ_OPTIONS} aria-label="Frecuencia del aviso" className="flex-nowrap" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {freq !== "monthly_day" && (
              <Input
                label="Días antes del vencimiento"
                inputMode="numeric"
                value={lead}
                disabled={!canEdit}
                onChange={(e) => setLead(e.target.value.replace(/[^\d]/g, ""))}
                error={leadN >= 0 && leadN <= 30 ? undefined : "De 0 a 30"}
              />
            )}
            {freq === "every_n_days" && (
              <Input
                label="Repetir cada (días)"
                inputMode="numeric"
                value={every}
                disabled={!canEdit}
                onChange={(e) => setEvery(e.target.value.replace(/[^\d]/g, ""))}
                error={everyN >= 1 && everyN <= 60 ? undefined : "De 1 a 60"}
              />
            )}
            {freq === "monthly_day" && (
              <Input
                label="Día del mes"
                inputMode="numeric"
                value={day}
                disabled={!canEdit}
                onChange={(e) => setDay(e.target.value.replace(/[^\d]/g, ""))}
                error={dayN >= 1 && dayN <= 31 ? undefined : "De 1 a 31"}
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>

        {canEdit ? (
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              variant="secondary"
              disabled={!dirty}
              onClick={() => {
                setEmail(s.payment_proof_email ?? "");
                setWhatsapp(s.payment_proof_whatsapp ?? "");
                setEnabled(s.notices_enabled);
                setLead(String(s.notice_lead_days_default));
                setFreq(s.statement_frequency_default);
                setEvery(String(s.statement_every_days_default));
                setDay(String(s.statement_day_default));
              }}
            >
              Descartar
            </Button>
            <Button disabled={!dirty || !emailOk || !waOk || !numsOk} onClick={() => setConfirm(true)}>
              Guardar
            </Button>
          </div>
        ) : (
          <Callout tone="neutral" icon={Mail}>
            Sólo un super admin cambia las cuentas y los avisos de cobro.
          </Callout>
        )}
      </div>

      <ReasonDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Guardar comprobantes y avisos"
        description={enabled ? `Avisos automáticos prendidos. ${summary}` : "Avisos automáticos apagados."}
        confirmLabel="Guardar"
        loading={m.setSettings.isPending}
        onConfirm={async (reason) => {
          try {
            await m.setSettings.mutateAsync({
              data: {
                payment_proof_email: email.trim() || null,
                payment_proof_whatsapp: whatsapp.trim() || null,
                notices_enabled: enabled,
                notice_lead_days_default: leadN,
                statement_frequency_default: freq,
                statement_every_days_default: everyN,
                statement_day_default: dayN,
              },
              reason,
            });
            toast({ title: "Configuración guardada", variant: "success" });
            setConfirm(false);
          } catch (e) {
            toast({ title: "No se pudo guardar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />
      <NoticePreviewModal open={preview} onOpenChange={setPreview} view={{ ...view, settings: { ...s, payment_proof_email: email.trim() || null, payment_proof_whatsapp: whatsapp.trim() || null } }} />
    </section>
  );
}
CollectionSettingsCard.displayName = "CollectionSettingsCard";

export function CollectionConfigSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
