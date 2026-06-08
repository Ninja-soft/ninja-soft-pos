// Catálogo de emails del sistema + render de variables. El envío real lo hace la
// Edge Function send_email (Resend + failover SMTP, ver supabase/functions). Estos
// son los DEFAULTS: staff los edita en /internal/emails (overrides en
// system_email_templates). La migración 20260608190000_email_templates_full.sql
// siembra estos mismos defaults en la tabla (on conflict do nothing).

export interface EmailTemplateDef {
  key: string;
  label: string;
  description: string;
  variables: string[];
  defaultSubject: string;
  defaultHtml: string;
}

const BASE_VARS = ["negocio", "logo_url"];

// Wordmark de NinjaPos para el header (sobre fondo claro) y para el footer oscuro.
const NINJA_LOGO_LIGHT =
  "https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-light-mode.webp";
const NINJA_LOGO_DARK =
  "https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp";

/**
 * Envoltorio branded de NinjaPos: tarjeta blanca con el logo claro arriba, un
 * acento naranja y footer oscuro (#09051C) con el wordmark dark-mode. Solo estilos
 * inline (los clientes de email descartan <style>/clases). `body` es HTML confiable
 * (proviene del catálogo, no de input de usuario).
 */
function brandedEmail(body: string): string {
  return (
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #eef0f3;border-radius:14px;overflow:hidden">' +
    '<div style="padding:28px 32px 8px;text-align:center">' +
    `<img src="${NINJA_LOGO_LIGHT}" alt="NinjaPos" style="max-height:26px;display:inline-block" />` +
    '<div style="height:3px;width:48px;background:#f97316;border-radius:99px;margin:18px auto 0"></div>' +
    "</div>" +
    '<div style="padding:20px 32px 32px;color:#1f2937;line-height:1.6;font-size:15px">' +
    body +
    "</div>" +
    '<div style="background:#09051C;padding:18px 12px;text-align:center">' +
    `<img src="${NINJA_LOGO_DARK}" alt="NinjaPos" style="max-height:20px;display:inline-block" />` +
    '<div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div>' +
    "</div>" +
    "</div>"
  );
}

