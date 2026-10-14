"use client";

import { useEffect, useState } from "react";
import { ReceiptText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard, SettingsNotice } from "@/components/settings/Settings";
import { billingProfileError, checkCuit } from "@/lib/billing/fiscalProfile";
import { conditionLabel, ISSUER_CONDITIONS, platformLetter } from "@/lib/billing/letter";
import { useMyStaffLevel } from "@/modules/internal/hooks";
import { usePlatformIssuer, useSavePlatformIssuer } from "@/modules/fiscalProfile/hooks";

type Env = "homologacion" | "produccion";
const NONE = "__none__";

// Emisor de las facturas de NinjaSoft (F20-3 · ADR-117): condición frente al
// IVA (define la letra), CUIT, ambiente del padrón e interruptor de la
// verificación automática. Mientras la condición esté "Sin definir" la letra
// de todos los negocios queda pendiente (§22 #1). Sólo super_admin edita.
export function PlatformIssuerCard() {
  const q = usePlatformIssuer();
  const save = useSavePlatformIssuer();
  const { level } = useMyStaffLevel();
  const canEdit = level === "super_admin";
  const { toast } = useToast();
  const [env, setEnv] = useState<Env>("homologacion");
  const row = q.data?.profiles.find((p) => p.environment === env);
  const [cond, setCond] = useState<string>(NONE);
  const [cuit, setCuit] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [padronOn, setPadronOn] = useState(true);
  const [active, setActive] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    const active = q.data?.profiles.find((p) => p.is_active);
    if (active) setEnv(active.environment);
  }, [q.data]);
  useEffect(() => {
    setCond(row?.iva_condition ?? NONE);
    setCuit(row?.cuit ?? "");
    setName(row?.razon_social ?? "");
    setAddress(row?.domicilio_comercial ?? "");
    setPadronOn(row?.padron_enabled ?? true);
    setActive(row?.is_active ?? false);
    setReason("");
  }, [row]);

  if (q.isLoading) {
    return (
      <SettingsCard title="Emisor de las facturas de NinjaSoft" icon={ReceiptText} padded>
        <SkeletonLines lines={4} />
      </SettingsCard>
    );
  }
  if (q.error || !q.data) {
    return <Callout tone="warning" title="No disponible">{billingProfileError(q.error)}</Callout>;
  }

  const cuitState = checkCuit(cuit);
  const letters = (["responsable_inscripto", "monotributo", "consumidor_final"] as const).map(
    (r) => `${conditionLabel(r)}: ${platformLetter(cond === NONE ? null : cond, r).letter ?? "pendiente"}`,
  );

  const submit = async () => {
    try {
      await save.mutateAsync({
        env,
        p: {
          iva_condition: cond === NONE ? null : cond,
          cuit: cuit.replace(/\D/g, "") || null,
          razon_social: name.trim() || null,
          domicilio_comercial: address.trim() || null,
          padron_enabled: padronOn,
          is_active: active,
        },
        reason: reason.trim(),
      });
      toast({ title: "Emisor actualizado", variant: "success" });
      setReason("");
    } catch (e) {
      toast({ title: "No se pudo guardar", description: billingProfileError(e), variant: "error" });
    }
  };

  return (
    <SettingsCard
      title="Emisor de las facturas de NinjaSoft"
      description="Con qué condición frente al IVA factura NinjaSoft la suscripción. Define la letra que ve cada negocio en sus datos de facturación."
      icon={ReceiptText}
      actions={
        <Segmented
          aria-label="Ambiente"
          size="sm"
          value={env}
          onChange={setEnv}
          options={[
            { value: "homologacion", label: "Homologación" },
            { value: "produccion", label: "Producción" },
          ]}
        />
      }
    >
      <SettingsNotice>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {row?.is_active ? <Badge tone="info">Ambiente activo</Badge> : <Badge tone="neutral">Inactivo</Badge>}
          {row?.certificate_ready ? (
            <Badge tone="success">Certificado vigente</Badge>
          ) : (
            <Badge tone="warning">Sin certificado (se carga en ARCA plataforma)</Badge>
          )}
          {q.data.padron.available ? (
            <Badge tone="success">Padrón disponible</Badge>
          ) : (
            <Badge tone="warning">Padrón no disponible: carga manual</Badge>
          )}
        </div>
      </SettingsNotice>
      <SettingRow label="Condición frente al IVA" description="Mientras esté sin definir, la letra de todos los negocios queda pendiente.">
        <Select
          value={cond}
          disabled={!canEdit}
          onChange={setCond}
          options={[{ value: NONE, label: "Sin definir (todavía sin CUIT)" }, ...ISSUER_CONDITIONS.map((c) => ({ value: c, label: conditionLabel(c) }))]}
        />
        <p className="mt-2 text-[13px] text-muted-foreground">{letters.join(" · ")}</p>
      </SettingRow>
      <SettingRow label="CUIT y razón social" description="Tienen que coincidir con el certificado de la plataforma.">
        <div className="grid gap-3">
          <Input
            aria-label="CUIT del emisor"
            inputMode="numeric"
            placeholder="30-12345678-9"
            value={cuit}
            disabled={!canEdit}
            onChange={(e) => setCuit(e.target.value)}
            error={cuitState === "invalid" ? "El dígito verificador no coincide." : undefined}
          />
          <Input aria-label="Razón social" placeholder="Razón social" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="Domicilio comercial" placeholder="Domicilio comercial" value={address} disabled={!canEdit} onChange={(e) => setAddress(e.target.value)} />
        </div>
      </SettingRow>
      <SettingRow label="Usar este ambiente" description="El ambiente activo es el que consulta el padrón y, más adelante, emite.">
        <Switch checked={active} onCheckedChange={setActive} disabled={!canEdit} label="Ambiente activo" />
      </SettingRow>
      <SettingRow label="Verificación con el padrón" description="Consulta ws_sr_constancia_inscripcion con el certificado de la plataforma.">
        <Switch checked={padronOn} onCheckedChange={setPadronOn} disabled={!canEdit} label="Verificación con el padrón" />
      </SettingRow>
      {canEdit ? (
        <SettingRow label="Motivo" description="Queda en la auditoría.">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input aria-label="Motivo" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: alta de la CUIT de NinjaSoft" />
            <Button loading={save.isPending} disabled={reason.trim().length < 3 || cuitState === "invalid" || cuitState === "incomplete"} onClick={submit}>
              Guardar
            </Button>
          </div>
        </SettingRow>
      ) : (
        <SettingsNotice>
          <p className="text-[13px] text-muted-foreground">Sólo un super admin puede cambiar el emisor.</p>
        </SettingsNotice>
      )}
    </SettingsCard>
  );
}
