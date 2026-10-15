"use client";

import { FileText } from "lucide-react";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { useMlTemplates, type MlTemplate } from "@/modules/mercadolibre/gestorHooks";

// Plantillas de respuesta (H141 · ADR-132): elegir una completa el texto.
// Sin plantillas (o sin el gestor) no se muestra nada.
export function MlTemplatePicker({ scope, onPick, className }: { scope: MlTemplate["scope"]; onPick: (body: string) => void; className?: string }) {
  const { data: templates = [], isError } = useMlTemplates(scope);
  if (isError || templates.length === 0) return null;
  return (
    <label className={cn("flex items-center gap-2 text-xs", className)}>
      <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      <select
        className={cn(selectCls, "h-8 text-xs")}
        value=""
        aria-label="Usar una plantilla"
        onChange={(e) => {
          const t = templates.find((x) => x.id === e.target.value);
          if (t) onPick(t.body);
        }}
      >
        <option value="">Usar una plantilla</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
