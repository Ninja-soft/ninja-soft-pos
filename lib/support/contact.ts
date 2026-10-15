// Contacto con NinjaSoft desde el registro (antes de tener panel). Hoy no hay un
// chat de soporte integrado: el canal es el email de ventas. Cuando exista el
// chat, este helper es el único lugar a cambiar.
export const SALES_EMAIL = "ventas@ninjapos.com.ar";

export function salesContactHref(subject: string): string {
  return `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
