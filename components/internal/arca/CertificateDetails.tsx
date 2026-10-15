import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import { certExpiry, certExpiryText, formatFiscalDate } from "@/lib/arca/labels";
import { CERT_SERVICE_LABEL, certHolder, certIssuerLabel, certServiceState, formatCuit } from "@/lib/arca/certUpload";

// Datos públicos del certificado de ARCA (nunca la clave): titular, CUIT,
// vencimiento y emisor. La usan el estado de arriba del modal y el resultado
// de "Validar y guardar".
export function CertificateDetails({
  subject,
  issuer,
  cuit,
  notAfter,
  className,
}: {
  subject: string | null | undefined;
  issuer?: string | null;
  cuit?: string | null;
  notAfter: string | null | undefined;
  className?: string;
}) {
  const holder = certHolder(subject);
  const exp = certExpiry(notAfter);
  const issuerText = certIssuerLabel(issuer);
  const shownCuit = cuit ?? holder.cuit;
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2", className)}>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">Titular del certificado</dt>
        <dd className="mt-0.5 break-words font-medium text-foreground">{holder.name ?? "Sin nombre"}</dd>
        {holder.alias && holder.alias !== holder.name && (
          <dd className="break-words text-xs text-muted-foreground">Alias {holder.alias}</dd>
        )}
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">CUIT</dt>
        <dd className="mt-0.5 font-mono font-medium tabular-nums text-foreground">{shownCuit ? formatCuit(shownCuit) : "Sin CUIT"}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">Vencimiento</dt>
        <dd className="mt-0.5 font-medium text-foreground">
          {notAfter ? `Certificado vence el ${formatFiscalDate(notAfter)}` : "Sin fecha"}
        </dd>
        {notAfter && (
          <dd className={cn("text-xs", exp.level === "ok" ? "text-muted-foreground" : exp.level === "warn" ? "text-warning" : "text-danger")}>
            {certExpiryText(exp)}
          </dd>
        )}
      </div>
      {issuerText && (
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Emisor</dt>
          <dd className="mt-0.5 break-words font-medium text-foreground">{issuerText}</dd>
        </div>
      )}
    </dl>
  );
}
CertificateDetails.displayName = "CertificateDetails";

/** Pastilla de estado del certificado (Activo, Falta certificado, Vence pronto, Vencido). */
export function CertStateBadge({ info }: { info: Parameters<typeof certServiceState>[0] }) {
  const { state } = certServiceState(info);
  const s = CERT_SERVICE_LABEL[state];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
CertStateBadge.displayName = "CertStateBadge";
