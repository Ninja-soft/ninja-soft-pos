"use client";

import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { CopyBlock } from "@/components/arca/shared";
import { isValidCuit } from "@/lib/tax/catalog";
import { arcaErrorMessage, certExpiry, certExpiryText, formatFiscalDate, type ArcaEnv } from "@/lib/arca/labels";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import { useArcaPlatform, usePlatformMutations } from "@/modules/arca/hooks";

// Panel interno (ADR-072): CUIT y certificado de la plataforma para el camino
// "Delegar en NinjaSoft". Mientras falte alguno, los negocios ven ese camino
// como "Disponible próximamente". La clave se genera y cifra en el servidor.
export function ArcaPlatformCard() {
  const q = useArcaPlatform();
  const m = usePlatformMutations();
  const { toast } = useToast();
  const [env, setEnv] = useState<ArcaEnv>("homologacion");
  const info = q.data?.[env];
  const [cuit, setCuit] = useState("");
  const [cert, setCert] = useState("");
  const [csr, setCsr] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ code: string; title: string; action: string }[]>([]);

  useEffect(() => {
    setCuit(info?.cuit ?? "");
    setCsr(info?.pending_csr ? info.csr_pem : null);
    setProblems([]);
  }, [info, env]);

  if (q.isLoading) return <SpinnerBlock className="py-10" />;
  if (q.error) {
    return (
      <Callout tone="warning" title="No disponible">
        {arcaErrorMessage(q.error)}
      </Callout>
    );
  }
  const cuitDigits = cuit.replace(/\D/g, "");
  const cuitBad = cuitDigits.length > 0 && !isValidCuit(cuitDigits);
  const exp = certExpiry(info?.not_after);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ title: ok, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo", description: arcaErrorMessage(e), variant: "error" });
    }
  };

  return (
    <SettingsCard
      title="ARCA plataforma (delegación)"
      description="CUIT y certificado de NinjaSoft para que los negocios deleguen la facturación. Hasta que estén los dos, los clientes ven la delegación como Disponible próximamente."
      padded
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            value={env}
            onChange={setEnv}
            aria-label="Ambiente"
            options={[
              { value: "homologacion", label: "Homologación" },
              { value: "produccion", label: "Producción" },
            ]}
          />
          {info?.ready ? <Badge tone="success">Lista para delegar</Badge> : <Badge tone="neutral">No configurada</Badge>}
        </div>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold">1. CUIT de la plataforma</h4>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input
              label="CUIT"
              inputMode="numeric"
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
              error={cuitBad ? "CUIT inválida" : undefined}
            />
            <Button
              onClick={() => run(() => m.setCuit.mutateAsync({ env, cuit: cuitDigits }), "CUIT guardada")}
              loading={m.setCuit.isPending}
              disabled={cuitDigits.length !== 11 || cuitBad || cuitDigits === (info?.cuit ?? "")}
            >
              Guardar
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold">2. Pedido de certificado (CSR)</h4>
          <p className="text-sm text-muted-foreground">
            La clave privada se genera y se cifra en el servidor. Subí el pedido a WSASS (homologación) o a Administración
            de Certificados Digitales (producción) con la clave fiscal de la plataforma.
          </p>
          <Button
            variant="secondary"
            disabled={!info?.cuit}
            loading={m.generarCsr.isPending}
            onClick={async () => {
              try {
                const r = await m.generarCsr.mutateAsync({ env });
                setCsr(r.csr_pem);
              } catch (e) {
                toast({ title: "No se pudo generar", description: arcaErrorMessage(e), variant: "error" });
              }
            }}
          >
            <KeyRound size={16} /> {csr ? "Generar otro pedido" : "Generar pedido"}
          </Button>
          {csr && <CopyBlock value={csr} fileName={`ninjasoft-${env}.csr`} />}
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold">3. Certificado emitido por ARCA</h4>
          {info?.has_cert && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <ShieldCheck size={15} className="text-success" aria-hidden /> {info.subject}
              </p>
              <p className="text-muted-foreground">
                Vence el {formatFiscalDate(info.not_after)} · {certExpiryText(exp)}
              </p>
            </div>
          )}
          <textarea
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            rows={5}
            placeholder="-----BEGIN CERTIFICATE-----"
            aria-label="Certificado de la plataforma"
            className="w-full rounded-md border border-border bg-background p-3 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            disabled={cert.trim().length < 50}
            loading={m.subirCertificado.isPending}
            onClick={async () => {
              setProblems([]);
              try {
                const r = await m.subirCertificado.mutateAsync({ env, cert });
                if (!r.ok) {
                  setProblems(r.messages ?? (r.problems ?? [r.error ?? "cert_invalido"]).map((code) => ({ code, ...humanError(code) })));
                  return;
                }
                setCert("");
                toast({ title: "Certificado de la plataforma cargado", variant: "success" });
              } catch (e) {
                toast({ title: "No se pudo cargar", description: arcaErrorMessage(e), variant: "error" });
              }
            }}
          >
            <ShieldCheck size={16} /> Validar y guardar
          </Button>
          {problems.length > 0 && (
            <Callout tone="danger" icon={AlertTriangle} title="El certificado no se guardó">
              <ul className="space-y-1">
                {problems.map((p) => (
                  <li key={p.code}>
                    <span className="font-medium text-foreground">{p.title}.</span> {p.action}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
        </section>
      </div>
    </SettingsCard>
  );
}
ArcaPlatformCard.displayName = "ArcaPlatformCard";
