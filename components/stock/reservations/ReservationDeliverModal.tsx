"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { pickupFailureMessage, reservationErrorMessage, type StockReservation } from "@/lib/stock/reservations";
import { useReservationMutations } from "@/modules/stock/reservations";

// Entrega de una reserva (retiro en tienda). El cliente presenta el código
// o su documento (sin ellos, sólo un dueño o encargado, con motivo). Lo
// normal (ADR-096): validar y cobrar en el POS con la reserva cargada; la
// venta la entrega en la misma transacción. Si ya se cobró aparte, se carga
// el número de esa venta.
export function ReservationDeliverModal({
  reservation,
  onOpenChange,
  canOverride,
}: {
  reservation: StockReservation | null;
  onOpenChange: (o: boolean) => void;
  canOverride: boolean;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const m = useReservationMutations();
  const [code, setCode] = useState("");
  const [doc, setDoc] = useState("");
  const [sale, setSale] = useState("");
  const [override, setOverride] = useState("");
  const [useOverride, setUseOverride] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setCode("");
    setDoc("");
    setSale("");
    setOverride("");
    setUseOverride(false);
    setFailure(null);
  }, [reservation?.id]);

  const saleNumber = Number(sale.replace(/\D/g, ""));
  const identity = useOverride ? override.trim().length >= 3 : code.trim().length > 0 || doc.trim().length > 0;
  const valid = identity && saleNumber > 0;

  async function chargeInPos() {
    if (!reservation || !identity) return;
    try {
      const r = await m.verify.mutateAsync({
        id: reservation.id,
        code: useOverride ? "" : code,
        doc: useOverride ? "" : doc,
        overrideReason: useOverride ? override : "",
      });
      if (!r.ok) {
        setFailure(pickupFailureMessage(r.error ?? "", r.attempts_left ?? 0));
        return;
      }
      onOpenChange(false);
      router.push(`/pos?reservation=${reservation.id}`);
    } catch (e) {
      toast({ title: "No se pudo validar el retiro", description: reservationErrorMessage(e), variant: "error" });
    }
  }

  async function submit() {
    if (!reservation || !valid) return;
    try {
      const r = await m.deliver.mutateAsync({
        id: reservation.id,
        saleNumber,
        code: useOverride ? "" : code,
        doc: useOverride ? "" : doc,
        overrideReason: useOverride ? override : "",
      });
      if (!r.ok) {
        setFailure(pickupFailureMessage(r.error ?? "", r.attempts_left ?? 0));
        return;
      }
      toast({ title: `Reserva #${reservation.number} entregada`, variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo entregar", description: reservationErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={reservation != null}
      onOpenChange={onOpenChange}
      title={reservation ? `Entregar reserva #${reservation.number}` : "Entregar reserva"}
      description="Validá al cliente y cobrá en el POS de esta sucursal: la venta entrega la reserva. Si ya la cobraste, cargá el número de esa venta."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button variant="secondary" onClick={submit} disabled={!valid} loading={m.deliver.isPending}>
            Entregar con esa venta
          </Button>
          <Button onClick={chargeInPos} disabled={!identity || saleNumber > 0} loading={m.verify.isPending}>
            Cobrar en el POS
          </Button>
        </>
      }
    >
      {reservation && (
        <div className="space-y-4">
          <p className="text-sm">
            {reservation.customer_name}
            {reservation.customer_doc ? <span className="text-muted-foreground"> · Doc. {reservation.customer_doc}</span> : null}
          </p>
          {!useOverride ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Código de retiro"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={6}
              />
              <Input
                label="o documento del cliente"
                inputMode="numeric"
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                maxLength={13}
              />
            </div>
          ) : (
            <Input
              label="Motivo para entregar sin código"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              maxLength={300}
            />
          )}
          {canOverride && (
            <button
              type="button"
              className="min-h-11 text-sm font-semibold text-ninja-flameSoft underline-offset-2 hover:underline"
              onClick={() => setUseOverride((v) => !v)}
            >
              {useOverride ? "Volver a validar con código o documento" : "El cliente no tiene el código"}
            </button>
          )}
          <Input
            label="Número de la venta (sólo si ya se cobró)"
            inputMode="numeric"
            value={sale}
            onChange={(e) => setSale(e.target.value)}
          />
          {failure && <p className="text-sm text-danger">{failure}</p>}
        </div>
      )}
    </Modal>
  );
}
