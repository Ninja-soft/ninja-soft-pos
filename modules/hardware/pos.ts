"use client";

import { useCallback } from "react";
import {
  decodeScaleLabel,
  productCodeCandidates,
  scaleDecodeErrorMessage,
  type ScaleDecode,
} from "@/lib/barcode/scaleLabel";
import { drawerDecision, drawerDeniedMessage } from "@/lib/hardware/drawer";
import { productsApi } from "@/modules/products/api";
import type { Product } from "@/modules/products/api";
import { useDrawerOpener, usePosStoreHardware, useRegisterHardware } from "./hooks";

// Balanza y cajón en el POS (ADR-063): etiqueta de balanza en el flujo del
// escáner, apertura del cajón al cobrar en efectivo y lo que necesita el
// botón "Abrir cajón".

export type ScaleScan =
  | { kind: "item"; product: Product; decoded: Extract<ScaleDecode, { ok: true }> }
  | { kind: "error"; message: string };

export function usePosHardware(registerId: string | null, storeId: string | null, hasShift: boolean) {
  const store = usePosStoreHardware();
  const hw = useRegisterHardware(registerId, storeId);
  const opener = useDrawerOpener();
  const hasDrawer = Boolean(hw?.drawer.hasDrawer && hw.drawer.transport !== "none");
  const noSale = drawerDecision("no_sale", store.drawer, {
    hasDrawer,
    hasShift,
    isSupervisor: false,
    isManager: false,
  });

  /**
   * ¿El código es una etiqueta de balanza? null = no (seguir con la búsqueda
   * común). Con la sucursal sin pesables nunca intercepta.
   */
  const scanScaleLabel = useCallback(
    async (code: string): Promise<ScaleScan | null> => {
      if (!store.scaleEnabled) return null;
      const d = decodeScaleLabel(code, store.scaleFormat);
      if (!d) return null;
      if (!d.ok) return { kind: "error", message: scaleDecodeErrorMessage(d.error) };
      const product = await productsApi.findByScaleCode(productCodeCandidates(d.itemCode));
      if (!product) return { kind: "error", message: `Sin producto con el código de balanza ${d.itemCode}` };
      return { kind: "item", product, decoded: d };
    },
    [store.scaleEnabled, store.scaleFormat],
  );

  /**
   * Venta cerrada: si tuvo efectivo y la sucursal abre el cajón al cobrar,
   * pide la apertura (el servidor la valida contra la venta y la registra) y
   * manda el pulso. Devuelve un aviso sólo si algo falló (la venta ya está).
   */
  const openOnSale = useCallback(
    async (saleId: string, hadCash: boolean): Promise<string | null> => {
      if (!hw) return null;
      const d = drawerDecision("sale", store.drawer, { hasDrawer, hasShift: true, isSupervisor: false, isManager: false, hadCash });
      if (d.action !== "open") return null;
      const out = await opener(hw, "sale", { saleId });
      if (out.status === "opened" && out.pulse === "failed") return "El cajón no respondió: abrilo con la llave.";
      if (out.status === "denied") return drawerDeniedMessage(out.result.denied_reason);
      if (out.status === "error") return "No se pudo abrir el cajón: abrilo con la llave.";
      return null;
    },
    [hw, store.drawer, hasDrawer, opener],
  );

  return {
    store,
    hw,
    hasDrawer,
    /** La caja tiene balanza conectada y la sucursal vende pesables. */
    liveScale: Boolean(store.scaleEnabled && hw?.scale.enabled),
    noSaleDecision: noSale,
    scanScaleLabel,
    openOnSale,
    opener,
  };
}
