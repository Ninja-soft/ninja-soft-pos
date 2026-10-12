"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PaymentPlansGridModal } from "@/components/dashboard-team/PaymentPlansGridModal";
import { createClient } from "@/lib/supabase/client";
import { withDefaultMethods } from "@/lib/payments/defaults";
import { useToast } from "@/components/ui/Toast";
import { useGating, useGlobalPlansForUpgrade } from "@/modules/saas/gating";
import { usePaymentPlans } from "@/modules/pos/hooks";
import { summarizePlans } from "@/modules/pos/planConstants";
import {
  BRAND_BY_KEY,
  SANDBOX_PROVIDERS,
  connectionKeyOf,
  groupProvidersByBrand,
  type ProviderRow,
} from "@/lib/payments/catalog";
import { PaymentMethodsView } from "@/components/dashboard-team/payments/PaymentMethodsView";
import {
  ConnectProviderModal,
  type ConnectSave,
} from "@/components/dashboard-team/payments/ConnectProviderModal";
import { MpQrPosSetup } from "@/components/dashboard-team/payments/MpQrPosSetup";
import { DirectoInfo } from "@/components/dashboard-team/payments/DirectoInfo";
import type { Method, MpEnvChange } from "@/components/dashboard-team/payments/types";

// Configuración de medios de pago, agrupada por marca → canal (QR + link ·
// Point). Este componente sólo trae datos y guarda; la vista vive en
// components/dashboard-team/payments/*. PROVIDER_FEATURE decide qué canal se
// puede ACTIVAR acá; el bloqueo real es el trigger de payments + las Edge.

async function invokeSecret(body: Record<string, unknown>) {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("set_payment_secret", { body });
  if (error) throw error;
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
}

