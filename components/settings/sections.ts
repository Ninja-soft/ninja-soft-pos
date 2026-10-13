import {
  BadgeDollarSign,
  Bike,
  Building2,
  CalendarDays,
  Clock,
  CreditCard,
  FileCheck2,
  LayoutTemplate,
  Mail,
  MonitorSmartphone,
  Package,
  Palette,
  Percent,
  Plug,
  Printer,
  ReceiptText,
  RotateCcw,
  ScanLine,
  Landmark,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  KeyRound,
  Store,
  Tag,
  Truck,
  Users,
  Utensils,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

// Mapa del centro de Configuración: grupos, secciones, textos del encabezado
// y palabras clave del buscador. Las keys son las de `?seccion=` (no se
// renombran: hay links internos que apuntan a ellas; los alias de abajo
// cubren nombres alternativos).

export type SettingsSectionKey =
  | "apariencia"
  | "diseno-pos"
  | "rubro"
  | "sucursales"
  | "seguridad"
  | "marca"
  | "tickets"
  | "impresion"
  | "email"
  | "pagos"
  | "posnet"
  | "terminales"
  | "operacion"
  | "salones"
  | "menus"
  | "zonas"
  | "profesionales"
  | "paquetes"
  | "clientes"
  | "cuenta-corriente"
  | "devoluciones"
  | "escaner"
  | "pantalla-cliente"
  | "hardware"
  | "precios"
  | "garantias"
  | "impuestos"
  | "promociones"
  | "nubceo"
  | "api"
  | "envios"
  | "mercadolibre"
  | "canales-delivery"
  | "facturacion";

export type SettingsSectionDef = {
  key: SettingsSectionKey;
  /** Etiqueta corta del menú (una línea). */
  label: string;
  /** Título del encabezado de la sección (puede ser más largo). */
  title: string;
  description: string;
  icon: LucideIcon;
  /** Términos extra para el buscador del menú. */
  keywords?: string;
  // `feature` (opcional): si el plan no la incluye, la sección queda
  // deshabilitada (candado) y el click abre el UpgradeModal en lugar de entrar.
  feature?: string;
  // `requiresDining` / `requiresDelivery` (opcional): la sección sólo se
  // muestra con el modo gastronómico (H43) o delivery (H49) activos. No es
  // gating de plan sino un toggle del tenant: se oculta, sin candado.
  requiresDining?: boolean;
  requiresDelivery?: boolean;
};

export type SettingsGroup = { title: string; sections: SettingsSectionDef[] };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: "Personal",
    sections: [
      {
        key: "apariencia",
        label: "Apariencia",
        title: "Apariencia",
        description:
          "Tema, tipografías y fondo de la app. Se guardan en tu cuenta y te siguen en cualquier dispositivo.",
        icon: Palette,
        keywords: "tema oscuro claro fuente tipografia fondo color precios modo",
      },
    ],
  },
  {
    title: "Negocio",
    sections: [
      {
        key: "rubro",
        label: "Rubro",
        title: "Rubro del negocio",
        description: "Tu actividad define qué funciones del POS se adaptan a cómo trabajás. Cambiá el perfil por rubro con vista previa.",
        icon: Tag,
        keywords: "actividad vertical kiosco textil restaurante catalogo vaciar perfil cambiar rubro almacen ferreteria farmacia verduleria libreria",
      },
      {
        key: "marca",
        label: "Marca",
        title: "Marca del negocio",
        description: "Logo, color y datos que se ven en tickets, comprobantes y catálogo.",
        icon: Store,
        feature: "personalizacion_marca",
        keywords: "logo color razon social cuit direccion telefono",
      },
      {
        key: "sucursales",
        label: "Sucursales y cajas",
        title: "Sucursales y cajas",
        description: "Tus locales, sus cajas y qué personal trabaja en cada uno, con traslados programados.",
        icon: Building2,
        keywords: "sucursal local caja punto de venta personal empleados traslado cobertura multi",
      },
      {
        key: "seguridad",
        label: "Seguridad y auditoría",
        title: "Seguridad y auditoría",
        description:
          "Qué acciones piden PIN de supervisor y desde qué monto, quién autoriza, tu PIN y el registro de todo lo que pasa en el negocio.",
        icon: ShieldCheck,
        keywords: "pin supervisor autorizacion anulacion devolucion retiro descuento auditoria registro log caja compartida",
      },
    ],
  },
  {
    title: "Punto de venta",
    sections: [
      {
        key: "diseno-pos",
        label: "Diseño del POS",
        title: "Diseño del POS",
        description:
          "Cómo se ve la pantalla de venta: estilo, grilla, carrito, medios fijados y teclas rápidas.",
        icon: LayoutTemplate,
        keywords: "pantalla venta grilla carrito teclas rapidas layout",
      },
      {
        key: "operacion",
        label: "Operación y productos",
        title: "Operación y productos",
        description: "Reglas de cobro y de productos que se aplican en el punto de venta.",
        icon: SlidersHorizontal,
        keywords: "gastronomico mesas delivery venta libre plu stock redondeo vuelto",
      },
      {
        key: "salones",
        label: "Salones y mesas",
        title: "Salones y mesas",
        description:
          "Tus salones (Salón principal, Terraza, Barra) y las mesas de cada uno con su capacidad. La atención por mesas está en Salón.",
        icon: Utensils,
        requiresDining: true,
        keywords: "gastronomia restaurante mesas sector",
      },
      {
        key: "menus",
        label: "Menús por horario",
        title: "Menús por horario",
        description:
          "Cartas por franja (Desayuno, Almuerzo, Happy hour, Cena) con su horario y productos. Sin horario, el menú está siempre disponible.",
        icon: Clock,
        requiresDining: true,
        keywords: "carta horario franja gastronomia",
      },
      {
        key: "zonas",
        label: "Zonas de envío",
        title: "Zonas de envío",
        description:
          "Zonas de reparto con tarifa y tiempo estimado. Al tomar un pedido elegís la zona y el envío se completa solo.",
        icon: Bike,
        requiresDelivery: true,
        keywords: "delivery reparto envio tarifa",
      },
      {
        key: "profesionales",
        label: "Profesionales",
        title: "Profesionales y agenda",
        description:
          "Quienes prestan los servicios (peluquería, estética, turnos), con color y comisión. Los turnos se gestionan en Agenda.",
        icon: CalendarDays,
        feature: "agenda",
        keywords: "agenda turnos peluqueria estetica comision",
      },
      {
        key: "paquetes",
        label: "Paquetes y sesiones",
        title: "Paquetes y sesiones",
        description:
          "Bonos de sesiones (4 cortes, 10 sesiones). Al venderlos se acreditan al cliente y cada visita consume una al cobrar.",
        icon: Package,
        feature: "packs",
        keywords: "packs bonos sesiones servicios",
      },
    ],
  },
  {
    title: "Cobros",
    sections: [
      {
        key: "pagos",
        label: "Medios de pago",
        title: "Medios de pago",
        description: "Conectá tus cuentas y elegí con qué canales cobrás en el POS.",
        icon: CreditCard,
        keywords: "mercado pago tarjetas cuotas qr posnet transferencia efectivo recargo",
      },
      // ADR-054: posnet offline (Tarjeta en posnet): terminales y datos del cupón.
      {
        key: "posnet",
        label: "Tarjeta en posnet",
        title: "Tarjeta en posnet",
        description:
          "Cobrás en tu terminal sin integrar (Payway, Getnet, Clover...) y cargás el cupón. Elegí las terminales y qué datos se piden.",
        icon: CreditCard,
        keywords: "posnet cupon voucher lote autorizacion ultimos 4 payway getnet fiserv clover nave adquirente terminal offline",
      },
      // F17 · H93 (ADR-049): registro de terminales por sucursal y caja (BASE).
      {
        key: "terminales",
        label: "Terminales de cobro",
        title: "Terminales de cobro",
        description: "Point, Clover, cajas QR y posnets de cada sucursal y caja. El POS usa la de su caja sola.",
        icon: CreditCard,
        keywords: "point clover nave posnet lector terminal caja qr sucursal numero de comercio",
      },
      // Promociones y cupones (F9, ADR-074). La sección no se gatea entera
      // porque los cupones no dependen del plan: la tarjeta de Promociones
      // muestra el bloqueo si falta `promociones` (gating real en la base).
      {
        key: "promociones",
        label: "Promociones y cupones",
        title: "Promociones y cupones",
        description:
          "Promos por condiciones que el POS aplica solas y códigos de descuento que el cajero ingresa al cobrar.",
        icon: Percent,
        keywords: "descuento cupon codigo 2x1 3x2 oferta combo banco tarjeta segunda unidad",
      },
      {
        key: "cuenta-corriente",
        label: "Cuenta corriente",
        title: "Cuenta corriente",
        description:
          "Plazos, cuotas, punitorios, bloqueo por mora y recordatorios. Cada cliente o grupo puede tener condiciones propias.",
        icon: Wallet,
        feature: "cuenta_corriente",
        keywords: "fiado credito mora punitorios pin supervisor grupos",
      },
    ],
  },
  {
    title: "Catálogo y precios",
    sections: [
      {
        key: "precios",
        label: "Listas de precios",
        title: "Listas de precios",
        description:
          "Precios por canal (mostrador, catálogo, mayorista) con ajuste % global o precio puntual por producto.",
        icon: BadgeDollarSign,
        feature: "listas_precios",
        keywords: "mayorista canal ajuste porcentaje",
      },
      {
        key: "garantias",
        label: "Garantías extendidas",
        title: "Garantías extendidas",
        description:
          "Planes que ofrecés al cobrar: meses extra, prima fija o % del precio y comisión del vendedor.",
        icon: ShieldCheck,
        feature: "garantias",
        keywords: "garantia extendida prima",
      },
      {
        key: "impuestos",
        label: "Impuestos",
        title: "Impuestos",
        description:
          "Condición fiscal del negocio, IVA de los ítems sin producto, agente de percepción y retención, jurisdicciones y padrones.",
        icon: Landmark,
        feature: "impuestos_iva",
        keywords: "iva alicuota afip arca cuit iibb ingresos brutos arba agip percepcion retencion padron monotributo responsable inscripto fiscal",
      },
    ],
  },
  {
    title: "Clientes y postventa",
    sections: [
      {
        key: "clientes",
        label: "Datos del cliente",
        title: "Datos del cliente",
        description: "Qué pedir al crear o editar un cliente y cómo se maneja su cuenta.",
        icon: Users,
        keywords: "documento dni obligatorio email comprobante",
      },
      {
        key: "devoluciones",
        label: "Devoluciones",
        title: "Devoluciones",
        description: "Cómo se resuelven las devoluciones y los vales (saldo a favor) del negocio.",
        icon: RotateCcw,
        feature: "devoluciones",
        keywords: "cambio vale saldo a favor reintegro motivos",
      },
    ],
  },
  {
    // Tickets: el ingreso NO se gatea. El ticket predeterminado siempre se
    // imprime y se envía; la personalización (modelos custom) queda detrás de
    // `tickets_pro` dentro de la sección.
    title: "Comprobantes",
    sections: [
      {
        key: "tickets",
        label: "Modelos de ticket",
        title: "Modelos de ticket",
        description: "Diseñá cómo se imprimen tus comprobantes con bloques arrastrables.",
        icon: ReceiptText,
        keywords: "ticket comprobante plantilla diseño",
      },
      {
        key: "facturacion",
        label: "Facturación electrónica",
        title: "Facturación electrónica ARCA",
        description:
          "Facturas A, B y C con CAE de ARCA, paso a paso: certificado, punto de venta, prueba y paso a real.",
        icon: FileCheck2,
        feature: "facturacion_afip",
        keywords: "arca afip cae caea factura electronica certificado punto de venta homologacion produccion contingencia wsfe qr",
      },
      {
        key: "impresion",
        label: "Impresión",
        title: "Impresión",
        description:
          "Por tipo de comprobante: formato, copias y si sale solo al confirmar o con un botón.",
        icon: Printer,
        keywords: "impresora termica 58 80 mm a4 pdf copias",
      },
      {
        key: "email",
        label: "Email del negocio",
        title: "Email del negocio",
        description: "Enviá los comprobantes a tus clientes desde tu propio email.",
        icon: Mail,
        feature: "email_comprobantes",
        keywords: "correo smtp gmail envio comprobante",
      },
    ],
  },
  // Integraciones con sistemas externos (ADR-062).
  {
    title: "Integraciones",
    sections: [
      {
        key: "nubceo",
        label: "NubCeo",
        title: "NubCeo",
        description:
          "Mandá cada venta con sus cobros a NubCeo para conciliar tarjetas y billeteras, mirá lo enviado y traé los asientos contables.",
        icon: Plug,
        feature: "integracion_nubceo",
        keywords: "nubceo conciliacion conciliar liquidaciones asientos contables contabilidad integracion api envio ventas",
      },
      // Canales de delivery (ADR-102): PedidosYa, Rappi, Uber Eats y simulador.
      {
        key: "canales-delivery",
        label: "Canales de delivery",
        title: "Canales de delivery",
        description:
          "Pedidos de PedidosYa, Rappi y Uber Eats que entran solos, van a cocina, se facturan y muestran al repartidor. Con simulador para probar.",
        icon: Bike,
        feature: "canales_delivery",
        requiresDelivery: true,
        keywords: "pedidosya rappi uber eats mp apps marketplace webhook simulador repartidor comanda mapeo",
      },
      // API pública v1 (ADR-094): credenciales OAuth2 por negocio, sólo el dueño.
      {
        key: "api",
        label: "API",
        title: "API pública",
        description:
          "Credenciales para conectar tu tienda online, ERP o planillas: productos, stock, precios, ventas y clientes por API.",
        icon: KeyRound,
        feature: "api_publica",
        keywords: "api rest oauth token credencial client id secret integracion erp ecommerce tienda sincronizar webhook desarrollador",
      },
      // Envíos y logística (ADR-103): logísticas por negocio o sucursal.
      {
        key: "envios",
        label: "Envíos",
        title: "Envíos y logísticas",
        description:
          "Conectá Andreani y otras logísticas con tu contrato, por negocio o por sucursal, probá las credenciales y mirá qué pedirle a cada una.",
        icon: Truck,
        feature: "envios",
        keywords: "envios logistica andreani correo argentino oca pickit hop andesmar bluemail cabify enviopack etiqueta despacho carrier courier seguimiento tracking",
      },
      // Mercado Libre (H87 · ADR-104): cuentas conectadas y su sincronización.
      {
        key: "mercadolibre",
        label: "Mercado Libre",
        title: "Mercado Libre",
        description:
          "Conectá tus cuentas de Mercado Libre: stock y precio de las publicaciones desde el POS, ventas que entran solas, facturación y etiquetas.",
        icon: ShoppingBag,
        feature: "mercadolibre",
        keywords: "mercado libre mercadolibre meli publicaciones ventas online marketplace sincronizar stock precio etiquetas envios preguntas canal ecommerce",
      },
    ],
  },
  {
    title: "Hardware",
    sections: [
      {
        key: "escaner",
        label: "Escáner",
        title: "Escáner",
        description:
          "Perfil del lector de código de barras: prefijo y sufijo, beep de confirmación y anti-duplicado.",
        icon: ScanLine,
        keywords: "lector codigo de barras scanner",
      },
      {
        key: "pantalla-cliente",
        label: "Pantalla del cliente",
        title: "Pantalla del cliente",
        description:
          "Una segunda pantalla de cara al cliente con el carrito, el total, el QR de pago y el vuelto en vivo.",
        icon: MonitorSmartphone,
        keywords: "doble pantalla monitor tablet",
      },
      {
        key: "hardware",
        label: "Hardware",
        title: "Balanza, cajón y diagnóstico",
        description:
          "Reglas de balanza y cajón por negocio o sucursal, equipos de cada caja, pruebas guiadas y diagnóstico para soporte.",
        icon: Wrench,
        keywords: "hardware impresora cajon cajón balanza pesables etiqueta peso soporte prueba diagnostico",
      },
    ],
  },
];

