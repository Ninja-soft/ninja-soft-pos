// =============================================================================
// Clasificación de errores de ARCA y mensajes en lenguaje simple (ADR-072).
// PURO: lo usan la Edge (decidir reintento, contingencia o acción) y la
// pantalla (explicar qué hacer).
//
//   transient → se reintenta con backoff (red, 5xx, 500/501/502 de WSFE,
//               reloj desfasado en WSAA). Si el error llegó ANTES de mandar el
//               FECAESolicitar, habilita la contingencia CAEA.
//   numbering → numeración desfasada (10016): se reconcilia y reintenta ya.
//   action    → falta algo del negocio (certificado, autorización de wsfe,
//               CUIT no representada, punto de venta): no se reintenta solo.
//   rejected  → ARCA rechazó el comprobante: hay que corregirlo.
// =============================================================================
import type { ArcaMsg } from "./wsfe.ts";

export type ErrorKind = "transient" | "numbering" | "action" | "rejected";

const TRANSIENT_CODES = new Set(["500", "501", "502"]);
const ACTION_CODES = new Set(["600", "601", "602", "1000", "1001"]);

/** Errores (Errors/Err) de una respuesta de WSFE. */
export function classifyWsfeErrors(errors: ArcaMsg[]): ErrorKind | null {
  if (errors.length === 0) return null;
  const codes = errors.map((e) => e.code);
  if (codes.some((c) => c === "10016")) return "numbering";
  if (codes.every((c) => TRANSIENT_CODES.has(c))) return "transient";
  if (codes.some((c) => ACTION_CODES.has(c))) return "action";
  return "rejected";
}

/** Backoff exponencial con techo (minutos): 1, 2, 4, 8, 16, 32, 60, 60... */
export function nextAttemptAt(attempts: number, now: Date = new Date(), capMinutes = 60): Date {
  const n = Math.max(1, attempts);
  const mins = Math.min(capMinutes, 2 ** (n - 1));
  return new Date(now.getTime() + mins * 60_000);
}

