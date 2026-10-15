"use client";

import Link from "next/link";
import { FileCheck2, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CatalogCard, CatalogCardSkeleton, CatalogStat } from "@/components/internal/CatalogCard";
import { formatFiscalDate } from "@/lib/arca/labels";
import { CERT_SERVICE_LABEL, certServiceState, formatCuit } from "@/lib/arca/certUpload";
import { formatInt } from "@/lib/utils/format";
import { useArcaPlatform } from "@/modules/arca/hooks";
import { useInternalPadron } from "@/modules/padron/hooks";
import { ARCA_CERT_ENV } from "./env";

// Complementos › Servicios de la plataforma: el certificado de ARCA de
// NinjaSoft con la misma tarjeta que el catálogo (CatalogCard).
export function ArcaCertificateServiceCard({ onConfigure, showArcaLink = true }: { onConfigure: () => void; showArcaLink?: boolean }) {
  const platform = useArcaPlatform();
  const padron = useInternalPadron();
  if (platform.isLoading) return <CatalogCardSkeleton />;

  const info = platform.data?.[ARCA_CERT_ENV];
  const { state, expiry } = certServiceState(info);
  const s = CERT_SERVICE_LABEL[state];
  const cfg = padron.data?.config;
  const usage = padron.data?.usage;
  const expirySub =
    state === "missing" || expiry.days == null
      ? undefined
      : expiry.days < 0
        ? "Ya venció"
        : expiry.days === 0
          ? "Vence hoy"
          : `Faltan ${formatInt(expiry.days)} días`;

  return (
    <CatalogCard
      icon={FileCheck2}
      title="Certificado de ARCA"
      badge={platform.error ? <Badge>Sin datos</Badge> : <Badge tone={s.tone}>{s.label}</Badge>}
      subtitle="producción · padrón y delegación"
      description="Con este certificado de NinjaSoft los negocios consultan CUITs en el padrón de ARCA y delegan la facturación electrónica."
      stats={
        <>
          <CatalogStat label="CUIT" value={info?.cuit ? formatCuit(info.cuit) : "Sin cargar"} />
          <CatalogStat
            label="Vence el"
            value={info?.has_cert && info.not_after ? formatFiscalDate(info.not_after) : "Sin certificado"}
            sub={expirySub}
          />
          <CatalogStat
            label="Consultas hoy"
            value={usage ? formatInt(usage.arca_day) : "Sin datos"}
            sub={cfg ? `Cupo ${formatInt(cfg.global_per_hour)} por hora` : undefined}
          />
          <CatalogStat
            label="Padrón"
            value={!cfg ? "Sin datos" : cfg.enabled ? "Encendido" : "Apagado"}
            sub={cfg && cfg.environment !== ARCA_CERT_ENV ? "Apunta a homologación" : undefined}
          />
        </>
      }
      actions={
        <>
          <Button size="sm" onClick={onConfigure} className="w-full sm:w-auto">
            <Settings2 size={15} aria-hidden /> Configurar
          </Button>
          {showArcaLink && (
            <Link
              href="/internal/arca"
              className="inline-flex h-9 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-ninja-flameSoft hover:underline sm:w-auto"
            >
              Ir a Plataforma › ARCA
            </Link>
          )}
        </>
      }
    />
  );
}
ArcaCertificateServiceCard.displayName = "ArcaCertificateServiceCard";
