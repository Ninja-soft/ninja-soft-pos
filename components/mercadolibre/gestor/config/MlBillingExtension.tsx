"use client";

import type { MlAccount } from "@/modules/mercadolibre/hooks";

// Punto de extensión de Configuración > Facturación de Mercado Libre.
//
// Hoy la sección muestra lo que existe (cuándo facturar y si la factura se
// sube sola a la venta, `AccountConfig` con `sections={["billing"]}`). La
// facturación avanzada de ventas de ML (rama `feat/ml-facturacion-pro`) se
// monta ACÁ: este componente recibe la cuenta y el permiso, y se renderiza
// debajo de los ajustes básicos dentro de la misma sección. No hace falta
// tocar MlConfigTab ni el resto de las secciones.
export function MlBillingExtension(_props: { account: MlAccount; canManage: boolean }) {
  return null;
}
