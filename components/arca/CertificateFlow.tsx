"use client";

import { useRef, useState } from "react";
import { FileUp, KeyRound, ShieldCheck, Trash2, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { EXPECTED_ISSUER_CN } from "@/supabase/functions/_shared/arca/config";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import { ARCA_LINKS, arcaErrorMessage, certExpiry, certExpiryText, formatFiscalDate, type ArcaEnv } from "@/lib/arca/labels";
import type { ArcaCertificate, ArcaConfig } from "@/modules/arca/api";
import { useArcaMutations } from "@/modules/arca/hooks";
import { CopyBlock, ExtLink, HowTo, Term } from "./shared";

// Certificado propio (camino B): NinjaSoft genera la clave privada y el pedido
// (CSR) en el servidor; la persona lo pega en ARCA y vuelve con el
// certificado. La clave nunca viaja al navegador.

export function aliasFromSubject(subject: string | null | undefined): string | null {
  const m = /CN=([^,]+)/.exec(subject ?? "");
  return m ? (m[1] as string).trim() : null;
}

export function defaultAlias(cuit: string | null | undefined): string {
  return `ninjapos${String(cuit ?? "").replace(/\D/g, "")}`;
}

export function CertificateFlow({ config, env, canWrite }: { config: ArcaConfig; env: ArcaEnv; canWrite: boolean }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const active = config.certificates.find((c) => c.environment === env && c.status === "active") ?? null;
  const pending = config.certificates.find((c) => c.environment === env && c.status === "pending_csr") ?? null;
  const [alias, setAlias] = useState(aliasFromSubject(pending?.subject) ?? defaultAlias(config.emitter.cuit));
  const [org, setOrg] = useState("");
  const [csr, setCsr] = useState<string | null>(pending?.csr_pem ?? null);
  const [cert, setCert] = useState("");
  const [problems, setProblems] = useState<{ code: string; title: string; action: string }[]>([]);
  const [replacing, setReplacing] = useState(false);
  const [del, setDel] = useState<ArcaCertificate | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isHomo = env === "homologacion";

  const generate = async () => {
    try {
      const r = await m.generarCsr.mutateAsync({ env, alias, organization: org });
      setCsr(r.csr_pem);
      setAlias(r.alias || alias);
      toast({ title: "Pedido generado", description: "Copialo y pegalo en ARCA.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo generar el pedido", description: arcaErrorMessage(e), variant: "error" });
    }
  };

  const upload = async () => {
    setProblems([]);
    try {
      const r = await m.subirCertificado.mutateAsync({ env, cert });
      if (!r.ok) {
        const list =
          r.messages ??
          (r.problems ?? [r.error ?? "cert_invalido"]).map((code) => ({ code, ...humanError(code) }));
        setProblems(list);
        return;
      }
      setCert("");
      setReplacing(false);
      toast({ title: "Certificado cargado", description: `${venceText(r) ?? ""} Ya podés seguir con el paso siguiente.`.trim(), variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo cargar el certificado", description: arcaErrorMessage(e), variant: "error" });
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20_000) {
      toast({ title: "Ese archivo es demasiado grande para ser un certificado", variant: "error" });
      return;
    }
    setCert(await f.text());
  };

  if (active && !replacing) {
    const exp = certExpiry(active.not_after);
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold">
              <ShieldCheck size={16} className="text-success" aria-hidden /> Certificado cargado
            </p>
            <Badge tone={exp.level === "ok" ? "success" : exp.level === "warn" ? "warning" : "danger"}>
              {certExpiryText(exp)}
            </Badge>
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">CUIT</dt>
              <dd className="font-mono">{active.cuit ?? "Sin dato"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                <Term k="alias">Alias</Term>
              </dt>
              <dd className="font-mono">{aliasFromSubject(active.subject) ?? "Sin dato"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Emitido por</dt>
              <dd>{active.issuer?.match(/CN=([^,]+)/)?.[1] ?? active.issuer}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Vence</dt>
              <dd>{formatFiscalDate(active.not_after)}</dd>
            </div>
          </dl>
          {canWrite && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>
                <KeyRound size={15} /> Renovar o cambiar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDel(active)}>
                <Trash2 size={15} /> Borrar
              </Button>
            </div>
          )}
        </div>
        <ConfirmDialog
          open={del != null}
          onOpenChange={(o) => !o && setDel(null)}
          title="¿Borrar el certificado?"
          description="NinjaSoft deja de poder facturar en este modo hasta que cargues otro."
          confirmLabel="Borrar"
          danger
          loading={m.deleteCertificate.isPending}
          onConfirm={async () => {
            if (!del) return;
            try {
              await m.deleteCertificate.mutateAsync(del.id);
              setDel(null);
            } catch (e) {
              toast({ title: "No se pudo borrar", description: arcaErrorMessage(e), variant: "error" });
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 1. Pedido */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold">1. Generá el pedido de certificado en NinjaSoft</h4>
        <p className="text-sm text-muted-foreground">
          NinjaSoft crea la <Term k="clave_privada" /> y la guarda cifrada en el servidor (nunca la ves ni viaja a tu
          navegador). Vos sólo copiás el <Term k="csr" /> y lo pegás en ARCA.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Alias del certificado"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            hint="Sólo letras y números. Lo vas a ver en ARCA."
            disabled={!canWrite}
          />
          <Input
            label="Razón social (opcional)"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            hint="Si la dejás vacía se usa la del negocio."
            disabled={!canWrite}
          />
        </div>
        <Button onClick={generate} loading={m.generarCsr.isPending} disabled={!canWrite || !config.emitter.cuit}>
          <KeyRound size={16} /> {csr ? "Generar otro pedido" : "Generar pedido"}
        </Button>
        {!config.emitter.cuit && (
          <p className="text-sm text-warning">Primero cargá la CUIT del negocio en Configuración &gt; Impuestos.</p>
        )}
        {csr && <CopyBlock value={csr} fileName={`${alias || "ninjapos"}.csr`} />}
      </section>

      {/* 2. ARCA */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold">
          2. {isHomo ? "Pedí el certificado de prueba en WSASS" : "Pedí el certificado real en ARCA"}
        </h4>
        {isHomo ? (
          <HowTo
            steps={[
              {
                title: "Entrá a ARCA con tu clave fiscal",
                body: (
                  <>
                    <ExtLink href={ARCA_LINKS.login}>Ingresar a ARCA</ExtLink>. Hace falta <Term k="clave_fiscal" /> nivel 3.
                  </>
                ),
              },
              {
                title: "Habilitá WSASS",
                body: (
                  <>
                    En <strong>Administrador de Relaciones de Clave Fiscal</strong>, adherí el servicio{" "}
                    <strong>WSASS - Autogestión Certificados Homologación</strong>. Se hace una sola vez.
                  </>
                ),
              },
              {
                title: "Abrí WSASS y creá el certificado",
                body: (
                  <>
                    <ExtLink href={ARCA_LINKS.wsass}>Abrir WSASS</ExtLink>. Elegí <strong>Nuevo certificado</strong>, poné el
                    alias <span className="font-mono">{alias}</span> como nombre simbólico y pegá el pedido.
                  </>
                ),
              },
              {
                title: "Copiá el certificado",
                body: (
                  <>
                    Tocá <strong>Crear DN y obtener certificado</strong>, copiá todo el texto que aparece (desde -----BEGIN
                    CERTIFICATE-----) y pegalo abajo.
                  </>
                ),
              },
            ]}
          />
        ) : (
          <HowTo
            steps={[
              {
                title: "Entrá a ARCA con tu clave fiscal",
                body: (
                  <>
                    <ExtLink href={ARCA_LINKS.login}>Ingresar a ARCA</ExtLink>. Hace falta <Term k="clave_fiscal" /> nivel 3.
                  </>
                ),
              },
              {
                title: "Abrí Administración de Certificados Digitales",
                body: (
                  <>
                    Si no lo ves en tus servicios, adherilo desde <strong>Administrador de Relaciones de Clave Fiscal</strong>{" "}
                    (Adherir servicio &gt; ARCA &gt; Administración de Certificados Digitales). Elegí tu CUIT{" "}
                    <span className="font-mono">{config.emitter.cuit ?? ""}</span>.
                  </>
                ),
              },
              {
                title: "Agregá un alias",
                body: (
                  <>
                    Tocá <strong>Agregar alias</strong>, escribí exactamente <span className="font-mono text-foreground">{alias}</span>,
                    tocá <strong>Examinar</strong>, elegí el archivo .csr que descargaste arriba y tocá <strong>Agregar alias</strong>.
                  </>
                ),
              },
              {
                title: "Descargá el certificado",
                body: (
                  <>
                    En la lista, tocá <strong>Ver</strong> al lado del alias y después <strong>Descargar</strong>. Te baja un
                    archivo .crt: subilo o pegalo abajo. Ese alias es el que vas a elegir después, al autorizar el servicio.
                  </>
                ),
              },
            ]}
          />
        )}
      </section>

      {/* 3. Certificado */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold">3. Pegá el certificado que te devolvió ARCA</h4>
        <textarea
          value={cert}
          onChange={(e) => setCert(e.target.value)}
          rows={6}
          disabled={!canWrite}
          placeholder="-----BEGIN CERTIFICATE-----"
          aria-label="Certificado"
          className="w-full rounded-md border border-border bg-background p-3 font-mono text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={upload} loading={m.subirCertificado.isPending} disabled={!canWrite || cert.trim().length < 50}>
            <ShieldCheck size={16} /> Validar y guardar
          </Button>
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={!canWrite}>
            <FileUp size={16} /> Subir archivo .crt
          </Button>
          {replacing && (
            <Button variant="ghost" onClick={() => setReplacing(false)}>
              Cancelar
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".crt,.pem,.cer,.txt"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          NinjaSoft revisa al instante que corresponda al pedido generado acá, que sea de{" "}
          {isHomo ? "prueba" : "producción"} (emitido por {EXPECTED_ISSUER_CN[env]}), que no esté vencido y que sea de tu
          CUIT.
        </p>
        {problems.length > 0 && (
          <Callout tone="danger" icon={AlertTriangle} title="El certificado no se guardó">
            <ul className="mt-1 space-y-1.5">
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
  );
}
CertificateFlow.displayName = "CertificateFlow";

/** "Certificado vence el 10/09/2028" a partir de la respuesta de la Edge. */
function venceText(r: unknown): string | undefined {
  const na = (r as { certificate?: { not_after?: string | null } } | null)?.certificate?.not_after;
  return na ? `Certificado vence el ${formatFiscalDate(na)}.` : undefined;
}