/** Mensaje humano (qué pasó y qué hacer) por código propio o de ARCA. */
export const HUMAN_ERRORS: Record<string, { title: string; action: string }> = {
  // WSAA
  "coe.alreadyAuthenticated": {
    title: "ARCA ya entregó un permiso de acceso que todavía está vigente",
    action:
      "ARCA no da otro permiso hasta que venza el anterior (dura 12 horas). Si NinjaSoft lo tiene guardado no pasa nada; si no, esperá a que venza y volvé a probar.",
  },
  "cms.cert.expired": {
    title: "El certificado está vencido",
    action: "Generá un pedido nuevo en el paso Certificado, subilo a ARCA y cargá el certificado nuevo que te devuelva.",
  },
  "cms.cert.untrusted": {
    title: "ARCA no reconoce el certificado",
    action:
      "Suele pasar cuando se usa el certificado de prueba para facturar en real (o al revés). El de prueba lo emite WSASS y el real, Administración de Certificados Digitales: cargá el que corresponde a este modo.",
  },
  "cms.cert.notFound": {
    title: "ARCA no encuentra el certificado",
    action: "Revisá que el certificado cargado sea el que descargaste de ARCA para este modo y volvé a probar.",
  },
  "cms.bad": { title: "La firma del pedido no es válida", action: "Volvé a cargar el certificado y probá de nuevo." },
  "cms.sign.invalid": { title: "La firma del pedido no es válida", action: "Volvé a cargar el certificado y probá de nuevo." },
  "coe.notAuthorized": {
    title: "El certificado no está autorizado para facturar",
    action:
      "Falta la relación en ARCA, o se eligió otro alias u otra CUIT. En ARCA, Administrador de Relaciones de Clave Fiscal > Nueva Relación > ARCA > WebServices > Facturación Electrónica, y como Representante elegí el Computador Fiscal con el alias del certificado. Después tocá Verificar (a veces ARCA tarda unos minutos).",
  },
  "xml.generationTime.invalid": {
    title: "La hora del servidor no coincide con la de ARCA",
    action: "Es un problema pasajero: NinjaSoft reintenta solo. Si sigue, probá de nuevo en unos minutos.",
  },
  "xml.expirationTime.expired": {
    title: "El pedido de acceso venció antes de llegar a ARCA",
    action: "Es un problema pasajero: NinjaSoft reintenta solo. Si sigue, probá de nuevo en unos minutos.",
  },
  // WSFE
  "600": {
    title: "La CUIT no está autorizada a facturar con este certificado",
    action: "Revisá que hayas autorizado el servicio wsfe (o la delegación) para la CUIT del negocio.",
  },
  "601": {
    title: "La CUIT del negocio no está incluida en el permiso",
    action: "La CUIT que factura no es la del certificado ni una delegada. Revisá la CUIT en Configuración > Impuestos.",
  },
  "602": {
    title: "ARCA no encontró datos para esa consulta",
    action: "Si es el punto de venta: dalo de alta en ARCA como Factura electrónica - Web Services.",
  },
  "1000": {
    title: "ARCA no autorizó la consulta para esta CUIT",
    action: "Revisá que la relación de Facturación Electrónica sea para la CUIT del negocio y volvé a probar.",
  },
  "10016": {
    title: "La numeración o la fecha no coinciden con lo que espera ARCA",
    action:
      "El número tiene que ser el siguiente al último autorizado y la fecha no puede ser anterior a la del último comprobante. NinjaSoft vuelve a consultar el último número y reintenta solo.",
  },
  "10015": {
    title: "La fecha del comprobante está fuera del rango que acepta ARCA",
    action:
      "ARCA acepta hasta 5 días atrás o adelante para productos y 10 para servicios. NinjaSoft ajusta la fecha al reprocesar; si la venta es más vieja, emitila desde ARCA.",
  },
  "11002": {
    title: "El punto de venta no está habilitado para Web Services",
    action:
      "En ARCA, Administración de puntos de venta y domicilios, dalo de alta con el sistema Factura Electrónica - Monotributo/Responsable Inscripto - Web Services. Uno de Comprobantes en línea no sirve.",
  },
  "500": { title: "ARCA tuvo un error interno", action: "Se reintenta solo." },
  "501": { title: "ARCA tuvo un error interno", action: "Se reintenta solo." },
  "502": { title: "ARCA tuvo un error interno", action: "Se reintenta solo." },
  // Propios
  cuit_distinta: {
    title: "La CUIT del certificado no es la del negocio",
    action:
      "El certificado tiene que ser de la misma CUIT que cargaste en Configuración > Impuestos. Corregí la CUIT o generá un certificado nuevo con la CUIT correcta.",
  },
  pv_no_habilitado: {
    title: "Hay puntos de venta que ARCA no tiene como Web Services",
    action:
      "Dalos de alta en ARCA (Administración de puntos de venta y domicilios) con el sistema Web Services y el mismo número que usa la sucursal, o cambiá el número de la sucursal por uno que ARCA sí liste.",
  },
  sin_respuesta: {
    title: "ARCA no respondió",
    action: "La venta quedó registrada y la factura se reintenta sola. Si tenés contingencia activa, se emite con CAEA.",
  },
  ta_ya_emitido: {
    title: "ARCA ya entregó un permiso de acceso que NinjaSoft no tiene guardado",
    action: "Hay que esperar a que venza (hasta 12 horas desde que se pidió) y reprocesar. No se reintenta solo para no empeorarlo.",
  },
  certificado_faltante: {
    title: "Falta el certificado de este ambiente",
    action: "Completá el paso Certificado del asistente.",
  },
  certificado_ilegible: {
    title: "No se pudo leer el certificado guardado",
    action: "Volvé a generar el pedido y cargar el certificado.",
  },
  plataforma_no_configurada: {
    title: "La delegación en NinjaSoft todavía no está disponible",
    action: "Usá el camino Certificado propio.",
  },
  sin_punto_de_venta: {
    title: "La sucursal o la caja no tiene punto de venta",
    action: "Elegí el punto de venta en el paso Punto de venta.",
  },
  importes_no_cierran: {
    title: "Los importes de la venta no cierran como pide ARCA",
    action: "Revisá las alícuotas de los productos de la venta y reprocesá.",
  },
  nada_para_acreditar: {
    title: "No queda importe para la nota de crédito",
    action: "Las devoluciones ya acreditaron el total de la factura.",
  },
  csr_faltante: {
    title: "Primero generá el pedido de certificado (CSR) en NinjaSoft",
    action: "En el paso Certificado tocá Generar pedido, copialo y subilo a ARCA.",
  },
  fiscal_data_missing: {
    title: "Faltan los datos fiscales del negocio",
    action: "Cargá la condición frente al IVA y la CUIT en Configuración > Impuestos.",
  },
  server_not_configured: {
    title: "Falta configurar el cifrado en el servidor",
    action: "Avisá a soporte de NinjaSoft (secret ARCA_KEY_ENC).",
  },
  exportacion_no_soportada: {
    title: "La factura E de exportación todavía no se emite",
    action: "Va por otro servicio de ARCA (WSFEX). Emitila desde ARCA por ahora.",
  },
  receptor_sin_cuit: {
    title: "La factura A necesita el CUIT del cliente",
    action: "Cargá el CUIT en la ficha del cliente y reprocesá.",
  },
  emisor_sin_configurar: {
    title: "Faltan la condición frente al IVA y el CUIT del negocio",
    action: "Completalos en Configuración > Impuestos y reprocesá.",
  },
  consumidor_final_sin_identificar: {
    title: "Por el monto, el consumidor final tiene que estar identificado",
    action: "Asigná a la venta un cliente con DNI o CUIT y reprocesá.",
  },
  cert_invalido: { title: "Eso no parece un certificado", action: "Pegá el texto completo, desde -----BEGIN CERTIFICATE-----." },
  cert_no_corresponde: {
    title: "El certificado no corresponde al pedido generado en NinjaSoft",
    action: "Asegurate de haber subido a ARCA el pedido (CSR) que copiaste de esta pantalla.",
  },
  cert_vencido: { title: "El certificado está vencido", action: "Generá uno nuevo." },
  cert_no_vigente: { title: "El certificado todavía no es válido", action: "Revisá la fecha de emisión." },
  cert_emisor_incorrecto: {
    title: "El certificado es de otro ambiente",
    action: "Para prueba lo emite WSASS (Computadores Test); para facturar en real, Administración de Certificados Digitales (Computadores).",
  },
  cert_sin_cuit: { title: "El certificado no tiene CUIT", action: "Generá el pedido desde NinjaSoft y volvé a cargarlo." },
  cert_cuit_distinto: {
    title: "El certificado es de otra CUIT",
    action: "La CUIT del certificado tiene que ser la del negocio (Configuración > Impuestos).",
  },
};

export function humanError(code: string | null | undefined, fallback?: string | null): { title: string; action: string } {
  if (code) {
    // Los faults de WSAA pueden venir con prefijo de namespace (ns1:coe.notAuthorized).
    const c = code.trim().replace(/^[a-z0-9]+:(?=[a-z])/i, "").toLowerCase();
    const k = Object.keys(HUMAN_ERRORS).find((x) => x.toLowerCase() === c);
    if (k) return HUMAN_ERRORS[k] as { title: string; action: string };
  }
  return { title: fallback || "ARCA devolvió un error", action: "Revisá el detalle y reprocesá." };
}

export function joinMsgs(list: ArcaMsg[]): string {
  return list.map((m) => (m.code ? `${m.code}: ${m.msg}` : m.msg)).join(" · ").slice(0, 900);
}
