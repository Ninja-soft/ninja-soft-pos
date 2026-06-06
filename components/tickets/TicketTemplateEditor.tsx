"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Plus,
  Printer,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { TicketRenderer } from "@/components/tickets/TicketRenderer";
import {
  BLOCK_LABELS,
  defaultSaleBlocks,
  newBlock,
  type Align,
  type BlocksContent,
  type BlockType,
  type TextSize,
  type TicketBlock,
} from "@/lib/tickets/blocks";
import { sampleTicketData } from "@/lib/tickets/sample";
import {
  useCreateTemplate,
  useTicketBranding,
  useUpdateTemplate,
} from "@/modules/tickets/hooks";
import type { TemplateInput, TemplateKind, TicketTemplate } from "@/modules/tickets/api";
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

export function TicketTemplateEditor({ open, onOpenChange, template, tenantId }: Props) {
  const { toast } = useToast();
  const { data: brand } = useTicketBranding(open);
  const create = useCreateTemplate();
  const update = useUpdateTemplate();

  const [name, setName] = useState("Mi ticket");
  const [kind, setKind] = useState<TemplateKind>("sale");
  const [paper, setPaper] = useState<Paper>("80");
  const [showNinja, setShowNinja] = useState(false);
  const [blocks, setBlocks] = useState<TicketBlock[]>(() => defaultSaleBlocks());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addType, setAddType] = useState<BlockType>("text");

  // Reset del estado cada vez que se abre el modal o cambia la plantilla.
  useEffect(() => {
    if (!open) return;
    if (template) {
      const content = template.content as unknown as BlocksContent | null;
      setName(template.name);
      setKind(template.kind as TemplateKind);
      setPaper(template.paper as Paper);
      setShowNinja(Boolean(template.show_ninjasoft_logo));
      setBlocks(content?.blocks?.length ? content.blocks : defaultSaleBlocks());
    } else {
      setName("Mi ticket");
      setKind("sale");
      setPaper("80");
      setShowNinja(false);
      setBlocks(defaultSaleBlocks());
    }
    setExpanded(null);
    // Solo open/id: una nueva referencia de la misma plantilla (refetch de la
    // lista) no debe pisar la edición en curso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id]);

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

  function buildInput(): TemplateInput {
    return {
      name: name.trim() || "Mi ticket",
      kind,
      mode: "blocks",
      paper,
      content: { blocks },
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

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={template ? "Editar modelo" : "Nuevo modelo"}
      className="max-w-5xl"
    >
      <div className="grid gap-6 md:grid-cols-2">
        {/* Controles */}
        <div className="no-print space-y-5">
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

          {/* Lista de bloques */}
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

          {/* Agregar bloque */}
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
        </div>

        {/* Preview en vivo */}
        <div>
          <span className="no-print mb-2 block text-sm font-medium text-muted-foreground">
            Vista previa
          </span>
          <TicketRenderer
            blocks={blocks}
            data={sampleTicketData(brand ?? null)}
            paper={paper}
            showNinjaLogo={showNinja}
            className="ticket-print"
          />
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
    </Modal>
  );
}

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
