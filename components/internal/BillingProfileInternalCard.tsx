"use client";

import { useEffect, useMemo, useState } from "react";
import { History, Pencil, RefreshCw, ReceiptText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import {
  BillingProfileForm,
  formProblem,
  formToInput,
  initialFormState,
  LetterBox,
  VerificationBadge,
  type BillingFormState,
} from "@/components/billing/BillingProfileForm";
import { billingProfileError, DOC_TIPO_LABEL, formatCuit } from "@/lib/billing/fiscalProfile";
import { conditionLabel, letterTitle } from "@/lib/billing/letter";
import { formatRelative } from "@/lib/utils/format";
import { fiscalProfileApi, type HistoryRow } from "@/modules/fiscalProfile/api";
import { useInternalBillingProfile, useSaveInternalBillingProfile } from "@/modules/fiscalProfile/hooks";
import { useMyStaffLevel } from "@/modules/internal/hooks";

const SOURCE_LABEL: Record<string, string> = {
  company: "Datos de la empresa",
  other: "Otro titular",
  consumidor_final: "Consumidor final (sin CUIT)",
};
const ROW_SOURCE: Record<string, string> = { owner: "El negocio", internal: "Staff", system: "Sistema" };

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "Sin datos";
  return new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Detalle del negocio › Plan y cobro (F20-3 · spec §14.4): datos fiscales con
// los que NinjaSoft le factura, verificación, historia y edición auditada
// (admin o super_admin, con motivo; la base lo valida).
export function BillingProfileInternalCard({ tenantId }: { tenantId: string }) {
  const q = useInternalBillingProfile(tenantId);
  const save = useSaveInternalBillingProfile(tenantId);
  const { level } = useMyStaffLevel();
  const canEdit = level === "admin" || level === "super_admin";
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [staffVerified, setStaffVerified] = useState(false);
  const data = q.data;
  const initial = useMemo(() => {
    const cur = data?.history.find((h) => !h.valid_to && !h.deleted_at) ?? null;
    return initialFormState(cur, data?.effective ?? null);
  }, [data]);
  const [form, setForm] = useState<BillingFormState>(initial);
  useEffect(() => setForm(initial), [initial]);

  if (q.isLoading) {
    return (
      <SettingsCard title="Datos fiscales" icon={ReceiptText} padded>
        <SkeletonLines lines={4} />
      </SettingsCard>
    );
  }
  if (q.error || !data) {
    return (
      <Callout tone="warning" title="Datos fiscales no disponibles">
        {billingProfileError(q.error)}
      </Callout>
    );
  }
  const eff = data.effective;
  const problem = formProblem(form);

  const submit = async () => {
    try {
      await save.mutateAsync({ p: { ...formToInput(form), staff_verified: staffVerified }, reason: reason.trim() });
      toast({ title: "Datos fiscales actualizados", variant: "success" });
      setOpen(false);
      setReason("");
      setStaffVerified(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: billingProfileError(e), variant: "error" });
    }
  };

  return (
    <SettingsCard
      title="Datos fiscales para la factura de NinjaSoft"
      description="A nombre de quién se le factura la suscripción a este negocio."
      icon={ReceiptText}
      actions={
        canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Pencil size={14} aria-hidden /> Editar
          </Button>
        ) : null
      }
      padded
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <LetterBox letter={eff.letter} status={eff.letter_status} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{letterTitle({ status: eff.letter_status, letter: eff.letter })}</p>
            <VerificationBadge verification={eff.verification} />
            <Badge tone="neutral">{SOURCE_LABEL[eff.source] ?? eff.source}</Badge>
            {eff.blocked_a_unverified && <Badge tone="danger">A bloqueada sin verificar</Badge>}
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Titular" value={eff.razon_social} />
            <Row
              label={DOC_TIPO_LABEL[eff.doc_tipo] ?? "Documento"}
              value={eff.doc_nro ? (eff.doc_tipo === 96 ? eff.doc_nro : formatCuit(eff.doc_nro)) : "Sin identificar"}
            />
            <Row label="Condición frente al IVA" value={conditionLabel(eff.iva_condition)} />
            <Row label="Domicilio" value={eff.domicilio} />
            <Row label="Email de facturación" value={`${eff.email ?? "Sin email"}${eff.email_is_default ? " (del dueño)" : ""}`} />
            <Row label="Verificado" value={eff.verified_at ? fmtDate(eff.verified_at) : "No"} />
          </dl>
        </div>
      </div>

      {!data.padron.available && (
        <p className="mt-4 text-[13px] text-muted-foreground">
          Padrón de ARCA no disponible ({data.padron.reason === "certificate_missing" ? "falta el certificado de la plataforma" : data.padron.reason === "disabled" ? "pausado" : "sin emisor"}).
          Los datos cargados a mano se pueden marcar como verificados por el staff con motivo.
        </p>
      )}

      <Disclosure className="mt-5" icon={<History size={15} />} title={`Historial de cambios (${data.history.length})`}>
        {data.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin cambios: usa los datos de la empresa.</p>
        ) : (
          <ol className="divide-y divide-border">
            {data.history.map((h) => (
              <HistoryItem key={h.id} h={h} />
            ))}
          </ol>
        )}
      </Disclosure>

      {data.lookups.length > 0 && (
        <Disclosure className="mt-3" icon={<RefreshCw size={15} />} title={`Consultas al padrón (${data.lookups.length})`}>
          <ul className="divide-y divide-border text-sm">
            {data.lookups.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="tabular-nums">{formatCuit(l.cuit)}</span>
                <span className="text-muted-foreground">{l.result?.razon_social ?? l.error ?? ""}</span>
                <Badge tone={l.status === "ok" ? "success" : l.status === "no_encontrado" ? "warning" : "danger"}>
                  {l.status === "ok" ? "Encontrada" : l.status === "no_encontrado" ? "No figura" : "Error"}
                </Badge>
                <span className="text-xs text-muted-foreground">{formatRelative(new Date(l.fetched_at))}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <Modal
        open={open}
        onOpenChange={(o) => !save.isPending && setOpen(o)}
        title="Editar datos fiscales"
        description="Queda en el historial y en la auditoría con tu usuario y el motivo."
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={save.isPending}>
              Cancelar
            </Button>
            <Button loading={save.isPending} disabled={Boolean(problem) || reason.trim().length < 3} onClick={submit}>
              Guardar cambios
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <BillingProfileForm
            value={form}
            onChange={setForm}
            company={data.company}
            ownerEmail={eff.email_is_default ? eff.email : null}
            padron={data.padron}
            issuerCondition={eff.issuer.iva_condition}
            lookup={(cuit) => fiscalProfileApi.lookup(cuit, { tenantId })}
            disabled={save.isPending}
          />
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-muted/50 p-3.5 text-sm">
            <Checkbox checked={staffVerified} onCheckedChange={setStaffVerified} className="mt-0.5" disabled={Boolean(form.padron)} />
            <span>
              <span className="block font-medium text-foreground">Marcar como verificados por el staff</span>
              <span className="block text-[13px] text-muted-foreground">
                Revisaste la constancia de inscripción a mano. Habilita la factura A sin consulta al padrón.
              </span>
            </span>
          </label>
          <Input
            label="Motivo del cambio"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: el cliente pidió facturar a su sociedad"
          />
          {problem && <p className="text-sm text-warning">{problem}</p>}
        </div>
      </Modal>
    </SettingsCard>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{value || "Sin cargar"}</dd>
    </div>
  );
}

function HistoryItem({ h }: { h: HistoryRow }) {
  return (
    <li className="py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">
          {h.use_company_data ? "Datos de la empresa" : `${h.razon_social ?? "Sin nombre"} · ${h.doc_nro ? formatCuit(h.doc_nro) : ""}`}
        </span>
        <VerificationBadge verification={h.verification} />
        {!h.valid_to && <Badge tone="info">Vigente</Badge>}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {fmtDate(h.valid_from)} · {ROW_SOURCE[h.source] ?? h.source}
        {h.created_by_email ? ` (${h.created_by_email})` : ""}
        {h.reason ? ` · ${h.reason}` : ""}
      </p>
    </li>
  );
}
