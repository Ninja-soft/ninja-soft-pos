// =============================================================================
// Directo (ADR-181, API Ecommerce 2.0): reglas del comprador y textos de error
// para las pantallas. La lógica pura vive en
// supabase/functions/_shared/directo.ts (la usan las Edges) y se reexporta acá.
// =============================================================================
export {
  buildFullName,
  dniFromDocument,
  normalizeDni,
  sexTypeId,
  splitCustomerName,
} from "@/supabase/functions/_shared/directo";

const COPY: Record<string, string> = {
  directo_buyer_required: "Completá DNI, apellido y nombre del cliente, como figuran en su DNI.",
  directo_sex_required: "Elegí el sexo que figura en el DNI para consultar la oferta.",
  directo_rate_limited:
    "Llegaste al tope de 20 consultas de oferta por hora. Podés generar el cobro igual: Directo evalúa al cliente en su página.",
  directo_auth_failed:
    "Directo rechazó las credenciales del comercio. Revisalas en Configuración → Medios de pago → Directo y que sean del mismo ambiente que el switch QA.",
  directo_invalid_credentials:
    "Directo no aceptó este usuario y contraseña en el ambiente elegido. Revisalos o probá el otro ambiente.",
  directo_missing_fields: "Completá el usuario y la contraseña que te dio Directo.",
  directo_invalid_policy_product: "El Policy Product sólo admite letras, números y guiones (ej. BNPL o 62).",
  directo_invalid_base_url: "La URL de la API tiene que ser https, sin parámetros.",
  directo_timeout: "Directo no respondió a tiempo. Probá de nuevo en unos segundos.",
  directo_unreachable: "No pudimos comunicarnos con Directo. Revisá tu conexión y probá de nuevo.",
  directo_invalid_person:
    "Directo no reconoce a esa persona. Revisá el DNI, el sexo y que el apellido y el nombre estén como en el DNI.",
  directo_policy_required:
    "Tu usuario de Directo tiene más de una política: cargá el Policy Product en Configuración → Medios de pago → Directo.",
  directo_rejected: "Directo no tiene una oferta de crédito para este cliente.",
  directo_invalid_plan:
    "Directo informa un problema con la configuración comercial (InvalidPlan). Consultalo con tu ejecutivo comercial de Directo.",
  directo_no_installments: "Directo no encontró planes de cuotas para este monto.",
  directo_invalid_request: "Directo rechazó los datos enviados. Revisá el DNI, el nombre y el monto.",
  directo_error: "Directo devolvió un error. Probá de nuevo en unos segundos.",
};

/** Texto para un código `directo_*` de las Edges, o null si no es de Directo. */
export function directoErrorCopy(code: string | null | undefined): string | null {
  return code ? (COPY[code] ?? null) : null;
}
