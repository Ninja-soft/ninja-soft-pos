// Copy del complemento Asistente IA en el registro (puro, testeable).
//
// El addon se activa al crear la cuenta con activate_addon(), que alinea su
// período al de la suscripción: con un plan en prueba no se cobra nada hasta
// que termina la prueba, y no se pide tarjeta en el registro.

export const AI_ADDON_BENEFITS = [
  "Preguntale por tus ventas, tu stock y tu caja como si hablaras con alguien",
  "Te explica cómo usar cada función, en la pantalla en la que estés",
  "Ideas para vender más y reponer a tiempo",
  "Lo usa todo tu equipo, sin costo por usuario",
] as const;

export interface AiAddonCopy {
  /** Cuándo se paga (lo más importante: no se paga ahora). */
  billing: string;
  /** Nota corta: no hace falta tarjeta / se puede sumar después. */
  later: string;
}

export function aiAddonCopy({
  planTrialDays,
}: {
  planTrialDays: number;
}): AiAddonCopy {
  const later =
    "Si no lo sumás ahora, lo activás cuando quieras desde tu panel, en Suscripción.";
  if (planTrialDays > 0) {
    return {
      billing: `No pagás nada ahora y no hace falta cargar tarjeta. Se cobra recién cuando termina tu prueba gratis de ${planTrialDays} días, junto con tu plan.`,
      later,
    };
  }
  return {
    billing:
      "Se suma al pago mensual de tu plan. Lo das de baja cuando quieras.",
    later,
  };
}
