// =============================================================================
// lib/shipping/providers.ts  (Envíos · ADR-103) · PURO
//
// Qué pide cada logística para conectarse y qué le tiene que tramitar el
// dueño. La lista de logísticas, su estado y capacidades vienen de la base
// (shipping_providers); acá sólo la ayuda y los campos del formulario.
// SHIPPING_PROVIDER_FEATURE es ESPEJO de shipping_provider_plan_key (SQL):
// la UI lo usa para mostrar el candado; el servidor lo exige igual.
// =============================================================================

export const SHIPPING_MODULE_FEATURE = "envios";

/** Logística → key de plan. El simulador no tiene key propia (lo cubre `envios`). */
export const SHIPPING_PROVIDER_FEATURE: Record<string, string | null> = {
  simulador: null,
  andreani: "andreani",
  correo_argentino: "correo_argentino",
  oca: "oca",
  enviopack: "enviopack",
};

export function shippingProviderFeature(key: string): string | null {
  return key in SHIPPING_PROVIDER_FEATURE ? (SHIPPING_PROVIDER_FEATURE[key] ?? null) : key;
}

export interface ProviderField {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** true = va a shipping_secrets (nunca vuelve al navegador). */
  secret?: boolean;
  required?: boolean;
  type?: "text" | "select";
  options?: { value: string; label: string }[];
}

export interface ProviderGuide {
  /** Qué tiene que pedir el dueño y a quién. */
  steps: string[];
  fields: ProviderField[];
  /** Advertencia visible (limitaciones). */
  warning?: string;
  sandboxLabel?: string;
}

const ORIGIN_FIELDS: ProviderField[] = [
  {
    key: "origin_postal_code",
    label: "CP de despacho (opcional)",
    hint: "Si despachás desde otra dirección que la de la sucursal (por ejemplo un depósito).",
    placeholder: "1414",
  },
  { key: "origin_street", label: "Calle de despacho", placeholder: "Thames" },
  { key: "origin_number", label: "Número", placeholder: "1234" },
  { key: "origin_city", label: "Localidad", placeholder: "CABA" },
  { key: "origin_province", label: "Provincia", placeholder: "Ciudad Autónoma de Buenos Aires" },
];

const SENDER_FIELDS: ProviderField[] = [
  { key: "sender_name", label: "Remitente en la etiqueta (opcional)", hint: "Si no, va el nombre del negocio." },
  { key: "sender_cuit", label: "CUIT del remitente (opcional)", placeholder: "20-12345678-9" },
];

const LABEL_FIELD = (formats: { value: string; label: string }[]): ProviderField => ({
  key: "label_format",
  label: "Formato de etiqueta",
  type: "select",
  options: formats,
});

