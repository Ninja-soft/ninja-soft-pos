"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Code2,
  Crop,
  Eye,
  EyeOff,
  LayoutGrid,
  Move,
  Plus,
  Printer,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { Rnd } from "react-rnd";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { TicketRenderer } from "@/components/tickets/TicketRenderer";
import {
  CanvasElementView,
  CanvasItemsTable,
  CanvasTicketRenderer,
} from "@/components/tickets/CanvasTicketRenderer";
import { HtmlTicketRenderer } from "@/components/tickets/HtmlTicketRenderer";
import { ImageCropModal } from "@/components/tickets/ImageCropModal";
import { uploadTicketImage } from "@/lib/tickets/uploadTicketImage";
import {
  BLOCK_LABELS,
  CANVAS_WIDTH,
  defaultSaleBlocks,
  newBlock,
  newCanvasElement,
  type Align,
  type BlocksContent,
  type BlockType,
  type CanvasContent,
  type CanvasElement,
  type CanvasElementType,
  type HtmlContent,
  type TemplateContent,
  type TextSize,
  type TicketBlock,
} from "@/lib/tickets/blocks";
import { upgradeCanvas } from "@/lib/tickets/canvasCompat";
import { HTML_STARTER_TEMPLATES } from "@/lib/tickets/htmlTemplates";
import { BLOCK_STARTER_TEMPLATES } from "@/lib/tickets/blockTemplates";
import { CANVAS_STARTER_TEMPLATES } from "@/lib/tickets/canvasTemplates";
import { HTML_TEMPLATE_VARS } from "@/lib/tickets/htmlVars";
import { sampleTicketData, type SampleBrand } from "@/lib/tickets/sample";
import {
  useCreateTemplate,
  useTicketBranding,
  useUpdateTemplate,
} from "@/modules/tickets/hooks";
import type {
  TemplateInput,
  TemplateKind,
  TemplateMode,
  TicketTemplate,
} from "@/modules/tickets/api";
import { cn } from "@/lib/utils/cn";

type Paper = "58" | "80" | "a4";

const KIND_OPTIONS: { value: TemplateKind; label: string }[] = [
  { value: "sale", label: "Venta" },
  { value: "promo", label: "Promo" },
  { value: "gift", label: "Gift" },
];
const PAPER_OPTIONS: { value: Paper; label: string }[] = [
  { value: "58", label: "58" },
  { value: "80", label: "80" },
  { value: "a4", label: "A4" },
];
const ALIGN_OPTIONS: { value: Align; label: string }[] = [
  { value: "left", label: "Izq" },
  { value: "center", label: "Centro" },
  { value: "right", label: "Der" },
];
const SIZE_OPTIONS: { value: TextSize; label: string }[] = [
  { value: "sm", label: "S" },
  { value: "md", label: "M" },
  { value: "lg", label: "L" },
];

const CANVAS_ELEMENT_LABELS: Record<CanvasElementType, string> = {
  text: "Texto",
  image: "Imagen",
  logo: "Logo",
  qr: "QR",
  barcode: "Código de barras",
  separator: "Separador",
  items: "Ítems",
};

const MODE_CHOICES: {
  mode: TemplateMode;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    mode: "blocks",
    label: "Bloques (simple)",
    desc: "Apilá secciones predefinidas. Lo más rápido y prolijo.",
    icon: <LayoutGrid size={22} />,
  },
  {
    mode: "canvas",
    label: "Canvas (libre)",
    desc: "Posicioná elementos a mano arrastrándolos sobre el ticket.",
    icon: <Move size={22} />,
  },
  {
    mode: "html",
    label: "HTML (avanzado)",
    desc: "Escribí tu propio HTML con variables. Control total.",
    icon: <Code2 size={22} />,
  },
];

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: TicketTemplate | null;
  tenantId: string;
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        className="accent-ninja-flame"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

const inputCls =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft";

const MINIMAL_HTML = `<div style="font-family:Arial,sans-serif;font-size:13px;color:#111;text-align:center;line-height:1.4">
  <div style="font-weight:bold;font-size:16px">{{negocio}}</div>
  <div>{{fecha}}</div>
  <div style="border-top:1px dashed #999;margin:8px 0"></div>
  <table style="width:100%;border-collapse:collapse">{{items_html}}</table>
  <div style="border-top:1px dashed #999;margin:8px 0"></div>
  <div style="font-weight:bold;font-size:18px">{{total}}</div>
  <div style="margin-top:8px">{{pie}}</div>
</div>`;

// Paso interno del wizard de creación.
type Step = "mode" | "starter" | "editor";

