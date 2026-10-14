"use client";

// Configuración de presupuestos (ADR-122): punto de venta interno, validez y
// condiciones por defecto y el espacio para la firma de aceptación. Dueño o
// encargado (RLS de quote_settings). ADR-123: "sin vencimiento" por defecto,
// tus datos de contacto impresos en el presupuesto y la plantilla del email.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useMyTenant } from "@/modules/tenants/hooks";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { useQuoteMutations, useQuoteSettings } from "@/modules/quotes/hooks";
import { DEFAULT_QUOTE_SETTINGS, type QuoteSettings } from "@/modules/quotes/api";
import {
  QUOTE_EMAIL_DEFAULT_MESSAGE,
  QUOTE_EMAIL_DEFAULT_SUBJECT,
  QUOTE_EMAIL_VARS,
  isEmail,
  quoteNumberLabel,
} from "@/lib/quotes/logic";

const field =
  "h-11 w-full rounded-lg border border-border bg-background/40 px-3 text-sm tabular-nums text-foreground outline-none focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";

export function QuoteSettingsCard() {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canEdit = Boolean(me?.canManage);
  const { data } = useQuoteSettings();
  const m = useQuoteMutations();
  const [s, setS] = useState<QuoteSettings>(DEFAULT_QUOTE_SETTINGS);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  const dirty = JSON.stringify(s) !== JSON.stringify(data ?? DEFAULT_QUOTE_SETTINGS);

  const emailBad = Boolean(s.contact_email?.trim()) && !isEmail(s.contact_email ?? "");

  async function save() {
    if (emailBad) {
      toast({ title: "Revisá tu email de contacto", variant: "error" });
      return;
    }
    try {
      await m.saveSettings.mutateAsync(s);
      toast({ title: "Presupuestos actualizados", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  }

  return (
    <SettingsCard
      title="Presupuestos"
      description="Numeración, validez y condiciones con las que nace cada presupuesto."
      actions={
        canEdit ? (
          <Button size="sm" onClick={save} loading={m.saveSettings.isPending} disabled={!dirty}>
            Guardar
          </Button>
        ) : undefined
      }
    >
      <SettingRow
        label="Punto de venta interno"
        description={`Numeración propia de los presupuestos, independiente de la factura. El próximo sale como ${quoteNumberLabel(s.pto_vta, 1).slice(0, 4)}-...`}
        htmlFor="q-pto"
      >
        <input
          id="q-pto"
          type="number"
          min={1}
          max={99999}
          disabled={!canEdit}
          value={s.pto_vta}
          onChange={(e) => setS({ ...s, pto_vta: Math.max(1, Math.min(99999, Number(e.target.value) || 1)) })}
          className={`${field} max-w-[10rem]`}
        />
      </SettingRow>
      <SettingRow label="Validez por defecto" description="Días desde la emisión. Se puede cambiar en cada presupuesto." htmlFor="q-days">
        <div className="flex max-w-[12rem] items-center gap-2">
          <input
            id="q-days"
            type="number"
            min={1}
            max={365}
            disabled={!canEdit}
            value={s.validity_days}
            onChange={(e) => setS({ ...s, validity_days: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
            className={field}
          />
          <span className="text-sm text-muted-foreground">días</span>
        </div>
      </SettingRow>
      <SettingRow label="Condiciones por defecto" description="Forma de pago, plazos, qué incluye y qué no." htmlFor="q-terms" stacked>
        <textarea
          id="q-terms"
          disabled={!canEdit}
          value={s.default_terms ?? ""}
          maxLength={2000}
          onChange={(e) => setS({ ...s, default_terms: e.target.value })}
          placeholder="50 % de anticipo y saldo contra entrega. Precios en pesos. Plazo de entrega: 10 días hábiles desde la aceptación."
          className="min-h-[96px] w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
        />
      </SettingRow>
      <SettingRow label="Espacio para la firma" description="Agrega firma, aclaración y fecha de aceptación al pie de la hoja A4.">
        <Switch checked={s.show_signature} disabled={!canEdit} onCheckedChange={(v) => setS({ ...s, show_signature: v })} label="Espacio para la firma" />
      </SettingRow>
      <SettingRow
        label="Sin vencimiento por defecto"
        description="Cada presupuesto nace como precio de referencia sujeto a cambios: no fija validez y nunca pasa a vencido. Se puede cambiar en cada uno."
      >
        <Switch
          checked={s.no_expiry_default}
          disabled={!canEdit}
          onCheckedChange={(v) => setS({ ...s, no_expiry_default: v })}
          label="Sin vencimiento por defecto"
        />
      </SettingRow>
      <SettingRow
        label="Tus datos de contacto en el presupuesto"
        description="Salen impresos en el documento y las respuestas a los emails llegan a este email. Vacío, el teléfono es el de la marca del comprobante."
        stacked
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted-foreground">
            Email de tu negocio
            <input
              type="email"
              disabled={!canEdit}
              value={s.contact_email ?? ""}
              maxLength={160}
              onChange={(e) => setS({ ...s, contact_email: e.target.value })}
              placeholder="ventas@tunegocio.com"
              aria-invalid={emailBad || undefined}
              className={`${field} mt-1.5 ${emailBad ? "border-danger/60" : ""}`}
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Teléfono o WhatsApp de tu negocio
            <input
              inputMode="tel"
              disabled={!canEdit}
              value={s.contact_phone ?? ""}
              maxLength={40}
              onChange={(e) => setS({ ...s, contact_phone: e.target.value })}
              placeholder="341 555-1234"
              className={`${field} mt-1.5`}
            />
          </label>
        </div>
      </SettingRow>
      <SettingRow
        label="Email del presupuesto"
        description={`Asunto y mensaje con los que se prellena cada envío (se pueden cambiar al enviar). Variables: ${QUOTE_EMAIL_VARS.join(", ")}.`}
        stacked
      >
        <div className="space-y-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Asunto
            <input
              disabled={!canEdit}
              value={s.email_subject ?? ""}
              maxLength={200}
              onChange={(e) => setS({ ...s, email_subject: e.target.value })}
              placeholder={QUOTE_EMAIL_DEFAULT_SUBJECT}
              className={`${field} mt-1.5`}
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Mensaje
            <textarea
              disabled={!canEdit}
              value={s.email_message ?? ""}
              maxLength={4000}
              rows={8}
              onChange={(e) => setS({ ...s, email_message: e.target.value })}
              placeholder={QUOTE_EMAIL_DEFAULT_MESSAGE}
              className="mt-1.5 w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
            />
          </label>
          {canEdit && (s.email_subject || s.email_message) && (
            <button
              type="button"
              onClick={() => setS({ ...s, email_subject: null, email_message: null })}
              className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Volver a la plantilla de NinjaSoft
            </button>
          )}
        </div>
      </SettingRow>
    </SettingsCard>
  );
}
