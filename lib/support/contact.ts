// Contacto con NinjaSoft desde el registro (antes de tener panel). Hoy no hay un
// chat de soporte integrado: el canal es el email de soporte del dominio de la
// app (soft.ninja, el mismo que se declara como contacto en el geocoder). Cuando
// exista el chat, este helper es el único lugar a cambiar.
export const CONTACT_EMAIL = "soporte@soft.ninja";

export function salesContactHref(subject: string): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
