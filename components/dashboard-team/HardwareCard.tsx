"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  FileJson,
  MinusCircle,
  MonitorSmartphone,
  Printer,
  RefreshCw,
  ScanLine,
  Scale,
  Trash2,
  Usb,
  XCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { RegisterHardwareTests } from "@/components/hardware/RegisterHardwareTests";
import { SimulatedCounterPanel } from "@/components/hardware/SimulatedCounterPanel";
import { useBranchContext } from "@/modules/branches/hooks";
import { branchLabel } from "@/modules/branches/logic";
import { useRegisterHardwareList } from "@/modules/hardware/hooks";
import { emptyRegisterHardware } from "@/lib/hardware/config";
import { cn } from "@/lib/utils/cn";
import { useScanner, type ScanInfo } from "@/modules/pos/useScanner";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { useDefaultRegister } from "@/modules/pos/hooks";
import { sampleTicketData } from "@/lib/tickets/sample";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { ticketStyle } from "@/components/invoices/InvoicePreview";
import { docOptions, invoiceFromTicket } from "@/lib/invoices/fromTicket";
import { useInvoiceStyle } from "@/modules/invoices/hooks";
import { DISPLAY_CHANNEL } from "@/lib/pos/customerDisplay";
import {
  detectCapabilities,
  detectEnv,
  type Capability,
  type EnvInfo,
} from "@/lib/hardware/capabilities";
import {
  AREA_LABELS,
  useDiagnosticsLog,
  type DiagResult,
} from "@/lib/hardware/diagnosticsLog";
import {
  buildDiagnosticPayload,
  exportDiagnosticJson,
  exportDiagnosticXlsx,
} from "@/lib/hardware/export";
import { onlyActiveTenant } from "@/lib/tenant/scope";

// =============================================================================
// Centro de diagnostico de hardware (F10 - H26)
// -----------------------------------------------------------------------------
// Una pantalla donde el negocio (y soporte NinjaSoft) ve el estado de los
// perifericos del POS, corre pruebas guiadas y exporta un diagnostico para
// soporte, sin que soporte tenga que conectarse a la maquina del cliente.
//
// Honestidad sobre limites del navegador: balanza y cajon funcionan con Web
// Serial / WebUSB (Chrome o Edge de escritorio) o el puente local (ADR-063);
// los monitores no se controlan como en una app nativa. Cada tarjeta dice
// con claridad que se puede probar de verdad.
// =============================================================================

// ---- Badge de estado reutilizable -------------------------------------------
type StateKind = "ok" | "warn" | "unavailable" | "connector" | "info";

const STATE_META: Record<
  StateKind,
  { label: string; icon: React.ElementType; cls: string }
> = {
  ok: {
    label: "OK",
    icon: CheckCircle2,
    cls: "bg-emerald-500/15 text-success",
  },
  warn: {
    label: "Advertencia",
    icon: AlertTriangle,
    cls: "bg-amber-500/15 text-warning",
  },
  unavailable: {
    label: "No disponible",
    icon: XCircle,
    cls: "bg-rose-500/15 text-danger",
  },
  connector: {
    label: "Requiere conector local",
    icon: Usb,
    cls: "bg-sky-500/15 text-info",
  },
  info: { label: "Info", icon: MinusCircle, cls: "bg-muted text-muted-foreground" },
};

function StatusBadge({ kind, label }: { kind: StateKind; label?: string }) {
  const m = STATE_META[kind];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium",
        m.cls,
      )}
    >
      <Icon size={13} className="shrink-0" />
      {label ?? m.label}
    </span>
  );
}

// Mapea el estado de una capacidad del browser a un badge.
const CAP_KIND: Record<Capability["status"], StateKind> = {
  ok: "ok",
  partial: "warn",
  unavailable: "unavailable",
};

