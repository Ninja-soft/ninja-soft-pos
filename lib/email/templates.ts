// Catálogo de emails del sistema + render de variables. El envío real (Resend)
// se conecta en una etapa siguiente. Ver docs/02-roadmap.md H13.

export interface EmailTemplateDef {
  key: string;
  label: string;
  description: string;
  variables: string[];
  defaultSubject: string;
  defaultHtml: string;
}

const BASE_VARS = ["negocio", "logo_url"];

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: "welcome",
    label: "Bienvenida",
    description: "Se envía cuando alguien se suma a tu negocio.",
    variables: [...BASE_VARS, "nombre"],
    defaultSubject: "¡Bienvenido a {{negocio}}!",
    defaultHtml:
      "<h1>Hola {{nombre}} 👋</h1><p>Te damos la bienvenida a <b>{{negocio}}</b>. Ya podés empezar a usar el sistema.</p>",
  },
  {
    key: "user_invite",
    label: "Invitación de usuario",
    description: "Invitación para que un usuario se una con su cuenta.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Te invitaron a {{negocio}}",
    defaultHtml:
      "<p>Hola {{nombre}}, te sumaron a <b>{{negocio}}</b>.</p><p><a href=\"{{link}}\">Activá tu cuenta</a>.</p>",
  },
  {
    key: "password_reset",
    label: "Restablecer contraseña",
    description: "Enlace para que el usuario cambie su contraseña.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Restablecé tu contraseña",
    defaultHtml:
      "<p>Hola {{nombre}}, para cambiar tu contraseña hacé clic <a href=\"{{link}}\">acá</a>.</p>",
  },
  {
    key: "trial_ending",
    label: "Prueba por vencer",
    description: "Aviso antes de que termine el período de prueba.",
    variables: [...BASE_VARS, "dias", "vence"],
    defaultSubject: "Tu prueba de {{negocio}} vence pronto",
    defaultHtml:
      "<p>Tu período de prueba termina en <b>{{dias}} días</b> ({{vence}}). Activá tu plan para no perder acceso.</p>",
  },
  {
    key: "payment_due",
    label: "Pago pendiente",
    description: "Aviso de pago vencido o pendiente.",
    variables: [...BASE_VARS, "monto", "vence"],
    defaultSubject: "Tenés un pago pendiente en {{negocio}}",
    defaultHtml:
      "<p>Registramos un pago pendiente de <b>{{monto}}</b> con vencimiento {{vence}}.</p>",
  },
  {
    key: "suspended",
    label: "Cuenta suspendida",
    description: "Aviso de suspensión por falta de pago.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu cuenta de {{negocio}} fue suspendida",
    defaultHtml:
      "<p>Tu cuenta fue suspendida por falta de pago. Regularizá para reactivarla.</p>",
  },
  // --- Fase E — motor de cobros (dunning) -----------------------------------
  // Estos defaults son INFORMATIVOS: el cron arma su propio HTML branded por
  // cada email. Existen acá para que staff pueda customizar copy/asunto a
  // futuro desde /internal/emails (overrides en system_email_templates).
  {
    key: "payment_failed",
    label: "Problema con el cobro",
    description: "Cobro no confirmado: la suscripción pasa a vencida.",
    variables: [...BASE_VARS],
    defaultSubject: "Hubo un problema con tu cobro",
    defaultHtml:
      "<p>No pudimos confirmar el pago de tu suscripción. Revisá tu medio de pago en Mercado Pago para no perder acceso.</p>",
  },
  {
    key: "suspended_dunning",
    label: "Suspensión por mora",
    description: "Suspensión automática tras superar los días de gracia.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu cuenta de {{negocio}} fue suspendida",
    defaultHtml:
      "<p>Suspendimos tu cuenta por falta de pago. Regularizá tu suscripción para reactivarla.</p>",
  },
  {
    key: "payment_reminder",
    label: "Recordatorio de renovación",
    description: "Aviso de renovación próxima de la suscripción.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Tu suscripción se renueva pronto",
    defaultHtml:
      "<p>Tu suscripción se renueva el {{vence}}. El cobro es automático por Mercado Pago; verificá que tu medio de pago esté activo.</p>",
  },
  {
    key: "trial_expired",
    label: "Prueba vencida",
    description: "La prueba terminó sin conversión: la cuenta queda pausada.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu prueba de {{negocio}} terminó",
    defaultHtml:
      "<p>Tu período de prueba terminó y pausamos tu cuenta. Activá un plan cuando quieras para retomar donde lo dejaste.</p>",
  },
  {
    key: "price_increase",
    label: "Actualización de tarifa",
    description: "Aviso de aumento de precio a los suscriptos del plan.",
    variables: [...BASE_VARS, "precio_anterior", "precio_nuevo"],
    defaultSubject: "Actualización de tarifa de tu plan",
    defaultHtml:
      "<p>Tu tarifa pasa de {{precio_anterior}} a {{precio_nuevo}} por mes a partir de tu próximo ciclo de facturación.</p>",
  },
];

/** Reemplaza {{variable}} por su valor; si falta, deja el placeholder. */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) =>
    key in vars ? vars[key]! : `{{${key}}}`,
  );
}

/** Valores de ejemplo para el preview. */
export function sampleVars(negocio: string): Record<string, string> {
  return {
    negocio,
    logo_url: "",
    nombre: "Juan Pérez",
    link: "https://ninja-soft-pos.vercel.app/login",
    dias: "3",
    vence: "31/05/2026",
    monto: "$ 12.500,00",
  };
}
