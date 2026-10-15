"use client";

import { useEffect, useState } from "react";
import { FileText, Printer } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import {
  PAPER_SIZES,
  SHEET_PRESETS,
  THERMAL_PRESETS,
  fmtMm,
  labelsPerPage,
  mediaFromPreset,
  normalizeMedia,
  sheetMedia,
  thermalMedia,
  type MediaConfig,
  type MediaKind,
} from "@/lib/labels/media";
import type { ZplDpi } from "@/lib/labels/zpl";

export function MediaPanel({
  media,
  onMedia,
  skip,
  onSkip,
  dpi,
  onDpi,
}: {
  media: MediaConfig;
  onMedia: (m: MediaConfig) => void;
  skip: number;
  onSkip: (n: number) => void;
  dpi: ZplDpi;
  onDpi: (d: ZplDpi) => void;
}) {
  const patch = (p: Partial<MediaConfig>) => onMedia(normalizeMedia({ ...media, ...p, preset: "custom" }));
  const per = labelsPerPage(media);

  return (
    <div className="space-y-5">
      <Segmented<MediaKind>
        aria-label="Tipo de impresora"
        fill
        value={media.kind}
        onChange={(k) => {
          onSkip(0);
          onMedia(k === "thermal" ? thermalMedia(THERMAL_PRESETS[2]!) : sheetMedia(SHEET_PRESETS[0]!));
        }}
        options={[
          { value: "thermal", label: "Etiquetadora", icon: <Printer size={15} /> },
          { value: "sheet", label: "Hoja A4 / Carta", icon: <FileText size={15} /> },
        ]}
      />

      {media.kind === "thermal" ? (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Rollo</h3>
            <p className="text-xs text-muted-foreground">Zebra, Argox, Brother, Xprinter, 3nStar y compatibles.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tamaño de etiqueta">
              {THERMAL_PRESETS.map((p) => {
                const on = media.preset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onMedia(thermalMedia(p))}
                    className={cn(
                      "flex min-h-[64px] items-center gap-2.5 rounded-lg border p-2.5 text-left transition",
                      on ? "border-foreground bg-muted/60" : "border-border bg-card hover:border-muted-foreground",
                    )}
                  >
                    <SizeGlyph w={p.labelW} h={p.labelH} cols={p.cols} />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold">{p.label}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">{p.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Personalizado</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Num label="Ancho (mm)" value={media.labelW} onChange={(v) => patch({ labelW: v })} min={10} max={200} />
              <Num label="Alto (mm)" value={media.labelH} onChange={(v) => patch({ labelH: v })} min={10} max={300} />
              <Num label="Columnas" value={media.cols} onChange={(v) => patch({ cols: v })} min={1} max={4} step={1} />
              <Num label="Separación (mm)" value={media.gapX} onChange={(v) => patch({ gapX: v })} min={0} max={20} disabled={media.cols < 2} />
            </div>
            <p className="text-xs text-muted-foreground">Ancho del rollo: {fmtMm(media.pageW)} mm.</p>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">ZPL para Zebra</h3>
            <p className="text-xs text-muted-foreground">
              Si tu Zebra (o compatible) imprime desde la cola de este equipo o querés el archivo .zpl, elegí la resolución del cabezal.
            </p>
            <Segmented<"203" | "300">
              aria-label="Resolución"
              size="sm"
              value={String(dpi) as "203" | "300"}
              onChange={(v) => onDpi(Number(v) as ZplDpi)}
              options={[
                { value: "203", label: "203 dpi" },
                { value: "300", label: "300 dpi" },
              ]}
            />
          </section>
        </>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Hoja</h3>
            <select
              className={selectCls}
              aria-label="Grilla de la hoja"
              value={SHEET_PRESETS.some((p) => p.key === media.preset) ? media.preset : ""}
              onChange={(e) => {
                const m = mediaFromPreset(e.target.value);
                if (m) {
                  onSkip(0);
                  onMedia(m);
                }
              }}
            >
              <option value="">Personalizada</option>
              {SHEET_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} · {p.hint}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="col-span-2 block">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">Papel</span>
                <select
                  className={selectCls}
                  value={Object.entries(PAPER_SIZES).find(([, s]) => Math.abs(s.w - media.pageW) < 0.5 && Math.abs(s.h - media.pageH) < 0.5)?.[0] ?? "a4"}
                  onChange={(e) => {
                    const s = PAPER_SIZES[e.target.value as keyof typeof PAPER_SIZES];
                    patch({ pageW: s.w, pageH: s.h });
                  }}
                >
                  {Object.entries(PAPER_SIZES).map(([k, s]) => (
                    <option key={k} value={k}>
                      {s.label} ({fmtMm(s.w)} × {fmtMm(s.h)} mm)
                    </option>
                  ))}
                </select>
              </label>
              <Num label="Columnas" value={media.cols} onChange={(v) => patch({ cols: v })} min={1} max={10} step={1} />
              <Num label="Filas" value={media.rows} onChange={(v) => patch({ rows: v })} min={1} max={30} step={1} />
              <Num label="Margen lateral (mm)" value={media.marginX} onChange={(v) => patch({ marginX: v })} min={0} max={60} />
              <Num label="Margen sup./inf. (mm)" value={media.marginY} onChange={(v) => patch({ marginY: v })} min={0} max={60} />
              <Num label="Separación horiz. (mm)" value={media.gapX} onChange={(v) => patch({ gapX: v })} min={0} max={30} />
              <Num label="Separación vert. (mm)" value={media.gapY} onChange={(v) => patch({ gapY: v })} min={0} max={30} />
            </div>
            <p className="text-xs text-muted-foreground">
              Cada etiqueta queda de {fmtMm(media.labelW)} × {fmtMm(media.labelH)} mm · {per} por hoja.
            </p>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <span className="text-sm">Marcas de corte (para recortar con tijera o guillotina)</span>
              <Switch checked={media.cutMarks} onCheckedChange={(v) => onMedia({ ...media, cutMarks: v })} label="Marcas de corte" />
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Hoja ya usada</h3>
            <p className="text-xs text-muted-foreground">
              Tocá la primera etiqueta libre: las anteriores quedan en blanco y aprovechás la hoja autoadhesiva.
            </p>
            <div
              className="grid max-w-[260px] gap-[3px] rounded-md border border-border bg-muted/40 p-1.5"
              style={{ gridTemplateColumns: `repeat(${media.cols}, minmax(0, 1fr))`, aspectRatio: `${media.pageW} / ${media.pageH}` }}
              role="radiogroup"
              aria-label="Primera etiqueta libre"
            >
              {Array.from({ length: per }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={skip === i}
                  aria-label={`Empezar en la etiqueta ${i + 1}`}
                  onClick={() => onSkip(i)}
                  className={cn(
                    "min-h-0 rounded-[2px] border transition",
                    i < skip ? "border-transparent bg-muted-foreground/25" : i === skip ? "border-foreground bg-foreground" : "border-border bg-card hover:bg-muted",
                  )}
                />
              ))}
            </div>
            {skip > 0 && <p className="text-xs text-muted-foreground">Se saltean {skip} etiquetas de la primera hoja.</p>}
          </section>
        </>
      )}

      <Callout tone="info" title="Al imprimir">
        {media.kind === "thermal"
          ? `Elegí la etiquetadora, tamaño de papel ${fmtMm(media.pageW)} × ${fmtMm(media.pageH)} mm, márgenes Ninguno y escala 100%.`
          : "Elegí la impresora común, el mismo papel, márgenes Ninguno y escala 100% (tamaño real), sin ajustar a la página."}
      </Callout>
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.5,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}) {
  // Texto local: se confirma al salir del campo o con Enter (así tipear "5"
  // camino a "50" no se acota al mínimo a mitad de camino).
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n) && text.trim() !== "") onChange(Math.min(max, Math.max(min, n)));
    else setText(String(value));
  };
  return (
    <label className="block min-w-0">
      <span className="mb-1 block truncate text-xs font-semibold text-muted-foreground">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        data-step={step}
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm tabular-nums outline-none focus:border-ninja-flameSoft disabled:opacity-50"
      />
    </label>
  );
}

function SizeGlyph({ w, h, cols }: { w: number; h: number; cols: number }) {
  const scale = 26 / Math.max(w * cols, h);
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center">
      <span className="flex gap-[2px]">
        {Array.from({ length: cols }, (_, i) => (
          <span key={i} className="rounded-[2px] border border-foreground/70" style={{ width: Math.max(5, w * scale), height: Math.max(5, h * scale) }} />
        ))}
      </span>
    </span>
  );
}
