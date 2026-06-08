// Copy de ayuda para el operador del POS, por sección principal.
//
// A diferencia de `lib/saas/featureInfo.ts` (que explica *features de plan* en el
// panel interno), este mapa describe *qué es cada pantalla* del POS y para qué
// sirve, en lenguaje del cajero/encargado. Lo consume <InfoHint> en el
// encabezado de cada sección.
//
//   - title:    nombre de la sección (lo que se muestra en negrita arriba).
//   - what:     qué es / qué se hace en esta pantalla.
//   - enables:  qué permite hacer (acciones concretas).
//   - tip:      consejo opcional para sacarle provecho.
//   - feature:  (opcional) key de FEATURE_INFO si la sección depende de un plan;
//               <InfoHint> agrega el "Desde plan: …" reutilizando ese catálogo.

export interface SectionInfo {
  title: string;
  what: string;
  enables: string;
  tip?: string;
  feature?: string;
}

export const SECTION_INFO: Record<string, SectionInfo> = {
  pos: {
    title: "Punto de venta",
    what: "Es la pantalla donde se carga el carrito y se cobra. El corazón operativo del día a día.",
    enables:
      "Buscar o escanear productos, sumar al carrito, aplicar descuento, elegir cliente y cobrar (efectivo, transferencia o QR).",
    tip: "Necesitás la caja abierta para poder cobrar. Podés escanear con lector USB en cualquier parte de la pantalla.",
    feature: "pos",
  },
  ventas: {
    title: "Ventas",
    what: "El historial de todas las ventas registradas, con su estado, total y cliente.",
    enables:
      "Buscar por N° o cliente, filtrar por fecha y estado, reimprimir el ticket, anular una venta o iniciar una devolución, y exportar a Excel.",
    tip: "Anular una venta repone el stock y queda auditado. Para devolver solo algunos ítems, usá la acción de devolución.",
    feature: "reportes",
  },
  productos: {
    title: "Productos",
    what: "El catálogo del negocio: lo que se puede vender, con su precio, código y stock.",
    enables:
      "Alta y edición de productos, ajuste e historial de stock, categorías, marcas, garantías, e importar/exportar por Excel.",
    tip: "El stock en amarillo avisa que llegaste al mínimo. Cargá el código de barras para vender escaneando.",
    feature: "productos",
  },
  clientes: {
    title: "Clientes",
    what: "La base de clientes del negocio, para asociarlos a ventas, cuenta corriente y comprobantes.",
    enables:
      "Alta y edición de clientes, ver su historial de compras, cuenta corriente (deuda y pagos), cumpleaños e importar por Excel.",
    tip: "Asociar el cliente a la venta habilita su cuenta corriente y el envío del comprobante por email.",
    feature: "clientes",
  },
  caja: {
    title: "Caja",
    what: "El control del efectivo del turno: apertura, movimientos y cierre con arqueo (Reporte Z).",
    enables:
      "Registrar ingresos y egresos de efectivo, ver el resumen del turno por medio de pago y cerrar la caja conciliando.",
    tip: "La caja se abre desde el punto de venta. Al cerrar, si la diferencia supera la tolerancia, vas a tener que dejar un motivo.",
    feature: "caja",
  },
  reportes: {
    title: "Reportes",
    what: "La vista de negocio: cuánto se vendió, qué productos y por qué medios de pago, en el período que elijas.",
    enables:
      "Ver totales y métricas por período, productos más vendidos, stock bajo y garantías, y exportar los reportes a Excel.",
    tip: "Cambiá el período arriba para comparar días, semanas o meses.",
    feature: "reportes",
  },
  devoluciones: {
    title: "Devoluciones",
    what: "El registro de devoluciones y cambios sobre ventas ya hechas, con su nota de crédito.",
    enables:
      "Buscar la venta por N° o ticket, devolver todos o algunos ítems, generar el comprobante de devolución y reponer el stock.",
    tip: "Podés gestionar los motivos de devolución para tener trazabilidad de por qué se devuelve.",
    feature: "devoluciones",
  },
  etiquetas: {
    title: "Etiquetas",
    what: "El generador de etiquetas de góndola/producto, listas para imprimir.",
    enables:
      "Elegir productos y la cantidad de etiquetas por cada uno, e imprimir nombre, precio y código de barras (barcode o SKU).",
    tip: "Si un producto no tiene barcode, se imprime el SKU. Cargá los códigos en Productos para escanear más rápido.",
    feature: "productos",
  },
  configuracion: {
    title: "Configuración",
    what: "Las preferencias del negocio: apariencia, datos, medios de pago, ticket, lector y reglas del POS.",
    enables:
      "Ajustar el tema y la marca, conectar medios de pago, personalizar el ticket, configurar el lector y las reglas de venta (descuentos, redondeo, cliente obligatorio).",
    tip: "Los cambios se aplican al instante y quedan guardados en tu cuenta, disponibles en cualquier dispositivo.",
  },
};

/** Devuelve el copy de una sección del POS (o null si no existe). */
export function sectionInfo(key: string): SectionInfo | null {
  return SECTION_INFO[key] ?? null;
}
