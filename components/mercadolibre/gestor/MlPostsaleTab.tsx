"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock, LifeBuoy, Paperclip, RefreshCw, RotateCcw, Scale, Search, Send, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import {
  ACTION_LABELS,
  CLAIM_KIND_LABELS,
  CLAIM_KIND_TONE,
  EXCLUSION_LABELS,
  RESPONSIBLE_LABELS,
  RESULT_LABELS,
  RETURN_STATUS_LABELS,
  STAGE_LABELS,
  URGENCY_TONE,
  dueLabel,
  reasonLabel,
  urgency,
  type ClaimKind,
} from "@/lib/mercadolibre/postsale";
import { attachmentProblem } from "@/supabase/functions/_shared/mercadolibre/claims";
import {
  useMlClaimDetail,
  useMlClaims,
  useMlGestorMutations,
  useMlGestorSettings,
  useMlPackMessages,
  type MlClaimRow,
} from "@/modules/mercadolibre/gestorHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";
import { MlTemplatePicker } from "./MlTemplatePicker";

// Posventa (H141 · ADR-132): reclamos, mediaciones y devoluciones con su
// vencimiento ("resolvé hasta"), detalle con mensajes, responder con
// adjuntos, pedir la mediación de Mercado Libre, aceptar la devolución y
// ofrecer un reintegro parcial con confirmación fuerte. Toda acción la
// vuelve a validar el servidor contra Mercado Libre.

type View = "turn" | "open" | "closed" | "all";

