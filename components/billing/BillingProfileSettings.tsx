"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, Mail, ReceiptText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Modal";
import { Skeleton, SkeletonLines } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { billingProfileError, formatCuit } from "@/lib/billing/fiscalProfile";
import { conditionLabel, letterExplanation, letterTitle } from "@/lib/billing/letter";
import { fiscalProfileApi, type MyBillingProfile } from "@/modules/fiscalProfile/api";
import { useMyBillingProfile, useSaveMyBillingProfile } from "@/modules/fiscalProfile/hooks";
import {
  BillingProfileForm,
  formPreview,
  formProblem,
  formToInput,
  initialFormState,
  LetterBox,
  VerificationBadge,
  type BillingFormState,
} from "./BillingProfileForm";

// Configuración › Datos de facturación (F20-3 · spec §8.1, §14.5): a nombre
// de quién le factura NinjaSoft la suscripción al negocio y a dónde le llega.
// Dueño o encargado (lo valida la base: my_billing_profile / owner_set_billing_profile).
export function BillingProfileSettings() {
  const q = useMyBillingProfile();
  if (q.isLoading) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Cargando datos de facturación">
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="space-y-4 rounded-xl border border-border bg-card p-5">
          <Skeleton className="h-5 w-56" />
          <SkeletonLines lines={5} />
        </div>
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <Callout tone="neutral" icon={Lock} title="Sólo el dueño o el encargado">
        {billingProfileError(q.error)}
      </Callout>
    );
  }
  return <BillingProfileEditor data={q.data} />;
}

export function BillingProfileEditor({ data }: { data: MyBillingProfile }) {
  const { toast } = useToast();
  const save = useSaveMyBillingProfile();
  const eff = data.effective;
  const current = data.current;
  const initial = useMemo(() => initialFormState(current, eff), [current, eff]);
  const [form, setForm] = useState<BillingFormState>(initial);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setForm(initial), [initial]);

  const dirty = JSON.stringify(formToInput(form)) !== JSON.stringify(formToInput(initial));
  const problem = formProblem(form);
  const preview = formPreview(form, data.company, eff.issuer.iva_condition);

  const submit = async () => {
    try {
      await save.mutateAsync(formToInput(form));
      setConfirm(false);
      toast({ title: "Datos de facturación guardados", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: billingProfileError(e), variant: "error" });
    }
  };

  return (
    <div className="space-y-5">
      {/* Cómo te facturamos hoy */}
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center">
        <LetterBox letter={eff.letter} status={eff.letter_status} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Hoy recibís</p>
          <p className="mt-0.5 break-words text-lg font-semibold leading-tight text-foreground">
            {letterTitle({ status: eff.letter_status, letter: eff.letter })}
            {eff.razon_social ? ` a nombre de ${eff.razon_social}` : ""}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              eff.doc_nro ? `${eff.doc_tipo === 96 ? "DNI" : eff.doc_tipo === 86 ? "CUIL" : "CUIT"} ${eff.doc_tipo === 96 ? eff.doc_nro : formatCuit(eff.doc_nro)}` : "Consumidor final",
              conditionLabel(eff.iva_condition),
            ].join(" · ")}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Mail size={14} aria-hidden className="shrink-0" />
            <span className="truncate">{eff.email ?? "Sin email"}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-end">
          <VerificationBadge verification={eff.verification} />
        </div>
      </div>

      {eff.letter_status === "pending_issuer" && (
        <Callout tone="info" icon={ReceiptText} title="La factura todavía no se emite">
          {letterExplanation({ status: eff.letter_status, letter: eff.letter })} Dejá tus datos listos: los usamos apenas empiece la facturación.
        </Callout>
      )}
      {eff.blocked_a_unverified && (
        <Callout tone="warning" title="Factura A pendiente de verificación">
          Para emitir una factura A los datos tienen que estar verificados en ARCA. Si los cargaste a mano, los revisamos antes de facturar.
        </Callout>
      )}

      {eff.verified && (
        <Callout tone="success" icon={ShieldCheck} title="Tus datos fiscales están verificados">
          Si cambiás el titular, el CUIT o sus datos fiscales, vuelven a quedar sin verificar. Cambiar sólo el email no afecta la verificación.
        </Callout>
      )}

      <SettingsCard
        title="¿A nombre de quién querés tu factura?"
        description="Si no elegís nada, usamos los datos de tu negocio. La letra la define ARCA según tu condición frente al IVA."
        padded
      >
        <BillingProfileForm
          value={form}
          onChange={setForm}
          company={data.company}
          ownerEmail={data.owner_email}
          padron={data.padron}
          issuerCondition={eff.issuer.iva_condition}
          lookup={(cuit) => fiscalProfileApi.lookup(cuit)}
          disabled={save.isPending}
        />
        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
          {dirty && (
            <Button variant="ghost" onClick={() => setForm(initial)} disabled={save.isPending}>
              Descartar cambios
            </Button>
          )}
          <Button disabled={!dirty || Boolean(problem)} onClick={() => setConfirm(true)}>
            Revisar y guardar
          </Button>
        </div>
        {dirty && problem && <p className="mt-2 text-right text-sm text-warning">{problem}</p>}
      </SettingsCard>

      <Modal
        open={confirm}
        onOpenChange={(o) => !save.isPending && setConfirm(o)}
        title="Confirmá tus datos de facturación"
        description="Así van a salir las próximas facturas de NinjaSoft."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={save.isPending}>
              Volver
            </Button>
            <Button loading={save.isPending} onClick={submit}>
              Confirmar
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-4">
          <LetterBox letter={preview.letter} status={preview.status} />
          <div className="min-w-0 space-y-1 text-sm">
            <p className="text-base font-semibold text-foreground">{letterTitle({ status: preview.status, letter: preview.letter })}</p>
            <p className="text-foreground">{preview.name ?? "Consumidor final"}</p>
            {preview.doc && <p className="text-muted-foreground">{preview.doc}</p>}
            <p className="text-muted-foreground">{conditionLabel(preview.cond)}</p>
            <p className="text-muted-foreground">Se envía a {form.email.trim() || data.owner_email || "el email del dueño"}</p>
          </div>
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
          {form.padron
            ? "Los datos fiscales vienen de ARCA y quedan verificados."
            : form.mode === "other"
              ? "Los datos quedan como \"sin verificar\" hasta que se confirmen con ARCA. No se emite factura A con datos sin verificar."
              : "Usamos los datos fiscales de tu negocio. Si los cambiás en Impuestos o Marca, la próxima factura sale con los nuevos."}
        </p>
      </Modal>
    </div>
  );
}
