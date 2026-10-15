"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, FileMinus, FileText, Link2, RefreshCw, Send, Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatCurrency } from "@/lib/utils/format";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import { conditionLabel } from "@/lib/billing/letter";
import {
  DOC_ORIGIN_LABELS,
  LOGISTIC_LABELS,
  PLAN_STATUS_LABELS,
  RECEPTOR_CHOICE_LABELS,
  SOURCE_LABELS,
  STRATEGY_LABELS,
  UPLOAD_STATUS_LABELS,
  billingErrorMessage,
  canEmit,
  docNumber,
  effectiveLetter,
  letterChoices,
  planStatusTone,
  warningLabel,
  type InboxRow,
  type ReceptorChoice,
} from "@/lib/mercadolibre/billing";
import { jurisdictionName } from "@/supabase/functions/_shared/mercadolibre/perceptionLink";
import { useMlBillingMutations, type PerceptionLinkResult } from "@/modules/mercadolibre/billingHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

const errText = (e: unknown) => billingErrorMessage(e) ?? mlErrorMessage(e);
const pct = (n: number) => `${String(Math.round(n * 100) / 100).replace(".", ",")} %`;

// Detalle de una venta de la bandeja (ADR-141): qué se factura (renglones,
// cupón, envío y el control de lo cobrado), a quién (datos del comprador o
// consumidor final, letra dentro de la matriz de ARCA, punto de venta,
// concepto y formato), la percepción con su link de pago y los comprobantes
// con qué se sube a la venta en Mercado Libre.
export function MlInvoiceDetail({
  row,
  account,
  emitter,
  canManage,
  onClose,
}: {
  row: InboxRow | null;
  account: MlAccount;
  emitter: { iva_condition: string | null; issues_m: boolean };
  canManage: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const m = useMlBillingMutations();
  const [choice, setChoice] = useState<ReceptorChoice>("billing");
  const [letter, setLetter] = useState("");
  const [pv, setPv] = useState("");
  const [concepto, setConcepto] = useState("");
  const [format, setFormat] = useState("");
  const [preview, setPreview] = useState<PerceptionLinkResult | null>(null);
  const [sendMsg, setSendMsg] = useState(true);
  const [paidRef, setPaidRef] = useState("");
  const [askNc, setAskNc] = useState(false);

  useEffect(() => {
    if (!row) return;
    setChoice(row.choice);
    setLetter(row.letter ?? "");
    setPv(row.pto_vta ? String(row.pto_vta) : "");
    setConcepto(row.concepto ? String(row.concepto) : "");
    setFormat(row.pdf_format ?? "");
    setPreview(null);
    setPaidRef("");
  }, [row]);

  const receptor = row ? row.plan.receptors[choice] : null;
  const options = useMemo(
    () => (receptor ? letterChoices(emitter.iva_condition, receptor, emitter.issues_m) : []),
    [receptor, emitter.iva_condition, emitter.issues_m],
  );
  if (!row || !receptor) return null;

  const plan = row.plan;
  const invoiced = Boolean(row.document);
  const editable = canManage && !invoiced && !["cancelled", "queued", "approved"].includes(row.status);
  const dirty =
    choice !== row.choice ||
    (letter || null) !== (row.letter ?? null) ||
    (pv || null) !== (row.pto_vta ? String(row.pto_vta) : null) ||
    (concepto || null) !== (row.concepto ? String(row.concepto) : null) ||
    (format || null) !== (row.pdf_format ?? null);
  const perc = plan.perception;
  const charge = row.charge;
  const chargeOpen = charge?.status === "link_sent";
  const chargePaid = charge?.status === "paid" || charge?.status === "paid_manual";
  const factura = row.documents.find((d) => d.origin === "sale" && d.status === "aprobado");
  const hasNc = row.documents.some((d) => d.origin !== "sale");

  const save = () =>
    m.choose.mutate(
      {
        planId: row.id,
        p: { choice, letter: letter || null, pto_vta: pv || null, concepto: concepto || null, pdf_format: format || null },
      },
      {
        onSuccess: () => toast({ title: "Elección guardada", variant: "success" }),
        onError: (e) => toast({ title: "No se pudo guardar", description: errText(e), variant: "error" }),
      },
    );

  const emitNow = () =>
    m.emit.mutate(
      { planIds: [row.id], force: row.status === "needs_review" || row.status === "blocked" },
      {
        onSuccess: (res) => {
          const r0 = res.results[0];
          if (r0?.ok) {
            toast({ title: `Factura ${r0.letter ?? ""} en la cola de ARCA`, variant: "success" });
            onClose();
          } else toast({ title: "No se facturó", description: errText(r0?.error ?? ""), variant: "error" });
        },
        onError: (e) => toast({ title: "No se facturó", description: errText(e), variant: "error" }),
      },
    );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copiado", variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar", variant: "error" });
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={row.sale_number ? `Venta #${row.sale_number} de Mercado Libre` : `Carrito ${row.pack_key}`}
      description={`${PLAN_STATUS_LABELS[row.status] ?? row.status} · ${LOGISTIC_LABELS[plan.logistic]}`}
      className="sm:max-w-2xl"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {editable && (
            <Button
              variant="secondary"
              loading={m.replan.isPending}
              onClick={() =>
                m.replan.mutate(
                  { accountId: account.id, packKey: row.pack_key },
                  {
                    onSuccess: () => toast({ title: "Factura rearmada con las reglas de hoy", variant: "success" }),
                    onError: (e) => toast({ title: "No se pudo rearmar", description: errText(e), variant: "error" }),
                  },
                )
              }
            >
              <RefreshCw size={15} /> Rearmar
            </Button>
          )}
          {editable && dirty && (
            <Button variant="secondary" onClick={save} loading={m.choose.isPending}>
              Guardar elección
            </Button>
          )}
          {editable && !dirty && canEmit(row) && (
            <Button onClick={emitNow} loading={m.emit.isPending}>
              <FileText size={15} /> Facturar {effectiveLetter(row) ?? ""}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={planStatusTone(row.status)}>{PLAN_STATUS_LABELS[row.status] ?? row.status}</Badge>
          {row.warnings.map((w) => (
            <Badge key={w} tone="warning">
              {warningLabel(w)}
            </Badge>
          ))}
        </div>
        {row.last_error && <Callout tone="danger">{billingErrorMessage(row.last_error) ?? row.last_error}</Callout>}

        {/* Qué se factura. */}
        <section aria-label="Qué se factura" className="space-y-2">
          <h3 className="text-sm font-semibold">Qué se factura</h3>
          <ul className="divide-y divide-border rounded-lg bg-secondary/40 text-sm">
            {plan.items.map((it, i) => (
              <li key={`${it.ml_item_id}-${i}`} className="flex justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{it.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {it.quantity} x {formatCurrency(it.unit_price)}
                    {it.unit_price !== it.list_unit_price && ` (publicado a ${formatCurrency(it.list_unit_price)})`}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(it.gross)}</span>
              </li>
            ))}
            {plan.coupon.discount > 0 && (
              <li className="flex justify-between px-3 py-2">
                <span>Descuento cupón</span>
                <span className="tabular-nums">−{formatCurrency(plan.coupon.discount)}</span>
              </li>
            )}
            {plan.shipping.line && (
              <li className="flex justify-between px-3 py-2">
                <span>{plan.shipping.label}</span>
                <span className="tabular-nums">{formatCurrency(plan.shipping.amount)}</span>
              </li>
            )}
            <li className="flex justify-between px-3 py-2 font-semibold">
              <span>Total de la factura{perc.applies && choice === "billing" && row.perception_mode === "charge" ? " (sin percepción)" : ""}</span>
              <span className="tabular-nums">{formatCurrency(plan.totals.invoice)}</span>
            </li>
          </ul>
          <p className="text-xs text-muted-foreground">
            {plan.shipping.kind === "a_convenir"
              ? "Envío a convenir: no va en esta factura. Si el comprador te paga el envío aparte, facturalo aparte."
              : plan.shipping.kind === "free"
                ? "Envío gratis o bonificado: no va en la factura."
                : plan.shipping.kind === "buyer_paid" && !plan.shipping.line
                  ? "El envío lo pagó el comprador pero tu regla es no sumarlo a la factura."
                  : null}
            {plan.coupon.total > 0 && plan.coupon.mode === "none" && " El cupón no se descuenta (regla de la cuenta)."}
            {" "}Comisiones y cargos de Mercado Libre nunca van en la factura al comprador.
          </p>
          {plan.totals.collected != null && (
            <p className="text-xs text-muted-foreground">
              Cobrado por Mercado Libre: {formatCurrency(plan.totals.collected)}
              {plan.totals.diff != null && Math.abs(plan.totals.diff) > 0.009 && (
                <span className="text-warning"> · diferencia {formatCurrency(plan.totals.diff)}</span>
              )}
            </p>
          )}
        </section>

        {/* A quién. */}
        <section aria-label="A quién se factura" className="space-y-2">
          <h3 className="text-sm font-semibold">A quién se factura</h3>
          <div role="radiogroup" aria-label="Receptor" className="grid gap-2 sm:grid-cols-2">
            {(["billing", "consumidor_final"] as const).map((k) => {
              const r = plan.receptors[k];
              return (
                <ChoiceCard
                  key={k}
                  selected={choice === k}
                  disabled={!editable}
                  indicator
                  onClick={() => {
                    setChoice(k);
                    setLetter("");
                  }}
                  title={RECEPTOR_CHOICE_LABELS[k]}
                  description={`${r.name} · ${r.doc_number ? `${(r.doc_type ?? "").toUpperCase()} ${r.doc_number}` : "sin documento"} · ${conditionLabel(r.iva_condition)}`}
                >
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {SOURCE_LABELS[r.source]}
                    {r.letter ? ` · Factura ${r.letter}` : ""}
                  </span>
                </ChoiceCard>
              );
            })}
          </div>
          {receptor.address && <p className="text-xs text-muted-foreground">Domicilio: {receptor.address}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-muted-foreground">Tipo de factura</span>
              <select className={selectCls} value={letter} disabled={!editable} onChange={(e) => setLetter(e.target.value)} aria-label="Tipo de factura">
                <option value="">{receptor.letter ? `Factura ${receptor.letter} (sugerida)` : "Sugerida"}</option>
                {options
                  .filter((o) => o.letter !== "E")
                  .map((o) => (
                    <option key={o.letter} value={o.letter} disabled={!o.allowed}>
                      Factura {o.letter}
                      {o.suggested ? " (sugerida)" : ""}
                      {!o.allowed ? " · ARCA no la acepta" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <Input
              label="Punto de venta"
              inputMode="numeric"
              placeholder="El de la cuenta"
              value={pv}
              disabled={!editable}
              onChange={(e) => setPv(e.target.value.replace(/\D/g, "").slice(0, 5))}
            />
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-muted-foreground">Concepto</span>
              <select className={selectCls} value={concepto} disabled={!editable} onChange={(e) => setConcepto(e.target.value)} aria-label="Concepto">
                <option value="">El de la cuenta</option>
                <option value="1">Productos</option>
                <option value="2">Servicios</option>
                <option value="3">Productos y servicios</option>
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-muted-foreground">PDF que se sube a la venta</span>
              <select className={selectCls} value={format} disabled={!editable} onChange={(e) => setFormat(e.target.value)} aria-label="Formato del PDF">
                <option value="">El de la cuenta</option>
                <option value="a4">Hoja A4</option>
                <option value="ticket">Ticket</option>
              </select>
            </label>
          </div>
          {letter && options.find((o) => o.letter === letter && !o.allowed)?.reason && (
            <p className="text-xs text-danger">{options.find((o) => o.letter === letter)?.reason}</p>
          )}
        </section>

        {/* Percepción. */}
        {(perc.applies || perc.skipped.length > 0) && (
          <section aria-label="Percepción de Ingresos Brutos" className="space-y-2">
            <h3 className="text-sm font-semibold">Percepción de Ingresos Brutos</h3>
            {perc.applies ? (
              <>
                <ul className="divide-y divide-border rounded-lg bg-secondary/40 text-sm">
                  {perc.lines.map((l) => (
                    <li key={l.jurisdiction} className="flex justify-between gap-3 px-3 py-2">
                      <span>
                        {jurisdictionName(l.jurisdiction)} · {pct(l.effective_rate)}
                        <span className="block text-xs text-muted-foreground">
                          {l.source === "padron" ? "Padrón" : "Alícuota fija"}
                          {l.base_pct !== 100 ? ` · ${l.base_pct} % de la base` : ""} · base {formatCurrency(l.base)}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between px-3 py-2 font-semibold">
                    <span>Total a percibir</span>
                    <span className="tabular-nums">{formatCurrency(perc.total)}</span>
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  Regla para {LOGISTIC_LABELS[plan.logistic]}: {perc.strategy ? STRATEGY_LABELS[perc.strategy] : "sin regla"}.
                  {choice === "consumidor_final" ? " A consumidor final no se percibe." : ""}
                  {row.perception_mode === "skip" && choice === "billing" ? " Elegiste facturar sin percibir." : ""}
                </p>
                {charge && (
                  <div className="space-y-1 rounded-lg bg-secondary/40 px-3 py-2 text-sm">
                    <p>
                      Link de pago:{" "}
                      <Badge tone={chargePaid ? "success" : chargeOpen ? "warning" : "neutral"}>
                        {chargePaid ? "Cobrada" : chargeOpen ? "Esperando el pago" : charge.status === "expired" ? "Vencido" : charge.status === "paid_late" ? "Pagó tarde" : "Cancelado"}
                      </Badge>
                    </p>
                    {chargeOpen && charge.expires_at && (
                      <p className="text-xs text-muted-foreground">
                        Vence el {new Date(charge.expires_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" })}
                        {charge.message_sent_at ? " · mensaje enviado" : charge.message_error ? ` · el mensaje no salió: ${charge.message_error}` : ""}
                      </p>
                    )}
                    {charge.init_point && chargeOpen && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button size="sm" variant="secondary" onClick={() => copy(charge.init_point!)}>
                          <Copy size={14} /> Copiar link
                        </Button>
                        {canManage && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={m.perceptionMessage.isPending}
                            onClick={() =>
                              m.perceptionMessage.mutate(row.id, {
                                onSuccess: () => toast({ title: "Mensaje enviado al comprador", variant: "success" }),
                                onError: (e) => toast({ title: "No se pudo mandar", description: errText(e), variant: "error" }),
                              })
                            }
                          >
                            <Send size={14} /> Reenviar mensaje
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {editable && choice === "billing" && !chargePaid && (
                  <div className="space-y-2">
                    {!chargeOpen && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={m.perceptionLink.isPending && m.perceptionLink.variables?.dryRun}
                          onClick={() =>
                            m.perceptionLink.mutate(
                              { planId: row.id, dryRun: true },
                              { onSuccess: setPreview, onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }) },
                            )
                          }
                        >
                          <Link2 size={14} /> Ver el mensaje
                        </Button>
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox checked={sendMsg} onCheckedChange={setSendMsg} aria-label="Mandar el mensaje por Mercado Libre" />
                          Mandarle el mensaje por Mercado Libre
                        </label>
                        <Button
                          size="sm"
                          loading={m.perceptionLink.isPending && !m.perceptionLink.variables?.dryRun}
                          onClick={() =>
                            m.perceptionLink.mutate(
                              { planId: row.id, sendMessage: sendMsg },
                              {
                                onSuccess: (r) =>
                                  toast({
                                    title: r.sent ? "Link creado y mensaje enviado" : "Link de pago creado",
                                    description: r.env === "test" ? "Credencial de prueba de Mercado Pago: el link es de sandbox." : undefined,
                                    variant: "success",
                                  }),
                                onError: (e) => toast({ title: "No se pudo crear el link", description: errText(e), variant: "error" }),
                              },
                            )
                          }
                        >
                          Crear link de pago por {formatCurrency(perc.total)}
                        </Button>
                      </div>
                    )}
                    {preview && (
                      <p className="rounded-lg bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">{preview.message}</p>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="w-full sm:w-56">
                        <Input label="Cobrada por otro medio" placeholder="N° de transferencia" value={paidRef} onChange={(e) => setPaidRef(e.target.value)} />
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={paidRef.trim().length < 3}
                        loading={m.perceptionPaid.isPending}
                        onClick={() =>
                          m.perceptionPaid.mutate(
                            { planId: row.id, reference: paidRef.trim() },
                            {
                              onSuccess: () => toast({ title: "Percepción marcada como cobrada", variant: "success" }),
                              onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }),
                            },
                          )
                        }
                      >
                        Marcar cobrada
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={m.perceptionCancel.isPending && m.perceptionCancel.variables?.then === "invoice_b"}
                        onClick={() => m.perceptionCancel.mutate({ planId: row.id, then: "invoice_b" }, { onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }) })}
                      >
                        Facturar B sin percepción
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={m.perceptionCancel.isPending && m.perceptionCancel.variables?.then === "invoice_a"}
                        onClick={() => m.perceptionCancel.mutate({ planId: row.id, then: "invoice_a" }, { onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }) })}
                      >
                        Facturar A sin percibir
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                No corresponde percibir:{" "}
                {perc.skipped
                  .map((s) => `${jurisdictionName(s.jurisdiction)} (${s.reason === "min_base" ? "base menor al mínimo" : s.reason === "min_amount" ? "monto menor al mínimo" : s.reason === "not_in_padron" ? "no está en el padrón" : s.reason === "other_destination" ? "el envío va a otra jurisdicción" : "alícuota cero"})`)
                  .join(", ")}
                .
              </p>
            )}
          </section>
        )}

        {/* Comprobantes y qué se sube a ML. */}
        {row.documents.length > 0 && (
          <section aria-label="Comprobantes" className="space-y-2">
            <h3 className="text-sm font-semibold">Comprobantes y qué se sube a la venta</h3>
            <ul className="divide-y divide-border rounded-lg bg-secondary/40 text-sm">
              {row.documents.map((d) => (
                <li key={d.id} className="space-y-1.5 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {DOC_ORIGIN_LABELS[d.origin] ?? d.origin} {docNumber(d)}
                      <span className="ml-1 text-xs text-muted-foreground">{formatCurrency(d.total)}</span>
                    </span>
                    <Badge tone={d.status === "aprobado" ? "success" : d.status === "rechazado" || d.status === "requiere_accion" ? "danger" : "info"}>
                      {d.status === "aprobado" ? "Aprobado" : d.status === "rechazado" ? "Rechazado" : d.status === "requiere_accion" ? "Requiere acción" : "En la cola de ARCA"}
                    </Badge>
                  </div>
                  {d.upload && (
                    <p className="text-xs text-muted-foreground">
                      {UPLOAD_STATUS_LABELS[d.upload.status] ?? d.upload.status}
                      {d.upload.last_error ? `: ${d.upload.last_error}` : ""}
                    </p>
                  )}
                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Switch
                        checked={d.upload ? d.upload.sync : d.origin === "sale"}
                        label="Subir a la venta en Mercado Libre"
                        onCheckedChange={(v) =>
                          m.upload.mutate({ docId: d.id, sync: v }, { onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }) })
                        }
                      />
                      {d.status === "aprobado" && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              m.upload.mutate(
                                { docId: d.id, sync: true, now: true },
                                {
                                  onSuccess: () => toast({ title: "Subida en la cola", variant: "success" }),
                                  onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }),
                                },
                              )
                            }
                          >
                            <Upload size={14} /> Subir ahora
                          </Button>
                          {d.upload?.status === "uploaded" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                m.upload.mutate(
                                  { docId: d.id, sync: true, now: true, replace: true },
                                  {
                                    onSuccess: () => toast({ title: "Se reemplaza el documento de la venta", variant: "success" }),
                                    onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }),
                                  },
                                )
                              }
                            >
                              Volver a subir
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {canManage && factura && !hasNc && (
              <Button size="sm" variant="secondary" onClick={() => setAskNc(true)}>
                <FileMinus size={14} /> Nota de crédito por el total
              </Button>
            )}
          </section>
        )}
      </div>
      <ConfirmDialog
        open={askNc}
        onOpenChange={setAskNc}
        title="Nota de crédito por el total"
        description="Sale por la cola de ARCA y anula fiscalmente la factura. Usala cuando Mercado Libre le devolvió todo el dinero al comprador. Para una devolución parcial, hacela desde Ventas."
        confirmLabel="Emitir nota de crédito"
        danger
        withReason
        reasonLabel="Motivo"
        loading={m.creditNote.isPending}
        onConfirm={(reason) =>
          m.creditNote.mutate(
            { planId: row.id, reason },
            {
              onSuccess: () => {
                setAskNc(false);
                toast({ title: "Nota de crédito en la cola de ARCA", variant: "success" });
              },
              onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }),
            },
          )
        }
      />
    </Modal>
  );
}