export const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  simulador: {
    steps: [
      "No necesita contrato ni credenciales: sirve para probar todo el circuito (cotizar, crear, imprimir, seguir y cancelar).",
      "Las etiquetas dicen \"Etiqueta de prueba\" y no sirven para despachar.",
      "Para probar errores, poné en el nombre del destinatario [rechazo], [caido], [timeout] o [ausente].",
    ],
    fields: [
      LABEL_FIELD([
        { value: "pdf", label: "PDF" },
        { value: "zpl", label: "ZPL (Zebra)" },
      ]),
      {
        key: "label_size",
        label: "Tamaño del PDF",
        type: "select",
        options: [
          { value: "10x15", label: "Térmica 10x15" },
          { value: "a4", label: "A4" },
        ],
      },
      {
        key: "minutes_per_step",
        label: "Minutos entre cada avance del seguimiento",
        placeholder: "1",
      },
    ],
    sandboxLabel: "Siempre de prueba",
  },
  andreani: {
    steps: [
      "Pedile a tu ejecutivo de cuentas de Andreani el alta de la API REST para tu CUIT (requiere contrato PyME, Middle Market o Corporativo).",
      "Te tienen que dar: usuario y contraseña de la API, número de cliente (CL...) y un número de contrato por servicio (a domicilio y a sucursal).",
      "Pedí también el código de tu sucursal de origen para cotizar (por ejemplo BAR).",
      "Probá primero en el ambiente de prueba (QA) y después pasá a producción con las credenciales reales.",
    ],
    fields: [
      { key: "username", label: "Usuario de la API", secret: true, required: true },
      { key: "password", label: "Contraseña de la API", secret: true, required: true },
      { key: "client_number", label: "Número de cliente", placeholder: "CL0003750", required: true },
      { key: "contract_door", label: "Contrato a domicilio", placeholder: "400006709" },
      { key: "contract_branch", label: "Contrato a sucursal", placeholder: "400006711" },
      { key: "origin_branch", label: "Sucursal de origen para cotizar", placeholder: "BAR" },
      ...SENDER_FIELDS,
      ...ORIGIN_FIELDS,
    ],
    warning:
      "Andreani no permite cancelar un envío por API: si te arrepentís, se cancela en NinjaSoft y tenés que avisarle a tu ejecutivo. La etiqueta sale en PDF.",
    sandboxLabel: "Prueba (QA de Andreani)",
  },
  correo_argentino: {
    steps: [
      "MiCorreo (pymes): creá tu cuenta en MiCorreo con tu CUIT y pedí las credenciales de API por el formulario de contacto.",
      "PAQ.AR (empresas): pedile a tu ejecutivo de cuentas el Agreement y la API key.",
      "Importante: con MiCorreo el envío se importa a tu cuenta y la etiqueta se paga e imprime en la web de MiCorreo.",
    ],
    fields: [
      {
        key: "api",
        label: "Tipo de cuenta",
        type: "select",
        options: [
          { value: "micorreo", label: "MiCorreo (pymes)" },
          { value: "paqar", label: "PAQ.AR (empresas)" },
        ],
      },
      { key: "username", label: "Usuario MiCorreo", secret: true },
      { key: "password", label: "Contraseña MiCorreo", secret: true },
      { key: "agreement", label: "Agreement (PAQ.AR)", secret: true },
      { key: "api_key", label: "API key (PAQ.AR)", secret: true },
    ],
    warning: "Próximamente: podés dejar cargadas las credenciales; todavía no se crean envíos con Correo Argentino.",
  },
  oca: {
    steps: [
      "Pedí a OCA (0800-999-7700 o tu ejecutivo) una cuenta e-Pak con tu CUIT.",
      "Te tienen que habilitar una operativa por servicio (puerta a puerta, puerta a sucursal, etc.) y darte usuario y contraseña de e-Pak.",
    ],
    fields: [
      { key: "username", label: "Usuario e-Pak", secret: true },
      { key: "password", label: "Contraseña e-Pak", secret: true },
      { key: "cuit", label: "CUIT", placeholder: "30-12345678-9" },
      { key: "operativa_door", label: "Operativa a domicilio" },
      { key: "operativa_branch", label: "Operativa a sucursal" },
    ],
    warning: "Próximamente: podés dejar cargadas las credenciales; todavía no se crean envíos con OCA.",
  },
  enviopack: {
    steps: [
      "Creá una cuenta en Envíopack con tu CUIT: te da acceso a varios carriers con tarifas propias o tus contratos.",
      "En el panel de Envíopack generá la API key y la secret key.",
    ],
    fields: [
      { key: "api_key", label: "API key", secret: true },
      { key: "secret_key", label: "Secret key", secret: true },
    ],
    warning: "Próximamente: podés dejar cargadas las credenciales; todavía no se crean envíos con Envíopack.",
  },
};

/** Logísticas sin integración directa todavía: qué conviene hacer. */
export const PLANNED_PROVIDER_NOTE =
  "Sin API pública: se suman cuando un negocio con contrato consiga la documentación o a través de un agregador (Envíopack o Zipnova).";

export function guideFor(key: string): ProviderGuide | null {
  return PROVIDER_GUIDES[key] ?? null;
}

/** Separa lo que el formulario manda como config (visible) y como secretos. */
export function splitConnectionValues(
  key: string,
  values: Record<string, string>,
): { config: Record<string, string>; secrets: Record<string, string> } {
  const guide = guideFor(key);
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of guide?.fields ?? []) {
    const v = (values[f.key] ?? "").trim();
    if (!v) continue;
    if (f.secret) secrets[f.key] = v;
    else config[f.key] = v;
  }
  return { config, secrets };
}

/** Campos obligatorios que faltan (los secretos ya cargados cuentan). */
export function missingRequired(key: string, values: Record<string, string>, storedSecretKeys: string[]): string[] {
  const guide = guideFor(key);
  return (guide?.fields ?? [])
    .filter((f) => f.required)
    .filter((f) => !(values[f.key] ?? "").trim() && !(f.secret && storedSecretKeys.includes(f.key)))
    .map((f) => f.label);
}