export function TicketTemplateEditor({ open, onOpenChange, template, tenantId }: Props) {
  const { toast } = useToast();
  const { data: brand } = useTicketBranding(open);
  const create = useCreateTemplate();
  const update = useUpdateTemplate();

  const [mode, setMode] = useState<TemplateMode>("blocks");
  const [step, setStep] = useState<Step>("editor");

  // Meta común.
  const [name, setName] = useState("Mi ticket");
  const [kind, setKind] = useState<TemplateKind>("sale");
  const [paper, setPaper] = useState<Paper>("80");
  const [showNinja, setShowNinja] = useState(false);

  // Estado por modo.
  const [blocks, setBlocks] = useState<TicketBlock[]>(() => defaultSaleBlocks());
  const [html, setHtml] = useState<string>(MINIMAL_HTML);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [canvasHeight, setCanvasHeight] = useState<number>(360);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [addType, setAddType] = useState<BlockType>("text");

  // Reset del estado cada vez que se abre el modal o cambia la plantilla.
  useEffect(() => {
    if (!open) return;
    if (template) {
      const tmode = (template.mode as TemplateMode) ?? "blocks";
      const content = template.content as unknown as TemplateContent | null;
      setMode(tmode);
      setStep("editor");
      setName(template.name);
      setKind(template.kind as TemplateKind);
      setPaper(template.paper as Paper);
      setShowNinja(Boolean(template.show_ninjasoft_logo));

      if (content && "blocks" in content && Array.isArray(content.blocks)) {
        setBlocks(content.blocks.length ? content.blocks : defaultSaleBlocks());
      } else {
        setBlocks(defaultSaleBlocks());
      }
      if (content && "html" in content && typeof content.html === "string") {
        setHtml(content.html);
      } else {
        setHtml(MINIMAL_HTML);
      }
      if (content && "canvas" in content && content.canvas) {
        const tpaper = (template.paper as Paper) ?? "80";
        const safe = {
          elements: Array.isArray(content.canvas.elements) ? content.canvas.elements : [],
          height: content.canvas.height || 360,
        };
        const upgraded = upgradeCanvas(safe, tpaper);
        setElements(upgraded.elements);
        setCanvasHeight(upgraded.height);
      } else {
        setElements([]);
        setCanvasHeight(360);
      }
    } else {
      // Nuevo: arranca eligiendo modo.
      setMode("blocks");
      setStep("mode");
      setName("Mi ticket");
      setKind("sale");
      setPaper("80");
      setShowNinja(false);
      setBlocks(defaultSaleBlocks());
      setHtml(MINIMAL_HTML);
      setElements([]);
      setCanvasHeight(360);
    }
    setExpanded(null);
    // Solo open/id: una nueva referencia de la misma plantilla (refetch de la
    // lista) no debe pisar la edición en curso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id]);

  function chooseMode(m: TemplateMode) {
    setMode(m);
    setStep("starter");
  }

  function buildInput(): TemplateInput {
    let content: TemplateContent;
    if (mode === "html") content = { html } as HtmlContent;
    else if (mode === "canvas")
      content = { canvas: { elements, height: canvasHeight } } as CanvasContent;
    else content = { blocks } as BlocksContent;
    return {
      name: name.trim() || "Mi ticket",
      kind,
      mode,
      paper,
      content,
      show_ninjasoft_logo: showNinja,
    };
  }

  function save() {
    const input = buildInput();
    if (template) {
      update.mutate(
        { id: template.id, input },
        {
          onSuccess: () => {
            toast({ title: "Modelo guardado", variant: "success" });
            onOpenChange(false);
          },
          onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
        },
      );
    } else {
      create.mutate(
        { tenantId, input },
        {
          onSuccess: () => {
            toast({ title: "Modelo creado", variant: "success" });
            onOpenChange(false);
          },
          onError: () => toast({ title: "No se pudo crear", variant: "error" }),
        },
      );
    }
  }

  const saving = create.isPending || update.isPending;
  const data = useMemo(() => sampleTicketData(brand ?? null), [brand]);

  const metaControls = (
    <>
      <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
      <div>
        <span className="mb-2 block text-sm font-medium text-muted-foreground">Tipo</span>
        <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />
      </div>
      <div>
        <span className="mb-2 block text-sm font-medium text-muted-foreground">Papel</span>
        <Segmented value={paper} onChange={setPaper} options={PAPER_OPTIONS} />
      </div>
      <Check checked={showNinja} onChange={setShowNinja}>
        Logo NinjaSoft al pie
      </Check>
    </>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={template ? "Editar modelo" : "Nuevo modelo"}
      className="max-w-5xl"
    >
      {step === "mode" ? (
        <ModeChooser onChoose={chooseMode} />
      ) : step === "starter" ? (
        <StarterChooser
          mode={mode}
          brand={brand ?? null}
          onPick={(s) => {
            setKind(s.kind);
            setPaper(s.paper);
            if (s.mode === "html") setHtml(s.html);
            else if (s.mode === "blocks") setBlocks(s.blocks);
            else {
              setElements(s.canvas.elements);
              setCanvasHeight(s.canvas.height);
            }
            setStep("editor");
          }}
          onScratch={() => {
            if (mode === "html") setHtml(MINIMAL_HTML);
            else if (mode === "blocks") setBlocks(defaultSaleBlocks());
            else {
              setElements([]);
              setCanvasHeight(300);
            }
            setStep("editor");
          }}
        />
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            {/* Controles */}
            <div className="no-print space-y-5">
              {metaControls}

              {mode === "canvas" && (
                <label className="block text-sm text-muted-foreground">
                  Alto del lienzo (px)
                  <input
                    type="number"
                    min={120}
                    className={`${inputCls} mt-1`}
                    value={canvasHeight}
                    onChange={(e) => setCanvasHeight(Math.max(120, Number(e.target.value) || 0))}
                  />
                </label>
              )}

              {mode === "blocks" && (
                <BlocksControls
                  blocks={blocks}
                  setBlocks={setBlocks}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  addType={addType}
                  setAddType={setAddType}
                />
              )}

              {mode === "html" && (
                <HtmlControls html={html} setHtml={setHtml} onCopy={(v) => {
                  void navigator.clipboard?.writeText(v);
                  toast({ title: `Copiado ${v}`, variant: "success" });
                }} />
              )}

              {mode === "canvas" && (
                <CanvasControls
                  elements={elements}
                  setElements={setElements}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  tenantId={tenantId}
                />
              )}
            </div>

            {/* Preview en vivo */}
            <div>
              <span className="no-print mb-2 block text-sm font-medium text-muted-foreground">
                Vista previa
              </span>
              {mode === "blocks" && (
                <TicketRenderer
                  blocks={blocks}
                  data={data}
                  paper={paper}
                  showNinjaLogo={showNinja}
                  className="ticket-print"
                />
              )}
              {mode === "html" && (
                <HtmlTicketRenderer
                  html={html}
                  data={data}
                  paper={paper}
                  showNinjaLogo={showNinja}
                  className="ticket-print"
                />
              )}
              {mode === "canvas" && (
                <CanvasPreview
                  elements={elements}
                  height={canvasHeight}
                  setElements={setElements}
                  selected={expanded}
                  setSelected={setExpanded}
                  data={data}
                  paper={paper}
                  showNinja={showNinja}
                />
              )}
            </div>
          </div>

          <div className="no-print mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer size={16} /> Imprimir
            </Button>
            <Button onClick={save} loading={saving}>
              Guardar
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ----------------------------- Mode chooser ----------------------------- */

function ModeChooser({ onChoose }: { onChoose: (m: TemplateMode) => void }) {
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">¿Cómo querés diseñar este modelo?</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {MODE_CHOICES.map((c) => (
          <button
            key={c.mode}
            type="button"
            onClick={() => onChoose(c.mode)}
            className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition hover:border-ninja-flameSoft hover:bg-muted/40"
          >
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
              {c.icon}
            </span>
            <span className="font-medium text-foreground">{c.label}</span>
            <span className="text-xs text-muted-foreground">{c.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------- Starter chooser --------------------------- */

// Plantilla de inicio normalizada para la grilla, con el contenido por modo.
type StarterPick =
  | ({ mode: "blocks" } & (typeof BLOCK_STARTER_TEMPLATES)[number])
  | ({ mode: "canvas" } & (typeof CANVAS_STARTER_TEMPLATES)[number])
  | ({ mode: "html"; description: string } & (typeof HTML_STARTER_TEMPLATES)[number]);

const KIND_LABEL: Record<TemplateKind, string> = {
  sale: "Venta",
  promo: "Promo",
  gift: "Gift",
};

function paperLabel(p: Paper) {
  return p === "a4" ? "A4" : `${p} mm`;
}

function starterPicks(mode: TemplateMode): StarterPick[] {
  if (mode === "html")
    return HTML_STARTER_TEMPLATES.map((t) => ({
      ...t,
      mode: "html" as const,
      description: `Plantilla HTML ${paperLabel(t.paper)}.`,
    }));
  if (mode === "canvas")
    return CANVAS_STARTER_TEMPLATES.map((t) => ({ ...t, mode: "canvas" as const }));
  return BLOCK_STARTER_TEMPLATES.map((t) => ({ ...t, mode: "blocks" as const }));
}

// Escala de la miniatura por papel: el contenido se renderiza a su ancho real
// (58/80 mm ≈ 219/302 px, A4 ≈ 794 px) y se reduce para entrar en el marco.
// width = 100/escala % para que ocupe todo el ancho del marco antes de escalar.
const THUMB_SCALE: Record<Paper, number> = { "58": 0.42, "80": 0.32, a4: 0.16 };

function StarterThumb({ pick, brand }: { pick: StarterPick; brand: SampleBrand | null }) {
  const data = useMemo(() => sampleTicketData(brand), [brand]);
  const scale = THUMB_SCALE[pick.paper as Paper] ?? 0.32;
  const widthPct = `${Math.round((1 / scale) * 100)}%`;
  return (
    <div className="h-40 w-full overflow-hidden rounded-lg border border-border bg-white">
      <div
        className="pointer-events-none origin-top-left"
        style={{ transform: `scale(${scale})`, width: widthPct }}
      >
        {pick.mode === "blocks" && (
          <TicketRenderer blocks={pick.blocks} data={data} paper={pick.paper} showNinjaLogo={false} />
        )}
        {pick.mode === "canvas" && (
          <CanvasTicketRenderer content={pick.canvas} data={data} paper={pick.paper} showNinjaLogo={false} />
        )}
        {pick.mode === "html" && (
          <HtmlTicketRenderer html={pick.html} data={data} paper={pick.paper} showNinjaLogo={false} />
        )}
      </div>
    </div>
  );
}

function StarterChooser({
  mode,
  brand,
  onPick,
  onScratch,
}: {
  mode: TemplateMode;
  brand: SampleBrand | null;
  onPick: (s: StarterPick) => void;
  onScratch: () => void;
}) {
  const picks = starterPicks(mode);
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        Elegí un modelo de inicio o empezá desde cero. Tocá una miniatura para usarla.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {picks.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onPick(t)}
            className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-3 text-left transition hover:border-ninja-flameSoft hover:bg-muted/40"
          >
            <StarterThumb pick={t} brand={brand} />
            <span className="font-medium text-foreground">{t.name}</span>
            <span className="text-xs text-muted-foreground">{t.description}</span>
            <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
              <Chip>{KIND_LABEL[t.kind]}</Chip>
              <Chip>{paperLabel(t.paper)}</Chip>
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={onScratch}
          className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-card p-3 text-left transition hover:border-ninja-flameSoft hover:bg-muted/40"
        >
          <span className="grid h-40 w-full place-items-center rounded-lg border border-dashed border-border bg-muted/20 text-xs text-muted-foreground">
            Lienzo en blanco
          </span>
          <span className="font-medium text-foreground">Desde cero</span>
          <span className="text-xs text-muted-foreground">Un esqueleto mínimo para arrancar.</span>
        </button>
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/* ----------------------------- Blocks pane ------------------------------ */

function BlocksControls({
  blocks,
  setBlocks,
  expanded,
  setExpanded,
  addType,
  setAddType,
}: {
  blocks: TicketBlock[];
  setBlocks: React.Dispatch<React.SetStateAction<TicketBlock[]>>;
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  addType: BlockType;
  setAddType: (t: BlockType) => void;
}) {
  function move(index: number, dir: -1 | 1) {
    setBlocks((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }
  function patch(id: string, changes: Partial<TicketBlock>) {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? ({ ...b, ...changes } as TicketBlock) : b)),
    );
  }
  function remove(id: string) {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
  }
  function add() {
    setBlocks((prev) => [...prev, newBlock(addType)]);
  }

  return (
    <>
      <div className="space-y-2">
        <span className="block text-sm font-medium text-muted-foreground">Bloques</span>
        {blocks.map((b, i) => (
          <BlockRow
            key={b.id}
            block={b}
            first={i === 0}
            last={i === blocks.length - 1}
            expanded={expanded === b.id}
            onToggleExpand={() => setExpanded((e) => (e === b.id ? null : b.id))}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
            onToggleHidden={() => patch(b.id, { hidden: !b.hidden })}
            onRemove={() => remove(b.id)}
            onPatch={(c) => patch(b.id, c)}
          />
        ))}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex-1 text-sm text-muted-foreground">
          Agregar bloque
          <select
            className={`${inputCls} mt-1`}
            value={addType}
            onChange={(e) => setAddType(e.target.value as BlockType)}
          >
            {(Object.keys(BLOCK_LABELS) as BlockType[]).map((t) => (
              <option key={t} value={t}>
                {BLOCK_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="secondary" onClick={add}>
          <Plus size={16} /> Agregar
        </Button>
      </div>
    </>
  );
}

/* ------------------------------ HTML pane ------------------------------- */

function HtmlControls({
  html,
  setHtml,
  onCopy,
}: {
  html: string;
  setHtml: (v: string) => void;
  onCopy: (placeholder: string) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-muted-foreground">
        HTML del ticket
        <textarea
          className={`${inputCls} mt-1 h-96 resize-y py-2 font-mono text-xs leading-relaxed`}
          spellCheck={false}
          value={html}
          onChange={(e) => setHtml(e.target.value)}
        />
      </label>
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
          Variables disponibles
        </summary>
        <div className="grid gap-1 border-t border-border px-3 py-2 sm:grid-cols-2">
          {HTML_TEMPLATE_VARS.map((v) => {
            const placeholder = `{{${v.key}}}`;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => onCopy(placeholder)}
                title="Copiar"
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <code className="font-mono text-ninja-flameSoft">{placeholder}</code>
                <span className="truncate">— {v.label}</span>
              </button>
            );
          })}
        </div>
      </details>
    </div>
  );
}

/* ----------------------------- Canvas pane ------------------------------ */

const CANVAS_ADD_OPTIONS: CanvasElementType[] = [
  "text",
  "image",
  "logo",
  "qr",
  "barcode",
  "separator",
  "items",
];

function CanvasControls({
  elements,
  setElements,
  expanded,
  setExpanded,
  tenantId,
}: {
  elements: CanvasElement[];
  setElements: React.Dispatch<React.SetStateAction<CanvasElement[]>>;
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  tenantId: string;
}) {
  const [addType, setAddType] = useState<CanvasElementType>("text");
  const hasItems = elements.some((e) => e.type === "items");
  const options = CANVAS_ADD_OPTIONS.filter((t) => t !== "items" || !hasItems);

  function patch(id: string, changes: Partial<CanvasElement>) {
    setElements((prev) => prev.map((e) => (e.id === id ? { ...e, ...changes } : e)));
  }
  function remove(id: string) {
    setElements((prev) => prev.filter((e) => e.id !== id));
  }
  function add() {
    setElements((prev) => {
      const el = newCanvasElement(addType);
      setExpanded(el.id);
      return [...prev, el];
    });
  }

  // Si el tipo seleccionado deja de estar disponible (items ya agregado), reseteá.
  useEffect(() => {
    if (!options.includes(addType)) setAddType(options[0] ?? "text");
  }, [options, addType]);

  return (
    <>
      <div className="space-y-2">
        <span className="block text-sm font-medium text-muted-foreground">Elementos</span>
        {elements.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Agregá elementos y arrastralos sobre la vista previa.
          </p>
        )}
        {elements.map((el) => (
          <CanvasRow
            key={el.id}
            el={el}
            tenantId={tenantId}
            expanded={expanded === el.id}
            onToggleExpand={() => setExpanded((e) => (e === el.id ? null : el.id))}
            onRemove={() => remove(el.id)}
            onPatch={(c) => patch(el.id, c)}
          />
        ))}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex-1 text-sm text-muted-foreground">
          Agregar elemento
          <select
            className={`${inputCls} mt-1`}
            value={addType}
            onChange={(e) => setAddType(e.target.value as CanvasElementType)}
          >
            {options.map((t) => (
              <option key={t} value={t}>
                {CANVAS_ELEMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="secondary" onClick={add}>
          <Plus size={16} /> Agregar
        </Button>
      </div>
    </>
  );
}

function CanvasRow({
  el,
  tenantId,
  expanded,
  onToggleExpand,
  onRemove,
  onPatch,
}: {
  el: CanvasElement;
  tenantId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onRemove: () => void;
  onPatch: (c: Partial<CanvasElement>) => void;
}) {
  const isItems = el.type === "items";
  return (
    <div className={cn("rounded-lg border border-border", expanded && "ring-1 ring-ninja-flameSoft")}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm">{CANVAS_ELEMENT_LABELS[el.type]}</span>
        <IconBtn title="Ajustes" onClick={onToggleExpand} active={expanded}>
          <SlidersHorizontal size={15} />
        </IconBtn>
        <IconBtn title="Quitar" onClick={onRemove} danger>
          <X size={15} />
        </IconBtn>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          <div className="grid grid-cols-3 gap-2">
            {!isItems && (
              <NumField
                label="X px"
                value={el.x}
                min={0}
                onChange={(v) => onPatch({ x: Math.max(0, v) })}
              />
            )}
            <NumField label="Y px" value={el.y} min={0} onChange={(v) => onPatch({ y: Math.max(0, v) })} />
            {!isItems && (
              <NumField
                label="Ancho px"
                value={el.w}
                min={24}
                onChange={(v) => onPatch({ w: Math.max(24, v) })}
              />
            )}
          </div>

          {!isItems && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <NumField
                  label="Alto px"
                  value={el.h ?? 0}
                  min={0}
                  onChange={(v) => onPatch({ h: v > 0 ? Math.max(16, v) : undefined })}
                />
              </div>
              {el.h !== undefined && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onPatch({ h: undefined })}
                  title="Alto automático"
                >
                  Auto
                </Button>
              )}
            </div>
          )}

          {el.type === "text" && (
            <>
              <textarea
                className={`${inputCls} h-20 py-2`}
                value={el.text ?? ""}
                onChange={(e) => onPatch({ text: e.target.value })}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  value={el.size ?? "md"}
                  onChange={(v) => onPatch({ size: v })}
                  options={SIZE_OPTIONS}
                />
                <Segmented
                  value={el.align ?? "center"}
                  onChange={(v) => onPatch({ align: v })}
                  options={ALIGN_OPTIONS}
                />
                <Check checked={Boolean(el.bold)} onChange={(v) => onPatch({ bold: v })}>
                  Negrita
                </Check>
              </div>
            </>
          )}

          {el.type === "image" && (
            <ImageElementSettings el={el} tenantId={tenantId} onPatch={onPatch} />
          )}
        </div>
      )}
    </div>
  );
}

function ImageElementSettings({
  el,
  tenantId,
  onPatch,
}: {
  el: CanvasElement;
  tenantId: string;
  onPatch: (c: Partial<CanvasElement>) => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);

  async function onFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadTicketImage(file, tenantId);
      onPatch({ url });
      toast({ title: "Imagen subida", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo subir la imagen",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <input
        className={inputCls}
        placeholder="URL de la imagen"
        value={el.url ?? ""}
        onChange={(e) => onPatch({ url: e.target.value })}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={15} /> Subir imagen
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!el.url}
          onClick={() => setCropOpen(true)}
        >
          <Crop size={15} /> Recortar
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </div>
      {el.url && (
        <ImageCropModal
          open={cropOpen}
          onOpenChange={setCropOpen}
          url={el.url}
          tenantId={tenantId}
          onCropped={(url) => onPatch({ url })}
        />
      )}
    </div>
  );
}

function NumField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        className={`${inputCls} mt-1`}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/* --------------------------- Canvas preview ----------------------------- */

// Tamaños mínimos de la caja react-rnd.
const RND_MIN_W = 24;
const RND_MIN_H = 16;

// Tipos cuyo alto es intrínseco a su contenido (resize vertical genera h).
function elementSupportsHeight(type: CanvasElementType) {
  return type === "image" || type === "qr" || type === "logo" || type === "barcode";
}

/**
 * Editor del modo canvas con react-rnd. En vez de superponer overlays sobre el
 * renderer, dibuja los elementos directamente como hijos `<Rnd>` dentro de una
 * tarjeta blanca del ancho del papel, reutilizando el mismo visual del renderer
 * (`CanvasElementView`). El elemento "items" parte el lienzo en dos zonas; su
 * caja Rnd se arrastra solo en vertical y define el punto de corte (y).
 */
function CanvasPreview({
  elements,
  height,
  setElements,
  selected,
  setSelected,
  data,
  paper,
  showNinja,
}: {
  elements: CanvasElement[];
  height: number;
  setElements: React.Dispatch<React.SetStateAction<CanvasElement[]>>;
  selected: string | null;
  setSelected: React.Dispatch<React.SetStateAction<string | null>>;
  data: ReturnType<typeof sampleTicketData>;
  paper: Paper;
  showNinja: boolean;
}) {
  const width = CANVAS_WIDTH[paper];
  const itemsEl = elements.find((e) => e.type === "items");
  const splitY = itemsEl?.y ?? null;
  const hasItems = splitY !== null;
  const topZoneH = hasItems ? splitY : height;
  const bottomZoneH = hasItems ? Math.max(0, height - splitY) : 0;

  const topEls = elements.filter((e) => e.type !== "items" && (!hasItems || e.y < splitY));
  const bottomEls = hasItems ? elements.filter((e) => e.type !== "items" && e.y >= splitY) : [];

  function patch(id: string, changes: Partial<CanvasElement>) {
    setElements((prev) => prev.map((e) => (e.id === id ? { ...e, ...changes } : e)));
  }

  // Caja Rnd de un elemento posicionado. `zoneY` = la Y relativa a la zona en
  // la que vive (igual al renderer). `yBase` se suma al escribir de vuelta.
  function ElementBox({ el, zoneY, yBase }: { el: CanvasElement; zoneY: number; yBase: number }) {
    const isSel = selected === el.id;
    const supportsH = elementSupportsHeight(el.type);
    return (
      <Rnd
        bounds="parent"
        size={{ width: el.w, height: el.h ?? "auto" }}
        position={{ x: el.x, y: zoneY }}
        minWidth={RND_MIN_W}
        minHeight={RND_MIN_H}
        enableResizing={{ right: true, bottom: true, bottomRight: true }}
        onDragStart={() => setSelected(el.id)}
        onDragStop={(_e, d) => {
          patch(el.id, { x: Math.round(d.x), y: Math.round(d.y) + yBase });
        }}
        onResizeStart={() => setSelected(el.id)}
        onResizeStop={(_e, _dir, ref, _delta, pos) => {
          const nextW = Math.round(ref.offsetWidth);
          const heightChanged = el.h !== undefined || ref.style.height.includes("px");
          const changes: Partial<CanvasElement> = {
            w: nextW,
            x: Math.round(pos.x),
            y: Math.round(pos.y) + yBase,
          };
          // Para tipos con alto intrínseco siempre persistimos h. Para texto y
          // separador solo si el usuario realmente arrastró el alto.
          if (supportsH || heightChanged) changes.h = Math.round(ref.offsetHeight);
          patch(el.id, changes);
        }}
        className={cn(
          "rounded outline-dashed outline-1 outline-offset-1 outline-border transition hover:outline-ninja-flameSoft/60",
          isSel && "outline-ninja-flameSoft outline-2",
        )}
        style={{ cursor: "move" }}
      >
        <div
          className="h-full w-full overflow-hidden"
          onMouseDownCapture={() => setSelected(el.id)}
        >
          <CanvasElementView el={el} data={data} />
        </div>
      </Rnd>
    );
  }

  // Caja Rnd del separador del flujo de ítems: solo se mueve en vertical y
  // define el punto de corte (y). No redimensiona.
  function ItemsBox() {
    if (!itemsEl || splitY === null) return null;
    return (
      <Rnd
        bounds="parent"
        dragAxis="y"
        enableResizing={false}
        size={{ width, height: 4 }}
        position={{ x: 0, y: 0 }}
        onDragStart={() => setSelected(itemsEl.id)}
        onDragStop={(_e, d) => patch(itemsEl.id, { y: Math.max(0, Math.round(d.y) + splitY) })}
        className={cn(
          "z-10 border-t-2 border-dashed border-ninja-flame/70",
          selected === itemsEl.id && "border-ninja-flame",
        )}
        style={{ cursor: "ns-resize" }}
        title="Ítems — arrastrá para mover el punto de corte"
      />
    );
  }

  return (
    <div
      className="mx-auto rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground ticket-print"
      style={{ width: `${width}px`, maxWidth: "100%" }}
    >
      {/* Zona superior: alto fijo (= items.y, o todo el lienzo si no hay items). */}
      <div style={{ position: "relative", height: `${topZoneH}px` }}>
        {topEls.map((el) => (
          <ElementBox key={el.id} el={el} zoneY={el.y} yBase={0} />
        ))}
        {hasItems && <ItemsBox />}
      </div>

      {hasItems && (
        <>
          {/* Tabla de ítems de muestra (no interactiva). */}
          <CanvasItemsTable data={data} />
          {/* Zona inferior: Y relativa a items.y. */}
          <div style={{ position: "relative", height: `${bottomZoneH}px` }}>
            {bottomEls.map((el) => (
              <ElementBox key={el.id} el={el} zoneY={el.y - splitY} yBase={splitY} />
            ))}
          </div>
        </>
      )}

      {data.sale.status === "voided" && (
        <div className="mt-3 text-center text-xs font-bold text-red-500">** ANULADA **</div>
      )}
      {showNinja && (
        <div className="mt-3 flex justify-center opacity-70">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/ninjasoft-wordmark.webp" alt="NinjaSoft" className="h-4 w-auto" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Block rows ------------------------------ */

function BlockRow({
  block,
  first,
  last,
  expanded,
  onToggleExpand,
  onUp,
  onDown,
  onToggleHidden,
  onRemove,
  onPatch,
}: {
  block: TicketBlock;
  first: boolean;
  last: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onUp: () => void;
  onDown: () => void;
  onToggleHidden: () => void;
  onRemove: () => void;
  onPatch: (c: Partial<TicketBlock>) => void;
}) {
  const hasSettings = BLOCKS_WITH_SETTINGS.has(block.type);
  return (
    <div className={cn("rounded-lg border border-border", block.hidden && "opacity-50")}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm">{BLOCK_LABELS[block.type]}</span>
        <IconBtn title="Subir" disabled={first} onClick={onUp}>
          <ChevronUp size={15} />
        </IconBtn>
        <IconBtn title="Bajar" disabled={last} onClick={onDown}>
          <ChevronDown size={15} />
        </IconBtn>
        <IconBtn title={block.hidden ? "Mostrar" : "Ocultar"} onClick={onToggleHidden}>
          {block.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconBtn>
        {hasSettings && (
          <IconBtn title="Ajustes" onClick={onToggleExpand} active={expanded}>
            <SlidersHorizontal size={15} />
          </IconBtn>
        )}
        <IconBtn title="Quitar" onClick={onRemove} danger>
          <X size={15} />
        </IconBtn>
      </div>
      {expanded && hasSettings && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          <BlockSettings block={block} onPatch={onPatch} />
        </div>
      )}
    </div>
  );
}

const BLOCKS_WITH_SETTINGS = new Set<BlockType>([
  "text",
  "title",
  "image",
  "items",
  "saleInfo",
  "business",
  "footer",
]);

function BlockSettings({
  block,
  onPatch,
}: {
  block: TicketBlock;
  onPatch: (c: Partial<TicketBlock>) => void;
}) {
  switch (block.type) {
    case "text":
      return (
        <>
          <textarea
            className={`${inputCls} h-20 py-2`}
            value={block.text}
            onChange={(e) => onPatch({ text: e.target.value })}
          />
          <AlignSizeBold block={block} onPatch={onPatch} />
        </>
      );
    case "title":
      return (
        <>
          <input
            className={inputCls}
            placeholder="usa el título del branding"
            value={block.text ?? ""}
            onChange={(e) => onPatch({ text: e.target.value })}
          />
          <AlignSizeBold block={block} onPatch={onPatch} />
        </>
      );
    case "image":
      return (
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder="URL de la imagen"
            value={block.url}
            onChange={(e) => onPatch({ url: e.target.value })}
          />
          <label className="block text-xs text-muted-foreground">
            Ancho %
            <input
              type="number"
              min={10}
              max={100}
              className={`${inputCls} mt-1`}
              value={block.widthPct ?? 100}
              onChange={(e) => onPatch({ widthPct: Number(e.target.value) })}
            />
          </label>
        </div>
      );
    case "items":
      return (
        <Check
          checked={Boolean(block.showUnitPrice)}
          onChange={(v) => onPatch({ showUnitPrice: v })}
        >
          Mostrar precio unitario
        </Check>
      );
    case "saleInfo":
      return (
        <div className="space-y-1.5">
          <Check
            checked={block.showNumber !== false}
            onChange={(v) => onPatch({ showNumber: v })}
          >
            N° de comprobante
          </Check>
          <Check checked={block.showDate !== false} onChange={(v) => onPatch({ showDate: v })}>
            Fecha
          </Check>
        </div>
      );
    case "business":
      return (
        <div className="space-y-1.5">
          <Check
            checked={block.showLegalName !== false}
            onChange={(v) => onPatch({ showLegalName: v })}
          >
            Razón social
          </Check>
          <Check checked={block.showCuit !== false} onChange={(v) => onPatch({ showCuit: v })}>
            CUIT
          </Check>
          <Check
            checked={block.showAddress !== false}
            onChange={(v) => onPatch({ showAddress: v })}
          >
            Dirección
          </Check>
          <Check checked={block.showPhone !== false} onChange={(v) => onPatch({ showPhone: v })}>
            Teléfono
          </Check>
        </div>
      );
    case "footer":
      return (
        <input
          className={inputCls}
          placeholder="usa el pie del branding"
          value={block.text ?? ""}
          onChange={(e) => onPatch({ text: e.target.value })}
        />
      );
    default:
      return null;
  }
}

function AlignSizeBold({
  block,
  onPatch,
}: {
  block: Extract<TicketBlock, { type: "text" | "title" }>;
  onPatch: (c: Partial<TicketBlock>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        value={block.align ?? "center"}
        onChange={(v) => onPatch({ align: v })}
        options={ALIGN_OPTIONS}
      />
      <Segmented
        value={block.size ?? "md"}
        onChange={(v) => onPatch({ size: v })}
        options={SIZE_OPTIONS}
      />
      <Check checked={Boolean(block.bold)} onChange={(v) => onPatch({ bold: v })}>
        Negrita
      </Check>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
  danger,
  active,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent",
        danger && "hover:text-destructive",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}
