"use client";

import { useState } from "react";
import { FileUp, KeyRound, SearchCheck, Settings2, ShieldCheck, ShieldOff } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton, SkeletonLines } from "@/components/ui/Skeleton";
import { arcaErrorMessage } from "@/lib/arca/labels";
import { certServiceState } from "@/lib/arca/certUpload";
import { useArcaPlatform } from "@/modules/arca/hooks";
import { useMyStaffLevel } from "@/modules/internal/hooks";
import { useInternalPadron } from "@/modules/padron/hooks";
import { usePlatformIssuer } from "@/modules/fiscalProfile/hooks";
import { CertificateDetails, CertStateBadge } from "./CertificateDetails";
import { CertUploadTab } from "./CertUploadTab";
import { PadronTestTab } from "./PadronTestTab";
import { PadronConfigTab } from "./PadronConfigTab";
import { CsrGenerateTab } from "./CsrGenerateTab";
import { ARCA_CERT_ENV } from "./env";

export type ArcaCertTab = "cargar" | "probar" | "config" | "generar";

const TABS: { value: ArcaCertTab; label: string; icon: React.ReactNode }[] = [
  { value: "cargar", label: "Cargar certificado", icon: <FileUp size={15} aria-hidden /> },
  { value: "probar", label: "Probar con un CUIT", icon: <SearchCheck size={15} aria-hidden /> },
  { value: "config", label: "Configuración", icon: <Settings2 size={15} aria-hidden /> },
  { value: "generar", label: "Generar certificado", icon: <KeyRound size={15} aria-hidden /> },
];

// Certificado de ARCA de NinjaSoft (producción) y padrón para los negocios
// (ADR-072, ADR-133). Arriba, el estado del certificado; abajo, pestañas:
// cargar el par, probar una CUIT, configurar el padrón y generar el pedido.
// La usan el modal de Complementos y Plataforma › ARCA (misma lógica).
export function ArcaCertificateSettings({ initialTab = "cargar" }: { initialTab?: ArcaCertTab }) {
  const [tab, setTab] = useState<ArcaCertTab>(initialTab);
  const platform = useArcaPlatform();
  const padron = useInternalPadron();
  const issuer = usePlatformIssuer();
  const { level } = useMyStaffLevel();
  const info = platform.data?.[ARCA_CERT_ENV];
  const issuerCondition = issuer.data?.profiles.find((p) => p.environment === ARCA_CERT_ENV)?.iva_condition ?? null;

  if (platform.isLoading) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Cargando el certificado de ARCA">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <SkeletonLines lines={4} />
      </div>
    );
  }
  if (platform.error) {
    return (
      <Callout tone="warning" title="No se pudo cargar el certificado de ARCA">
        {arcaErrorMessage(platform.error)}
      </Callout>
    );
  }

  const { state } = certServiceState(info);
  const has = state !== "missing";

  return (
    <div className="space-y-5">
      <div className="rounded-lg bg-muted/50 p-3 sm:p-4" data-testid="cert-status">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
            {has ? (
              <ShieldCheck size={16} className="shrink-0 text-success" aria-hidden />
            ) : (
              <ShieldOff size={16} className="shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate">Certificado de producción</span>
          </p>
          <CertStateBadge info={info} />
        </div>
        {has ? (
          <CertificateDetails subject={info?.subject} issuer={info?.issuer} cuit={info?.cuit} notAfter={info?.not_after} className="mt-3" />
        ) : (
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Todavía no hay certificado. Cargalo con su clave o, si no lo tenés, generalo desde la pestaña Generar certificado.
          </p>
        )}
      </div>

      <Segmented value={tab} onChange={setTab} options={TABS} aria-label="Secciones del certificado" scrollOnMobile />

      <div role="region" aria-label={TABS.find((t) => t.value === tab)?.label}>
        {tab === "cargar" && <CertUploadTab info={info} />}
        {tab === "probar" && <PadronTestTab cfg={padron.data?.config} issuerCondition={issuerCondition} />}
        {tab === "config" &&
          (padron.isLoading ? (
            <SkeletonLines lines={6} />
          ) : padron.data?.config ? (
            <PadronConfigTab data={padron.data} canEdit={level === "super_admin"} />
          ) : (
            <Callout tone="warning" title="Padrón no disponible">
              Falta aplicar la migración del padrón para los negocios o no tenés acceso.
            </Callout>
          ))}
        {tab === "generar" && <CsrGenerateTab info={info} />}
      </div>
    </div>
  );
}
ArcaCertificateSettings.displayName = "ArcaCertificateSettings";
