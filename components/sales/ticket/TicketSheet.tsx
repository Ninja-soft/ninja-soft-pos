"use client";

// Ventana del ticket (ADR-111). PRESENTACIONAL: la arma TicketModal con los
// datos de la venta. Mismo ancho y lenguaje que la hoja de cobro (PosSheet
// xl): en la compu, vista previa del comprobante a la izquierda y acciones a
// la derecha; en el celular, apiladas (resumen y acciones arriba, vista previa
// abajo) con la acción principal fija abajo.
// Venta fiscal: el comprobante no se muestra hasta tener CAE (o CAEA).
import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertTriangle,
  Check,
  CloudOff,
  ExternalLink,
  FileDown,
  FileText,
  Printer,
  RotateCcw,
  Share2,
  ShoppingCart,
} from "lucide-react";
import { PosSheet } from "@/components/pos/ui/PosSheet";
import { POS_CTA, POS_EYEBROW, POS_QUIET, money } from "@/components/pos/ui/posStyles";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { previewVisible, type PostSalePhase } from "@/lib/tickets/postSale";

export type DetailTab = "ticket" | "cobros";
const TABS: { value: DetailTab; label: string }[] = [
  { value: "ticket", label: "Ticket" },
  { value: "cobros", label: "Cobros" },
];

export interface TicketSummary {
  numberLabel: string;
  total: number;
  createdAt: string;
  customerName?: string | null;
  itemsCount: number;
  /** "Factura B 00003-00000012" cuando hay comprobante autorizado. */
  fiscalLabel?: string | null;
  homologacion?: boolean;
  /** Venta anulada o en espera: se muestra como pastilla. */
  statusLabel?: string | null;
}

export interface TicketSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  phase: PostSalePhase;
  /** El usuario pidió ver el comprobante sin CAE. */
  provisional: boolean;
  onShowProvisional: () => void;
  /** Muestra el provisorio y lo imprime. */
  onPrintProvisional: () => void;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  /** Ticket renderizado (sin la clase de impresión). */
  preview: ReactNode;
  /** Pestaña Cobros (ADR-061). */
  payments: ReactNode;
  summary: TicketSummary | null;
  /** Abrió recién cobrada desde el POS: muestra "Nueva venta" (Enter). */
  onNewSale?: () => void;
  onPrint: () => void;
  /** "80 mm · 2 copias · Caja 1". */
  printHint?: string | null;
  printFailed?: boolean;
  onPdf: () => void;
  pdfBusy?: boolean;
  /** Compartir el comprobante (Web Share con archivo); sólo si el equipo puede. */
  onShare?: () => void;
  shareBusy?: boolean;
  /** Botón y formulario de email (SendReceiptEmail). */
  emailButton: ReactNode;
  emailPanel: ReactNode;
  saleHref: string;
  /** Estado fiscal completo (FiscalStatus): CAE, QR, errores y reproceso. */
  fiscalDetail: ReactNode | null;
  fiscalDetailOpen: boolean;
  onFiscalDetail: (open: boolean) => void;
  /** Volver a pedir el CAE ya (sólo comprobantes en cola). */
  onRetry?: () => void;
  retryBusy?: boolean;
  /** Mensaje en lenguaje simple del error de ARCA. */
  errorText?: { title: string; action: string } | null;
  /** Hora del próximo intento automático ("14:32"). */
  nextAttemptLabel?: string | null;
  /** Dueño o encargado: pueden corregir y reprocesar. */
  canFix?: boolean;
}

function fiscalBadge(phase: PostSalePhase, provisional: boolean): { tone: BadgeTone; label: string } | null {
  switch (phase.kind) {
    case "ready":
      if (phase.fiscal === "cae") return { tone: "success", label: "Factura autorizada" };
      if (phase.fiscal === "caea") return { tone: "info", label: "Factura en contingencia (CAEA)" };
      return { tone: "neutral", label: "Comprobante no fiscal" };
    case "authorizing":
      return { tone: "info", label: provisional ? "Provisorio sin CAE" : "Autorizando en ARCA" };
    case "retrying":
      return { tone: "warning", label: provisional ? "Provisorio sin CAE" : "ARCA no responde" };
    case "failed":
      return { tone: "danger", label: phase.status === "rechazado" ? "Factura rechazada" : "Factura con problemas" };
    default:
      return null;
  }
}

const isEditable = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t || typeof t.closest !== "function") return false;
  return Boolean(t.closest("input, textarea, select, [contenteditable='true']"));
};