const URGENCY_TEXT = { vencido: "Vencido", rojo: "Vence en menos de 4 h", ambar: "Vence pronto", ok: "", sin_plazo: "" } as const;

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function MlPostsaleTab({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { toast } = useToast();
  const { data: claims = [], isLoading } = useMlClaims(account.id, 60);
  const { data: settings } = useMlGestorSettings(account.id);
  const { syncClaims } = useMlGestorMutations();
  const [view, setView] = useState<View>("turn");
  const [kind, setKind] = useState<ClaimKind | "">("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const dueHours = settings?.notify?.due_hours ?? 24;

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return claims
      .filter((c) =>
        view === "turn"
          ? c.status === "opened" && (c.action_responsible === "respondent" || !c.action_responsible)
          : view === "open"
            ? c.status === "opened"
            : view === "closed"
              ? c.status !== "opened"
              : true,
      )
      .filter((c) => !kind || c.kind === kind)
      .filter((c) => !s || String(c.claim_id).includes(s) || String(c.resource_id ?? "").includes(s) || (c.detail_title ?? "").toLowerCase().includes(s))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "opened" ? -1 : 1;
        const da = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
        const db = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
        return da - db || Date.parse(b.date_created ?? "") - Date.parse(a.date_created ?? "");
      });
  }, [claims, view, kind, q]);
  const turnCount = claims.filter((c) => c.status === "opened" && (c.action_responsible === "respondent" || !c.action_responsible)).length;
  const openCount = claims.filter((c) => c.status === "opened").length;

  const sync = () =>
    syncClaims.mutate(account.id, {
      onSuccess: (r) => toast({ title: "Reclamos actualizados", description: `${r?.seen ?? 0} revisados en Mercado Libre.`, variant: "success" }),
      onError: (e) => toast({ title: "No se pudo actualizar", description: mlErrorMessage(e), variant: "error" }),
    });

  if (isLoading) return <SpinnerBlock className="py-16" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          scrollOnMobile
          value={view}
          onChange={setView}
          aria-label="Casos"
          options={[
            { value: "turn", label: `Te toca (${turnCount})` },
            { value: "open", label: `Abiertos (${openCount})` },
            { value: "closed", label: "Cerrados" },
            { value: "all", label: "Todos" },
          ]}
        />
        {canManage && (
          <Button variant="secondary" size="sm" onClick={sync} loading={syncClaims.isPending}>
            <RefreshCw size={15} /> Actualizar
          </Button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Buscar por reclamo, venta o motivo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar reclamo" />
        </div>
        <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as ClaimKind | "")} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {(Object.keys(CLAIM_KIND_LABELS) as ClaimKind[]).map((k) => (
            <option key={k} value={k}>
              {CLAIM_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title={claims.length === 0 ? "No tenés reclamos ni devoluciones" : view === "turn" ? "No hay casos esperando tu respuesta" : "No hay casos con esos filtros"}
          description={
            claims.length === 0
              ? "Cuando un comprador abra un reclamo, una mediación o una devolución, aparece acá con el plazo para responder. Te avisamos en el centro de notificaciones."
              : undefined
          }
          action={
            claims.length === 0 && canManage ? (
              <Button size="sm" variant="secondary" onClick={sync} loading={syncClaims.isPending}>
                <RefreshCw size={15} /> Buscar en Mercado Libre ahora
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl bg-card">
          {list.map((c) => {
            const u = c.status === "opened" ? urgency(c.due_at, Date.now(), dueHours) : "sin_plazo";
            const next = c.my_actions[0];
            return (
              <li key={c.id}>
                <button type="button" className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/50" onClick={() => setOpenId(c.id)}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={CLAIM_KIND_TONE[c.kind]}>{CLAIM_KIND_LABELS[c.kind]}</Badge>
                    {c.status === "opened" ? (
                      <Badge tone={c.action_responsible && c.action_responsible !== "respondent" ? "neutral" : "warning"}>
                        {RESPONSIBLE_LABELS[c.action_responsible ?? "respondent"] ?? "Abierto"}
                      </Badge>
                    ) : (
                      <Badge tone={RESULT_LABELS[c.resolution_result ?? ""]?.tone ?? "neutral"}>{RESULT_LABELS[c.resolution_result ?? ""]?.label ?? "Cerrado"}</Badge>
                    )}
                    {URGENCY_TEXT[u] && (
                      <Badge tone={URGENCY_TONE[u]}>
                        <Clock size={12} /> {URGENCY_TEXT[u]}
                      </Badge>
                    )}
                    {c.affects_reputation && <Badge tone="danger">Afecta la reputación</Badge>}
                    {c.return_status && <Badge tone="info">Devolución: {RETURN_STATUS_LABELS[c.return_status] ?? c.return_status}</Badge>}
                  </span>
                  <span className="text-sm font-medium">{c.detail_title || reasonLabel(c.reason_id)}</span>
                  <span className="text-xs text-muted-foreground">
                    Reclamo {c.claim_id}
                    {c.resource_id ? ` · venta ${c.resource_id}` : ""}
                    {c.status === "opened" ? ` · ${dueLabel(c.due_at)}` : ""}
                    {next && c.status === "opened" ? ` · ${ACTION_LABELS[next.action] ?? next.action}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {openId && <MlClaimDetailModal claim={claims.find((c) => c.id === openId) ?? null} account={account} canManage={canManage} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Detalle del caso.
// -----------------------------------------------------------------------------
type Confirm = { kind: "dispute" } | { kind: "return" } | { kind: "refund"; percentage: number; amount: number };

function MlClaimDetailModal({ claim, account, canManage, onClose }: { claim: MlClaimRow | null; account: MlAccount; canManage: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useMlClaimDetail(claim?.id ?? null);
  const { data: pack } = useMlPackMessages(account.id, claim?.pack_key ?? null);
  const m = useMlGestorMutations();
  const [text, setText] = useState("");
  const [receiver, setReceiver] = useState<"complainant" | "mediator">("complainant");
  const [files, setFiles] = useState<File[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [packText, setPackText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  if (!claim) return null;

  const can = data?.can ?? null;
  const canReply = Boolean(can?.message_complainant || can?.message_mediator);
  const effectiveReceiver = can?.message_mediator && !can?.message_complainant ? "mediator" : can?.message_complainant && !can?.message_mediator ? "complainant" : receiver;
  const fileProblem = attachmentProblem(files.map((f) => ({ type: f.type, size: f.size })));
  const errMsg = (e: unknown) => toast({ title: "No se pudo", description: mlErrorMessage(e), variant: "error" });

  const send = async () => {
    try {
      const attachments = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, base64: await toBase64(f) })));
      await m.sendClaimMessage.mutateAsync({ claimRowId: claim.id, receiver: effectiveReceiver, message: text.trim(), attachments });
      toast({ title: "Respuesta enviada a Mercado Libre", variant: "success" });
      setText("");
      setFiles([]);
      void refetch();
    } catch (e) {
      errMsg(e);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === "dispute") await m.openDispute.mutateAsync(claim.id);
      if (confirm.kind === "return") await m.allowReturn.mutateAsync(claim.id);
      if (confirm.kind === "refund") await m.partialRefund.mutateAsync({ claimRowId: claim.id, percentage: confirm.percentage, expectedAmount: confirm.amount });
      toast({ title: "Listo: Mercado Libre recibió la acción", variant: "success" });
      setConfirm(null);
      void refetch();
    } catch (e) {
      setConfirm(null);
      errMsg(e);
    }
  };

  const busy = m.openDispute.isPending || m.allowReturn.isPending || m.partialRefund.isPending;

  return (
    <>
      <Modal open onOpenChange={(o) => !o && onClose()} title={`${CLAIM_KIND_LABELS[claim.kind]} ${claim.claim_id}`} description={claim.detail_title ?? reasonLabel(claim.reason_id)} className="sm:max-w-3xl">
        {isLoading ? (
          <SpinnerBlock className="py-12" />
        ) : error ? (
          <Callout tone="danger" title="No se pudo leer el caso en Mercado Libre">
            {mlErrorMessage(error)}
          </Callout>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p>
                <span className="text-muted-foreground">Estado: </span>
                {claim.status === "opened" ? "Abierto" : "Cerrado"}
                {claim.stage ? ` · ${STAGE_LABELS[claim.stage] ?? claim.stage}` : ""}
              </p>
              <p>
                <span className="text-muted-foreground">Motivo: </span>
                {reasonLabel(claim.reason_id)} {claim.reason_id ? <span className="text-xs text-muted-foreground">({claim.reason_id})</span> : null}
              </p>
              {claim.status === "opened" && (
                <p>
                  <span className="text-muted-foreground">Plazo: </span>
                  {dueLabel(claim.due_at)}
                </p>
              )}
              {claim.resource_id && (
                <p>
                  <span className="text-muted-foreground">Venta de Mercado Libre: </span>
                  {claim.resource_id}
                </p>
              )}
              {data?.return && (
                <p>
                  <span className="text-muted-foreground">Devolución: </span>
                  {RETURN_STATUS_LABELS[data.return.status ?? ""] ?? data.return.status ?? "sin datos"}
                </p>
              )}
              {claim.affects_reputation != null && (
                <p>
                  <span className="text-muted-foreground">Reputación: </span>
                  {claim.affects_reputation ? "este caso la afecta" : "no la afecta"}
                </p>
              )}
            </div>
            {data?.detail?.description && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{data.detail.description}</p>}

            {/* Acciones */}
            {claim.status === "opened" && canManage && can && (can.open_dispute || can.allow_return || (can.partial_refund && data!.offers.length > 0)) && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Acciones</p>
                <div className="flex flex-wrap gap-2">
                  {can.open_dispute && (
                    <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: "dispute" })} disabled={busy}>
                      <Scale size={15} /> Pedir la mediación de Mercado Libre
                    </Button>
                  )}
                  {can.allow_return && (
                    <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: "return" })} disabled={busy}>
                      <Undo2 size={15} /> Aceptar la devolución
                    </Button>
                  )}
                  {can.partial_refund &&
                    data!.offers.map((o) => (
                      <Button key={o.percentage} variant="secondary" size="sm" onClick={() => setConfirm({ kind: "refund", percentage: o.percentage, amount: o.amount })} disabled={busy}>
                        <RotateCcw size={15} /> Reintegro del {o.percentage} % ({formatCurrency(o.amount)})
                      </Button>
                    ))}
                </div>
                <p className="text-xs text-muted-foreground">Devolver todo el dinero o revisar una devolución se hace desde Mercado Libre.</p>
              </div>
            )}

            {/* Mensajes */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">Mensajes del caso</p>
              {(data?.messages ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin mensajes todavía.</p>
              ) : (
                <ul className="space-y-2">
                  {data!.messages.map((msg, i) => (
                    <li
                      key={i}
                      className={cn(
                        "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                        msg.from === "respondent" ? "ml-auto bg-ninja-flame/10" : msg.from === "mediator" ? "bg-info/10" : "bg-muted",
                      )}
                    >
                      <p className="text-[11px] text-muted-foreground">
                        {msg.from === "respondent" ? "Vos" : msg.from === "mediator" ? "Mercado Libre" : "Comprador"}
                        {msg.date ? ` · ${new Date(msg.date).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}` : ""}
                      </p>
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                      {msg.attachments.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          <Paperclip size={11} className="mr-1 inline" />
                          {msg.attachments.join(", ")}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {claim.status === "opened" && canReply && (
              <div className="space-y-2 rounded-lg bg-muted/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Responder</p>
                  <MlTemplatePicker scope="claim" onPick={setText} />
                </div>
                {can?.message_complainant && can?.message_mediator && (
                  <Segmented
                    size="sm"
                    value={receiver}
                    onChange={setReceiver}
                    aria-label="A quién"
                    options={[
                      { value: "complainant", label: "Al comprador" },
                      { value: "mediator", label: "A Mercado Libre" },
                    ]}
                  />
                )}
                <textarea
                  className="min-h-[96px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ninja-flameSoft"
                  maxLength={2000}
                  placeholder={effectiveReceiver === "mediator" ? "Contale a Mercado Libre qué pasó, con datos concretos." : "Escribile al comprador. Sin datos de contacto."}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-label="Mensaje"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])].slice(0, 4));
                        e.target.value = "";
                      }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={files.length >= 3}>
                      <Paperclip size={15} /> Adjuntar
                    </Button>
                    {files.map((f, i) => (
                      <Badge key={i} tone="neutral">
                        {f.name.slice(0, 24)}
                        <button type="button" aria-label={`Quitar ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                          <X size={11} />
                        </button>
                      </Badge>
                    ))}
                    {fileProblem && <span className="text-xs text-danger">{fileProblem}</span>}
                  </div>
                  <Button size="sm" onClick={send} disabled={text.trim().length < 2 || Boolean(fileProblem)} loading={m.sendClaimMessage.isPending}>
                    <Send size={15} /> Enviar
                  </Button>
                </div>
              </div>
            )}

            {/* Exclusión */}
            {claim.affects_reputation && canManage && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <AlertTriangle size={15} className="text-warning" />
                <span>Exclusión de la reputación (se pide a mano en Mercado Libre):</span>
                <select
                  className={cn(selectCls, "h-8 w-auto")}
                  value={claim.exclusion_status ?? ""}
                  aria-label="Exclusión"
                  onChange={(e) =>
                    m.setExclusion.mutate(
                      { claimRowId: claim.id, status: e.target.value || null },
                      { onSuccess: () => toast({ title: "Exclusión registrada", variant: "success" }), onError: errMsg },
                    )
                  }
                >
                  <option value="">Sin marcar</option>
                  {Object.entries(EXCLUSION_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Mensajes postventa del carrito */}
            {claim.pack_key && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Mensajes de la venta</p>
                {(pack?.messages ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sin mensajes en la venta.</p>
                ) : (
                  <ul className="space-y-2">
                    {pack!.messages.map((msg, i) => (
                      <li key={i} className={cn("max-w-[85%] rounded-lg px-3 py-2 text-sm", msg.mine ? "ml-auto bg-ninja-flame/10" : "bg-muted")}>
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Input aria-label="Mensaje al comprador" placeholder="Escribile al comprador" value={packText} maxLength={3500} onChange={(e) => setPackText(e.target.value)} />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={packText.trim().length < 2}
                    loading={m.sendPackMessage.isPending}
                    onClick={() =>
                      m.sendPackMessage.mutate(
                        { accountId: account.id, packKey: claim.pack_key!, text: packText.trim() },
                        {
                          onSuccess: () => {
                            setPackText("");
                            toast({ title: "Mensaje enviado", variant: "success" });
                          },
                          onError: errMsg,
                        },
                      )
                    }
                  >
                    <Send size={15} />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm?.kind === "dispute"
            ? "¿Pedir la mediación de Mercado Libre?"
            : confirm?.kind === "return"
              ? "¿Aceptar la devolución?"
              : `¿Ofrecer un reintegro del ${confirm?.kind === "refund" ? confirm.percentage : 0} %?`
        }
        description={
          confirm?.kind === "dispute"
            ? "Mercado Libre va a revisar el caso y decidir. Ya no vas a poder resolverlo directamente con el comprador."
            : confirm?.kind === "return"
              ? "El comprador va a recibir la etiqueta para devolver el producto y, cuando llegue, Mercado Libre le devuelve el dinero. No se puede deshacer."
              : confirm?.kind === "refund"
                ? `Se le devuelven ${formatCurrency(confirm.amount)} al comprador y se cierra el reclamo si lo acepta. Si el monto cambió en Mercado Libre, no se hace nada. No se puede deshacer.`
                : undefined
        }
        confirmLabel={confirm?.kind === "dispute" ? "Pedir la mediación" : confirm?.kind === "return" ? "Aceptar la devolución" : "Ofrecer el reintegro"}
        danger
        withReason={confirm?.kind !== "dispute"}
        reasonLabel="Escribí CONFIRMAR para seguir"
        reasonPlaceholder="CONFIRMAR"
        loading={busy}
        onConfirm={(reason) => {
          if (confirm?.kind !== "dispute" && reason.trim().toUpperCase() !== "CONFIRMAR") {
            toast({ title: "Escribí CONFIRMAR para seguir", variant: "error" });
            return;
          }
          void runConfirm();
        }}
      />
    </>
  );
}
