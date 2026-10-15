"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatInt } from "@/lib/utils/format";
import { fullErrorMessage } from "@/lib/mercadolibre/full";
import {
  FULL_LABEL_FORMATS,
  boxLabels,
  buildLabelsHtml,
  expandUnitLabels,
  labelFormat,
  labelsPerSheet,
  type FullLabelFormatKey,
} from "@/lib/mercadolibre/fullLabels";
import { useMlFullMutations, type MlFullInbound, type MlFullRow } from "@/modules/mercadolibre/fullHooks";

type Kind = "units" | "boxes";

/** Abre el HTML de las etiquetas en una ventana nueva e imprime. */
export function printHtml(html: string): boolean {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}

/**
 * Etiquetas que exige Full (ADR-142): una por unidad con el código de
 * inventario de ML, y de bulto, impresas en lote desde el envío.
 */
export function MlFullLabelsModal({
  open,
  onOpenChange,
  inbound,
  rows,
  accountName,
  defaultFormat,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inbound: MlFullInbound;
  rows: MlFullRow[];
  accountName: string;
  defaultFormat: string;
}) {
  const { toast } = useToast();
  const { labelsPrinted } = useMlFullMutations();
  const [kind, setKind] = useState<Kind>("units");
  const [fmt, setFmt] = useState<FullLabelFormatKey>(labelFormat(defaultFormat).key);
  useEffect(() => {
    if (open) setFmt(labelFormat(defaultFormat).key);
  }, [open, defaultFormat]);

  const f = labelFormat(fmt);
  const units = useMemo(
    () =>
      expandUnitLabels(
        inbound.items.map((i) => {
          const r = rows.find((x) => x.id === i.inventory_row_id) ?? rows.find((x) => x.inventory_id === i.inventory_id);
          return { inventory_id: i.inventory_id, title: i.title, variation_label: r?.variation_label ?? null, sku: r?.sku ?? null, qty: i.qty_sent };
        }),
      ),
    [inbound.items, rows],
  );
  const boxes = useMemo(
    () =>
      inbound.ml_inbound_id
        ? boxLabels(
            {
              mlInboundId: inbound.ml_inbound_id,
              account: accountName,
              origin: inbound.stores?.name ?? "Depósito",
              number: inbound.number,
              date: new Date().toLocaleDateString("es-AR"),
            },
            inbound.boxes,
          )
        : [],
    [inbound, accountName],
  );
  const count = kind === "units" ? units.labels.length : boxes.length;
  const sheets = Math.ceil(count / labelsPerSheet(f));

  const print = () => {
    const html =
      kind === "units"
        ? buildLabelsHtml({ kind: "units", labels: units.labels }, f, `Etiquetas Full · envío ${inbound.number}`)
        : buildLabelsHtml({ kind: "boxes", labels: boxes }, f, `Bultos Full · envío ${inbound.number}`);
    if (!printHtml(html)) {
      toast({ title: "El navegador bloqueó la ventana", description: "Permití ventanas emergentes para imprimir.", variant: "error" });
      return;
    }
    labelsPrinted.mutate(
      { id: inbound.id, kind, count },
      { onError: (e) => toast({ title: "No se registró la impresión", description: fullErrorMessage(e), variant: "warning" }) },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Etiquetas del envío N° ${inbound.number}`}
      description="Imprimí una etiqueta por unidad con el código de inventario de Mercado Libre y, si querés, las de bulto."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button onClick={print} disabled={count === 0}>
            <Printer size={15} /> Imprimir {formatInt(count)}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={kind}
          onChange={setKind}
          aria-label="Tipo de etiqueta"
          options={[
            { value: "units", label: "Por unidad" },
            { value: "boxes", label: "Por bulto" },
          ]}
        />
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Tamaño</span>
          <select className={selectCls} value={fmt} onChange={(e) => setFmt(e.target.value as FullLabelFormatKey)} aria-label="Tamaño de etiqueta">
            {Object.values(FULL_LABEL_FORMATS).map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          {formatInt(count)} {count === 1 ? "etiqueta" : "etiquetas"}
          {f.kind === "a4" ? ` en ${formatInt(sheets)} ${sheets === 1 ? "hoja" : "hojas"} A4` : " en rollo"}. Imprimí al 100 %, sin
          ajustar a la página.
        </p>
        {kind === "units" ? (
          <>
            <Callout tone="info" title="Dónde va la etiqueta">
              Pegala en cada unidad tapando cualquier otro código de barras (el EAN de fábrica también), en una cara lisa y
              visible. Cada etiqueta lleva el código de inventario de ML; si la publicación tiene variantes, cada variante tiene
              el suyo.
            </Callout>
            {units.skipped.length > 0 && (
              <Callout tone="warning" title="Productos sin código de inventario">
                {units.skipped.join(", ")}: sincronizá Full para traer su código antes de imprimir.
              </Callout>
            )}
            {units.truncated && <Callout tone="warning">Se imprimen hasta 5.000 etiquetas por vez.</Callout>}
          </>
        ) : !inbound.ml_inbound_id ? (
          <Callout tone="warning" title="Falta el número del envío de Mercado Libre">
            Cargalo para imprimir las etiquetas de bulto.
          </Callout>
        ) : (
          <Callout tone="neutral" title="Etiqueta de bulto">
            Mercado Libre te da la etiqueta oficial de cada bulto al crear el envío: esa es la que va por fuera. Éstas sirven para
            ordenar la preparación en tu depósito (número de envío y bulto, origen y fecha).
          </Callout>
        )}
      </div>
    </Modal>
  );
}