export function TicketSheet(p: TicketSheetProps) {
  const visible = previewVisible(p.phase, p.provisional);
  const badge = fiscalBadge(p.phase, p.provisional);
  const { onNewSale, onPrint } = p;

  // Atajos dentro de la ventana: Enter = nueva venta, P = imprimir. Enter
  // sobre un botón o link lo deja al navegador (activa ese botón).
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const tgt = e.target as HTMLElement | null;
      if (e.key === "Enter" && onNewSale) {
        if (tgt && typeof tgt.closest === "function" && tgt.closest("button, a")) return;
        e.preventDefault();
        onNewSale();
      } else if ((e.key === "p" || e.key === "P") && !e.shiftKey && visible) {
        e.preventDefault();
        onPrint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.open, onNewSale, onPrint, visible]);

  const mainAction = onNewSale ? (
    <button
      type="button"
      onClick={onNewSale}
      className={cn(POS_CTA, "flex h-12 w-full items-center justify-center gap-2 rounded-lg text-base font-semibold")}
    >
      <ShoppingCart size={18} aria-hidden /> Nueva venta
      <kbd className="ml-1 hidden rounded-md bg-white/20 px-1.5 py-0.5 font-sans text-[11px] font-semibold md:inline">Enter</kbd>
    </button>
  ) : (
    <Button variant="secondary" size="lg" className="w-full" onClick={() => p.onOpenChange(false)}>
      Cerrar
    </Button>
  );

  return (
    <PosSheet
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={p.summary ? `Venta ${p.summary.numberLabel}` : "Ticket"}
      description={p.summary ? `Total ${money(p.summary.total)}` : undefined}
      size="xl"
      focusContainer
      className="md:h-[min(92dvh,780px)] md:max-w-4xl"
    >
      <div className="slim-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_minmax(320px,360px)] md:overflow-hidden">
        {/* Vista previa */}
        <section
          aria-label="Vista previa del comprobante"
          className="flex flex-col bg-fg-4 px-4 pb-5 pt-3 md:slim-scrollbar md:min-h-0 md:overflow-y-auto md:px-8 md:pb-8 md:pt-6"
        >
          <div className="mb-4 flex items-center gap-3">
            <Segmented
              value={p.tab}
              options={TABS}
              onChange={p.onTab}
              aria-label="Vista del detalle"
              size="sm"
              className="w-full max-w-[240px]"
              fill
            />
          </div>
          {p.tab === "cobros" ? (
            <div className="rounded-xl border border-border bg-card p-4">{p.payments}</div>
          ) : (
            <PreviewArea {...p} visible={visible} />
          )}
        </section>

        {/* Acciones */}
        <aside className="order-first flex flex-col border-border md:order-none md:min-h-0 md:border-l">
          <div className="flex-1 px-4 pb-4 pt-4 md:slim-scrollbar md:min-h-0 md:overflow-y-auto md:px-5 md:pt-6">
            <SummaryBlock summary={p.summary} badge={badge} newSale={Boolean(onNewSale)} />

            <div className="mt-5 space-y-2">
              <p className={POS_EYEBROW}>Comprobante</p>
              <button
                type="button"
                onClick={onPrint}
                disabled={!visible}
                className={cn(
                  POS_QUIET,
                  "flex min-h-12 w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left",
                )}
              >
                <Printer size={18} aria-hidden className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">Imprimir ticket</span>
                  {p.printHint && <span className="block truncate text-xs text-muted-foreground">{p.printHint}</span>}
                </span>
                <kbd className="hidden rounded-md bg-fg-10 px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground md:inline">P</kbd>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <div className="[&>button]:h-11 [&>button]:w-full">{p.emailButton}</div>
                <Button variant="secondary" className="h-11 w-full" onClick={p.onPdf} disabled={!visible || p.pdfBusy}>
                  <FileDown size={16} aria-hidden /> PDF
                </Button>
                {p.onShare && (
                  <Button variant="secondary" className="h-11 w-full" onClick={p.onShare} disabled={!visible || p.shareBusy}>
                    <Share2 size={16} aria-hidden /> Compartir
                  </Button>
                )}
                <Link
                  href={p.saleHref as Route}
                  className={cn(
                    "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary px-3 text-sm font-semibold text-secondary-foreground transition hover:bg-secondary/70",
                    !p.onShare && "col-span-2",
                  )}
                >
                  <ExternalLink size={16} aria-hidden /> Ver venta
                </Link>
              </div>
              {p.emailPanel}
              {p.printFailed && (
                <Callout tone="danger" icon={AlertTriangle} title="No se pudo imprimir">
                  Revisá la impresora y volvé a intentar con Imprimir ticket.
                </Callout>
              )}
            </div>

            {p.fiscalDetail && (
              <div className="mt-5">
                <button
                  type="button"
                  aria-expanded={p.fiscalDetailOpen}
                  onClick={() => p.onFiscalDetail(!p.fiscalDetailOpen)}
                  className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left"
                >
                  <span className={POS_EYEBROW}>Factura electrónica</span>
                  <span className="text-xs font-semibold text-muted-foreground">
                    {p.fiscalDetailOpen ? "Ocultar" : "Ver detalle"}
                  </span>
                </button>
                {p.fiscalDetailOpen && <div className="mt-2">{p.fiscalDetail}</div>}
              </div>
            )}
          </div>
          <div className="hidden shrink-0 border-t border-border px-5 py-4 md:block">{mainAction}</div>
        </aside>
      </div>
      {/* Celular: la acción principal queda siempre a mano. */}
      <div className="shrink-0 border-t border-border bg-popover px-4 pb-3 pt-3 md:hidden">{mainAction}</div>
    </PosSheet>
  );
}
TicketSheet.displayName = "TicketSheet";

