"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Info, Printer, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import {
  clampPrintCopies,
  defaultPrintProfiles,
  FONT_LABELS,
  MARGIN_LABELS,
  normalizePrintProfiles,
  PAPER_LABELS,
  PRINT_DOC_META,
  PRINT_DOC_TYPES,
  type PrintDocType,
  type PrintFont,
  type PrintMargin,
  type PrintPaper,
  type PrintProfile,
  type PrintProfiles,
} from "@/lib/print/profiles";

// Configuración avanzada de impresión por TIPO DE DOCUMENTO (F10 · H22).
// Owner/manager configuran, por cada tipo (ticket de venta, cierre Z, movimiento
// de caja, etiqueta, devolución): formato/destino, copias, impresión automática
// vs manual y ajustes básicos (fuente/margen). Se guarda en
// pos_settings.print_profiles (jsonb). El POS lo respeta al imprimir.
//
// La columna print_profiles aún no está en los tipos generados (no se
// regeneran): se castea el payload.

const numCls =
  "h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft";

export function PrintSettingsCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: ctx } = useQuery({
    queryKey: ["print-settings-ctx"],
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
      return {
        tenantId: mem.tenant_id,
        canManage: ["owner", "manager"].includes(mem.role),
      };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useQuery({
    queryKey: ["print-settings", tenantId],
    enabled: !!tenantId && (ctx?.canManage ?? false),
    queryFn: async (): Promise<PrintProfiles> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("print_profiles")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const raw = (data as { print_profiles?: unknown } | null)?.print_profiles;
      return normalizePrintProfiles(raw);
    },
  });

  const [profiles, setProfiles] = useState<PrintProfiles>(defaultPrintProfiles);

  useEffect(() => {
    if (settings) setProfiles(settings);
  }, [settings]);

  function patch(type: PrintDocType, p: Partial<PrintProfile>) {
    setProfiles((prev) => ({ ...prev, [type]: { ...prev[type], ...p } }));
  }

  const save = useMutation({
    mutationFn: async () => {
      // Normalizamos de nuevo antes de persistir (clamp de copias, papel válido
      // por tipo): el server guarda jsonb tal cual, así que saneamos en el cliente.
      const clean = normalizePrintProfiles(profiles);
      const { error } = await supabase.from("pos_settings").upsert(
        { tenant_id: tenantId, print_profiles: clean } as never,
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["print-settings", tenantId] });
      // El POS/Caja/Devoluciones leen estos perfiles vía usePrintProfiles:
      // refrescá para que tomen el cambio sin recargar.
      qc.invalidateQueries({ queryKey: ["print-profiles"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!ctx || !ctx.canManage) return null;

  return (
    <section className="space-y-4">
      <div>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <Printer size={18} /> Impresión
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Configurá, por tipo de comprobante, cómo se imprime: formato, copias y
          si sale solo al confirmar (automático) o con un botón (manual). El punto
          de venta lo respeta al cobrar, al cerrar caja y al hacer devoluciones.
        </p>
      </div>

      {/* Límite actual + qué queda para más adelante. Honesto: hoy es web print. */}
      <Card>
        <CardContent className="space-y-2 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Info size={16} className="text-ninja-flameSoft" /> Cómo imprime hoy
          </div>
          <p className="text-sm text-muted-foreground">
            La impresión usa el diálogo del navegador (web print): sale por la
            impresora que elijas en el sistema y sirve para térmica (58/80 mm) y
            para hoja A4 / PDF. No hay corte de papel ni apertura de cajón por
            software.
          </p>
          <p className="text-xs text-muted-foreground">
            Próximamente: impresión directa a térmicas USB/red por conector local
            (ESC/POS), cola de impresión con reintentos y perfiles distintos por
            sucursal y por caja. Hoy esta configuración es por negocio.
          </p>
        </CardContent>
      </Card>

      {/* Un bloque por tipo de documento. */}
      {PRINT_DOC_TYPES.map((type) => (
        <DocTypeCard
          key={type}
          type={type}
          profile={profiles[type]}
          onPatch={(p) => patch(type, p)}
        />
      ))}

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </section>
  );
}

function DocTypeCard({
  type,
  profile,
  onPatch,
}: {
  type: PrintDocType;
  profile: PrintProfile;
  onPatch: (p: Partial<PrintProfile>) => void;
}) {
  const meta = PRINT_DOC_META[type];
  const paperOptions = meta.papers.map((p) => ({
    value: p,
    label: p === "a4" ? "A4" : `${p}mm`,
  }));

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <Printer size={16} className="text-ninja-flameSoft" /> {meta.label}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{meta.description}</p>
        </div>

        {/* Formato / destino */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">Formato</div>
            <div className="text-xs text-muted-foreground">
              {PAPER_LABELS[profile.paper]}
            </div>
          </div>
          <Segmented
            value={profile.paper}
            options={paperOptions}
            onChange={(v) => onPatch({ paper: v as PrintPaper })}
          />
        </div>

        {/* Copias */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="flex items-center gap-1.5 font-medium">
              <Copy size={14} className="text-muted-foreground" /> Copias
            </div>
            <div className="text-xs text-muted-foreground">
              Cuántas veces se imprime cada comprobante (1 a 20).
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={profile.copies}
            onChange={(e) => onPatch({ copies: Number(e.target.value) || 1 })}
            onBlur={() => onPatch({ copies: clampPrintCopies(profile.copies) })}
            className={numCls}
          />
        </div>

        {/* Auto vs manual */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="flex items-center gap-1.5 font-medium">
              <Zap size={14} className="text-muted-foreground" /> Impresión automática
            </div>
            <div className="text-xs text-muted-foreground">
              Activado: se imprime solo al confirmar. Desactivado: aparece un
              botón para imprimir cuando quieras.
            </div>
          </div>
          <Switch
            checked={profile.auto}
            onCheckedChange={(v) => onPatch({ auto: v })}
            label={`Imprimir ${meta.label} automáticamente al confirmar`}
          />
        </div>

        {/* Ajustes básicos: fuente + margen */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="text-sm">
            <div className="mb-1.5 font-medium">Tamaño de fuente</div>
            <Segmented
              value={profile.font}
              options={(Object.keys(FONT_LABELS) as PrintFont[]).map((f) => ({
                value: f,
                label: FONT_LABELS[f],
              }))}
              onChange={(v) => onPatch({ font: v as PrintFont })}
            />
          </div>
          <div className="text-sm">
            <div className="mb-1.5 font-medium">Margen</div>
            <Segmented
              value={profile.margin}
              options={(Object.keys(MARGIN_LABELS) as PrintMargin[]).map((m) => ({
                value: m,
                label: MARGIN_LABELS[m],
              }))}
              onChange={(v) => onPatch({ margin: v as PrintMargin })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