export function PaymentMethodsCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [connectBrand, setConnectBrand] = useState<string | null>(null);
  const [plansFor, setPlansFor] = useState<{ key: string; name: string } | null>(null);

  // Resultado del redirect del OAuth de Mercado Pago (?mp=ok|err|denied).
  useEffect(() => {
    const mp = searchParams.get("mp");
    if (!mp) return;
    if (mp === "ok") toast({ title: "Mercado Pago conectado", variant: "success" });
    else if (mp === "denied") toast({ title: "Conexión cancelada", variant: "error" });
    else toast({ title: "No se pudo conectar Mercado Pago", variant: "error" });
    qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
    router.replace("/configuracion");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const { data: ctx } = useQuery({
    queryKey: ["my-payments-ctx"],
    queryFn: async (): Promise<{ tenantId: string; canManage: boolean } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return { tenantId: mem.tenant_id, canManage: ["owner", "manager"].includes(mem.role) };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  // brand/channel pueden no existir todavía en la base (migración
  // 20261011150000): si el select falla, se reintenta sin ellas y la UI usa el
  // mapeo local de lib/payments/catalog.
  const { data: providers = [] } = useQuery({
    queryKey: ["payment-providers"],
    queryFn: async (): Promise<ProviderRow[]> => {
      const full = await supabase
        .from("payment_providers")
        .select("key, name, kind, sort, brand, channel")
        .eq("is_active", true)
        .order("sort");
      if (!full.error) return (full.data ?? []) as ProviderRow[];
      const { data } = await supabase
        .from("payment_providers")
        .select("key, name, kind, sort")
        .eq("is_active", true)
        .order("sort");
      return (data ?? []) as ProviderRow[];
    },
  });

  const { data: methods = [] } = useQuery({
    queryKey: ["tenant-payment-methods", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<Method[]> => {
      const { data } = await supabase
        .from("tenant_payment_methods")
        .select("provider_key, enabled, sandbox, surcharge_pct, config")
        .eq("tenant_id", tenantId);
      // Efectivo y transferencia sin fila cuentan como prendidos, igual que
      // en el POS (lib/payments/defaults).
      return withDefaultMethods((data ?? []) as Method[], (provider_key) => ({
        provider_key,
        enabled: true,
        sandbox: false,
        surcharge_pct: 0,
        config: null,
      }));
    },
  });

  const byKey = useMemo(() => {
    const m = new Map<string, Method>();
    methods.forEach((x) => m.set(x.provider_key, x));
    return m;
  }, [methods]);

  const { data: gating } = useGating();
  // Planes de cuotas activos por medio: cantidad + tarjetas en cada canal.
  const { data: activePlans } = usePaymentPlans(null);
  const planSummary = useMemo(() => summarizePlans(activePlans ?? []), [activePlans]);
  const { data: plans = [] } = useGlobalPlansForUpgrade();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["tenant-payment-methods", tenantId] });

  const upsertMethod = async (key: string, patch: Partial<Pick<Method, "enabled" | "sandbox" | "surcharge_pct">>) => {
    const cur = byKey.get(key);
    const { error } = await supabase.from("tenant_payment_methods").upsert(
      {
        tenant_id: tenantId,
        provider_key: key,
        enabled: patch.enabled ?? cur?.enabled ?? false,
        sandbox: patch.sandbox ?? cur?.sandbox ?? true,
        surcharge_pct: patch.surcharge_pct ?? cur?.surcharge_pct ?? 0,
      },
      { onConflict: "tenant_id,provider_key" },
    );
    if (error) throw error;
  };

  const save = useMutation({
    mutationFn: (v: { key: string; enabled?: boolean; surcharge_pct?: number }) =>
      upsertMethod(v.key, { enabled: v.enabled, surcharge_pct: v.surcharge_pct }),
    onSuccess: invalidate,
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  // OAuth: pide la URL de autorización y redirige a Mercado Pago.
  const oauthStart = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("mp_oauth_start", { body: {} });
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

  if (!ctx || !ctx.canManage) return null;

  const brand = connectBrand ? BRAND_BY_KEY[connectBrand] : undefined;
  const connKey = connectBrand ? connectionKeyOf(connectBrand) : null;
  const connectChannels = connectBrand
    ? (groupProvidersByBrand(providers)
        .find((g) => g.brand.key === connectBrand)
        ?.channels.filter((c) => c.implemented) ?? [])
    : [];
  const channelNames = connectChannels.map((c) =>
    c.channel === "point" ? "la terminal Point" : c.channel === "manual" ? "la terminal sin integrar" : "QR y link",
  );
  const channelKeys = connectChannels.map((c) => c.key);

  // Guarda credenciales (y el ambiente elegido, en proveedores con prueba real).
  const saveConnection = async (key: string, v: ConnectSave) => {
    await invokeSecret({ provider_key: key, secrets: v.secrets ?? { access_token: v.token } });
    if (v.env && SANDBOX_PROVIDERS.has(key)) await upsertMethod(key, { sandbox: v.env === "test" });
    await invalidate();
  };

  // MP: token de prueba (sin pisar producción) y ambiente (ADR-032).
  const changeMpEnv = async (v: MpEnvChange) => {
    if (v.testToken || v.clearTest) {
      await invokeSecret({
        provider_key: "mercadopago",
        merge: true,
        secrets: v.testToken ? { test_access_token: v.testToken } : {},
        remove: v.clearTest ? ["test_access_token"] : [],
      });
    }
    await upsertMethod("mercadopago", { sandbox: v.env === "test" });
    toast({
      title: v.env === "test" ? "Mercado Pago en modo prueba" : "Mercado Pago en producción",
      variant: "success",
    });
    await invalidate();
  };

  return (
    <>
      <PaymentMethodsView
        providers={providers}
        methods={methods}
        features={gating?.features}
        plans={plans}
        planSummary={planSummary}
        handlers={{
          onToggle: (key, enabled) => save.mutate({ key, enabled }),
          onSurcharge: (key, pct) => save.mutate({ key, surcharge_pct: pct }),
          onOpenPlans: (key, name) => setPlansFor({ key, name }),
          onConnect: (b) => setConnectBrand(b),
          renderChannelExtra: (key, m) =>
            key === "mercadopago" && m?.config?.connected ? (
              <MpQrPosSetup
                method={m}
                onReconnect={() => setConnectBrand("mercadopago")}
                onOpenPlans={() => setPlansFor({ key: "mercadopago", name: "Mercado Pago" })}
              />
            ) : key === "directo" ? (
              <DirectoInfo connected={Boolean(m?.config?.connected)} onConnect={() => setConnectBrand("directo")} />
            ) : null,
        }}
      />

      {brand && connKey && (
        <ConnectProviderModal
          open
          onOpenChange={(o) => !o && setConnectBrand(null)}
          brand={brand}
          providerKey={connKey}
          method={byKey.get(connKey)}
          channelNames={channelNames}
          channelKeys={channelKeys}
          onSave={(v) => saveConnection(connKey, v)}
          onDisconnect={async () => {
            await invokeSecret({ provider_key: connKey, action: "clear" });
            await invalidate();
          }}
          onOAuth={connKey === "mercadopago" ? () => oauthStart.mutate() : undefined}
          oauthPending={oauthStart.isPending}
          onMpEnv={connKey === "mercadopago" ? changeMpEnv : undefined}
        />
      )}

      {/* Planes (cuotas por tarjeta + recargo). Se abren desde el canal que
          los usa; se guardan con su provider_key (MP: 'mercadopago'). */}
      {plansFor && (
        <PaymentPlansGridModal
          open
          onOpenChange={(o) => !o && setPlansFor(null)}
          providerKey={plansFor.key}
          providerName={plansFor.name}
        />
      )}
    </>
  );
}
