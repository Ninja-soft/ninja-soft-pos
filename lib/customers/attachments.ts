// Adjuntos de la ficha del cliente (ADR-169). Reglas puras y testeadas: el
// bucket customer-files y la RPC customer_attachment_add vuelven a validarlas
// en el servidor (tamaño, tipo y carpeta negocio/cliente).

export const CUSTOMER_FILES_BUCKET = "customer-files";
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "Imagen",
  "image/png": "Imagen",
  "image/webp": "Imagen",
  "text/plain": "Texto",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
};

/** Atributo accept del input de archivos. */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(",");

export type AttachmentCheck = { ok: true } | { ok: false; reason: string };

export function checkAttachment(file: { name: string; size: number; type: string }): AttachmentCheck {
  if (!file.size) return { ok: false, reason: "El archivo está vacío." };
  if (file.size > ATTACHMENT_MAX_BYTES) return { ok: false, reason: "El archivo pesa más de 10 MB." };
  if (!ATTACHMENT_TYPES[file.type]) {
    return { ok: false, reason: "Ese tipo de archivo no se puede adjuntar. Usá PDF, imagen, Word, Excel o texto." };
  }
  return { ok: true };
}

/** Nombre seguro para la ruta en storage (sin acentos, espacios ni barras). */
export function safeFileName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-\./g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return base || "archivo";
}

/** Ruta: <negocio>/<cliente>/<uuid>-<nombre>. */
export function attachmentPath(tenantId: string, customerId: string, uuid: string, name: string): string {
  return `${tenantId}/${customerId}/${uuid}-${safeFileName(name)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const ATTACHMENT_ERRORS: Record<string, string> = {
  attachment_bad_path: "La ruta del archivo no es válida.",
  attachment_not_uploaded: "El archivo no terminó de subir. Probá de nuevo.",
  attachment_limit: "Este cliente ya tiene 100 adjuntos. Quitá alguno para sumar otro.",
  attachment_not_found: "Ese adjunto ya no existe.",
  feature_not_in_plan: "Los adjuntos son parte de la ficha del cliente 360 (plan Pro).",
  forbidden: "No tenés permiso para hacer esto.",
};

export function attachmentErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  for (const [k, v] of Object.entries(ATTACHMENT_ERRORS)) if (msg.includes(k)) return v;
  if (/mime|type/i.test(msg)) return "Ese tipo de archivo no se puede adjuntar.";
  if (/size|large|exceed/i.test(msg)) return "El archivo pesa más de 10 MB.";
  return "No se pudo completar. Probá de nuevo.";
}
