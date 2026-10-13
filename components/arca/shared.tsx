"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { GLOSSARY, statusInfo, type GlossaryKey } from "@/lib/arca/labels";

// Piezas compartidas de la facturación electrónica ARCA (ADR-072).

/**
 * Término con explicación simple: subrayado punteado que abre un popover con
 * el glosario. Click o tap en mobile; hover en desktop.
 */
export function Term({ k, children, className }: { k: GlossaryKey; children?: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const g = GLOSSARY[k];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          className={cn(
            "inline cursor-help font-semibold text-foreground underline decoration-muted-foreground decoration-dotted underline-offset-4 hover:decoration-ninja-flameSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {children ?? g.term}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          avoidCollisions
          collisionPadding={12}
          onMouseLeave={() => setOpen(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[60] w-72 rounded-lg border border-border bg-popover p-3.5 text-popover-foreground data-[state=open]:animate-fade-in"
        >
          <p className="text-sm font-bold text-foreground">{g.term}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{g.text}</p>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
Term.displayName = "Term";

export function useCopy() {
  const { toast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (value: string, label = "Copiado") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? null : c)), 1800);
      toast({ title: label, variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar", description: "Seleccioná el texto y copialo a mano.", variant: "error" });
    }
  };
  return { copy, copied };
}

/** Valor exacto para completar en ARCA, con botón Copiar. */
export function CopyValue({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const { copy, copied } = useCopy();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("truncate text-sm text-foreground", mono && "font-mono")}>{value || "Sin dato"}</p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!value}
        onClick={() => copy(value, `${label} copiado`)}
        aria-label={`Copiar ${label}`}
      >
        {copied === value ? <Check size={15} /> : <Copy size={15} />}
        <span className="hidden sm:inline">Copiar</span>
      </Button>
    </div>
  );
}
CopyValue.displayName = "CopyValue";

/** Bloque de texto largo (CSR) con Copiar y Descargar. */
export function CopyBlock({ value, fileName }: { value: string; fileName: string }) {
  const { copy, copied } = useCopy();
  const download = () => {
    const blob = new Blob([value], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-2">
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {value}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => copy(value, "Pedido copiado")}>
          {copied === value ? <Check size={15} /> : <Copy size={15} />} Copiar pedido
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={download}>
          Descargar {fileName}
        </Button>
      </div>
    </div>
  );
}
CopyBlock.displayName = "CopyBlock";

export function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-ninja-flameSoft underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink size={13} aria-hidden />
    </a>
  );
}
ExtLink.displayName = "ExtLink";

/**
 * Instrucciones numeradas para hacer en ARCA. Cada paso es una tarjeta con su
 * número arriba (sin bordes laterales de color).
 */
export function HowTo({ steps }: { steps: { title: React.ReactNode; body?: React.ReactNode }[] }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2">
      {steps.map((s, i) => (
        <li key={i} className="rounded-md border border-border bg-card p-3">
          <div className="flex items-start gap-3">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ninja-flame/15 text-xs font-bold text-ninja-flameSoft"
              aria-hidden
            >
              {i + 1}
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-foreground">{s.title}</p>
              {s.body && <div className="mt-1 text-muted-foreground">{s.body}</div>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
HowTo.displayName = "HowTo";

export function FiscalStatusBadge({ status }: { status: string }) {
  const s = statusInfo(status);
  return (
    <Badge tone={s.tone} title={s.hint}>
      {s.label}
    </Badge>
  );
}
FiscalStatusBadge.displayName = "FiscalStatusBadge";

/** Punto de estado (verde, ámbar, rojo o gris), sin borde de color. */
export function Dot({ tone }: { tone: "success" | "warning" | "danger" | "neutral" | "info" }) {
  const c = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    neutral: "bg-muted-foreground",
    info: "bg-info",
  }[tone];
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", c)} aria-hidden />;
}

const dtf = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? dtf.format(d) : "";
}
