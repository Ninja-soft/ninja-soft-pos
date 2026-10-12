// Token de autorización de supervisor en curso (F17 · H116, ADR-051).
//
// supervisor_authorize() devuelve un token de un solo uso; el servidor lo lee
// del header `x-ninja-supervisor-token` dentro de los triggers (sin cambiar la
// firma de ninguna RPC). Mientras corre `withSupervisorToken(token, fn)`, el
// fetch del cliente Supabase agrega el header a las requests REST/RPC.
// Una request ajena que salga en esa ventana lo lleva sin efecto: el token
// sólo lo consume un trigger de la misma acción y del mismo usuario.
// Anidados se acumulan separados por coma (ADR-056): una venta puede pedir PIN
// por el cambio de precio y por el descuento, y el servidor usa el de cada acción.

export const SUPERVISOR_TOKEN_HEADER = "x-ninja-supervisor-token";

let current: string | null = null;

export function currentSupervisorToken(): string | null {
  return current;
}

export async function withSupervisorToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const prev = current;
  current = prev && !prev.split(",").includes(token) ? `${prev},${token}` : token;
  try {
    return await fn();
  } finally {
    current = prev;
  }
}
