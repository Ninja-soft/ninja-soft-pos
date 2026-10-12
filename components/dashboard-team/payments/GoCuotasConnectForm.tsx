"use client";

// Conexión de GO Cuotas (ADR-033): API Key de la sucursal + ambiente.
// Standalone: guarda el secreto vía set_payment_secret (provider 'gocuotas',
// { api_key }) y el ambiente en tenant_payment_methods.sandbox, que la Edge
// `gocuotas` usa para elegir sandbox.gocuotas.com o www.gocuotas.com.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";

type Env = "prod" | "test";

export interface GoCuotasConnectFormProps {
  tenantId: string;
  connected: boolean;
  // Ambiente actual del medio (tenant_payment_methods.sandbox).
  sandbox?: boolean;
  // Estado actual de la fila del medio, para no pisarlo al guardar el ambiente.
  enabled?: boolean;
  surchargePct?: number;
  onDone?: () => void;
}

export function GoCuotasConnectForm({
  tenantId,
  connected,
  sandbox = false,
  enabled = false,
  surchargePct = 0,
  onDone,
}: GoCuotasConnectFormProps) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState("");
  const [env, setEnv] = useState<Env>(sandbox ? "test" : "prod");

  const save = useMutation({
    mutationFn: async (clear: boolean) => {
      const body = clear
        ? { provider_key: "gocuotas", action: "clear" }
        : { provider_key: "gocuotas", secrets: { api_key: apiKey.trim() } };
      const { data, error } = await supabase.functions.invoke("set_payment_secret", { body });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      if (!clear) {
        const { error: upErr } = await supabase.from("tenant_payment_methods").upsert(
          {
            tenant_id: tenantId,
            provider_key: "gocuotas",
            enabled,
            sandbox: env === "test",
            surcharge_pct: surchargePct,
          },
          { onConflict: "tenant_id,provider_key" },
        );
        if (upErr) throw upErr;
      }
    },
    onSuccess: (_d, clear) => {
      toast({ title: clear ? "GO Cuotas desconectado" : "GO Cuotas conectado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods", tenantId] });
      setApiKey("");
      onDone?.();
    },
    onError: () => toast({ title: "No se pudo guardar la conexión", variant: "error" }),
  });

  const envButton = (value: Env, label: string) => (
    <button
      type="button"
      onClick={() => setEnv(value)}
      aria-pressed={env === value}
      className={cn(
        "rounded-md px-3 py-2 text-xs transition",
        env === value
          ? value === "test"
            ? "bg-warning/15 font-semibold text-foreground"
            : "bg-ninja-flame/15 font-semibold text-foreground"
          : "bg-muted/50 text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      {connected ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check size={16} /> GO Cuotas está conectado.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Pegá la API Key de tu sucursal de GO Cuotas (panel de GO Cuotas: Sucursales, Editar,
          Ver ApiKeys de la sucursal). Se guarda cifrada del lado del servidor. El cliente paga
          en 2 a 4 cuotas sin interés con su débito; el cobro mínimo es de $1.500.
        </p>
      )}

      <Input
        label="API Key de la sucursal"
        type="password"
        name="gocuotas_api_key"
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={connected ? "•••••• (configurada)" : "Tu API Key"}
      />

      <div className="rounded-md bg-muted/40 p-3">
        <p className="text-xs font-semibold">¿De qué ambiente es esta API Key?</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {envButton("prod", "Producción (cobros reales)")}
          {envButton("test", "Prueba (sandbox)")}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          GO Cuotas muestra una API Key de producción y otra de prueba: usá la que coincida con
          el ambiente elegido.
        </p>
      </div>

      <Button
        className="w-full"
        loading={save.isPending && save.variables === false}
        disabled={save.isPending || apiKey.trim().length < 8}
        onClick={() => save.mutate(false)}
      >
        {connected ? "Actualizar API Key" : "Conectar GO Cuotas"}
      </Button>
      {connected && (
        <Button
          variant="ghost"
          className="w-full"
          loading={save.isPending && save.variables === true}
          disabled={save.isPending}
          onClick={() => save.mutate(true)}
        >
          Desconectar
        </Button>
      )}
    </div>
  );
}
GoCuotasConnectForm.displayName = "GoCuotasConnectForm";
