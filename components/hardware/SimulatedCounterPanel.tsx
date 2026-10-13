"use client";

import { useMemo, useState } from "react";
import {
  Ban,
  MonitorSmartphone,
  Printer,
  RefreshCw,
  RotateCcw,
  Trash2,
  Vault,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  columnsFor,
  decodeEscpos,
  encodeTicket,
  testTicketLines,
  CMD,
  type PaperWidth,
} from "@/lib/print/escpos";
import {
  PRINT_DOC_LABELS,
  PRINT_STATUS_LABELS,
  queueCounts,
  toBase64,
  type PrintJobStatus,
} from "@/lib/print/queue";
import {
  SIMULATED_FAULT_LABELS,
  SimulatedPrinter,
  type SimulatedFault,
} from "@/lib/print/simulator";
import { usePrintQueue } from "@/lib/print/usePrintQueue";
import { DrawerSimulatorTransport } from "@/lib/hardware/devices";
import {
  decodePole,
  encodePole,
  poleLines,
  type PoleState,
} from "@/lib/hardware/poleDisplay";
import type { useDiagnosticsLog } from "@/lib/hardware/diagnosticsLog";

// Mostrador simulado (F10 · ADR-101): prueba impresión ESC/POS, cola con
// reintentos, cajón y visor de 2 líneas SIN equipos. Los simuladores reciben
// exactamente los bytes que recibiría el equipo real; lo que se ve acá es la
// interpretación de esos bytes. Nada sale del navegador.

type Log = ReturnType<typeof useDiagnosticsLog>["log"];

const STATUS_DOT: Record<PrintJobStatus, string> = {
  pending: "bg-muted-foreground",
  printing: "bg-info",
  printed: "bg-success",
  failed: "bg-danger",
  cancelled: "bg-muted-foreground/50",
};

const PAPER_OPTIONS: SegmentedOption<"58" | "80">[] = [
  { value: "58", label: "58 mm" },
  { value: "80", label: "80 mm" },
];
const CUT_OPTIONS: SegmentedOption<"partial" | "full" | "none">[] = [
  { value: "partial", label: "Corte parcial" },
  { value: "full", label: "Total" },
  { value: "none", label: "Sin corte" },
];
const POLE_OPTIONS: SegmentedOption<PoleState["kind"]>[] = [
  { value: "idle", label: "Espera" },
  { value: "item", label: "Ítem" },
  { value: "total", label: "Total" },
  { value: "change", label: "Vuelto" },
  { value: "thanks", label: "Gracias" },
];

const POLE_SAMPLE: Record<PoleState["kind"], PoleState> = {
  idle: { kind: "idle", message: "Caja abierta" },
  item: {
    kind: "item",
    name: "Yerba mate 1 kg",
    qty: 2,
    price: 3250,
    total: 6500,
  },
  total: { kind: "total", total: 12840.5 },
  change: { kind: "change", paid: 15000, change: 2159.5 },
  thanks: { kind: "thanks", message: "Gracias por su compra" },
};

