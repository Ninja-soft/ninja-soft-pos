"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { arcaErrorMessage, formatFiscalDate } from "@/lib/arca/labels";
import { cuitFieldError, cuitReady, uploadProblems, type UploadProblem } from "@/lib/arca/certUpload";
import { usePlatformMutations } from "@/modules/arca/hooks";
import type { PlatformEnvInfo } from "@/modules/arca/api";
import { PemDropzone, type PemFile } from "./PemDropzone";
import { CertificateDetails } from "./CertificateDetails";
import { ARCA_CERT_ENV } from "./env";

// Pestaña "Cargar certificado": CUIT de la empresa titular + .crt + .key.
// La clave viaja sólo a la Edge (platform_subir_par), que valida el par, la
// CUIT y el emisor de producción y la guarda cifrada (ARCA_KEY_ENC).
export function CertUploadTab({ info }: { info: PlatformEnvInfo | undefined }) {
  const m = usePlatformMutations();
  const { toast } = useToast();
  const [cuit, setCuit] = useState(info?.cuit ?? "");
  const [cert, setCert] = useState<PemFile | null>(null);
  const [key, setKey] = useState<PemFile | null>(null);
  const [problems, setProblems] = useState<UploadProblem[]>([]);
  const [saved, setSaved] = useState<{ subject: string | null; issuer: string | null; cuit: string | null; not_after: string | null } | null>(null);

  const cuitDigits = cuit.replace(/\D/g, "");
  const cuitErr = cuitFieldError(cuit);
  const canSubmit = cuitReady(cuit) && cert?.check.ok === true && key?.check.ok === true;

  const submit = async () => {
    if (!canSubmit || !cert?.check.ok || !key?.check.ok) return;
    setProblems([]);
    setSaved(null);
    try {
      const r = await m.subirPar.mutateAsync({ env: ARCA_CERT_ENV, cert: cert.check.pem, key: key.check.pem, cuit: cuitDigits });
      if (!r.ok) {
        setProblems(uploadProblems(r, { typedCuit: cuitDigits, pair: true }));
        return;
      }
      const c = r.certificate ?? {};
      setSaved({ subject: c.subject ?? null, issuer: c.issuer ?? null, cuit: c.cuit ?? cuitDigits, not_after: c.not_after ?? null });
      setCert(null);
      setKey(null);
      toast({
        title: "Certificado guardado",
        description: c.not_after ? `Certificado vence el ${formatFiscalDate(c.not_after)}.` : undefined,
        variant: "success",
      });
    } catch (e) {
      setProblems([{ code: "edge", title: "No se pudo cargar", action: arcaErrorMessage(e) }]);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Si ya tenés el certificado de producción y su clave privada (por ejemplo, generados con openssl), cargalos acá.
        Se validan juntos contra la CUIT y ARCA antes de guardarse.
      </p>

      <Input
        label="CUIT de la empresa titular del certificado"
        inputMode="numeric"
        autoComplete="off"
        placeholder="30-12345678-9"
        value={cuit}
        maxLength={13}
        onChange={(e) => {
          setCuit(e.target.value);
          setProblems([]);
        }}
        error={cuitErr ?? undefined}
        hint="La misma que figura en el certificado. Queda como CUIT de NinjaSoft para el padrón y la delegación."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <PemDropzone
          kind="certificate"
          label="Certificado (.crt o .pem)"
          hint="El que descargaste de ARCA"
          value={cert}
          onChange={(f) => {
            setCert(f);
            setProblems([]);
          }}
          disabled={m.subirPar.isPending}
        />
        <PemDropzone
          kind="private_key"
          label="Clave privada (.key)"
          hint="Sin contraseña"
          value={key}
          onChange={(f) => {
            setKey(f);
            setProblems([]);
          }}
          disabled={m.subirPar.isPending}
        />
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <LockKeyhole size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          La clave se lee en tu navegador, viaja sólo al servidor y se guarda cifrada. No se vuelve a mostrar.
          {info?.has_cert ? " Reemplaza al certificado actual." : ""}
        </span>
      </p>

      {problems.length > 0 && (
        <Callout tone="danger" icon={AlertTriangle} title="El certificado no se guardó">
          <ul className="space-y-1.5">
            {problems.map((p) => (
              <li key={p.code}>
                <span className="font-medium text-foreground">{p.title}.</span> {p.action}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {saved && (
        <div className="space-y-3 rounded-lg bg-success/10 p-3 sm:p-4" role="status">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CheckCircle2 size={16} className="text-success" aria-hidden /> Certificado validado y guardado
          </p>
          <CertificateDetails subject={saved.subject} issuer={saved.issuer} cuit={saved.cuit} notAfter={saved.not_after} />
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={submit} loading={m.subirPar.isPending} disabled={!canSubmit} className="w-full sm:w-auto">
          <ShieldCheck size={16} aria-hidden /> Validar y guardar
        </Button>
      </div>
    </div>
  );
}
CertUploadTab.displayName = "CertUploadTab";
