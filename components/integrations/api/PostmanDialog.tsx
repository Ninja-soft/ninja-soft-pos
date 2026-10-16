"use client";

import { useState } from "react";
import { Download, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import type { ApiClientView, ApiClientWithSecret } from "@/modules/api-publica/api";
import { buildPostmanCollection, postmanFileName } from "@/lib/api/postman";
import { downloadJson } from "./CodeBlock";
import { envOf } from "./ApiCredentials";

// Descarga de la colección de Postman v2.1 (ADR-159). Se arma en el navegador.
// De una credencial existente sólo se conoce el client_id (el secreto no se
// guarda): la colección sale con client_secret vacío. Si el dueño acaba de
// crear o rotar una, puede incluir ese secreto (con confirmación).

const NONE = "__none__";

export function PostmanDialog({
  open,
  onOpenChange,
  clients,
  fresh,
  initialClientId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clients: ApiClientView[];
  fresh: ApiClientWithSecret | null;
  initialClientId?: string | null;
}) {
  const { toast } = useToast();
  const active = clients.filter((c) => c.status === "active");
  const [selected, setSelected] = useState<string>(initialClientId ?? fresh?.client_id ?? active[0]?.client_id ?? NONE);
  const [include, setInclude] = useState(true);
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setSelected(initialClientId ?? fresh?.client_id ?? active[0]?.client_id ?? NONE);
      setInclude(true);
    }
  }

  const client = active.find((c) => c.client_id === selected) ?? (fresh?.client_id === selected ? fresh : null);
  const canIncludeSecret = Boolean(fresh && client && fresh.client_id === client.client_id);
  const env = client ? envOf(client) : "test";

  const download = () => {
    const collection = buildPostmanCollection({
      origin: window.location.origin,
      clientId: client?.client_id ?? null,
      clientSecret: canIncludeSecret && include ? fresh!.client_secret : null,
      environment: env,
    });
    downloadJson(collection, postmanFileName(env));
    toast({ title: "Colección descargada", variant: "success" });
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Colección de Postman"
      description="Postman v2.1 con carpetas por recurso, ejemplos y notas. Pide el token sola y lo renueva antes de que venza."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={download}>
            <Download size={15} /> Descargar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Select
          label="Credencial precargada"
          value={selected}
          onChange={setSelected}
          options={[
            ...active.map((c) => ({
              value: c.client_id,
              label: `${c.name} · ${envOf(c) === "test" ? "Prueba" : "Producción"}`,
              description: c.client_id,
            })),
            { value: NONE, label: "Ninguna", description: "Completás client_id y client_secret en Postman." },
          ]}
        />
        {client && !canIncludeSecret && (
          <p className="text-xs text-muted-foreground">
            El secreto de una credencial existente no se puede volver a ver: la colección sale con client_secret vacío
            para que lo pegues en Postman. Si lo perdiste, rotalo y descargá la colección desde ese aviso.
          </p>
        )}
        {canIncludeSecret && (
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox checked={include} onCheckedChange={(v) => setInclude(Boolean(v))} aria-label="Incluir el client_secret" />
            <span className="text-sm">
              Incluir el client_secret que acabás de ver
              <span className="block text-xs text-muted-foreground">
                Queda dentro del archivo. Tratalo como una contraseña.
              </span>
            </span>
          </label>
        )}
        {canIncludeSecret && include && env === "live" && (
          <Callout tone="warning" icon={KeyRound}>
            Es una credencial de producción: con este archivo se puede leer y escribir en el negocio. No lo compartas ni lo
            subas a un repositorio.
          </Callout>
        )}
      </div>
    </Modal>
  );
}
PostmanDialog.displayName = "PostmanDialog";
