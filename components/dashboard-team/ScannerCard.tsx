"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanLine, Sparkles, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { useScanner, type ScanInfo } from "@/modules/pos/useScanner";

type ScannerSettings = {
  scanner_prefix: string;
  scanner_suffix: string;
  scanner_beep: boolean;
  scanner_dup_ms: number;
};

const DEFAULTS: ScannerSettings = {
  scanner_prefix: "",
  scanner_suffix: "",
  scanner_beep: true,
  scanner_dup_ms: 1500,
};

const monoCls =
  "h-9 w-44 rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus:border-ninja-flameSoft";
const numCls =
  "h-9 w-28 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft";

type Capture = ScanInfo & { at: number };

export function ScannerCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: ctx } = useQuery({
    queryKey: ["scanner-settings-ctx"],
    queryFn: async (): Promise<{ tenantId: string; role: string } | null> => {
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
      return { tenantId: mem.tenant_id, role: mem.role };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useQuery({
    queryKey: ["scanner-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<ScannerSettings> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("scanner_prefix, scanner_suffix, scanner_beep, scanner_dup_ms")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      return (data as ScannerSettings) ?? DEFAULTS;
    },
  });

  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [beep, setBeep] = useState(true);
  const [dupMs, setDupMs] = useState(1500);

  useEffect(() => {
    if (!settings) return;
    setPrefix(settings.scanner_prefix ?? "");
    setSuffix(settings.scanner_suffix ?? "");
    setBeep(settings.scanner_beep ?? true);
    setDupMs(settings.scanner_dup_ms ?? 1500);
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("pos_settings").upsert(
        {
          tenant_id: tenantId,
          scanner_prefix: prefix,
          scanner_suffix: suffix,
          scanner_beep: beep,
          scanner_dup_ms: Math.max(0, Number(dupMs) || 0),
        },
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["scanner-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["pos", "settings"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  // Diagnóstico: usa la configuración GUARDADA (no la edición en curso) para
  // reflejar cómo se comportará el lector en el POS.
  const [captures, setCaptures] = useState<Capture[]>([]);
  useScanner(
    () => {
      // El onScan real no hace nada acá: solo nos interesa el diagnóstico.
    },
    {
      prefix: settings?.scanner_prefix ?? "",
      suffix: settings?.scanner_suffix ?? "",
      beep: settings?.scanner_beep ?? true,
      dupMs: settings?.scanner_dup_ms ?? 1500,
      onRaw: (info) =>
        setCaptures((prev) => [{ ...info, at: Date.now() }, ...prev].slice(0, 10)),
    },
  );

  if (!ctx || ctx.role !== "owner") return null;

  return (
    <section className="space-y-4">
      <div>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <ScanLine size={18} /> Escáner
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Perfil del lector de código de barras: limpieza de prefijo/sufijo, beep
          de confirmación y anti-duplicado.
        </p>
      </div>

      {/* Ajustes */}
      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                Prefijo a quitar
              </span>
              <input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="Ej. ]C1"
                className={monoCls}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                Sufijo a quitar
              </span>
              <input
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                placeholder="Ej. \\r"
                className={monoCls}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Algunos lectores agregan caracteres fijos al inicio o al final de cada
            lectura. Si los configurás acá, se eliminan antes de buscar el producto.
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <div className="font-semibold">Beep de confirmación</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Sonido corto al aceptar una lectura.
              </p>
            </div>
            <Switch
              checked={beep}
              onCheckedChange={setBeep}
              label="Beep de confirmación"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <div className="font-semibold">Anti-duplicado (ms)</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Ignora la misma lectura repetida dentro de esta ventana. 0 = sin
                anti-duplicado.
              </p>
            </div>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={100}
                value={dupMs}
                onChange={(e) => setDupMs(Number(e.target.value) || 0)}
                className={numCls}
              />
              <span className="text-sm text-muted-foreground">ms</span>
            </span>
          </div>

          <div className="flex justify-end">
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Guardando…" : "Guardar cambios"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Diagnóstico */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Sparkles size={16} className="text-ninja-flameSoft" /> Probá tu
                lector acá
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Escaneá un producto: no hace falta hacer clic en ningún campo. Se
                muestran las últimas 10 lecturas con la configuración guardada.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCaptures([])}
              disabled={captures.length === 0}
            >
              <Trash2 size={14} className="mr-1" /> Limpiar
            </Button>
          </div>

          <div className="mt-4 overflow-x-auto">
            {captures.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Esperando lecturas…
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Hora</th>
                    <th className="py-2 pr-3 font-medium">Código</th>
                    <th className="py-2 pr-3 font-medium">Crudo</th>
                    <th className="py-2 pr-3 text-right font-medium">Largo</th>
                    <th className="py-2 pr-3 text-right font-medium">Dur. ms</th>
                    <th className="py-2 pr-3 text-right font-medium">Gap prom.</th>
                    <th className="py-2 pr-3 font-medium">Formato</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {captures.map((c, i) => (
                    <tr key={c.at + "-" + i} className="border-b border-border/60">
                      <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                        {new Date(c.at).toLocaleTimeString("es-AR")}
                      </td>
                      <td className="py-2 pr-3 font-mono">{c.code}</td>
                      <td className="py-2 pr-3 font-mono text-muted-foreground">
                        {c.raw !== c.code ? c.raw : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {c.length}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {Math.round(c.durationMs)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {c.avgGapMs ? c.avgGapMs.toFixed(1) : "0"}
                      </td>
                      <td className="py-2 pr-3">{c.format}</td>
                      <td className="py-2">
                        {c.duplicate && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
                            duplicado
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