function SummaryBlock({
  summary,
  badge,
  newSale,
}: {
  summary: TicketSummary | null;
  badge: { tone: BadgeTone; label: string } | null;
  newSale: boolean;
}) {
  if (!summary) {
    return (
      <div className="space-y-2 pr-10 md:pr-8" aria-busy>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-3 w-48" />
      </div>
    );
  }
  return (
    <div className="pr-10 md:pr-8">
      <p className={cn(POS_EYEBROW, "flex items-center gap-1.5")}>
        {newSale && <Check size={13} className="text-success" aria-hidden />}
        {newSale ? "Venta cobrada" : "Venta"} {summary.numberLabel}
      </p>
      <p className="mt-1 font-price text-[2rem] font-semibold leading-none tabular-nums text-foreground">
        {money(summary.total)}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        {new Date(summary.createdAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
        {" · "}
        {summary.itemsCount} {summary.itemsCount === 1 ? "producto" : "productos"}
        {" · "}
        {summary.customerName || "Consumidor final"}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        {summary.statusLabel && <Badge tone="warning">{summary.statusLabel}</Badge>}
        {summary.homologacion && <Badge tone="neutral">Modo prueba</Badge>}
      </div>
      {summary.fiscalLabel && <p className="mt-2 text-xs font-medium text-foreground">{summary.fiscalLabel}</p>}
    </div>
  );
}

function PreviewArea(p: TicketSheetProps & { visible: boolean }) {
  const { phase } = p;
  if (p.visible) {
    return (
      <div className="flex flex-col items-center gap-3">
        {phase.kind !== "ready" && (
          <Callout tone="warning" icon={AlertTriangle} title="Comprobante provisorio" className="w-full max-w-md">
            Todavía no tiene CAE: no es una factura válida. Cuando ARCA la autorice, imprimí el ticket de nuevo.
          </Callout>
        )}
        <div className="w-full overflow-x-auto">{p.preview}</div>
      </div>
    );
  }
  if (phase.kind === "loading") {
    return <PaperSkeleton label="Preparando el comprobante" />;
  }
  if (phase.kind === "authorizing") {
    return (
      <div className="flex flex-col items-center gap-4">
        <StateCard
          icon={<Spinner size={22} label="Autorizando en ARCA" />}
          title={phase.slow ? "ARCA está tardando" : "Autorizando en ARCA"}
          text={
            phase.slow
              ? "Seguimos esperando el CAE. Podés esperar o imprimir un comprobante provisorio y reimprimir cuando llegue."
              : "Estamos pidiendo el CAE. El comprobante aparece apenas ARCA lo autorice."
          }
          progress
          steps={[
            { label: "Venta registrada", state: "done" },
            { label: "Pidiendo el CAE a ARCA", state: "active" },
            { label: "Comprobante listo para imprimir", state: "todo" },
          ]}
          actions={
            phase.slow ? (
              <Button variant="secondary" size="sm" onClick={p.onShowProvisional}>
                <FileText size={15} aria-hidden /> Ver provisorio
              </Button>
            ) : null
          }
        />
        <PaperSkeleton />
      </div>
    );
  }
  const failed = phase.kind === "failed";
  return (
    <div className="flex flex-col items-center gap-4">
      <StateCard
        tone={failed ? "danger" : "warning"}
        icon={failed ? <AlertTriangle size={22} aria-hidden /> : <CloudOff size={22} aria-hidden />}
        title={
          failed
            ? phase.status === "rechazado"
              ? "ARCA rechazó la factura"
              : "Falta algo para facturar"
            : "ARCA no responde"
        }
        text={
          <>
            {p.errorText && (
              <span className="block font-medium text-foreground">{p.errorText.title}.</span>
            )}
            {failed ? (
              p.canFix ? (
                <span className="block">{p.errorText?.action ?? "Revisá el detalle, corregí y reprocesá."}</span>
              ) : (
                <span className="block">Avisale al encargado: puede corregirla y reprocesarla desde Ventas.</span>
              )
            ) : (
              <span className="block">
                NinjaSoft reintenta solo{p.nextAttemptLabel ? ` (próximo intento ${p.nextAttemptLabel})` : ""}. Si el
                negocio tiene la contingencia CAEA activa, la factura puede salir en contingencia en el próximo intento.
              </span>
            )}
          </>
        }
        actions={
          <>
            {!failed && p.onRetry && (
              <Button variant="secondary" size="sm" onClick={p.onRetry} loading={p.retryBusy}>
                <RotateCcw size={15} aria-hidden /> Reintentar ahora
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={p.onPrintProvisional}>
              <Printer size={15} aria-hidden /> Imprimir provisorio
            </Button>
            {p.fiscalDetail && (
              <Button variant="ghost" size="sm" onClick={() => p.onFiscalDetail(!p.fiscalDetailOpen)}>
                {p.fiscalDetailOpen ? "Ocultar detalle" : "Ver detalle"}
              </Button>
            )}
          </>
        }
      />
      {p.fiscalDetailOpen && p.fiscalDetail && <div className="w-full max-w-md">{p.fiscalDetail}</div>}
      <PaperSkeleton muted />
    </div>
  );
}

function StateCard({
  icon,
  title,
  text,
  actions,
  tone = "info",
  progress,
  steps,
}: {
  icon: ReactNode;
  title: string;
  text: ReactNode;
  actions?: ReactNode;
  tone?: "info" | "warning" | "danger";
  progress?: boolean;
  steps?: { label: string; state: "done" | "active" | "todo" }[];
}) {
  const iconBox =
    tone === "danger" ? "bg-danger/15 text-danger" : tone === "warning" ? "bg-warning/15 text-warning" : "bg-info/15 text-info";
  return (
    <div role="status" aria-live="polite" className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card">
      {progress && (
        <div className="h-1 w-full overflow-hidden bg-fg-6" aria-hidden>
          <div className="ticket-progress h-full w-2/5 bg-[var(--pos-solid)]" />
        </div>
      )}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg", iconBox)}>{icon}</span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-base font-bold leading-tight">{title}</p>
            <div className="mt-1 space-y-1 text-sm text-muted-foreground">{text}</div>
          </div>
        </div>
        {steps && (
          <ol className="mt-4 space-y-2">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-2.5 text-sm">
                <span
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full",
                    s.state === "done" && "bg-success/15 text-success",
                    s.state === "active" && "bg-info/15 text-info",
                    s.state === "todo" && "bg-fg-6 text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {s.state === "done" ? (
                    <Check size={12} />
                  ) : s.state === "active" ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
                  )}
                </span>
                <span className={cn(s.state === "todo" ? "text-muted-foreground" : "text-foreground", s.state === "active" && "font-semibold")}>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        )}
        {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Silueta del ticket mientras no se puede mostrar. */
function PaperSkeleton({ label, muted }: { label?: string; muted?: boolean }) {
  return (
    <div
      aria-busy={label ? true : undefined}
      aria-label={label}
      className={cn("w-full max-w-[320px] space-y-3 rounded-lg border border-border bg-card p-5", muted && "opacity-60")}
    >
      <Skeleton className="mx-auto h-10 w-10 rounded-full" />
      <Skeleton className="mx-auto h-4 w-40" />
      <Skeleton className="mx-auto h-3 w-28" />
      <div className="space-y-2 border-t border-dashed border-border pt-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/6" />
      </div>
      <div className="flex justify-between border-t border-dashed border-border pt-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className="mx-auto h-16 w-16" />
    </div>
  );
}
