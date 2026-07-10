"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type Status = {
  updated_at: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  public_key: string | null;
  client_secret: boolean;
  access_token: boolean;
};

// Credenciales globales de la app de Mercado Pago de NinjaSoft.
// client_id/secret/redirect_uri → OAuth de los tenants.
// access_token/public_key → cuenta propia para cobrar suscripciones.
export function PlatformMpCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  const { data: status } = useQuery({
    queryKey: ["platform-mp-status"],
    queryFn: async (): Promise<Status | null> => {
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: "mercadopago", action: "status" },
      });
      if (error) throw error;
      return (data as { status?: Status })?.status ?? null;
    },
  });

  // Prefill de valores públicos (no secretos).
  useEffect(() => {
    if (!status) return;
    setClientId(status.client_id ?? "");
    setPublicKey(status.public_key ?? "");
    setRedirectUri(
      status.redirect_uri ??
        (typeof window !== "undefined"
          ? `${window.location.origin}/api/mp/oauth/callback`
          : ""),
    );
  }, [status]);

  const save = useMutation({
    mutationFn: async () => {
      const secrets: Record<string, string> = {};
      if (clientId.trim()) secrets.client_id = clientId.trim();
      if (clientSecret.trim()) secrets.client_secret = clientSecret.trim();
      if (accessToken.trim()) secrets.access_token = accessToken.trim();
      if (publicKey.trim()) secrets.public_key = publicKey.trim();
      if (redirectUri.trim()) secrets.redirect_uri = redirectUri.trim();
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: "mercadopago", secrets },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error)
        throw new Error((data as { error: string }).error);
    },
    onSuccess: () => {
      toast({ title: "Credenciales guardadas", variant: "success" });
      setClientSecret("");
      setAccessToken("");
      qc.invalidateQueries({ queryKey: ["platform-mp-status"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  return (
    <section>
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <CreditCard size={18} /> Mercado Pago (plataforma)
      </Heading>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Credenciales de la app de Mercado Pago de NinjaSoft. El{" "}
        <strong>Client ID / Secret</strong> habilitan que cada cliente conecte su
        cuenta con un click (OAuth). El <strong>Access Token / Public Key</strong>{" "}
        son de tu cuenta y se usan para cobrar las suscripciones.
      </p>

      <Card className="mt-3">
        <CardContent className="grid max-w-2xl gap-4 p-5">
          <Input
            label="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="971231514820445"
          />
          <Input
            label="Client Secret"
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={status?.client_secret ? "•••••• (configurado)" : "Pegá el Client Secret"}
          />
          <Input
            label="Access Token (cuenta NinjaSoft)"
            type="password"
            autoComplete="off"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={status?.access_token ? "•••••• (configurado)" : "APP_USR-..."}
          />
          <Input
            label="Public Key"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="APP_USR-..."
          />
          <Input
            label="Redirect URI (OAuth)"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="https://tu-dominio/api/mp/oauth/callback"
          />
          <p className="text-xs text-muted-foreground">
            La Redirect URI tiene que estar cargada idéntica en MP → Tu app →
            Redirect URIs.
          </p>
          <div className="flex items-center gap-3">
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Guardando…" : "Guardar"}
            </Button>
            {status?.updated_at && (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <Check size={13} /> Actualizado{" "}
                {new Date(status.updated_at).toLocaleString("es-AR")}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