/** Lista plana (validación del query param, buscador). */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = SETTINGS_GROUPS.flatMap(
  (g) => g.sections,
);

/** Nombres alternativos aceptados en `?seccion=`. */
export const SECTION_ALIASES: Record<string, SettingsSectionKey> = {
  cupones: "promociones",
  arca: "facturacion",
  afip: "facturacion",
  "factura-electronica": "facturacion",
  diagnostico: "hardware",
  pantalla: "pantalla-cliente",
  cuenta: "cuenta-corriente",
  "listas-precios": "precios",
  "medios-pago": "pagos",
  cupon: "posnet",
  voucher: "posnet",
  tema: "apariencia",
  auditoria: "seguridad",
  pin: "seguridad",
  supervisor: "seguridad",
  integraciones: "nubceo",
  meli: "mercadolibre",
  "mercado-libre": "mercadolibre",
  "api-publica": "api",
  logistica: "envios",
  logisticas: "envios",
  andreani: "envios",
  pedidosya: "canales-delivery",
  rappi: "canales-delivery",
  "apps-delivery": "canales-delivery",
  credenciales: "api",
  conciliacion: "nubceo",
  fiscal: "impuestos",
  iva: "impuestos",
  percepciones: "impuestos",
  padrones: "impuestos",
};

export const DEFAULT_SECTION: SettingsSectionKey = "apariencia";

/** Resuelve `?seccion=` (key o alias) a una sección válida, o null. */
export function resolveSection(q: string | null | undefined): SettingsSectionKey | null {
  if (!q) return null;
  if (SETTINGS_SECTIONS.some((s) => s.key === q)) return q as SettingsSectionKey;
  return SECTION_ALIASES[q] ?? null;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Filtra los grupos por texto (etiqueta, título, grupo y palabras clave, sin
 * tildes). Todas las palabras de la búsqueda tienen que aparecer.
 */
export function filterSettingsGroups(
  groups: SettingsGroup[],
  query: string,
): SettingsGroup[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return groups;
  return groups
    .map((g) => ({
      ...g,
      sections: g.sections.filter((s) => {
        const hay = normalize(
          [g.title, s.label, s.title, s.keywords ?? ""].join(" "),
        );
        return terms.every((t) => hay.includes(t));
      }),
    }))
    .filter((g) => g.sections.length > 0);
}
