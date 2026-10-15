"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { CopyBlock, ExtLink } from "@/components/arca/shared";
import { arcaErrorMessage, formatFiscalDate } from "@/lib/arca/labels";
import { cuitFieldError, cuitReady, uploadProblems, type UploadProblem } from "@/lib/arca/certUpload";
import { usePlatformMutations } from "@/modules/arca/hooks";
import type { PlatformEnvInfo } from "@/modules/arca/api";
import { PemDropzone, type PemFile } from "./PemDropzone";
import { CertificateDetails } from "./CertificateDetails";
import { ARCA_CERT_ENV } from "./env";

const ARCA_LOGIN = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";
const ARCA_CERT_HELP = "https://www.afip.gob.ar/ws/documentacion/certificados.asp";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-bold tabular-nums text-muted-foreground"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <h4 className="pt-0.5 text-sm font-semibold text-foreground">{title}</h4>
        {children}
      </div>
    </li>
  );
}

// Pestaña "Generar certificado": la clave se genera y se cifra en el servidor
// (platform_generar_csr), se baja el pedido (.csr), se lo sube a ARCA y el
// certificado que devuelve ARCA se carga acá (platform_subir_certificado).
export function CsrGenerateTab({ info }: { info: PlatformEnvInfo | undefined }) {
  const m = usePlatformMutations();
  const { toast } = useToast();
  const [cuit, setCuit] = useState(info?.cuit ?? "");
  const [csr, setCsr] = useState<string | null>(info?.pending_csr ? info.csr_pem : null);
  const [confirm, setConfirm] = useState(false);
  const [cert, setCert] = useState<PemFile | null>(null);
  const [problems, setProblems] = useState<UploadProblem[]>([]);
  const [saved, setSaved] = useState<{ subject: string | null; issuer: string | null; cuit: string | null; not_after: string | null } | null>(null);

  const cuitDigits = cuit.replace(/\D/g, "");
  const cuitErr = cuitFieldError(cuit);
  const generating = m.setCuit.isPending || m.generarCsr.isPending;
  // Hay una clave guardada esperando su certificado (pedido de esta sesión o pendiente).
  const hasPendingKey = Boolean(csr) && Boolean(info?.has_key ?? true);

  const generate = async () => {
    setConfirm(false);
    try {
      if (cuitDigits !== (info?.cuit ?? "")) await m.setCuit.mutateAsync({ env: ARCA_CERT_ENV, cuit: cuitDigits });
      const r = await m.generarCsr.mutateAsync({ env: ARCA_CERT_ENV });
      setCsr(r.csr_pem);
      setSaved(null);
      toast({ title: "Pedido generado", description: "Descargalo y subilo a ARCA.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo generar el pedido", description: arcaErrorMessage(e), variant: "error" });
    }
  };

  const upload = async () => {
    if (!cert?.check.ok) return;
    setProblems([]);
    try {
      const r = await m.subirCertificado.mutateAsync({ env: ARCA_CERT_ENV, cert: cert.check.pem });
      if (!r.ok) {
        setProblems(uploadProblems(r, { typedCuit: info?.cuit ?? cuitDigits, pair: false }));
        return;
      }
      const c = r.certificate ?? {};
      setSaved({ subject: c.subject ?? null, issuer: c.issuer ?? null, cuit: c.cuit ?? null, not_after: c.not_after ?? null });
      setCert(null);
      setCsr(null);
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
        Si todavía no tenés certificado, NinjaSoft genera la clave privada en el servidor (cifrada, nunca sale de ahí) y
        te da el pedido para subir a ARCA.
      </p>

      <ol className="space-y-6">
        <Step n={1} title="CUIT de la empresa">
          <Input
            aria-label="CUIT de la empresa del certificado"
            inputMode="numeric"
            autoComplete="off"
            placeholder="30-12345678-9"
            maxLength={13}
            value={cuit}
            onChange={(e) => setCuit(e.target.value)}
            error={cuitErr ?? undefined}
            hint="El pedido sale a nombre de esta CUIT."
          />
        </Step>

        <Step n={2} title="Generar el pedido (CSR)">
          <Button
            variant="secondary"
            onClick={() => (info?.has_cert ? setConfirm(true) : void generate())}
            loading={generating}
            disabled={!cuitReady(cuit)}
            className="w-full sm:w-auto"
          >
            <KeyRound size={16} aria-hidden /> {csr ? "Generar otro pedido" : "Generar pedido"}
          </Button>
          {csr && <CopyBlock value={csr} fileName="ninjasoft-produccion.csr" />}
        </Step>

        <Step n={3} title="Pedir el certificado en ARCA">
          <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-muted-foreground marker:text-muted-foreground">
            <li>
              Entrá a <ExtLink href={ARCA_LOGIN}>ARCA con clave fiscal</ExtLink> de la empresa.
            </li>
            <li>
              Abrí <span className="font-medium text-foreground">Administración de Certificados Digitales</span> (si no aparece, sumalo desde Administrador de Relaciones de Clave Fiscal).
            </li>
            <li>
              <span className="font-medium text-foreground">Agregar alias</span>, ponele un nombre (por ejemplo ninjasoftpos) y subí el archivo .csr.
            </li>
            <li>
              Entrá al alias y descargá el certificado (.crt). <ExtLink href={ARCA_CERT_HELP}>Guía de ARCA</ExtLink>
            </li>
          </ol>
        </Step>

        <Step n={4} title="Habilitar el padrón para ese certificado">
          <p className="text-[13px] text-muted-foreground">
            En <span className="font-medium text-foreground">Administrador de Relaciones de Clave Fiscal</span> › Nueva relación ›
            ARCA › WebServices, elegí <span className="font-mono text-foreground">ws_sr_constancia_inscripcion</span> y asocialo al alias.
            Para la delegación de facturas, repetí con <span className="font-mono text-foreground">wsfe</span>.
          </p>
        </Step>

        <Step n={5} title="Cargar el certificado que te dio ARCA">
          <PemDropzone
            kind="certificate"
            label="Certificado (.crt o .pem)"
            hint={hasPendingKey ? "El que descargaste del alias" : "Primero generá el pedido (paso 2)"}
            value={cert}
            onChange={(f) => {
              setCert(f);
              setProblems([]);
            }}
            disabled={!hasPendingKey || m.subirCertificado.isPending}
          />
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
          <div className="flex justify-end">
            <Button
              onClick={upload}
              loading={m.subirCertificado.isPending}
              disabled={!hasPendingKey || cert?.check.ok !== true}
              className="w-full sm:w-auto"
            >
              <ShieldCheck size={16} aria-hidden /> Validar y guardar
            </Button>
          </div>
        </Step>
      </ol>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="¿Generar un pedido nuevo?"
        description="Reemplaza la clave del certificado actual: el padrón y la delegación dejan de funcionar hasta que cargues el certificado nuevo que te dé ARCA."
        confirmLabel="Generar igual"
        danger
        loading={generating}
        onConfirm={() => void generate()}
      />
    </div>
  );
}
CsrGenerateTab.displayName = "CsrGenerateTab";
