"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { appOrigin } from "@/lib/site";
import {
  PlatformMpPanel,
  type MpPlatformStatus,
  type MpTestResult,
  type MpWebhookStats,
  type SaveResult,
} from "@/components/internal/payments/PlatformMpPanel";
import type { MpCredentialField } from "@/supabase/functions/_shared/mpCredentials";

// Credenciales globales de Mercado Pago de NinjaSoft (F20-0b · H126).
// Lee y guarda por la Edge set_platform_secret (service_role sólo ahí): los
// secretos nunca vuelven al navegador, sólo "guardada" y los últimos 4
// caracteres. La validación de formato corre acá (aviso) y en la Edge
// (barrera real).
export function PlatformMpCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const [test, setTest] = useState<MpTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const { data: status, isLoading, isError, refetch } = useQuery({
    queryKey: ["platform-mp-status"],
    queryFn: async (): Promise<MpPlatformStatus | null> => {
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: "mercadopago", action: "status" },
      });
      if (error) throw error;
      return (data as { status?: MpPlatformStatus })?.status ?? null;
    },
  });

  // Últimos eventos del webhook de suscripciones (webhook_events, ADR-070).
  const { data: webhook } = useQuery({
    queryKey: ["platform-mp-webhook-stats"],
    queryFn: async (): Promise<MpWebhookStats> => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const [last, day] = await Promise.all([
        supabase
          .from("webhook_events")
          .select("created_at")
          .eq("function_name", "mp_billing_webhook")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("webhook_events")
          .select("status, error, created_at")
          .eq("function_name", "mp_billing_webhook")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);
      const rows = (day.data ?? []) as { status: string; error: string | null }[];
      const errs = rows.filter((r) => r.status === "error");
      return {
        lastAt: (last.data as { created_at?: string } | null)?.created_at ?? null,
        total24h: rows.length,
        errors24h: errs.length,
        lastError: errs[0]?.error ?? null,
      };
    },
  });

  const { data: activeMpSubs } = useQuery({
    queryKey: ["platform-mp-active-subs"],
    queryFn: async (): Promise<number | null> => {
      const { count, error } = await supabase
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .not("mp_preapproval_id", "is", null);
      return error ? null : (count ?? 0);
    },
  });

  async function onSave(fields: Partial<Record<MpCredentialField, string>>): Promise<SaveResult> {
    const { data, error } = await supabase.functions.invoke("set_platform_secret", {
      body: { key: "mercadopago", secrets: fields },
    });
    let body = (data ?? null) as { error?: string; fields?: Partial<Record<MpCredentialField, string>> } | null;
    if (error) {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        try {
          body = (await ctx.json()) as typeof body;
        } catch {
          /* cuerpo no JSON */
        }
      }
    }
    if (body?.error === "invalid_format" && body.fields) return { fieldErrors: body.fields };
    if (error || body?.error) throw new Error(body?.error ?? "save_failed");
    await qc.invalidateQueries({ queryKey: ["platform-mp-status"] });
    if (fields.access_token) setTest(null);
  }

  async function onTest() {
    setTesting(true);
    try {
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: "mercadopago", action: "test" },
      });
      const r = (data ?? {}) as Omit<MpTestResult, "at">;
      setTest({ ...r, ok: !error && r.ok === true, error: error ? "mp_unreachable" : r.error, at: new Date().toISOString() });
    } finally {
      setTesting(false);
    }
  }

  return (
    <PlatformMpPanel
      status={status ?? null}
      loading={isLoading}
      loadError={isError}
      onRetry={() => void refetch()}
      test={test}
      testing={testing}
      webhook={webhook ?? null}
      activeMpSubscriptions={activeMpSubs ?? null}
      webhookUrl={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/mp_billing_webhook`}
      redirectUri={`${appOrigin()}/api/mp/oauth/callback`}
      onSave={onSave}
      onTest={onTest}
    />
  );
}
