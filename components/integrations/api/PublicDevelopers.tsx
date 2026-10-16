"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Code2, FlaskConical, KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { buildPostmanCollection, postmanFileName } from "@/lib/api/postman";
import { DEMO_CLIENT_ID, DEMO_CLIENT_SECRET, SANDBOX_BASE_PATH } from "@/lib/api/sandboxConstants";
import { ENDPOINTS } from "@/lib/api/spec";
import { ApiPortal, PORTAL_START } from "./ApiPortal";
import { CodeBlock, downloadJson } from "./CodeBlock";
import { SandboxProvider, useSandbox } from "./TryIt";

// Portal público de desarrolladores (ADR-163, H68b): /developers sin login.
// La misma referencia que Configuración › Integraciones › API (generada desde
// lib/api/spec.ts) y Probar contra /api/sandbox/v1: credenciales de ejemplo
// con un negocio ficticio, o una credencial de prueba propia. Nunca muestra
// datos de un negocio por sí misma ni acepta credenciales de producción.

const SECTIONS = new Set<string>(["intro", "credentials", "auth", "sandbox", "limits", "errors", "downloads", ...ENDPOINTS.map((e) => e.id)]);

function sectionFromHash(hash: string): string | null {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  return SECTIONS.has(id) ? id : null;
}

function CredentialsGuide({ onUseDemo }: { onUseDemo: () => void }) {
  return (
    <Card className="space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Credenciales</h2>
        <p className="text-sm text-muted-foreground">
          Cada credencial pertenece a un negocio y la crea su dueño. Para probar sin cuenta están las credenciales de
          ejemplo.
        </p>
      </header>
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <FlaskConical size={16} aria-hidden /> Credenciales de ejemplo
          <Badge tone="info">Datos ficticios</Badge>
        </h3>
        <p className="text-sm text-muted-foreground">
          Son públicas y sólo funcionan contra el sandbox público ({SANDBOX_BASE_PATH}), que responde con un negocio
          inventado. No dan acceso a ningún negocio real.
        </p>
        <CodeBlock code={`client_id=${DEMO_CLIENT_ID}\nclient_secret=${DEMO_CLIENT_SECRET}`} label="Credenciales de ejemplo" />
        <Button size="sm" onClick={onUseDemo}>
          <FlaskConical size={15} /> Usar en el sandbox
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <KeyRound size={16} aria-hidden /> Credenciales de tu negocio
        </h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>El dueño entra a Configuración, Integraciones, API (plan Enterprise).</li>
          <li>Crea una credencial de prueba (prefijo nsc_test_) con los permisos que necesita la integración.</li>
          <li>Con esa credencial podés probar acá mismo: lecturas reales de tu negocio y escrituras simuladas (dry_run).</li>
          <li>Cuando todo funciona, crea una credencial de producción y la integración la usa desde su servidor.</li>
        </ol>
        <Callout tone="info" icon={ShieldCheck}>
          Esta página no acepta credenciales de producción, no guarda nada en el navegador y nunca muestra el secreto de
          una credencial.
        </Callout>
      </section>
    </Card>
  );
}

function Inner() {
  const sandbox = useSandbox();
  const [section, setSection] = useState<string>(PORTAL_START);

  useEffect(() => {
    const fromHash = sectionFromHash(window.location.hash);
    if (fromHash) setSection(fromHash);
  }, []);

  const navigate = (id: string) => {
    setSection(id);
    if (typeof window !== "undefined" && window.history?.replaceState) {
      window.history.replaceState(null, "", id === PORTAL_START ? window.location.pathname : `#${id}`);
    }
  };

  const downloadPostman = () => {
    const collection = buildPostmanCollection({
      origin: window.location.origin,
      basePath: SANDBOX_BASE_PATH,
      clientId: DEMO_CLIENT_ID,
      clientSecret: DEMO_CLIENT_SECRET,
      environment: "test",
      demo: true,
    });
    downloadJson(collection, postmanFileName("test").replace("-prueba", "-sandbox-publico"));
  };

  return (
    <ApiPortal
      variant="public"
      active={section}
      onNavigate={navigate}
      onPostman={downloadPostman}
      credentials={
        <CredentialsGuide
          onUseDemo={() => {
            sandbox.loadCredentials(DEMO_CLIENT_ID, DEMO_CLIENT_SECRET);
            navigate("oauth.token");
          }}
        />
      }
    />
  );
}

export function PublicDevelopers() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Code2 size={20} className="shrink-0 text-ninja-flameSoft" aria-hidden />
            <span className="truncate font-semibold">NinjaSoft POS · Desarrolladores</span>
            <Badge tone="neutral" className="font-mono">
              API v1
            </Badge>
          </div>
          <Link href="/login" className={buttonVariants({ size: "sm", variant: "ghost" })}>
            <LogIn size={15} aria-hidden /> Ingresar
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">API pública de NinjaSoft POS</h1>
          <p className="text-sm text-muted-foreground">
            Referencia completa, descargas y un sandbox para probar sin cuenta con datos ficticios.
          </p>
        </div>
        <SandboxProvider basePath={SANDBOX_BASE_PATH} demo>
          <Inner />
        </SandboxProvider>
      </main>
    </div>
  );
}
PublicDevelopers.displayName = "PublicDevelopers";
