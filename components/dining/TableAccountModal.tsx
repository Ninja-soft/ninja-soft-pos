"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChefHat,
  Clock,
  CreditCard,
  Flame,
  Minus,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  useTableOrderItems,
  useTableOrderMutations,
} from "@/modules/dining/hooks";
import { useTicketBranding } from "@/modules/tickets/hooks";
import type { DiningTable, TableOrderItem, TableStatus } from "@/modules/dining/api";
import {
  COURSE_LABELS,
  MAX_COURSE,
  TABLE_STATUS_LABELS,
  courseLabel,
} from "@/modules/dining/api";
import { TableProductPicker } from "./TableProductPicker";
import { ComandaModal } from "./ComandaModal";
import { formatCurrency, formatQty } from "@/lib/utils/format";

// Cuenta de una mesa ocupada (H44): ver/editar ítems, agregar, marcar "cuenta
// pedida", cancelar y COBRAR. El cobro abre el POS con los ítems cargados
// (/pos?table=<order_id>) y reusa create_sale + PaymentModal; al confirmar, el POS
// llama close_dining_table (enlaza venta + libera la mesa).
export function TableAccountModal({
  table,
  onClose,
  onSetStatus,
}: {
  table: DiningTable | null;
  onClose: () => void;
  onSetStatus: (tableId: string, status: TableStatus) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const orderId = table?.current_order_id ?? null;
  const open = table !== null && orderId !== null;
  const { data: items } = useTableOrderItems(orderId);
  const { setItemQty, removeItem, cancel, setItemCourse, fireCourse } =
    useTableOrderMutations();
  // Nombre del local para la cabecera (opcional) de la comanda de cocina (H45).
  const { data: brand } = useTicketBranding(open);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [comandaOpen, setComandaOpen] = useState(false);

  const total = useMemo(
    () => (items ?? []).reduce((acc, it) => acc + it.qty * it.unit_price, 0),
    [items],
  );

  // Agrupa las líneas por tiempo (course), en orden ascendente. Dentro de cada
  // tiempo conserva el orden FIFO de carga que ya trae la query. Marca si el
  // tiempo tiene ítems EN ESPERA (fired_at null) para ofrecer "Disparar".
  const courseGroups = useMemo(() => {
    const byCourse = new Map<number, TableOrderItem[]>();
    for (const it of items ?? []) {
      const c = it.course ?? 1;
      const arr = byCourse.get(c);
      if (arr) arr.push(it);
      else byCourse.set(c, [it]);
    }
    return [...byCourse.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([course, list]) => ({
        course,
        items: list,
        heldCount: list.filter((it) => it.fired_at === null).length,
      }));
  }, [items]);

  // ¿Hay más de un tiempo en juego? Si sólo es Tiempo 1, no mostramos los
  // encabezados de tiempo (no estorbar el flujo simple de mostrador/cafetería).
  const showCourses = courseGroups.length > 1 || courseGroups.some((g) => g.course !== 1);

  async function changeQty(itemId: string, qty: number) {
    try {
      await setItemQty.mutateAsync({ itemId, qty: Math.max(0, qty) });
    } catch (e) {
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function changeCourse(itemId: string, course: number) {
    try {
      await setItemCourse.mutateAsync({ itemId, course });
    } catch (e) {
      toast({
        title: "No se pudo cambiar el tiempo",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  // Dispara un tiempo a cocina (fire course): los ítems en espera de ese tiempo
  // pasan al KDS/comanda. course=null dispara TODO lo que esté en espera.
  async function fire(course: number | null) {
    if (!orderId) return;
    try {
      const fired = await fireCourse.mutateAsync({ orderId, course });
      toast({
        title:
          fired > 0
            ? course === null
              ? `Pedido disparado a cocina (${fired})`
              : `${courseLabel(course)} disparado a cocina`
            : "No había ítems en espera para disparar",
        variant: fired > 0 ? "success" : "info",
      });
    } catch (e) {
      toast({
        title: "No se pudo disparar a cocina",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  // ¿Hay algún ítem en espera en todo el pedido? Habilita "Disparar todo".
  const anyHeld = (items ?? []).some((it) => it.fired_at === null);

  async function doCancel() {
    if (!orderId) return;
    try {
      await cancel.mutateAsync(orderId);
      toast({ title: "Pedido cancelado, mesa liberada", variant: "success" });
      setConfirmCancel(false);
      onClose();
    } catch (e) {
      toast({
        title: "No se pudo cancelar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  // Cobrar: lleva al POS con el pedido cargado. El POS resuelve el resto (medios,
  // descuentos, cliente) y cierra la mesa al confirmar.
  function charge() {
    if (!orderId) return;
    if ((items ?? []).length === 0) {
      toast({ title: "La mesa no tiene ítems para cobrar", variant: "info" });
      return;
    }
    router.push(`/pos?table=${orderId}`);
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={table ? `Mesa ${table.label}` : "Mesa"}
      >
        <div className="space-y-4">
          {/* Estado + capacidad */}
          {table && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {TABLE_STATUS_LABELS[table.status]} · {table.capacity} personas
              </span>
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                <Plus size={15} /> Agregar ítem
              </Button>
            </div>
          )}

          {/* Líneas del pedido — agrupadas por tiempo (course) cuando hay más de
              un tiempo. Los ítems EN ESPERA (fired_at null) se marcan y el tiempo
              ofrece "Disparar Tiempo N". */}
          <div className="max-h-[46vh] space-y-3 overflow-y-auto">
            {(items ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                Mesa abierta sin ítems. Tocá{" "}
                <span className="font-medium text-foreground">Agregar ítem</span>{" "}
                para cargar el pedido.
              </p>
            ) : (
              courseGroups.map((g) => (
                <div key={g.course} className="space-y-2">
                  {/* Encabezado del tiempo + acción de disparar (sólo si aplica) */}
                  {showCourses && (
                    <div className="flex items-center justify-between gap-2 px-0.5">
                      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-ninja-flame/15 px-1.5 text-[11px] font-bold text-ninja-flameSoft tabular-nums">
                          {g.course}
                        </span>
                        {COURSE_LABELS[g.course] ?? `Tiempo ${g.course}`}
                      </span>
                      {g.heldCount > 0 && (
                        <button
                          type="button"
                          onClick={() => fire(g.course)}
                          disabled={fireCourse.isPending}
                          className="flex items-center gap-1.5 rounded-lg bg-ninja-flame px-2.5 py-1 text-xs font-semibold text-ninja-voidViolet shadow-ninjaGlow transition hover:brightness-110 disabled:opacity-50"
                          title={`Disparar ${courseLabel(g.course)} a cocina`}
                        >
                          <Flame size={13} /> Disparar Tiempo {g.course}
                          <span className="tabular-nums opacity-80">
                            ({g.heldCount})
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                  {g.items.map((it) => (
                    <ItemRow
                      key={it.id}
                      item={it}
                      showCourse={showCourses}
                      onQty={changeQty}
                      onRemove={(id) => removeItem.mutate(id)}
                      onCourse={changeCourse}
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          {/* Total */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm font-medium text-muted-foreground">Total</span>
            <span className="price-hl font-price text-2xl font-bold tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>

          {/* Disparar TODO lo que esté en espera (cualquier tiempo) de una sola
              vez. Sólo aparece si hay ítems en espera (fire course global). */}
          {anyHeld && (
            <Button
              onClick={() => fire(null)}
              disabled={fireCourse.isPending}
              className="w-full"
            >
              <Flame size={16} /> Disparar todo a cocina
            </Button>
          )}

          {/* Comanda de cocina (H45): imprime la(s) comanda(s) por estación del
              pedido. Por defecto envía sólo lo nuevo a cocina/barra. */}
          <Button
            variant="secondary"
            onClick={() => setComandaOpen(true)}
            disabled={(items ?? []).length === 0}
            className="w-full"
          >
            <ChefHat size={16} /> Imprimir comanda
          </Button>

          {/* Acciones */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={charge} className="flex-1">
              <CreditCard size={16} /> Cobrar mesa
            </Button>
            {table?.status === "ocupada" ? (
              <Button
                variant="secondary"
                onClick={() => table && onSetStatus(table.id, "cuenta_pedida")}
              >
                <ReceiptText size={15} /> Cuenta pedida
              </Button>
            ) : (
              table?.status === "cuenta_pedida" && (
                <Button
                  variant="secondary"
                  onClick={() => table && onSetStatus(table.id, "ocupada")}
                >
                  Reabrir
                </Button>
              )
            )}
            <Button
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
              className="text-destructive"
            >
              <X size={15} /> Cancelar pedido
            </Button>
          </div>
        </div>
      </Modal>

      {/* Picker de productos para agregar al pedido */}
      <TableProductPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        orderId={orderId}
      />

      {/* Comanda de cocina por estación (H45) */}
      <ComandaModal
        open={comandaOpen}
        onOpenChange={setComandaOpen}
        orderId={orderId}
        businessName={brand?.legal_name ?? null}
      />

      {/* Confirmación de cancelación (libera la mesa, anula el pedido) */}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancelar el pedido de la mesa"
        description="Se anula el pedido y la mesa queda libre. Esta acción no se puede deshacer."
        confirmLabel="Cancelar pedido"
        danger
        loading={cancel.isPending}
        onConfirm={doCancel}
      />
    </>
  );
}

// Una línea del pedido en la cuenta: nombre + precio, estado "en espera" (si el
// ítem no fue disparado), selector de tiempo (course), cantidad, total y quitar.
function ItemRow({
  item,
  showCourse,
  onQty,
  onRemove,
  onCourse,
}: {
  item: TableOrderItem;
  showCourse: boolean;
  onQty: (itemId: string, qty: number) => void;
  onRemove: (itemId: string) => void;
  onCourse: (itemId: string, course: number) => void;
}) {
  const held = item.fired_at === null;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
        held
          ? "border-amber-400/40 bg-amber-400/[0.06]"
          : "border-border bg-card"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {item.name}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>
            {formatCurrency(item.unit_price)} c/u
            {item.notes ? ` · ${item.notes}` : ""}
          </span>
          {held && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
              <Clock size={11} /> En espera · Tiempo {item.course}
            </span>
          )}
          {/* Alergia/intolerancia (F13 · H47): destacada en rojo. */}
          {item.allergens && (
            <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold uppercase text-danger">
              <AlertTriangle size={11} /> Alergia: {item.allergens}
            </span>
          )}
        </div>
      </div>

      {/* Selector de tiempo (course): mover el ítem a otro tiempo. */}
      {showCourse && (
        <select
          value={item.course}
          onChange={(e) => onCourse(item.id, Number(e.target.value))}
          aria-label="Tiempo del ítem"
          title="Tiempo (course) del ítem"
          className="h-7 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none transition focus:border-ninja-flameSoft"
        >
          {Array.from({ length: MAX_COURSE }, (_, i) => i + 1).map((c) => (
            <option key={c} value={c}>
              T{c}
            </option>
          ))}
        </select>
      )}

      {/* Controles de cantidad */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onQty(item.id, item.qty - 1)}
          className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Restar"
        >
          <Minus size={14} />
        </button>
        <span className="w-8 text-center text-sm font-semibold tabular-nums">
          {formatQty(item.qty)}
        </span>
        <button
          type="button"
          onClick={() => onQty(item.id, item.qty + 1)}
          className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Sumar"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="w-20 shrink-0 text-right price-hl font-price text-sm font-bold tabular-nums">
        {formatCurrency(item.qty * item.unit_price)}
      </div>

      <button
        type="button"
        onClick={() => onRemove(item.id)}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-danger"
        aria-label="Quitar"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}
