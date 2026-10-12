"use client";

// Conectar Mercado Pago desde la conciliación (ADR-061): el mismo asistente
// de Medios de pago (ConnectProviderModal) con OAuth o token manual de la
// credencial del negocio. Las credenciales por sucursal y el ambiente de
// prueba se siguen administrando en Configuración, Medios de pago.

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { BRAND_BY_KEY } from "@/lib/payments/catalog";
import { useToast } from "@/components/ui/Toast";
import { ConnectProviderModal, type ConnectSave } from "@/components/dashboard-team/payments/ConnectProviderModal";
import type { Method } from "@/components/dashboard-team/payments/types";

async function invokeSecret(body: Record<string, unknown>) {
  const { data, error } = await createClient().functions.invoke("set_payment_secret", { body });
  if (error) throw error;
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
}

export function MpConnectModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: method } = useQuery({
    queryKey: ["settlements", "mp-method"],
    enabled: open,
    queryFn: async (): Promise<Method | undefined> => {
      const tenantId = await getCurrentTenantId();
      if (!tenantId) return undefined;
      const { data } = await createClient()
        .from("tenant_payment_methods")
        .select("provider_key, enabled, sandbox, surcharge_pct, config")
        .eq("tenant_id", tenantId)
        .eq("provider_key", "mercadopago")
        .maybeSingle();
      return (data as Method | null) ?? undefined;
    },
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["settlements"] });
    await qc.invalidateQueries({ queryKey: ["pos", "payment-methods-status"] });
    await qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
  };
  const oauth = useMutation({
    mutationFn: async () => {
      const { data, error } = await createClient().functions.invoke("mp_oauth_start", { body: {} });
      if (error) throw error;
      const res = data as { url?: string; error?: string };
      if (res?.error || !res?.url) throw new Error(res?.error ?? "no_url");
      return res.url;
    },
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: (e: Error) =>
      toast({
        title:
          e.message === "platform_not_configured"
            ? "Mercado Pago no está configurado por NinjaSoft todavía"
            : "No se pudo iniciar la conexión",
        variant: "error",
      }),
  });
  const brand = BRAND_BY_KEY.mercadopago;
  if (!open || !brand) return null;
  return (
    <ConnectProviderModal
      open={open}
      onOpenChange={onOpenChange}
      brand={brand}
      providerKey="mercadopago"
      method={method}
      channelNames={["QR y link", "la terminal Point", "la conciliación"]}
      channelKeys={["mercadopago", "mercadopago_point"]}
      onSave={async (v: ConnectSave) => {
        await invokeSecret({ provider_key: "mercadopago", secrets: v.secrets ?? { access_token: v.token } });
        await refresh();
      }}
      onDisconnect={async () => {
        await invokeSecret({ provider_key: "mercadopago", action: "clear" });
        await refresh();
      }}
      onOAuth={() => oauth.mutate()}
      oauthPending={oauth.isPending}
    />
  );
}