// ---- Tarjeta de periferico ---------------------------------------------------
function PeripheralCard({
  icon: Icon,
  title,
  description,
  status,
  statusLabel,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  status: StateKind;
  statusLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 shrink-0 rounded-lg bg-ninja-flame/12 p-2 text-ninja-flameSoft">
              <Icon size={18} />
            </span>
            <div className="min-w-0">
              <div className="font-semibold">{title}</div>
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            </div>
          </div>
          <StatusBadge kind={status} label={statusLabel} />
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

const RESULT_DOT: Record<DiagResult, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-rose-500",
  info: "bg-muted-foreground",
};

export function HardwareCard() {
  const supabase = createClient();
  const { toast } = useToast();
  const { log, entries, clear } = useDiagnosticsLog();

  // Identidad del negocio/caja para el header del export (solo nombre/slug).
  const { data: ctx } = useQuery({
    queryKey: ["hardware-diag-ctx"],
    queryFn: async (): Promise<{
      tenantName: string | null;
      tenantSlug: string | null;
    } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await onlyActiveTenant(
        supabase
          .from("tenant_users")
          .select("tenant_id, tenants(name, slug)")
          .eq("user_id", user.id)
          .eq("status", "active"),
        user,
      )
        .limit(1)
        .maybeSingle();
      const t = (mem as { tenants?: { name?: string; slug?: string } } | null)?.tenants;
      return { tenantName: t?.name ?? null, tenantSlug: t?.slug ?? null };
    },
  });
  const { data: register } = useDefaultRegister();
  const { data: brand } = useTicketBranding();

  // Capacidades + entorno: se detectan en el cliente tras montar (evita SSR).
  const [caps, setCaps] = useState<Capability[]>([]);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const refreshEnv = () => {
    setCaps(detectCapabilities());
    setEnv(detectEnv());
  };
  useEffect(() => {
    refreshEnv();
  }, []);

  const capByKey = useMemo(() => {
    const m: Record<string, Capability> = {};
    for (const c of caps) m[c.key] = c;
    return m;
  }, [caps]);

  // -- Prueba de impresion: render oculto + window.print() (patron ticket-print).
  const [printing, setPrinting] = useState(false);
  const ticketRef = useRef<HTMLDivElement>(null);
  const sample = useMemo(() => sampleTicketData(brand ?? null), [brand]);
  // ADR-119: la prueba sale con el modelo de ticket del negocio.
  const invoice = useInvoiceStyle(brand ?? null, true);
  const sampleDoc = useMemo(
    () =>
      invoiceFromTicket(
        { ...sample, brand: invoice.brand ?? sample.brand },
        docOptions(invoice.style, { nonFiscalLabel: "Ticket de prueba" }),
      ),
    [sample, invoice],
  );
  function testPrint() {
    if (typeof window === "undefined" || typeof window.print !== "function") {
      log("printer", "Imprimir ticket de prueba", "error", "El navegador no expone window.print().");
      toast({ title: "Impresion no disponible", variant: "error" });
      return;
    }
    setPrinting(true);
    // Deja pintar el ticket oculto antes de abrir el dialogo del sistema.
    setTimeout(() => {
      try {
        window.print();
        log(
          "printer",
          "Imprimir ticket de prueba",
          "ok",
          "Se abrio el dialogo de impresion del sistema (web print). Confirma en la impresora que el ticket salio legible.",
        );
      } catch {
        log("printer", "Imprimir ticket de prueba", "error", "Fallo al abrir el dialogo de impresion.");
      } finally {
        setPrinting(false);
      }
    }, 250);
  }

  // -- Prueba de escaner: captura en vivo con useScanner (mismo motor del POS).
  const [scannerArmed, setScannerArmed] = useState(false);
  const [captures, setCaptures] = useState<(ScanInfo & { at: number })[]>([]);
  useScanner(() => {}, {
    enabled: scannerArmed,
    onRaw: (info) => {
      setCaptures((prev) => [{ ...info, at: Date.now() }, ...prev].slice(0, 8));
      log(
        "scanner",
        "Lectura de prueba",
        info.duplicate ? "warn" : "ok",
        `Codigo "${info.code}" (${info.format}, ${info.length} digitos, ${Math.round(info.durationMs)}ms${info.duplicate ? ", duplicado ignorado" : ""}).`,
      );
    },
  });

  // -- Prueba de pantalla del cliente: abrir ventana + round-trip BroadcastChannel.
  function openDisplay() {
    window.open("/customer-display", "ninja-customer-display", "noopener");
    log("customer_display", "Abrir pantalla de prueba", "ok", "Se abrio la ventana /customer-display.");
  }
  const [bcTesting, setBcTesting] = useState(false);
  function testBroadcast() {
    if (!("BroadcastChannel" in window)) {
      log(
        "customer_display",
        "Probar sincronizacion",
        "warn",
        "BroadcastChannel no esta disponible: la pantalla del cliente usa el respaldo por localStorage.",
      );
      toast({ title: "Sin BroadcastChannel (usa respaldo)", variant: "info" });
      return;
    }
    setBcTesting(true);
    const token = `ping-${Date.now()}`;
    let done = false;
    const rx = new BroadcastChannel(DISPLAY_CHANNEL);
    const tx = new BroadcastChannel(DISPLAY_CHANNEL);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        rx.close();
        tx.close();
      } catch {
        /* noop */
      }
      setBcTesting(false);
      if (ok) {
        log(
          "customer_display",
          "Probar sincronizacion",
          "ok",
          "BroadcastChannel responde: la pantalla del cliente se sincroniza en vivo en este equipo.",
        );
        toast({ title: "Canal de sincronizacion OK", variant: "success" });
      } else {
        log(
          "customer_display",
          "Probar sincronizacion",
          "warn",
          "No se recibio el eco del canal (cae al respaldo por localStorage).",
        );
        toast({ title: "Sin eco del canal (usa respaldo)", variant: "info" });
      }
    };
    rx.onmessage = (e) => {
      if ((e.data as { __diag?: string } | null)?.__diag === token) finish(true);
    };
    // Damos un tick para que el receptor quede suscripto antes de emitir.
    setTimeout(() => tx.postMessage({ __diag: token }), 30);
    setTimeout(() => finish(false), 800);
  }

  // -- Export del diagnostico ----------------------------------------------------
  const [exporting, setExporting] = useState(false);
  function buildPayload() {
    return buildDiagnosticPayload({
      context: {
        tenantName: ctx?.tenantName ?? null,
        tenantSlug: ctx?.tenantSlug ?? null,
        registerName: register?.name ?? null,
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      },
      environment: env,
      capabilities: caps,
      tests: entries,
    });
  }
  async function exportXls() {
    setExporting(true);
    try {
      await exportDiagnosticXlsx(buildPayload());
      log("environment", "Exportar diagnostico (XLSX)", "ok", "Se descargo el diagnostico en XLSX.");
    } catch {
      toast({ title: "No se pudo exportar", variant: "error" });
    } finally {
      setExporting(false);
    }
  }
  function exportJson() {
    try {
      exportDiagnosticJson(buildPayload());
      log("environment", "Exportar diagnostico (JSON)", "ok", "Se descargo el diagnostico en JSON.");
    } catch {
      toast({ title: "No se pudo exportar", variant: "error" });
    }
  }

  const printCap = capByKey.webprint;
  const bcCap = capByKey.broadcastChannel;
  const cameraCap = capByKey.barcodeDetector;

  return (
    <section className="space-y-5">
      {/* Export - bloque destacado arriba para acceso rapido de soporte. */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Download size={16} className="text-ninja-flameSoft" /> Exportar diagnostico
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Baja un archivo con las capacidades del equipo, el entorno y los
              resultados de las pruebas. Sin datos sensibles (no incluye claves,
              tokens ni datos de clientes).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={exportXls} disabled={exporting}>
              <Download size={15} /> {exporting ? "Generando..." : "Exportar (XLSX)"}
            </Button>
            <Button variant="secondary" onClick={exportJson}>
              <FileJson size={15} /> JSON
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tarjetas por periferico */}
      <div className="grid gap-4">
        {/* Impresora / impresion */}
        <PeripheralCard
          icon={Printer}
          title="Impresora / impresion"
          description="Metodo disponible: impresion web (window.print). Imprime termica 58/80mm o A4 por el dialogo del sistema."
          status={printCap?.status === "ok" ? "ok" : "unavailable"}
          statusLabel={printCap?.status === "ok" ? "Web print disponible" : undefined}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={testPrint} disabled={printing}>
              <Printer size={14} /> {printing ? "Abriendo..." : "Imprimir ticket de prueba"}
            </Button>
            <span className="text-xs text-muted-foreground">
              El pulso del cajon se manda directo a la termica (Web Serial, WebUSB o el
              puente local): ver Balanza y cajon.
            </span>
          </div>
        </PeripheralCard>

        {/* Escaner */}
        <PeripheralCard
          icon={ScanLine}
          title="Escaner"
          description="Proba tu lector USB/HID aca: escanea sin hacer clic en ningun campo. Usa el mismo motor que el POS (Configuracion -> Escaner)."
          status={scannerArmed ? "ok" : "info"}
          statusLabel={
            scannerArmed
              ? captures.length > 0
                ? `${captures.length} lectura(s)`
                : "Esperando lectura"
              : "Inactivo"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={scannerArmed ? "secondary" : "primary"}
              onClick={() => {
                setScannerArmed((v) => !v);
                if (!scannerArmed) setCaptures([]);
              }}
            >
              <ScanLine size={14} /> {scannerArmed ? "Detener prueba" : "Iniciar prueba"}
            </Button>
            {captures.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setCaptures([])}>
                <Trash2 size={14} /> Limpiar
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              Camara (BarcodeDetector):{" "}
              {cameraCap?.status === "ok" ? "disponible" : "no disponible en este navegador"}.
            </span>
          </div>
          {scannerArmed && (
            <div className="mt-2 overflow-x-auto rounded-lg border border-border">
              {captures.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Escanea un producto...
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Hora</th>
                      <th className="px-3 py-2 font-medium">Codigo</th>
                      <th className="px-3 py-2 text-right font-medium">Largo</th>
                      <th className="px-3 py-2 text-right font-medium">ms</th>
                      <th className="px-3 py-2 font-medium">Formato</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {captures.map((c, i) => (
                      <tr key={c.at + "-" + i} className="border-b border-border/60">
                        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                          {new Date(c.at).toLocaleTimeString("es-AR")}
                        </td>
                        <td className="px-3 py-1.5 font-mono">{c.code}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.length}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {Math.round(c.durationMs)}
                        </td>
                        <td className="px-3 py-1.5">{c.format}</td>
                        <td className="px-3 py-1.5">
                          {c.duplicate && (
                            <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-warning">
                              dup
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </PeripheralCard>

        {/* Pantalla del cliente */}
        <PeripheralCard
          icon={MonitorSmartphone}
          title="Pantalla del cliente"
          description="Segunda pantalla (monitor o tablet) que muestra el carrito y el total en vivo. Abri la prueba y verifica la sincronizacion."
          status={bcCap?.status === "ok" ? "ok" : "warn"}
          statusLabel={
            bcCap?.status === "ok" ? "BroadcastChannel OK" : "Usa respaldo (localStorage)"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={openDisplay}>
              <ExternalLink size={14} /> Abrir pantalla de prueba
            </Button>
            <Button size="sm" onClick={testBroadcast} disabled={bcTesting}>
              <RefreshCw size={14} className={bcTesting ? "animate-spin" : undefined} />{" "}
              {bcTesting ? "Probando..." : "Probar sincronizacion"}
            </Button>
            <span className="text-xs text-muted-foreground">
              El navegador no puede mover la ventana a otro monitor por su cuenta:
              arrastrala vos y ponela en pantalla completa (F11).
            </span>
          </div>
        </PeripheralCard>

        {/* Balanza y cajon por caja (ADR-063): prueban la config efectiva de la caja. */}
        <PeripheralCard
          icon={Scale}
          title="Balanza y cajon"
          description="Prueban los equipos cargados en la caja elegida (Configuracion, Hardware, Que tiene cada caja). El cajon pasa por el servidor, que registra la prueba, y se abre con el pulso ESC/POS de su impresora."
          status={capByKey.webserial?.status === "unavailable" ? "warn" : "ok"}
          statusLabel={capByKey.webserial?.status === "unavailable" ? "Sin Web Serial (usa el puente)" : "Web Serial disponible"}
        >
          <RegisterTestsPicker />
        </PeripheralCard>
      </div>

      {/* Mostrador simulado (ADR-101): impresión ESC/POS, cola, cajón y visor sin equipos. */}
      <SimulatedCounterPanel business={ctx?.tenantName ?? null} registerName={register?.name ?? null} log={log} />

      {/* Entorno / capacidades del navegador */}
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              <Cpu size={16} className="text-ninja-flameSoft" /> Entorno y capacidades del navegador
            </div>
            <Button size="sm" variant="ghost" onClick={refreshEnv}>
              <RefreshCw size={14} /> Actualizar
            </Button>
          </div>

          {/* Capacidades */}
          <div className="grid gap-2 sm:grid-cols-2">
            {caps.map((c) => (
              <div
                key={c.key}
                className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{c.label}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>
                </div>
                <StatusBadge kind={CAP_KIND[c.status]} />
              </div>
            ))}
          </div>

          {/* Datos del equipo */}
          {env && (
            <dl className="grid gap-x-6 gap-y-1.5 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
              <EnvRow label="Navegador" value={env.userAgent} mono full />
              <EnvRow label="Plataforma" value={env.platform} />
              <EnvRow label="Idioma" value={env.language} />
              <EnvRow label="Pantalla" value={env.screen} />
              <EnvRow label="Ventana" value={env.viewport} />
              <EnvRow label="Densidad" value={`${env.devicePixelRatio}x`} />
              <EnvRow label="Conexion" value={env.online ? "En linea" : "Sin conexion"} />
              <EnvRow
                label="Nucleos"
                value={env.hardwareConcurrency != null ? String(env.hardwareConcurrency) : "-"}
              />
              <EnvRow
                label="Memoria"
                value={env.deviceMemoryGb != null ? `${env.deviceMemoryGb} GB` : "-"}
              />
              <EnvRow label="Tactil" value={env.touch ? "Si" : "No"} />
              <EnvRow label="Origen seguro (HTTPS)" value={env.secureContext ? "Si" : "No"} />
            </dl>
          )}
        </CardContent>
      </Card>

      {/* Log local de pruebas */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">Registro de pruebas (local)</div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Historial de las pruebas que corriste en este equipo. Se guarda
                solo aca (en este navegador) y se incluye en el diagnostico.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={entries.length === 0}
            >
              <Trash2 size={14} /> Limpiar
            </Button>
          </div>

          {entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Todavia no corriste ninguna prueba.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {entries.map((e) => (
                <li key={e.id} className="flex items-start gap-3 py-2.5">
                  <span
                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", RESULT_DOT[e.result])}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-medium">{AREA_LABELS[e.area]}</span>
                      <span className="text-muted-foreground">- {e.action}</span>
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                        {new Date(e.at).toLocaleString("es-AR")}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Ticket oculto para la prueba de impresion: solo visible al imprimir
          (.ticket-print aisla la hoja; en pantalla queda fuera del viewport). */}
      {printing && (
        <div
          ref={ticketRef}
          aria-hidden
          className="ticket-print pointer-events-none fixed -left-[9999px] top-0"
        >
          <InvoiceDocument
            doc={sampleDoc}
            style={ticketStyle(invoice.style, brand?.ticket_show_logo)}
            format={brand?.ticket_width === "58" ? "58" : "80"}
          />
        </div>
      )}
    </section>
  );
}

// Caja a probar: por defecto la de este equipo.
function RegisterTestsPicker() {
  const ctx = useBranchContext();
  const { data: current } = useDefaultRegister();
  const { data: list } = useRegisterHardwareList();
  const options = ctx.allowed
    .filter((b) => !b.deleted_at)
    .flatMap((b) =>
      b.registers
        .filter((r) => !r.deleted_at)
        .map((r) => ({ value: r.id, storeId: b.id, label: ctx.isMulti ? `${branchLabel(b)} · ${r.name}` : r.name })),
    );
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? current?.id ?? options[0]?.value ?? null;
  const opt = options.find((o) => o.value === id) ?? null;
  if (!opt) return <p className="text-sm text-muted-foreground">No hay cajas cargadas.</p>;
  const hw = list?.find((h) => h.registerId === opt.value) ?? emptyRegisterHardware(opt.value, opt.storeId);
  return (
    <div className="space-y-3">
      {options.length > 1 && (
        <Select<string>
          label="Caja a probar"
          value={opt.value}
          onChange={setPicked}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
          className="sm:max-w-xs"
        />
      )}
      <RegisterHardwareTests key={opt.value} hw={hw} label={opt.label} />
    </div>
  );
}

function EnvRow({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={cn("flex flex-col", full && "sm:col-span-2")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")} title={value}>
        {value}
      </dd>
    </div>
  );
}