// Botón de acción primario (naranja NinjaPos). `href` viene del catálogo.
function ctaButton(href: string, label: string): string {
  return (
    `<div style="text-align:center;margin:22px 0 4px">` +
    `<a href="${href}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 26px;border-radius:10px;font-size:15px">${label}</a>` +
    "</div>"
  );
}

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  // === Transaccionales — ciclo de cuenta ====================================
  {
    key: "account_registered",
    label: "Cuenta creada",
    description: "Se envía apenas alguien crea su cuenta en NinjaPos.",
    variables: [...BASE_VARS, "nombre"],
    defaultSubject: "Tu cuenta de NinjaPos está creada",
    defaultHtml: brandedEmail(
      "<p>¡Hola {{nombre}}! 🎉</p>" +
        "<p>Creamos tu cuenta en <b>NinjaPos</b>. Ya podés entrar y empezar a configurar <b>{{negocio}}</b>.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Ingresar a NinjaPos"),
    ),
  },
  {
    key: "email_confirmation",
    label: "Confirmar email",
    description: "Enlace para confirmar la dirección de email de la cuenta.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Confirmá tu email para activar tu cuenta",
    defaultHtml: brandedEmail(
      "<p>Hola {{nombre}},</p>" +
        "<p>Confirmá tu dirección de email para terminar de activar tu cuenta de NinjaPos.</p>" +
        ctaButton("{{link}}", "Confirmar mi email") +
        '<p style="color:#6b7280;font-size:13px;margin-top:16px">Si no creaste esta cuenta, podés ignorar este email.</p>',
    ),
  },
  {
    key: "welcome",
    label: "Bienvenida",
    description: "Mensaje de bienvenida al sumarse a un negocio.",
    variables: [...BASE_VARS, "nombre"],
    defaultSubject: "¡Bienvenido a {{negocio}}!",
    defaultHtml: brandedEmail(
      "<p>Hola {{nombre}} 👋</p>" +
        "<p>Te damos la bienvenida a <b>{{negocio}}</b>. Ya podés empezar a usar el sistema y vender en minutos.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Empezar ahora"),
    ),
  },
  {
    key: "password_recovery",
    label: "Recuperar contraseña",
    description: "Enlace para que el usuario restablezca su contraseña.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Restablecé tu contraseña de NinjaPos",
    defaultHtml: brandedEmail(
      "<p>Hola {{nombre}},</p>" +
        "<p>Pediste restablecer tu contraseña. Hacé clic en el botón para elegir una nueva.</p>" +
        ctaButton("{{link}}", "Cambiar mi contraseña") +
        '<p style="color:#6b7280;font-size:13px;margin-top:16px">Si no fuiste vos, ignorá este email: tu contraseña no cambia.</p>',
    ),
  },

  // === Transaccionales — trial y suscripción ================================
  {
    key: "trial_started",
    label: "Prueba iniciada",
    description: "Confirma el inicio del período de prueba gratuito.",
    variables: [...BASE_VARS, "dias", "vence"],
    defaultSubject: "Arrancó tu prueba gratis de NinjaPos",
    defaultHtml: brandedEmail(
      "<p>¡Listo! Empezó tu prueba gratis de <b>NinjaPos</b> para <b>{{negocio}}</b>.</p>" +
        "<p>Tenés <b>{{dias}} días</b> con todo desbloqueado (hasta el {{vence}}). Probá el punto de venta, cargá tus productos y sumá a tu equipo.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Explorar NinjaPos"),
    ),
  },
  {
    key: "trial_ending",
    label: "Prueba por vencer",
    description: "Aviso antes de que termine el período de prueba.",
    variables: [...BASE_VARS, "dias", "vence"],
    defaultSubject: "Tu prueba de NinjaPos vence pronto",
    defaultHtml: brandedEmail(
      "<p>Tu período de prueba termina en <b>{{dias}} días</b> ({{vence}}).</p>" +
        "<p>Activá tu plan para no perder acceso a <b>{{negocio}}</b> ni a tu información.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Activar mi plan"),
    ),
  },
  {
    key: "subscription_activated",
    label: "Suscripción activada",
    description: "Confirma que la suscripción quedó activa.",
    variables: [...BASE_VARS, "plan", "vence"],
    defaultSubject: "Tu suscripción de NinjaPos está activa",
    defaultHtml: brandedEmail(
      "<p>¡Gracias por sumarte! Tu plan <b>{{plan}}</b> ya está activo para <b>{{negocio}}</b>.</p>" +
        "<p>Tu próxima renovación es el {{vence}}. El cobro es automático por Mercado Pago.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Ir a mi panel"),
    ),
  },
  {
    key: "subscription_cancelled",
    label: "Suscripción cancelada",
    description: "Confirma la cancelación de la suscripción.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Cancelamos tu suscripción de NinjaPos",
    defaultHtml: brandedEmail(
      "<p>Tu suscripción de <b>{{negocio}}</b> quedó cancelada.</p>" +
        "<p>Tenés acceso hasta el {{vence}}. Después, tu cuenta se pausa pero tu información queda guardada por si querés volver.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Reactivar cuando quieras"),
    ),
  },

  // === Transaccionales — cobros =============================================
  {
    key: "payment_ok",
    label: "Pago confirmado",
    description: "Confirma un cobro exitoso de la suscripción.",
    variables: [...BASE_VARS, "monto", "vence"],
    defaultSubject: "Recibimos tu pago — gracias",
    defaultHtml: brandedEmail(
      "<p>¡Listo! Recibimos tu pago de <b>{{monto}}</b> por la suscripción de <b>{{negocio}}</b>.</p>" +
        "<p>Tu acceso sigue activo. Tu próxima renovación es el {{vence}}.</p>",
    ),
  },
  {
    key: "payment_failed",
    label: "Problema con el cobro",
    description: "El cobro no se confirmó: la suscripción pasa a vencida.",
    variables: [...BASE_VARS],
    defaultSubject: "Hubo un problema con tu cobro",
    defaultHtml: brandedEmail(
      "<p>No pudimos confirmar el pago de tu suscripción de <b>{{negocio}}</b>.</p>" +
        "<p>Revisá tu medio de pago en Mercado Pago para no perder acceso. Vamos a reintentar el cobro automáticamente.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Revisar mi pago"),
    ),
  },
  {
    key: "payment_reminder",
    label: "Recordatorio de renovación",
    description: "Aviso de renovación próxima de la suscripción.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Tu suscripción se renueva pronto",
    defaultHtml: brandedEmail(
      "<p>Tu suscripción de <b>{{negocio}}</b> se renueva el <b>{{vence}}</b>.</p>" +
        "<p>El cobro es automático por Mercado Pago; verificá que tu medio de pago esté activo para no perder acceso.</p>",
    ),
  },

  // === Transaccionales — addon IA ===========================================
  {
    key: "addon_ai_activated",
    label: "Asistente IA activado",
    description: "Confirma la activación del addon de asistente IA.",
    variables: [...BASE_VARS],
    defaultSubject: "Activaste el Asistente IA en NinjaPos",
    defaultHtml: brandedEmail(
      "<p>¡Buenísimo! Activaste el <b>Asistente IA</b> en <b>{{negocio}}</b>.</p>" +
        "<p>Ya podés pedirle reportes, resúmenes y ayuda en lenguaje natural desde tu panel.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Probar el Asistente IA"),
    ),
  },
  {
    key: "addon_ai_cancelled",
    label: "Asistente IA cancelado",
    description: "Confirma la baja del addon de asistente IA.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Diste de baja el Asistente IA",
    defaultHtml: brandedEmail(
      "<p>Diste de baja el <b>Asistente IA</b> de <b>{{negocio}}</b>.</p>" +
        "<p>Lo vas a poder seguir usando hasta el {{vence}}. Después, el resto de tu plan sigue igual.</p>",
    ),
  },

  // === Transaccionales — Tiendita (compra de catálogo) =====================
  {
    key: "catalog_purchased",
    label: "Catálogo comprado",
    description: "Confirma la compra de un catálogo de Tiendita (pago único).",
    variables: [...BASE_VARS, "catalogo"],
    defaultSubject: "Ya tenés acceso a tu catálogo en NinjaPos",
    defaultHtml: brandedEmail(
      "<p>¡Listo! Tu compra del catálogo <b>{{catalogo}}</b> para <b>{{negocio}}</b> se acreditó.</p>" +
        "<p>Entrá a Tiendita para buscar productos del catálogo y agregarlos a tu tienda con un clic.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Ir a Tiendita"),
    ),
  },

  // === Legacy / catálogo previo (no romper flujos existentes) ===============
  // Estas claves ya existían (dunning, invitaciones). Se conservan tal cual para
  // no romper overrides ni el HTML que arma el cron por su cuenta.
  {
    key: "user_invite",
    label: "Invitación de usuario",
    description: "Invitación para que un usuario se una con su cuenta.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Te invitaron a {{negocio}}",
    defaultHtml: brandedEmail(
      "<p>Hola {{nombre}}, te sumaron a <b>{{negocio}}</b>.</p>" +
        ctaButton("{{link}}", "Activar mi cuenta"),
    ),
  },
  {
    key: "trial_expired",
    label: "Prueba vencida",
    description: "La prueba terminó sin conversión: la cuenta queda pausada.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu prueba de {{negocio}} terminó",
    defaultHtml: brandedEmail(
      "<p>Tu período de prueba terminó y pausamos tu cuenta.</p>" +
        "<p>Activá un plan cuando quieras para retomar <b>{{negocio}}</b> donde lo dejaste.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Activar un plan"),
    ),
  },
  {
    key: "suspended_dunning",
    label: "Suspensión por mora",
    description: "Suspensión automática tras superar los días de gracia.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu cuenta de {{negocio}} fue suspendida",
    defaultHtml: brandedEmail(
      "<p>Suspendimos tu cuenta por falta de pago.</p>" +
        "<p>Regularizá tu suscripción para reactivar <b>{{negocio}}</b>.</p>" +
        ctaButton("https://ninja-soft-pos.vercel.app/login", "Regularizar ahora"),
    ),
  },
  {
    key: "price_increase",
    label: "Actualización de tarifa",
    description: "Aviso de aumento de precio a los suscriptos del plan.",
    variables: [...BASE_VARS, "precio_anterior", "precio_nuevo"],
    defaultSubject: "Actualización de tarifa de tu plan",
    defaultHtml: brandedEmail(
      "<p>Te avisamos que tu tarifa pasa de <b>{{precio_anterior}}</b> a <b>{{precio_nuevo}}</b> por mes, a partir de tu próximo ciclo de facturación.</p>" +
        "<p>No tenés que hacer nada: el cobro sigue siendo automático.</p>",
    ),
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
    plan: "Pyme",
    precio_anterior: "$ 9.900,00",
    precio_nuevo: "$ 12.500,00",
    catalogo: "Kiosco esencial",
  };
}