export function SimulatedCounterPanel({
  business,
  registerName,
  log,
}: {
  business: string | null;
  registerName: string | null;
  log: Log;
}) {
  const { toast } = useToast();
  const printer = useMemo(() => new SimulatedPrinter(), []);
  const [fault, setFault] = useState<SimulatedFault>("none");
  const [paper, setPaper] = useState<PaperWidth>(80);
  const [cut, setCut] = useState<"partial" | "full" | "none">("partial");
  const [density, setDensity] = useState<string>("auto");
  const [withDrawer, setWithDrawer] = useState(false);
  const [, force] = useState(0);

  const q = usePrintQueue(printer, (job) => {
    force((n) => n + 1);
    if (job.status === "printed") {
      log(
        "printer",
        "Cola de impresión (simulada)",
        "ok",
        `${job.label}: impreso al intento ${job.attempts}.`,
      );
    } else if (job.status === "failed") {
      log(
        "printer",
        "Cola de impresión (simulada)",
        "error",
        `${job.label}: falló ${job.attempts} veces (${job.lastError ?? "sin detalle"}).`,
      );
      toast({
        title: "No se pudo imprimir",
        description: job.lastError ?? undefined,
        variant: "error",
      });
    } else if (job.status === "pending" && job.lastError) {
      log(
        "printer",
        "Cola de impresión (simulada)",
        "warn",
        `${job.label}: ${job.lastError}. Reintenta solo.`,
      );
    }
  });
  const counts = queueCounts(q.queue);
  const last = printer.printed[0] ?? null;

  function changeFault(f: SimulatedFault) {
    printer.fault = f;
    setFault(f);
  }

  function testPrint() {
    const bytes = encodeTicket(
      testTicketLines({
        business: business ?? "",
        register: registerName,
        when: new Date(),
      }),
      {
        paper,
        cut,
        density: density === "auto" ? null : Number(density),
        drawer: withDrawer ? { pin: 2, onMs: 100, offMs: 100 } : null,
      },
    );
    q.add({
      doc: "test",
      label: `Prueba ${paper} mm`,
      printerId: "simulator",
      payload: toBase64(bytes),
    });
  }

  const [drawerResult, setDrawerResult] = useState<string | null>(null);
  async function testDrawer() {
    const t = new DrawerSimulatorTransport();
    await t.open();
    await t.write(new Uint8Array(CMD.drawer(2, 100, 100)));
    await t.close();
    const ev = decodeEscpos(t.received[0] ?? new Uint8Array()).events.find(
      (e) => e.kind === "drawer",
    );
    const msg =
      ev && ev.kind === "drawer"
        ? `Pulso recibido: pin ${ev.pin}, ${ev.onMs} ms encendido y ${ev.offMs} ms apagado.`
        : "El simulador no recibió el pulso.";
    setDrawerResult(msg);
    log("cash_drawer", "Abrir cajón (simulado)", ev ? "ok" : "error", msg);
  }

  const [pole, setPole] = useState<PoleState["kind"]>("idle");
  const poleShown = useMemo(
    () =>
      decodePole(
        encodePole(poleLines(POLE_SAMPLE[pole], business ?? "NinjaSoft")),
      ),
    [pole, business],
  );

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <Printer size={16} className="text-ninja-flameSoft" /> Mostrador
            simulado
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Probá la impresión ESC/POS, la cola con reintentos, el cajón y el
            visor de 2 líneas sin tener los equipos. Los simuladores reciben los
            mismos datos que el equipo real.
          </p>
        </div>

        {/* Impresora simulada + opciones del perfil */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                aria-label="Ancho de papel"
                size="sm"
                value={String(paper) as "58" | "80"}
                onChange={(v) => setPaper(Number(v) as PaperWidth)}
                options={PAPER_OPTIONS}
              />
              <Segmented
                aria-label="Corte de papel"
                size="sm"
                value={cut}
                onChange={setCut}
                options={CUT_OPTIONS}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Densidad"
                value={density}
                onChange={setDensity}
                options={[
                  { value: "auto", label: "La de la impresora" },
                  ...Array.from({ length: 8 }, (_, i) => ({
                    value: String(i + 1),
                    label: `Nivel ${i + 1}${i === 0 ? " (clara)" : i === 7 ? " (oscura)" : ""}`,
                  })),
                ]}
              />
              <Select
                label="Simular falla"
                value={fault}
                onChange={changeFault}
                options={(
                  Object.keys(SIMULATED_FAULT_LABELS) as SimulatedFault[]
                ).map((f) => ({ value: f, label: SIMULATED_FAULT_LABELS[f] }))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={withDrawer}
                onCheckedChange={setWithDrawer}
                label="Abrir el cajón al terminar el ticket"
              />
              Abrir el cajón al terminar el ticket
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={testPrint}>
                <Printer size={14} /> Ticket de prueba
              </Button>
              <Button size="sm" variant="secondary" onClick={testDrawer}>
                <Vault size={14} /> Abrir cajón
              </Button>
            </div>
            {drawerResult && (
              <p className="text-xs text-muted-foreground" role="status">
                {drawerResult}
              </p>
            )}
          </div>

          {/* Vista del papel */}
          <div>
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Último ticket
            </p>
            {last ? (
              <div className="overflow-x-auto rounded-md border border-border bg-background p-3">
                <pre
                  className="font-mono text-[11px] leading-4 text-foreground"
                  style={{ width: `${columnsFor(paper)}ch` }}
                  aria-label="Vista del ticket simulado"
                >
                  {last.lines.join("\n")}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  {last.bytes} bytes
                  {last.events.some((e) => e.kind === "cut") &&
                    ` · ${last.events.some((e) => e.kind === "cut" && e.partial) ? "corte parcial" : "corte total"}`}
                  {last.events.some((e) => e.kind === "drawer") &&
                    " · pulso de cajón"}
                  {last.events.some((e) => e.kind === "density") &&
                    " · densidad ajustada"}
                </p>
              </div>
            ) : (
              <EmptyState
                compact
                icon={Printer}
                title="Sin tickets todavía"
                description="Mandá un ticket de prueba."
              />
            )}
          </div>
        </div>

        {/* Cola */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              Cola de impresión
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {counts.pending + counts.printing} en curso · {counts.failed}{" "}
                con error
              </span>
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={q.clearFinished}
              disabled={counts.printed + counts.cancelled === 0}
            >
              <Trash2 size={14} /> Limpiar terminados
            </Button>
          </div>
          {q.queue.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              La cola está vacía.
            </p>
          ) : (
            <ul
              className="mt-2 divide-y divide-border rounded-lg border border-border"
              aria-live="polite"
            >
              {[...q.queue].reverse().map((j) => (
                <li
                  key={j.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        STATUS_DOT[j.status],
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{j.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {PRINT_DOC_LABELS[j.doc]} ·{" "}
                        {PRINT_STATUS_LABELS[j.status]} · intento {j.attempts}/
                        {j.maxAttempts}
                        {j.lastError && j.status !== "printed"
                          ? ` · ${j.lastError}`
                          : ""}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {(j.status === "failed" ||
                      (j.status === "pending" && j.attempts > 0)) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => q.retry(j.id)}
                        aria-label={`Reintentar ${j.label}`}
                      >
                        <RefreshCw size={14} /> Reintentar
                      </Button>
                    )}
                    {(j.status === "printed" || j.status === "cancelled") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => q.reprint(j.id)}
                        aria-label={`Reimprimir ${j.label}`}
                      >
                        <RotateCcw size={14} /> Reimprimir
                      </Button>
                    )}
                    {(j.status === "pending" || j.status === "failed") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => q.cancel(j.id)}
                        aria-label={`Cancelar ${j.label}`}
                      >
                        <Ban size={14} /> Cancelar
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Visor de cliente de 2 líneas */}
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <MonitorSmartphone size={15} className="text-ninja-flameSoft" />{" "}
            Visor de 2 líneas (20 caracteres)
          </p>
          <Segmented
            aria-label="Qué muestra el visor"
            size="sm"
            value={pole}
            onChange={setPole}
            options={POLE_OPTIONS}
          />
          <div className="w-fit max-w-full overflow-x-auto rounded-md border border-border bg-background px-3 py-2">
            <pre
              className="font-mono text-sm leading-5 text-success"
              aria-label="Visor simulado"
            >
              {poleShown.join("\n")}
            </pre>
          </div>
          <p className="text-xs text-muted-foreground">
            Para un visor real por serie o USB: los mismos comandos ESC/POS de
            visores (Epson DM-D y compatibles) por Web Serial o el puente local.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
