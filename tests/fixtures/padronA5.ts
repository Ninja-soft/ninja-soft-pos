// Respuestas de ws_sr_constancia_inscripcion (getPersona_v2) para los tests
// (F20-3). Armadas a partir de la estructura documentada por ARCA; datos
// ficticios. Nunca se llama al servicio real desde los tests.
const env = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const ret = (inner: string) =>
  env(`<ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn>${inner}<metadata><fechaHora>2026-10-14T10:00:00-03:00</fechaHora><servidor>aws</servidor></metadata></personaReturn></ns2:getPersona_v2Response>`);

const domicilio = `<domicilioFiscal><codPostal>2000</codPostal><descripcionProvincia>SANTA FE</descripcionProvincia><direccion>MITRE 123 PISO 2</direccion><idProvincia>12</idProvincia><localidad>ROSARIO</localidad><tipoDomicilio>FISCAL</tipoDomicilio></domicilioFiscal>`;

/** Sociedad responsable inscripta (IVA, impuesto 30). */
export const RI_JURIDICA = ret(
  `<datosGenerales>${domicilio}<esSucesion>NO</esSucesion><estadoClave>ACTIVO</estadoClave><idPersona>30712345671</idPersona><mesCierre>12</mesCierre><razonSocial>ACME &amp; ASOCIADOS S.R.L.</razonSocial><tipoClave>CUIT</tipoClave><tipoPersona>JURIDICA</tipoPersona></datosGenerales>` +
    `<datosRegimenGeneral><actividad><descripcionActividad>SERVICIOS DE CONSULTORES EN INFORMATICA</descripcionActividad><idActividad>620100</idActividad><nomenclador>883</nomenclador><orden>1</orden><periodo>201901</periodo></actividad>` +
    `<impuesto><descripcionImpuesto>GANANCIAS SOCIEDADES</descripcionImpuesto><idImpuesto>10</idImpuesto><periodo>201901</periodo></impuesto>` +
    `<impuesto><descripcionImpuesto>IVA</descripcionImpuesto><idImpuesto>30</idImpuesto><periodo>201901</periodo></impuesto></datosRegimenGeneral>`,
);

/** Persona física monotributista (impuesto 20 en datosMonotributo). */
export const MONOTRIBUTO_FISICA = ret(
  `<datosGenerales><apellido>PEREZ</apellido>${domicilio}<estadoClave>ACTIVO</estadoClave><idPersona>20287654329</idPersona><nombre>JUAN CARLOS</nombre><tipoClave>CUIT</tipoClave><tipoPersona>FISICA</tipoPersona></datosGenerales>` +
    `<datosMonotributo><actividadMonotributista><descripcionActividad>VENTA AL POR MENOR EN KIOSCOS</descripcionActividad><idActividad>477461</idActividad></actividadMonotributista>` +
    `<categoriaMonotributo><descripcionCategoria>B VENTAS DE COSAS MUEBLES</descripcionCategoria><idCategoria>21</idCategoria><idImpuesto>20</idImpuesto><periodo>202402</periodo></categoriaMonotributo>` +
    `<impuesto><descripcionImpuesto>MONOTRIBUTO</descripcionImpuesto><idImpuesto>20</idImpuesto><periodo>202402</periodo></impuesto></datosMonotributo>`,
);

/** Exento en IVA (impuesto 32). */
export const EXENTO = ret(
  `<datosGenerales>${domicilio}<estadoClave>ACTIVO</estadoClave><idPersona>30500000001</idPersona><razonSocial>FUNDACION EJEMPLO</razonSocial><tipoPersona>JURIDICA</tipoPersona></datosGenerales>` +
    `<datosRegimenGeneral><impuesto><descripcionImpuesto>IVA EXENTO</descripcionImpuesto><idImpuesto>32</idImpuesto><periodo>201001</periodo></impuesto></datosRegimenGeneral>`,
);

/** CUIT activa sin IVA ni monotributo (sólo ganancias): consumidor final. */
export const SIN_IVA = ret(
  `<datosGenerales><apellido>GOMEZ</apellido>${domicilio}<estadoClave>INACTIVO</estadoClave><idPersona>20111111112</idPersona><nombre>ANA</nombre><tipoPersona>FISICA</tipoPersona></datosGenerales>` +
    `<datosRegimenGeneral><impuesto><descripcionImpuesto>GANANCIAS PERSONAS FISICAS</descripcionImpuesto><idImpuesto>11</idImpuesto><periodo>201001</periodo></impuesto></datosRegimenGeneral>` +
    `<errorConstancia><apellido>GOMEZ</apellido><error>El contribuyente cuenta con impuestos con baja de oficio por Decreto 1299/98</error><idPersona>20111111112</idPersona></errorConstancia>`,
);

/** Sólo errorConstancia, sin datos generales. */
export const SOLO_ERROR = ret(
  `<errorConstancia><error>La clave se encuentra inactiva</error><idPersona>20222222223</idPersona></errorConstancia>`,
);

/** Fault: la persona no existe. */
export const NO_EXISTE = env(
  `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>No existe persona con ese Id</faultstring></soap:Fault>`,
);

/** Fault: el certificado no está autorizado al servicio. */
export const SIN_AUTORIZACION = env(
  `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>No autorizado: el CUIT representado no tiene permiso para el servicio</faultstring></soap:Fault>`,
);
