// Catálogo de emails del sistema + render de variables. El envío real lo hace la
// Edge Function send_email (Resend + failover SMTP, ver supabase/functions). Estos
// son los DEFAULTS: staff los edita en /internal/emails (overrides en
// system_email_templates). La migración 20261011160000_emails_diseno_ninja_soft.sql
// guarda estos mismos defaults en la tabla; se genera con
// scripts/gen-email-templates-sql.ts (no copiar el HTML a mano).
//
// El diseño (header oscuro con la llama, ícono, eyebrow, título, botón pastilla,
// footer con logos) vive en lib/email/layout.ts.

import { APP_URL, emailLayout } from "./layout";

export interface EmailTemplateDef {
  key: string;
  label: string;
  description: string;
  variables: string[];
  defaultSubject: string;
  defaultHtml: string;
  /**
   * Migración que siembra esta plantilla, si no es la general
   * (20261011160000_emails_diseno_ninja_soft.sql, que ya está aplicada y no se
   * regenera para plantillas nuevas).
   */
  migration?: string;
}

const BASE_VARS = ["negocio", "logo_url"];
const LOGIN = `${APP_URL}/login`;

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  // === Transaccionales: ciclo de cuenta =====================================
  {
    key: "account_registered",
    label: "Cuenta creada",
    description: "Se envía apenas alguien crea su cuenta en NinjaPos.",
    variables: [...BASE_VARS, "nombre"],
    defaultSubject: "Tu cuenta de NinjaPos está creada",
    defaultHtml: emailLayout({
      preheader: "Tu cuenta está lista. Entrá y configurá {{negocio}} en minutos.",
      icon: "🎉",
      eyebrow: "Cuenta creada",
      title: "¡Hola, {{nombre}}!",
      intro:
        "Tu cuenta de <b>NinjaPos</b> ya está lista. Entrá y empezá a configurar <b>{{negocio}}</b>: cargá tus productos, abrí la caja y hacé tu primera venta.",
      cta: { href: LOGIN, label: "Ingresar a NinjaPos" },
      note: "Tu usuario es este email. Guardalo para ingresar desde cualquier dispositivo.",
    }),
  },
  {
    key: "email_confirmation",
    label: "Confirmar email",
    description: "Enlace para confirmar la dirección de email de la cuenta.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Confirmá tu email para activar tu cuenta",
    defaultHtml: emailLayout({
      preheader: "Un clic y tu cuenta de NinjaPos queda activa.",
      icon: "✉️",
      eyebrow: "Confirmá tu email",
      title: "Un paso más, {{nombre}}",
      intro:
        "Confirmá tu dirección de email para terminar de activar tu cuenta de <b>NinjaPos</b>.",
      cta: { href: "{{link}}", label: "Confirmar mi email" },
      note: "Si no creaste esta cuenta, podés ignorar este email.",
    }),
  },
  {
    key: "welcome",
    label: "Bienvenida",
    description: "Mensaje de bienvenida al sumarse a un negocio.",
    variables: [...BASE_VARS, "nombre"],
    defaultSubject: "¡Bienvenido a {{negocio}}!",
    defaultHtml: emailLayout({
      preheader: "Ya formás parte de {{negocio}} en NinjaPos.",
      icon: "👋",
      eyebrow: "Bienvenida",
      title: "¡Bienvenido a {{negocio}}!",
      intro:
        "Hola {{nombre}}, ya formás parte del equipo de <b>{{negocio}}</b> en NinjaPos. Entrá y empezá a vender en minutos.",
      cta: { href: LOGIN, label: "Empezar ahora" },
    }),
  },
  {
    key: "password_recovery",
    label: "Recuperar contraseña",
    description: "Enlace para que el usuario restablezca su contraseña.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Restablecé tu contraseña de NinjaPos",
    defaultHtml: emailLayout({
      preheader: "Elegí una contraseña nueva para tu cuenta de NinjaPos.",
      icon: "🔑",
      eyebrow: "Seguridad de tu cuenta",
      title: "Restablecé tu contraseña",
      intro:
        "Hola {{nombre}}, recibimos un pedido para cambiar la contraseña de tu cuenta. Tocá el botón para elegir una nueva.",
      cta: { href: "{{link}}", label: "Cambiar mi contraseña" },
      note: "Si no fuiste vos, ignorá este email: tu contraseña no cambia.",
    }),
  },

  // === Transaccionales: trial y suscripción =================================
  {
    key: "trial_started",
    label: "Prueba iniciada",
    description: "Confirma el inicio del período de prueba gratuito.",
    variables: [...BASE_VARS, "dias", "vence"],
    defaultSubject: "Arrancó tu prueba gratis de NinjaPos",
    defaultHtml: emailLayout({
      preheader: "Tenés {{dias}} días con todo desbloqueado para {{negocio}}.",
      icon: "🚀",
      eyebrow: "Prueba gratis activa",
      title: "Arrancó tu prueba de NinjaPos",
      intro:
        "Tenés todo desbloqueado para <b>{{negocio}}</b>. Probá el punto de venta, cargá tus productos y sumá a tu equipo.",
      rows: [
        ["Duración", "{{dias}} días"],
        ["Disponible hasta", "{{vence}}"],
      ],
      cta: { href: LOGIN, label: "Explorar NinjaPos" },
    }),
  },
  {
    key: "trial_ending",
    label: "Prueba por vencer",
    description: "Aviso antes de que termine el período de prueba.",
    variables: [...BASE_VARS, "dias", "vence"],
    defaultSubject: "Tu prueba de NinjaPos vence pronto",
    defaultHtml: emailLayout({
      preheader: "Activá tu plan para seguir usando {{negocio}} sin cortes.",
      icon: "⏳",
      eyebrow: "Tu prueba termina pronto",
      title: "Te quedan {{dias}} días de prueba",
      intro:
        "Activá tu plan para seguir usando <b>{{negocio}}</b> sin cortes y sin perder tu información.",
      rows: [
        ["Negocio", "{{negocio}}"],
        ["La prueba vence", "{{vence}}"],
      ],
      cta: { href: LOGIN, label: "Activar mi plan" },
    }),
  },
  {
    key: "subscription_activated",
    label: "Suscripción activada",
    description: "Confirma que la suscripción quedó activa.",
    variables: [...BASE_VARS, "plan", "vence"],
    defaultSubject: "Tu suscripción de NinjaPos está activa",
    defaultHtml: emailLayout({
      preheader: "Tu plan {{plan}} ya está activo para {{negocio}}.",
      icon: "✅",
      tone: "success",
      eyebrow: "Suscripción activa",
      title: "¡Gracias por sumarte!",
      intro: "Tu plan <b>{{plan}}</b> ya está activo para <b>{{negocio}}</b>.",
      rows: [
        ["Plan", "{{plan}}"],
        ["Próxima renovación", "{{vence}}"],
        ["Cobro", "Automático por Mercado Pago"],
      ],
      cta: { href: LOGIN, label: "Ir a mi panel" },
    }),
  },
  {
    key: "subscription_cancelled",
    label: "Suscripción cancelada",
    description: "Confirma la cancelación de la suscripción.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Cancelamos tu suscripción de NinjaPos",
    defaultHtml: emailLayout({
      preheader: "Tenés acceso hasta el {{vence}}. Tu información queda guardada.",
      icon: "📦",
      eyebrow: "Suscripción cancelada",
      title: "Cancelamos tu suscripción",
      intro:
        "La suscripción de <b>{{negocio}}</b> quedó cancelada. Después de esa fecha tu cuenta se pausa, pero tu información queda guardada por si querés volver.",
      rows: [["Acceso hasta", "{{vence}}"]],
      cta: { href: LOGIN, label: "Reactivar cuando quieras" },
    }),
  },

  // === Transaccionales: cobros ==============================================
  {
    key: "payment_ok",
    label: "Pago confirmado",
    description: "Confirma un cobro exitoso de la suscripción.",
    variables: [...BASE_VARS, "monto", "vence"],
    defaultSubject: "Recibimos tu pago. ¡Gracias!",
    defaultHtml: emailLayout({
      preheader: "Acreditamos {{monto}} por la suscripción de {{negocio}}.",
      icon: "💳",
      tone: "success",
      eyebrow: "Pago recibido",
      title: "¡Gracias por tu pago!",
      intro:
        "Acreditamos el pago de la suscripción de <b>{{negocio}}</b>. Tu acceso sigue activo.",
      rows: [
        ["Monto", "{{monto}}"],
        ["Próxima renovación", "{{vence}}"],
      ],
      cta: { href: LOGIN, label: "Ir a mi panel" },
    }),
  },
  {
    key: "payment_failed",
    label: "Problema con el cobro",
    description: "El cobro no se confirmó: la suscripción pasa a vencida.",
    variables: [...BASE_VARS],
    defaultSubject: "Hubo un problema con tu cobro",
    defaultHtml: emailLayout({
      preheader: "Revisá tu medio de pago para no perder acceso a {{negocio}}.",
      icon: "⚠️",
      tone: "danger",
      eyebrow: "Problema con el cobro",
      title: "No pudimos cobrar tu suscripción",
      intro:
        "No pudimos confirmar el pago de <b>{{negocio}}</b>. Revisá tu medio de pago en Mercado Pago para no perder acceso: vamos a reintentar el cobro automáticamente.",
      cta: { href: LOGIN, label: "Revisar mi pago" },
      note: "Si ya pagaste, podés ignorar este aviso.",
    }),
  },
  {
    key: "payment_reminder",
    label: "Recordatorio de renovación",
    description: "Aviso de renovación próxima de la suscripción.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Tu suscripción se renueva pronto",
    defaultHtml: emailLayout({
      preheader: "Tu suscripción de {{negocio}} se renueva el {{vence}}.",
      icon: "🔔",
      eyebrow: "Renovación próxima",
      title: "Tu suscripción se renueva pronto",
      intro:
        "El cobro es automático por Mercado Pago. Verificá que tu medio de pago esté activo para que <b>{{negocio}}</b> siga sin cortes.",
      rows: [["Fecha de renovación", "{{vence}}"]],
      cta: { href: LOGIN, label: "Ver mi suscripción" },
    }),
  },

  // === Transaccionales: addon IA ============================================
  {
    key: "addon_ai_activated",
    label: "Asistente IA activado",
    description: "Confirma la activación del addon de asistente IA.",
    variables: [...BASE_VARS],
    defaultSubject: "Activaste el Asistente IA en NinjaPos",
    defaultHtml: emailLayout({
      preheader: "Pedile reportes y resúmenes de {{negocio}} en lenguaje natural.",
      icon: "✨",
      eyebrow: "Asistente IA",
      title: "Tu Asistente IA está listo",
      intro:
        "Activaste el <b>Asistente IA</b> en <b>{{negocio}}</b>. Pedile reportes, resúmenes y ayuda en lenguaje natural desde tu panel.",
      cta: { href: LOGIN, label: "Probar el Asistente IA" },
    }),
  },
  {
    key: "addon_ai_cancelled",
    label: "Asistente IA cancelado",
    description: "Confirma la baja del addon de asistente IA.",
    variables: [...BASE_VARS, "vence"],
    defaultSubject: "Diste de baja el Asistente IA",
    defaultHtml: emailLayout({
      preheader: "Podés seguir usándolo hasta {{vence}}.",
      icon: "🤖",
      eyebrow: "Asistente IA",
      title: "Diste de baja el Asistente IA",
      intro:
        "Lo vas a poder seguir usando en <b>{{negocio}}</b> hasta la fecha de abajo. Después, el resto de tu plan sigue igual.",
      rows: [["Disponible hasta", "{{vence}}"]],
      cta: { href: LOGIN, label: "Ir a mi panel" },
    }),
  },

  // === Transaccionales: Tiendita (compra de catálogo) ======================
  {
    key: "catalog_purchased",
    label: "Catálogo comprado",
    description: "Confirma la compra de un catálogo de Tiendita (pago único).",
    variables: [...BASE_VARS, "catalogo"],
    defaultSubject: "Ya tenés acceso a tu catálogo en NinjaPos",
    defaultHtml: emailLayout({
      preheader: "El catálogo {{catalogo}} ya está disponible en Tiendita.",
      icon: "🛍️",
      tone: "success",
      eyebrow: "Compra confirmada",
      title: "Tu catálogo ya está disponible",
      intro:
        "Se acreditó la compra para <b>{{negocio}}</b>. Entrá a Tiendita, buscá productos del catálogo y agregalos a tu tienda con un clic.",
      rows: [
        ["Catálogo", "{{catalogo}}"],
        ["Pago", "Único, sin renovación"],
      ],
      cta: { href: LOGIN, label: "Ir a Tiendita" },
    }),
  },

  // === Ciclo de cobro e invitaciones ========================================
  // Estas claves ya existían (dunning, invitaciones): se conservan las claves y
  // las variables para no romper a quien las encola.
  {
    key: "user_invite",
    label: "Invitación de usuario",
    description: "Invitación para que un usuario se una con su cuenta.",
    variables: [...BASE_VARS, "nombre", "link"],
    defaultSubject: "Te invitaron a {{negocio}}",
    defaultHtml: emailLayout({
      preheader: "Activá tu cuenta y empezá a usar NinjaPos en {{negocio}}.",
      icon: "🤝",
      eyebrow: "Invitación",
      title: "Te sumaron a {{negocio}}",
      intro:
        "Hola {{nombre}}, te invitaron a usar <b>NinjaPos</b> en <b>{{negocio}}</b>. Activá tu cuenta para empezar.",
      cta: { href: "{{link}}", label: "Activar mi cuenta" },
      note: "Si no esperabas esta invitación, podés ignorar este email.",
      reason: "Recibiste este email porque te invitaron a un negocio en NinjaPos.",
    }),
  },
  {
    key: "trial_expired",
    label: "Prueba vencida",
    description: "La prueba terminó sin conversión: la cuenta queda pausada.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu prueba de {{negocio}} terminó",
    defaultHtml: emailLayout({
      preheader: "Tu información queda guardada. Activá un plan cuando quieras.",
      icon: "⌛",
      eyebrow: "Prueba finalizada",
      title: "Terminó tu prueba gratis",
      intro:
        "Pausamos la cuenta de <b>{{negocio}}</b>. Tu información queda guardada: activá un plan cuando quieras y retomá donde lo dejaste.",
      cta: { href: LOGIN, label: "Activar un plan" },
    }),
  },
  {
    key: "suspended_dunning",
    label: "Suspensión por mora",
    description: "Suspensión automática tras superar los días de gracia.",
    variables: [...BASE_VARS],
    defaultSubject: "Tu cuenta de {{negocio}} fue suspendida",
    defaultHtml: emailLayout({
      preheader: "Regularizá el pago para reactivar {{negocio}}.",
      icon: "⛔",
      tone: "danger",
      eyebrow: "Cuenta suspendida",
      title: "Suspendimos tu cuenta",
      intro:
        "No registramos el pago de la suscripción de <b>{{negocio}}</b>, así que pausamos el acceso. Regularizá el pago y tu cuenta vuelve con toda tu información.",
      cta: { href: LOGIN, label: "Regularizar ahora" },
      note: "Si ya pagaste, tu cuenta se reactiva sola cuando se acredita el pago.",
    }),
  },
  {
    key: "price_increase",
    label: "Actualización de tarifa",
    description: "Aviso de aumento de precio a los suscriptos del plan.",
    variables: [...BASE_VARS, "precio_anterior", "precio_nuevo"],
    defaultSubject: "Actualización de tarifa de tu plan",
    defaultHtml: emailLayout({
      preheader: "Tu tarifa pasa a {{precio_nuevo}} por mes desde tu próximo ciclo.",
      icon: "📈",
      eyebrow: "Actualización de tarifa",
      title: "Actualizamos la tarifa de tu plan",
      intro:
        "A partir de tu próximo ciclo de facturación cambia la tarifa mensual de <b>{{negocio}}</b>. No tenés que hacer nada: el cobro sigue siendo automático.",
      rows: [
        ["Tarifa actual", "{{precio_anterior}} / mes"],
        ["Nueva tarifa", "{{precio_nuevo}} / mes"],
      ],
      cta: { href: LOGIN, label: "Ver mi suscripción" },
    }),
  },
  // === Staff: participación (F21 · ADR-121) =================================
  {
    key: "staff_payout_credited",
    label: "Pago al staff acreditado",
    description: "Avisa a una persona del staff que NinjaSoft le pagó (total o parcial) su liquidación.",
    variables: [...BASE_VARS, "nombre", "monto", "periodo", "medio", "fecha", "referencia", "cuenta"],
    defaultSubject: "NinjaSoft te acreditó {{monto}}",
    defaultHtml: emailLayout({
      preheader: "Pago de tu liquidación de {{periodo}}.",
      icon: "💸",
      tone: "success",
      eyebrow: "Pago acreditado",
      title: "Te pagamos {{monto}}",
      intro: "Hola {{nombre}}, NinjaSoft registró un pago de tu participación de <b>{{periodo}}</b>.",
      rows: [
        ["Monto", "{{monto}}"],
        ["Medio", "{{medio}}"],
        ["Fecha", "{{fecha}}"],
        ["Cuenta", "{{cuenta}}"],
        ["Referencia", "{{referencia}}"],
      ],
      cta: { href: `${APP_URL}/internal/mi-participacion`, label: "Ver mi participación" },
      note: "Si algo no coincide con lo que te llegó, respondé este email.",
      reason: "Recibiste este email porque participás de la facturación de NinjaSoft.",
    }),
    migration: "supabase/migrations/20261115200000_staff_participacion.sql",
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
    link: "https://pos.soft.ninja/login",
    dias: "3",
    vence: "31/05/2026",
    monto: "$ 12.500,00",
    plan: "Pyme",
    precio_anterior: "$ 9.900,00",
    precio_nuevo: "$ 12.500,00",
    catalogo: "Kiosco esencial",
    periodo: "10/2026",
    medio: "Transferencia bancaria",
    fecha: "05/11/2026",
    referencia: "123456789012",
    cuenta: "Banco Galicia · juan.perez.ns",
  };
}
