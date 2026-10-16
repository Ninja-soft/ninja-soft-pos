"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useApiClients } from "@/modules/api-publica/hooks";
import { apiPublicaErrorMessage, type ApiClientWithSecret } from "@/modules/api-publica/api";
import { ApiCredentials } from "./ApiCredentials";
import { ApiPortal, PORTAL_START } from "./ApiPortal";
import { PostmanDialog } from "./PostmanDialog";
import { SandboxProvider, useSandbox } from "./TryIt";

// Configuración > Integraciones > API (ADR-094 + ADR-159): portal de
// desarrolladores. La documentación, el OpenAPI y el Probar (sólo sandbox)
// los ve cualquiera que entre a la sección; las credenciales y la colección
// de Postman con credencial precargada, sólo el dueño. El secreto recién
// creado o rotado vive sólo en memoria de esta página.

function Inner() {
  const { data: me, isLoading: meLoading } = useMyTenant();
  const isOwner = me?.role === "owner";
  const q = useApiClients(isOwner);
  const sandbox = useSandbox();
  const [section, setSection] = useState<string>(PORTAL_START);
  const [fresh, setFresh] = useState<ApiClientWithSecret | null>(null);
  const [postman, setPostman] = useState<{ open: boolean; clientId: string | null }>({ open: false, clientId: null });

  if (meLoading) return <SpinnerBlock className="py-16" />;

  let credentials: React.ReactNode;
  if (!isOwner) {
    credentials = (
      <Callout tone="info" icon={Lock} title="Sólo el dueño">
        Las credenciales de la API dan acceso a los datos del negocio: las crea y revoca el dueño.
      </Callout>
    );
  } else if (q.isLoading) {
    credentials = <SpinnerBlock className="py-16" />;
  } else if (q.error || !q.data) {
    credentials = (
      <Callout tone="warning" icon={Lock} title="No disponible">
        {apiPublicaErrorMessage(q.error)}
      </Callout>
    );
  } else {
    credentials = (
      <ApiCredentials
        state={q.data}
        onSecret={setFresh}
        onPostman={(c) => setPostman({ open: true, clientId: c.client_id })}
        onSandbox={(c) => {
          sandbox.loadCredentials(c.client_id, c.client_secret);
          setSection("oauth.token");
        }}
      />
    );
  }

  return (
    <>
      <ApiPortal
        active={section}
        onNavigate={setSection}
        credentials={credentials}
        onPostman={() => setPostman({ open: true, clientId: null })}
      />
      <PostmanDialog
        open={postman.open}
        onOpenChange={(open) => setPostman((p) => ({ ...p, open }))}
        clients={isOwner ? (q.data?.clients ?? []) : []}
        fresh={fresh}
        initialClientId={postman.clientId}
      />
    </>
  );
}

export function ApiSettings() {
  return (
    <SandboxProvider>
      <Inner />
    </SandboxProvider>
  );
}
ApiSettings.displayName = "ApiSettings";
