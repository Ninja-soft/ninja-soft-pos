// =============================================================================
// _shared/mercadolibre/labels.ts (H87 · ADR-104). PURO.
//
// Etiquetas ME2: GET /shipment_labels?shipment_ids=..&response_type=pdf|zpl2
// (hasta 50 por llamada; sólo me2 + ready_to_ship + ready_to_print|printed;
// en Full no hay etiqueta). ZPL2 puede venir comprimido en un ZIP con el
// .txt adentro: extractZpl lo detecta (firma "PK") y lo descomprime. El
// template de ML no se modifica nunca (buenas prácticas).
// =============================================================================

export type LabelFormat = "pdf" | "zpl2";

export function labelPath(ids: Array<string | number>, format: LabelFormat): string {
  const list = ids.map(String).filter((s) => /^\d{5,22}$/.test(s));
  return `/shipment_labels?shipment_ids=${list.join(",")}&response_type=${format}&savePdf=Y`;
}

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

/** Inflate "deflate-raw" con DecompressionStream (Deno y navegadores). */
export const webInflateRaw: Inflate = async (data) => {
  const ds = new DecompressionStream("deflate-raw" as CompressionFormat);
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Archivos de un ZIP (encabezados locales; método 0 o 8). */
export async function unzip(bytes: Uint8Array, inflate: Inflate = webInflateRaw): Promise<Array<{ name: string; data: Uint8Array }>> {
  const out: Array<{ name: string; data: Uint8Array }> = [];
  let o = 0;
  while (o + 30 <= bytes.length && u32(bytes, o) === 0x04034b50) {
    const flags = u16(bytes, o + 6);
    const method = u16(bytes, o + 8);
    let size = u32(bytes, o + 18);
    const nameLen = u16(bytes, o + 26);
    const extraLen = u16(bytes, o + 28);
    const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const start = o + 30 + nameLen + extraLen;
    if (flags & 0x08 && size === 0) {
      // Tamaño en el descriptor posterior: buscar la próxima firma.
      let e = start;
      while (e + 4 <= bytes.length && u32(bytes, e) !== 0x08074b50 && u32(bytes, e) !== 0x04034b50 && u32(bytes, e) !== 0x02014b50) e++;
      size = e - start;
    }
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.push({ name, data: raw.slice() });
    else if (method === 8) out.push({ name, data: await inflate(raw) });
    o = start + size;
    if (flags & 0x08) {
      if (u32(bytes, o) === 0x08074b50) o += 16;
      else o += 12;
    }
  }
  return out;
}

/** Texto ZPL de la respuesta (directo o dentro de un ZIP). */
export async function extractZpl(bytes: Uint8Array, inflate: Inflate = webInflateRaw): Promise<string> {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = await unzip(bytes, inflate);
    const txt = files.find((f) => /\.(txt|zpl)$/i.test(f.name)) ?? files[0];
    if (!txt) throw new Error("zpl_empty_zip");
    return new TextDecoder("latin1").decode(txt.data);
  }
  return new TextDecoder("latin1").decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
