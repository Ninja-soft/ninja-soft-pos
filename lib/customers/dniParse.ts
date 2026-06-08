import { capitalizeName } from "@/lib/utils/format";

// Datos parseados del PDF417 del frente del DNI argentino (parseo OFFLINE: el
// dato vive en el propio código del documento, no consultamos ningún servicio
// ni registro gubernamental). H31 (F11).
export interface ParsedDni {
  apellido: string; // apellido(s) capitalizado(s)
  nombre: string; // nombre(s) capitalizado(s)
  nombreCompleto: string; // "Nombre Apellido" listo para customers.name
  sexo: "M" | "F" | "X" | null; // solo para mostrar; no hay columna en customers
  dni: string; // número de documento, solo dígitos
  fechaNac: string | null; // ISO yyyy-mm-dd o null si no se pudo leer
}

// Convierte "DD/MM/AAAA" (o "DD-MM-AAAA") a ISO "AAAA-MM-DD". Devuelve null si
// la fecha no es plausible. El PDF417 del DNI trae las fechas en formato local
// argentino (día primero).
function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += year >= 30 ? 1900 : 2000; // por si viniera a 2 dígitos
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Normaliza el sexo a M / F / X. El DNI usa M (masculino), F (femenino) y, en
// documentos nuevos, X (no binario). Cualquier otra cosa → null.
function normalizeSexo(raw: string | undefined): ParsedDni["sexo"] {
  const s = (raw ?? "").trim().toUpperCase();
  if (s === "M" || s === "F" || s === "X") return s;
  return null;
}

// Toma los dígitos del campo DNI y saca ceros a la izquierda (deja al menos un
// dígito). El DNI argentino tiene 7-8 dígitos; algunos lectores agregan ceros.
function extractDni(raw: string | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Parsea el string del PDF417 del frente del DNI argentino (campos separados
 * por `@`) y devuelve los datos del titular, o `null` si el string no parece un
 * DNI (no rompe con basura: el llamador muestra "no parece un DNI").
 *
 * Formato típico del DNI tarjeta (con variantes viejo/nuevo):
 *   `00123456789@APELLIDO@NOMBRE@SEXO@DNI@EJEMPLAR@DD/MM/AAAA@DD/MM/AAAA`
 *   [0] nro de trámite · [1] apellido(s) · [2] nombre(s) · [3] sexo (M/F) ·
 *   [4] número de DNI · [5] ejemplar (A/B/C) · [6] fecha de nacimiento ·
 *   [7] fecha de emisión.
 *
 * Parseo robusto: split por `@`, se toma apellido / nombre / sexo / dni /
 * fecha_nac; se capitalizan nombre y apellido (helper `capitalizeName`) y la
 * fecha se normaliza a ISO. Tolera espacios y ceros a la izquierda.
 */
export function parseDni(raw: string): ParsedDni | null {
  if (!raw) return null;
  // Algunos lectores entregan el separador como `@` o, según config, como salto
  // de línea o tabulador entre los mismos campos. Normalizamos a `@`.
  const normalized = raw.trim().replace(/[\r\n\t]+/g, "@");
  const parts = normalized.split("@").map((p) => p.trim());

  // Un DNI trae al menos: trámite, apellido, nombre, sexo, dni (5 campos). Menos
  // que eso no es un DNI.
  if (parts.length < 5) return null;

  const apellidoRaw = parts[1] ?? "";
  const nombreRaw = parts[2] ?? "";
  const sexo = normalizeSexo(parts[3]);
  const dni = extractDni(parts[4]);
  const fechaNac = toIsoDate(parts[6]);

  // Validaciones mínimas para no aceptar un código de barras cualquiera como
  // DNI: apellido y nombre con letras, sexo válido y DNI de 7-9 dígitos.
  const hasName = /\p{L}/u.test(apellidoRaw) && /\p{L}/u.test(nombreRaw);
  const dniOk = /^\d{7,9}$/.test(dni);
  if (!hasName || sexo === null || !dniOk) return null;

  const apellido = capitalizeName(apellidoRaw);
  const nombre = capitalizeName(nombreRaw);

  return {
    apellido,
    nombre,
    nombreCompleto: `${nombre} ${apellido}`.trim(),
    sexo,
    dni,
    fechaNac,
  };
}
