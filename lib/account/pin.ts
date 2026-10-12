// PIN de supervisor (Cuenta corriente v2).
//
// ESPEJO del SQL: account_set_supervisor_pin() y account_pin_is_weak() en
// supabase/migrations/20261011200300_cuenta_corriente_v2_pin_supervisor.sql.
// El server revalida todo; esto es para avisar antes de enviar.

export function isWeakPin(pin: string): boolean {
  let same = true;
  let up = true;
  let down = true;
  for (let i = 1; i < pin.length; i++) {
    const a = Number(pin[i - 1]);
    const b = Number(pin[i]);
    if (b !== a) same = false;
    if (b !== (a + 1) % 10) up = false;
    if (b !== (a + 9) % 10) down = false;
  }
  return same || up || down;
}

// Problema del PIN en palabras, o null si sirve.
export function pinProblem(pin: string): string | null {
  if (!/^[0-9]{4,6}$/.test(pin)) return "Tiene que tener entre 4 y 6 números";
  if (isWeakPin(pin)) return "Es muy fácil: evitá números repetidos o en escalera";
  return null;
}

// Mensaje para el cajero según la respuesta de account_authorize_override.
export function overrideErrorMessage(
  error: string,
  extra?: { attempts_left?: number; locked_until?: string },
): string {
  switch (error) {
    case "pin_invalid": {
      const n = extra?.attempts_left ?? 0;
      return `PIN incorrecto. ${n === 1 ? "Queda 1 intento" : `Quedan ${n} intentos`} antes de bloquearlo 15 minutos.`;
    }
    case "pin_locked": {
      const until = extra?.locked_until
        ? new Date(extra.locked_until).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
        : null;
      return until
        ? `PIN bloqueado por intentos fallidos hasta las ${until}.`
        : "PIN bloqueado por intentos fallidos.";
    }
    case "pin_not_set":
      return "Esa persona todavía no cargó su PIN de supervisor.";
    case "override_not_needed":
      return "La venta ya no necesita autorización.";
    case "override_not_allowed":
      return "El negocio no permite autorizar ventas con la cuenta bloqueada.";
    default:
      return "No se pudo autorizar la venta.";
  }
}
