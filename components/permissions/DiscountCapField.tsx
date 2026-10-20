"use client";

// F24 · H159 (ADR-172): tope de descuento manual propio de una persona. Se
// suma al del rol (manda el menor). Vacío = el de su rol. Lo controla el
// servidor al cerrar la venta (discount_exceeds_user_limit).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { parseDiscountCap } from "@/lib/permissions/discountCap";

export function DiscountCapField({ userId }: { userId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = ["permissions", "discount-cap", userId];
  const { data, isFetched } = useQuery({
    queryKey: key,
    queryFn: async (): Promise<number | null> => {
      const { data: row, error } = await createClient()
        .from("tenant_users")
        .select("max_discount_pct" as never)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) return null;
      const v = (row as { max_discount_pct?: number | null } | null)?.max_discount_pct;
      return v === null || v === undefined ? null : Number(v);
    },
  });
  const [value, setValue] = useState("");
  useEffect(() => {
    if (isFetched) setValue(data === null || data === undefined ? "" : String(data));
  }, [isFetched, data]);
  const save = useMutation({
    mutationFn: async (pct: number | null) => {
      const { error } = await createClient().rpc("team_set_discount_cap" as never, { p_user_id: userId, p_pct: pct } as never);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const parsed = parseDiscountCap(value);
  const dirty = isFetched && parsed.ok && parsed.value !== (data ?? null);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <Input
          label="Tope de descuento propio (%)"
          inputMode="decimal"
          placeholder="El de su rol"
          value={value}
          error={parsed.ok ? undefined : "Entre 0 y 100"}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Si lo cargás, puede descontar como máximo esto aunque su rol permita más. Vacío: el de su rol.
        </p>
      </div>
      <Button
        variant="secondary"
        disabled={!dirty}
        loading={save.isPending}
        onClick={async () => {
          if (!parsed.ok) return;
          try {
            await save.mutateAsync(parsed.value);
            toast({ title: "Tope de descuento guardado", variant: "success" });
          } catch {
            toast({ title: "No se pudo guardar el tope", variant: "error" });
          }
        }}
      >
        Guardar
      </Button>
    </div>
  );
}
