"use client";

// H9b PR2 — Despacho por modo de plantilla. Punto único de render para
// TicketModal, preview del editor, A4 y export a PNG/email.
import { TicketRenderer, type TicketData } from "@/components/tickets/TicketRenderer";
import { CanvasTicketRenderer } from "@/components/tickets/CanvasTicketRenderer";
import { HtmlTicketRenderer } from "@/components/tickets/HtmlTicketRenderer";
import type { TemplateContent, TicketBlock } from "@/lib/tickets/blocks";
import type { TicketTemplate } from "@/modules/tickets/api";

type Paper = "58" | "80" | "a4";

interface Props {
  template: TicketTemplate | null;
  fallbackBlocks: TicketBlock[];
  data: TicketData;
  paperOverride?: Paper;
  className?: string;
}

export function TemplateRenderer({
  template,
  fallbackBlocks,
  data,
  paperOverride,
  className,
}: Props) {
  const paper: Paper = paperOverride ?? (template?.paper as Paper | undefined) ?? "80";
  const showNinja = Boolean(template?.show_ninjasoft_logo);

  const fallback = (
    <TicketRenderer
      blocks={fallbackBlocks}
      data={data}
      paper={paper}
      showNinjaLogo={showNinja}
      className={className}
    />
  );

  if (!template) return fallback;

  const c = template.content as unknown as TemplateContent;
  const mode = template.mode;

  if (mode === "blocks" && c && "blocks" in c && Array.isArray(c.blocks) && c.blocks.length) {
    return (
      <TicketRenderer
        blocks={c.blocks}
        data={data}
        paper={paper}
        showNinjaLogo={showNinja}
        className={className}
      />
    );
  }

  if (
    mode === "canvas" &&
    c &&
    "canvas" in c &&
    c.canvas &&
    Array.isArray(c.canvas.elements) &&
    c.canvas.elements.length
  ) {
    return (
      <CanvasTicketRenderer
        content={c.canvas}
        data={data}
        paper={paper}
        showNinjaLogo={showNinja}
        className={className}
      />
    );
  }

  if (mode === "html" && c && "html" in c && typeof c.html === "string" && c.html.length) {
    return (
      <HtmlTicketRenderer
        html={c.html}
        data={data}
        paper={paper}
        showNinjaLogo={showNinja}
        className={className}
      />
    );
  }

  // Modo no reconocido o content malformado → fallback de bloques.
  return fallback;
}
