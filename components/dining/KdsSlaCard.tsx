"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useKdsSla, useSaveKdsSla } from "@/modules/dining/hooks";
import { KDS_STATIONS, KDS_STATION_LABELS } from "@/modules/dining/api";
import {
  KDS_SLA_FALLBACK,
  KdsSlaRuleSchema,
  type KdsSlaConfig,
} from "@/lib/gastro/kdsSla";

type Row = { warn: string; late: string };
const KEYS = ["default", ...KDS_STATIONS] as const;

function label(key: string): string {
  return key === "default" ? "Todas las estaciones" : KDS_STATION_LABELS[key as keyof typeof KDS_STATION_LABELS] ?? key;
}

// SLA del KDS por estación (F13 · H46): a qué minuto la tarjeta pasa a "atención"
// y a "demorado". Vacío = hereda de "Todas las estaciones" (y ésta, de 5/10).
// Lo guarda sólo el dueño (RLS de pos_settings) y la DB valida la forma.
export function KdsSlaCard() {
  const { toast } = useToast();
  const { data } = useKdsSla();
  const save = useSaveKdsSla();
  const [rows, setRows] = useState<Record<string, Row>>({});

  useEffect(() => {
    const next: Record<string, Row> = {};
    for (const k of KEYS) {
      const r = data?.[k];
      next[k] = { warn: r ? String(r.warn) : "", late: r ? String(r.late) : "" };
    }
    setRows(next);
  }, [data]);

  function set(key: string, field: keyof Row, value: string) {
    setRows((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { warn: "", late: "" }), [field]: value } }));
  }

  // Valida fila por fila: vacía = hereda; a medias o inválida = error.
  const errors: Record<string, string> = {};
  const config: KdsSlaConfig = {};
  for (const k of KEYS) {
    const r = rows[k];
    if (!r || (r.warn.trim() === "" && r.late.trim() === "")) continue;
    const parsed = KdsSlaRuleSchema.safeParse({ warn: Number(r.warn), late: Number(r.late) });
    if (parsed.success) config[k] = parsed.data;
    else errors[k] = "Minutos enteros de 1 a 240, el aviso antes que la demora";
  }
  const hasErrors = Object.keys(errors).length > 0;

  async function onSave() {
    if (hasErrors) return;
    try {
      await save.mutateAsync(config);
      toast({ title: "Tiempos de cocina guardados", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudieron guardar",
        description: e instanceof Error ? e.message : "Sólo el dueño puede cambiar estos tiempos",
        variant: "error",
      });
    }
  }

  const inherited = config.default ?? KDS_SLA_FALLBACK;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Timer size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div>
          <h3 className="text-base font-semibold">Tiempos de cocina (KDS)</h3>
          <p className="text-sm text-muted-foreground">
            A qué minuto una tarjeta pasa a atención y a demorada, por estación. Vacío usa el de
            todas las estaciones ({inherited.warn} y {inherited.late} min).
          </p>
        </div>
      </div>

      <div className="divide-y divide-border">
        <div className="grid grid-cols-[1fr_4.5rem_4.5rem] gap-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>Estación</span>
          <span>Atención</span>
          <span>Demora</span>
        </div>
        {KEYS.map((k) => (
          <div key={k} className="py-2">
            <div className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2">
              <span className="text-sm">{label(k)}</span>
              <input
                inputMode="numeric"
                aria-label={`Minutos de atención · ${label(k)}`}
                value={rows[k]?.warn ?? ""}
                placeholder={k === "default" ? String(KDS_SLA_FALLBACK.warn) : String(inherited.warn)}
                onChange={(e) => set(k, "warn", e.target.value.replace(/\D/g, ""))}
                className="h-11 w-full rounded-md border border-border bg-background px-2 text-center text-sm tabular-nums outline-none focus:border-foreground"
              />
              <input
                inputMode="numeric"
                aria-label={`Minutos de demora · ${label(k)}`}
                value={rows[k]?.late ?? ""}
                placeholder={k === "default" ? String(KDS_SLA_FALLBACK.late) : String(inherited.late)}
                onChange={(e) => set(k, "late", e.target.value.replace(/\D/g, ""))}
                className="h-11 w-full rounded-md border border-border bg-background px-2 text-center text-sm tabular-nums outline-none focus:border-foreground"
              />
            </div>
            {errors[k] && <p className="mt-1 text-xs text-danger">{errors[k]}</p>}
          </div>
        ))}
      </div>

      <Button onClick={onSave} disabled={hasErrors || save.isPending} loading={save.isPending}>
        Guardar tiempos
      </Button>
    </div>
  );
}
