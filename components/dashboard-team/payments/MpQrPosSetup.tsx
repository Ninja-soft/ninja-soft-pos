"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, QrCode } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { posApi } from "@/modules/pos/api";
import { MP_AR_STATES } from "@/supabase/functions/_shared/mpOrders";
import { mpEnvOf, type Method } from "./types";

// Caja QR de Mercado Pago (alta única por ambiente). Crea la sucursal y la caja
// en la cuenta de MP del negocio (Edge mp_qr setup) para cobrar con QR dinámico
// de la Orders API. Sin caja, el POS cobra con el QR del link de pago.
const MP_QR_ERRORS: Record<string, string> = {
  name: "Poné el nombre del local.",
  street_name: "Falta la calle.",
  street_number: "Falta la altura.",
  city_name: "Falta la ciudad o localidad.",
  state_name: "Elegí la provincia.",
  coordinates: "Pegá las coordenadas como las copia Google Maps (ej. -34.6037, -58.3816).",
};

export function MpQrPosSetup({ method }: { method: Method | undefined }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const env = mpEnvOf(method);
  const pos = method?.config?.mp_qr?.[env];
  const [editing, setEditing] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; msg: string } | null>(null);
  const [form, setForm] = useState({
    name: "",
    street_name: "",
    street_number: "",
    city_name: "",
    state_name: "",
    coordinates: "",
    reference: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    if (fieldError?.field === k) setFieldError(null);
  };
  const err = (k: string) => (fieldError?.field === k ? fieldError.msg : undefined);

  const setup = useMutation({
    mutationFn: () => posApi.mpQrSetup(form),
    onSuccess: () => {
      toast({ title: "Caja QR lista", variant: "success" });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
    },
    onError: (e: Error) => {
      const [code, field] = e.message.split(":");
      if (code === "invalid_store" && field && MP_QR_ERRORS[field]) {
        setFieldError({ field, msg: MP_QR_ERRORS[field]! });
        return;
      }
      toast({
        title:
          code === "payment_method_not_allowed"
            ? "Tu plan no incluye Mercado Pago."
            : "Mercado Pago no aceptó la sucursal o la caja. Revisá la dirección y probá de nuevo.",
        variant: "error",
      });
    },
  });

  if (pos && !editing) {
    return (
      <div className="flex items-start gap-3 rounded-xl bg-success/10 p-3">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-foreground">
            Caja QR lista{env === "test" ? " (prueba)" : ""}
          </p>
          <p className="text-muted-foreground">
            {pos.store_name}
            {pos.address ? `, ${pos.address}` : ""}. El POS genera un QR único por cobro.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          Cambiar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-3.5">
      <div className="flex items-start gap-2.5">
        <QrCode size={18} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
        <div className="text-sm">
          <p className="font-semibold">Caja QR en el local{env === "test" ? " (prueba)" : ""}</p>
          <p className="text-muted-foreground">
            Una sola vez: damos de alta tu local y una caja en tu cuenta de Mercado Pago. Mientras
            tanto, el POS cobra con el QR del link de pago.
          </p>
        </div>
      </div>
      <Input label="Nombre del local" value={form.name} onChange={set("name")} error={err("name")} />
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Input label="Calle" value={form.street_name} onChange={set("street_name")} error={err("street_name")} />
        </div>
        <Input label="Altura" value={form.street_number} onChange={set("street_number")} error={err("street_number")} />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input label="Ciudad o localidad" value={form.city_name} onChange={set("city_name")} error={err("city_name")} />
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Provincia</span>
          <select
            value={form.state_name}
            onChange={set("state_name")}
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Elegí</option>
            {MP_AR_STATES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
          {err("state_name") && <span className="mt-2 block text-sm text-destructive">{err("state_name")}</span>}
        </label>
      </div>
      <Input
        label="Coordenadas (de Google Maps)"
        value={form.coordinates}
        onChange={set("coordinates")}
        placeholder="-34.6037, -58.3816"
        error={err("coordinates")}
      />
      <Input
        label="Referencia (opcional)"
        value={form.reference}
        onChange={set("reference")}
        placeholder="Ej: local 2, entre calles"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={setup.isPending} onClick={() => setup.mutate()}>
          {!setup.isPending && <QrCode size={14} />} Crear caja QR
        </Button>
        {editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
        )}
      </div>
    </div>
  );
}
