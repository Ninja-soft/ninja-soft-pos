// Respuestas REALES del QA público de Andreani (apisqa.andreani.com), tomadas
// el 2026-10-13 con las credenciales de prueba publicadas (ADR-103). Sólo se
// recortaron listas largas. La tarifa NO se pudo obtener en QA (el contrato de
// prueba responde "No se pudo obtener la tarifa"): QUOTE_OK sigue la forma del
// cliente comunitario node-andreani-api y está marcada como no verificada.

export const LOGIN_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI1YWJmMzljMS0wMWIzLTQ4YTItYjEzOC1jNGNkMTE2ZWIzNDciLCJ1c2VyTmFtZSI6InVzdWFyaW9fdGVzdCIsImdyb3VwSWQiOiJhNDFjMjU2Yi1kNGM3LTRiYzEtOTA5Mi1jM2FkZWQ5YzM5MWMiLCJpYXQiOjE3OTE4OTAxOTAsImV4cCI6MTc5MTk3NjU5MH0.BeslnbVxfTT68Z5Agnq2wy2EYIVgqfB5yaTMPTB1Iy4";

/** POST /v2/ordenes-de-envio → 202 (a domicilio). */
export const ORDER_CREATED = {
  estado: "Pendiente",
  tipo: "B2C",
  sucursalDeDistribucion: { nomenclatura: "FLO", descripcion: "FLORES (AV JUAN B ALBERDI)", id: "15" },
  sucursalDeRendicion: {},
  sucursalDeImposicion: {},
  sucursalAbastecedora: {},
  fechaCreacion: "2026-10-13T08:17:19-03:00",
  numeroDePermisionaria: "RNPSP Nº 586",
  descripcionServicio: "ENCOMIENDA ECOMMERCE",
  bultos: [
    {
      numeroDeBulto: "1",
      numeroDeEnvio: "360000108921289",
      totalizador: "1/1",
      linking: [
        { meta: "Etiqueta", contenido: "https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000964698/etiquetas?bulto=1" },
      ],
    },
  ],
  agrupadorDeBultos: "API0000000964698",
  etiquetasPorAgrupador: "https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000964698/etiquetas",
};

/** POST /v2/ordenes-de-envio sin bultos → 400. */
export const ORDER_INVALID = [{ Code: null, Property: "Bultos", Message: "Debe enviar bultos o articulos, pero no ambos." }];

/** GET /v2/envios/{n}/trazas de un envío existente en QA. */
export const TRAZAS = {
  eventos: [
    {
      Fecha: "2026-07-24T16:28:37",
      Estado: "Ingreso al circuito operativo",
      Evento: "AltaAutomatica",
      EstadoId: 5,
      Traduccion: "ENVIO INGRESADO AL SISTEMA",
      Sucursal: "Barracas",
      SucursalId: 3,
      Ciclo: "Distribution",
    },
  ],
};

/** GET /v2/envios/{n} recién creado → 404. */
export const ENVIO_NOT_FOUND = {
  type: "about:blank",
  title: "Recurso no encontrado",
  detail: "Envio no encontrado",
  status: 404,
  errors: null,
};

/** GET /v1/tarifas con el contrato de prueba → 400. */
export const QUOTE_REJECTED = {
  type: "about:blank",
  title: "Error en la validacion de su pedido",
  detail: "No se pudo obtener la tarifa",
  status: 400,
  errors: null,
};

/** Forma de una tarifa OK (NO verificada en QA; node-andreani-api). */
export const QUOTE_OK = {
  pesoAforado: "1.50",
  tarifaSinIva: { seguroDistribucion: "120.00", distribucion: "4500.00", total: "4620.00" },
  tarifaConIva: { seguroDistribucion: "145.20", distribucion: "5445.00", total: "5590.20" },
};

/** GET /v2/sucursales?codigoPostal=1406 (2 de 4). */
export const SUCURSALES = [
  {
    id: 10015,
    codigo: "FLO",
    numero: "15",
    descripcion: "FLORES (AV JUAN B ALBERDI)",
    canal: "B2C",
    direccion: {
      calle: "Av. Juan B. Alberdi ",
      numero: "3138",
      provincia: "Buenos Aires",
      localidad: "C.a.b.a.",
      region: "Caba",
      pais: "Argentina",
      codigoPostal: "1406",
    },
    coordenadas: { latitud: "-34.634340", longitud: "-58.471690" },
    horarioDeAtencion: "Lunes a viernes de 08:00 a 18:00 – Sábados de 08:00 a 13:00Hs",
    datosAdicionales: { seHaceAtencionAlCliente: true, tipo: "CENTRO DE DISTRIBUCION", admiteEnvios: true, entregaEnvios: true },
  },
  {
    id: 20146,
    codigo: "146",
    numero: "146",
    descripcion: "CDS CENTRO DE DISTRIB. MERCADO CENTRAL",
    canal: "B2B",
    direccion: { calle: "", numero: "", provincia: "Buenos Aires", localidad: "Mercado Central", codigoPostal: "1771" },
    coordenadas: { latitud: "", longitud: "" },
    horarioDeAtencion: "",
    datosAdicionales: { seHaceAtencionAlCliente: false, tipo: "", admiteEnvios: false, entregaEnvios: false },
  },
];

/** Primeros bytes de la etiqueta real (application/pdf, ~36 KB). */
export const LABEL_PDF_HEAD = "%PDF-1.4\n";
