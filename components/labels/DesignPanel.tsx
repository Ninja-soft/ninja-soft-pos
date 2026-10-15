"use client";

import { useMemo, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Check, Lock, Save, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { inputCls } from "@/components/purchases/shared";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import {
  ACCENT_SWATCHES,
  BORDER_OPTIONS,
  DESIGN_PRESETS,
  FIELD_LABELS,
  FONT_OPTIONS,
  type AlignKey,
  type BorderKey,
  type DecimalsMode,
  type FieldKey,
  type FontKey,
  type LabelDesign,
  type Symbology,
} from "@/lib/labels/designs";
import type { LabelItem } from "@/lib/labels/items";
import type { MediaConfig } from "@/lib/labels/media";
import { buildLabelDocument, type RenderContext } from "@/lib/labels/render";
import type { LabelTemplate } from "@/modules/labels/hooks";
import { LabelFrame, PX_PER_MM } from "./LabelFrame";

const FIELD_ORDER: FieldKey[] = ["name", "variant", "brand", "price", "prevPrice", "unitPrice", "plu", "sku", "barcode", "qr", "date", "logo", "image"];
const PRO_FEATURE = "etiquetas_pro";

export function DesignPanel({
  design,
  presetKey,
  onPreset,
  onDesign,
  pro,
  sample,
  media,
  ctx,
  templates,
  templateId,
  onApplyTemplate,
  onSaveTemplate,
  onDeleteTemplate,
  saving,
  canEdit,
  slugMissing,
}: {
  design: LabelDesign;
  presetKey: string;
  onPreset: (key: string) => void;
  onDesign: (d: LabelDesign) => void;
  pro: boolean;
  sample: LabelItem;
  media: MediaConfig;
  ctx: RenderContext;
  templates: LabelTemplate[];
  templateId: string | null;
  onApplyTemplate: (t: LabelTemplate) => void;
  onSaveTemplate: (name: string, asDefault: boolean, id: string | null) => void;
  onDeleteTemplate: (id: string) => void;
  saving: boolean;
  canEdit: boolean;
  slugMissing: boolean;
}) {
  const [upgrade, setUpgrade] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const set = <K extends keyof LabelDesign>(k: K, v: LabelDesign[K]) => {
    if (!pro) return setUpgrade(true);
    onDesign({ ...design, [k]: v });
  };
  const setShow = (k: FieldKey, v: boolean) => {
    if (!pro) return setUpgrade(true);
    onDesign({ ...design, show: { ...design.show, [k]: v } });
  };

  // Miniaturas de los modelos con el tamaño elegido (máx. 60 × 40 mm de ancho visible).
  const thumbW = Math.min(media.labelW, 70);
  const thumbH = (media.labelH / media.labelW) * thumbW;
  const thumbs = useMemo(
    () =>
      DESIGN_PRESETS.map((p) => ({
        p,
        html: buildLabelDocument({
          items: [sample],
          design: p.design,
          media: { ...media, kind: "thermal", cols: 1, rows: 1, labelW: thumbW, labelH: thumbH, pageW: thumbW, pageH: thumbH, marginX: 0, marginY: 0, gapX: 0, gapY: 0, cutMarks: false },
          ctx,
          mode: "preview",
          zoom: Math.min(2, 150 / (thumbW * PX_PER_MM)),
        }),
      })),
    [sample, media, ctx, thumbW, thumbH],
  );

  return (
    <div className="space-y-5">
      {/* Plantillas del negocio (PRO) */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Plantillas del negocio</h3>
          {!pro && (
            <Badge tone="gold">
              <Lock size={12} /> PRO
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={cn(selectCls, "h-10 min-w-0 flex-1")}
            value={templateId ?? ""}
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) onApplyTemplate(t);
            }}
            aria-label="Plantilla"
            disabled={templates.length === 0}
          >
            <option value="">{templates.length ? "Elegí una plantilla" : "Todavía no guardaste plantillas"}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.is_default ? " (predeterminada)" : ""}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => (pro ? setSaveOpen(true) : setUpgrade(true))}
            disabled={!canEdit}
            title={canEdit ? undefined : "Necesitás permiso para editar productos"}
          >
            <Save size={15} /> Guardar
          </Button>
          {templateId && pro && canEdit && (
            <Button size="sm" variant="ghost" onClick={() => onDeleteTemplate(templateId)} aria-label="Eliminar plantilla">
              <Trash2 size={15} />
            </Button>
          )}
        </div>
      </section>

      {/* Modelos */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Modelo</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" role="radiogroup" aria-label="Modelo de etiqueta">
          {thumbs.map(({ p, html }) => {
            const locked = !pro && !p.basic;
            const on = presetKey === p.key;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => (locked ? setUpgrade(true) : onPreset(p.key))}
                className={cn(
                  "group flex flex-col overflow-hidden rounded-lg border text-left transition",
                  on ? "border-foreground bg-muted/60" : "border-border bg-card hover:border-muted-foreground",
                )}
              >
                <div className="pointer-events-none flex min-h-[96px] items-center justify-center bg-muted/40 p-1">
                  <LabelFrame html={html} title={`Modelo ${p.label}`} minHeight={60} maxHeight={150} />
                </div>
                <div className="flex items-start justify-between gap-1 px-2.5 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">{p.label}</span>
                    <span className="line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{p.hint}</span>
                  </span>
                  {locked ? (
                    <Lock size={13} className="mt-0.5 shrink-0 text-muted-foreground" aria-label="PRO" />
                  ) : on ? (
                    <Check size={14} className="mt-0.5 shrink-0" />
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {!pro && (
        <Callout
          tone="brand"
          title="Personalizá tus etiquetas con Etiquetas PRO"
          actions={
            <Button size="sm" variant="secondary" onClick={() => setUpgrade(true)}>
              Ver planes
            </Button>
          }
        >
          Elegí qué datos mostrar, tipografía, tamaños, colores de banda, QR a la ficha del producto y guardá tus plantillas.
        </Callout>
      )}

      {/* Datos */}
      <section className={cn("space-y-2", !pro && "opacity-60")}>
        <h3 className="text-sm font-semibold">Qué mostrar</h3>
        <div className="flex flex-wrap gap-1.5">
          {FIELD_ORDER.map((k) => {
            const on = design.show[k];
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setShow(k, !on)}
                className={cn(
                  "flex min-h-[36px] items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition",
                  on ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {on && <Check size={13} />}
                {FIELD_LABELS[k]}
              </button>
            );
          })}
        </div>
        {design.show.qr && slugMissing && (
          <p className="text-xs text-warning">Tu negocio no tiene link público todavía; el QR no se puede armar.</p>
        )}
        {design.show.qr && (
          <p className="text-xs text-muted-foreground">
            El QR abre la ficha pública del producto con fotos, descripción, precio y simulador de cuotas.
          </p>
        )}
        {design.show.logo && !ctx.logoUrl && (
          <p className="text-xs text-muted-foreground">Subí el logo en Configuración → Mi negocio para que salga en la etiqueta.</p>
        )}
      </section>

      {/* Estilo */}
      <section className={cn("grid gap-4 sm:grid-cols-2", !pro && "opacity-60")}>
        <Field label="Tipografía">
          <select className={selectCls} value={design.font} onChange={(e) => set("font", e.target.value as FontKey)}>
            {FONT_OPTIONS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Borde">
          <select className={selectCls} value={design.border} onChange={(e) => set("border", e.target.value as BorderKey)}>
            {BORDER_OPTIONS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Tamaño del nombre · ${Math.round(design.nameScale * 100)}%`}>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={design.nameScale}
            onChange={(e) => set("nameScale", Number(e.target.value))}
            className="h-10 w-full accent-[var(--pos-solid,#FF4B22)]"
          />
        </Field>
        <Field label={`Tamaño del precio · ${Math.round(design.priceScale * 100)}%`}>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={design.priceScale}
            onChange={(e) => set("priceScale", Number(e.target.value))}
            className="h-10 w-full accent-[var(--pos-solid,#FF4B22)]"
          />
        </Field>
        <Field label="Alineación">
          <Segmented<AlignKey>
            aria-label="Alineación"
            size="sm"
            value={design.align}
            onChange={(v) => set("align", v)}
            options={[
              { value: "left", label: "Izquierda", icon: <AlignLeft size={15} /> },
              { value: "center", label: "Centro", icon: <AlignCenter size={15} /> },
              { value: "right", label: "Derecha", icon: <AlignRight size={15} /> },
            ]}
            iconOnlyOnMobile
          />
        </Field>
        <Field label="Centavos">
          <Segmented<DecimalsMode>
            aria-label="Centavos del precio"
            size="sm"
            value={design.decimals}
            onChange={(v) => set("decimals", v)}
            options={[
              { value: "auto", label: "Si hay" },
              { value: "always", label: "Siempre" },
              { value: "never", label: "Nunca" },
            ]}
          />
        </Field>
        <Field label="Color de bandas">
          <div className="flex flex-wrap items-center gap-1.5">
            {ACCENT_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("accent", c)}
                aria-label={`Color ${c}`}
                aria-pressed={design.accent.toLowerCase() === c.toLowerCase()}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-md border",
                  design.accent.toLowerCase() === c.toLowerCase() ? "border-foreground" : "border-border",
                )}
              >
                <span className="h-5 w-5 rounded" style={{ background: c }} />
              </button>
            ))}
            <input
              type="color"
              value={design.accent}
              onChange={(e) => set("accent", e.target.value)}
              aria-label="Otro color"
              className="h-8 w-10 cursor-pointer rounded-md border border-border bg-background"
            />
          </div>
        </Field>
        <Field label="Código de barras">
          <select className={selectCls} value={design.symbology} onChange={(e) => set("symbology", e.target.value as Symbology)}>
            <option value="auto">Automático (EAN-13 si corresponde)</option>
            <option value="ean13">EAN-13</option>
            <option value="code128">Code 128</option>
            <option value="code39">Code 39</option>
          </select>
        </Field>
        <Field label="Texto de la banda de oferta">
          <input className={inputCls} value={design.offerText} maxLength={20} onChange={(e) => set("offerText", e.target.value)} />
        </Field>
        <Field label="Leyenda al pie">
          <input
            className={inputCls}
            value={design.footer}
            maxLength={60}
            placeholder="ej. Precio final con IVA"
            onChange={(e) => set("footer", e.target.value)}
          />
        </Field>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:col-span-2">
          <span className="text-sm">Nombre en mayúsculas</span>
          <Switch checked={design.uppercase} onCheckedChange={(v) => set("uppercase", v)} label="Nombre en mayúsculas" />
        </div>
      </section>

      <SaveTemplateModal
        open={saveOpen}
        onOpenChange={setSaveOpen}
        current={templates.find((t) => t.id === templateId) ?? null}
        saving={saving}
        onSave={(name, def, id) => {
          onSaveTemplate(name, def, id);
          setSaveOpen(false);
        }}
      />
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey={PRO_FEATURE} featureLabel="Etiquetas PRO" />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function SaveTemplateModal({
  open,
  onOpenChange,
  current,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: LabelTemplate | null;
  saving: boolean;
  onSave: (name: string, asDefault: boolean, id: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [def, setDef] = useState(false);
  const [overwrite, setOverwrite] = useState(true);
  const target = current && overwrite ? current : null;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setName(current?.name ?? "");
          setDef(current?.is_default ?? false);
          setOverwrite(Boolean(current));
        }
        onOpenChange(o);
      }}
      title="Guardar plantilla"
      description="Guarda el modelo, los datos, el estilo y el tamaño de papel para usarlos de nuevo."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => onSave(name, def, target?.id ?? null)} loading={saving} disabled={!name.trim()}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">Nombre</span>
          <input className={inputCls} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="ej. Góndola almacén" autoFocus />
        </label>
        {current && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <span className="text-sm">Reemplazar &quot;{current.name}&quot;</span>
            <Switch checked={overwrite} onCheckedChange={setOverwrite} label="Reemplazar la plantilla elegida" />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <span className="flex items-center gap-2 text-sm">
            <Star size={15} /> Usarla por defecto al entrar
          </span>
          <Switch checked={def} onCheckedChange={setDef} label="Plantilla predeterminada" />
        </div>
      </div>
    </Modal>
  );
}
