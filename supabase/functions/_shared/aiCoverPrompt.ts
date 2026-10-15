// =============================================================================
// Portadas con IA (ADR-122): estilos y armado del prompt. Lógica PURA
// compartida por la Edge `ai_cover_image` (Deno), la vista previa de
// Configuración y los tests de Vitest. Sin imports: corre en Deno y Node.
//
// El prompt final = prompt base del negocio (o el default) con los datos del
// ítem reemplazados + el fragmento del estilo + el color de acento + reglas
// fijas (sin texto ni logos, cuadrado). Las reglas fijas no se pueden pisar
// desde el prompt base: evitan que la imagen salga con letras inventadas.
// =============================================================================

export type CoverStyle =
  | "flat_icon"
  | "isometric"
  | "photo"
  | "soft_3d"
  | "line_minimal"
  | "watercolor"
  | "paper_cut"
  | "duotone";

export interface CoverStyleInfo {
  key: CoverStyle;
  name: string;
  description: string;
  /** Fragmento del prompt (en inglés: el modelo de imagen rinde mejor). */
  prompt: string;
}

export const COVER_STYLES: CoverStyleInfo[] = [
  {
    key: "flat_icon",
    name: "Ícono plano",
    description: "Ícono grande y simple, colores planos, ideal para una grilla.",
    prompt:
      "a bold flat vector icon, simple geometric shapes, solid flat colors, no gradients, generous padding, centered on a plain light background",
  },
  {
    key: "isometric",
    name: "Ilustración isométrica",
    description: "Escena chica en perspectiva isométrica, prolija y técnica.",
    prompt:
      "a clean isometric illustration of a small scene, 30 degree isometric perspective, crisp edges, soft flat shading, plain light background",
  },
  {
    key: "photo",
    name: "Foto realista",
    description: "Foto de estudio con luz natural, como de catálogo.",
    prompt:
      "a realistic professional studio photograph, natural soft light, shallow depth of field, clean uncluttered composition, neutral background",
  },
  {
    key: "soft_3d",
    name: "3D suave",
    description: "Objetos 3D redondeados con luz suave, estilo app moderna.",
    prompt:
      "a soft 3D render of rounded friendly objects, clay-like matte materials, soft global illumination, subtle ambient occlusion, plain pastel background",
  },
  {
    key: "line_minimal",
    name: "Línea minimal",
    description: "Dibujo de línea fina y mucho aire. Sobrio y elegante.",
    prompt:
      "a minimal line art drawing, single consistent thin stroke weight, lots of white space, one accent color only, plain white background",
  },
  {
    key: "watercolor",
    name: "Acuarela",
    description: "Acuarela suave con bordes orgánicos. Cálido y artesanal.",
    prompt:
      "a delicate watercolor illustration, soft washes, organic edges, visible paper texture, light and airy palette, plain white background",
  },
  {
    key: "paper_cut",
    name: "Papel recortado",
    description: "Capas de papel recortado con sombras cortas.",
    prompt:
      "a layered paper cut illustration, stacked paper layers with short soft shadows, simple shapes, plain light background",
  },
  {
    key: "duotone",
    name: "Duotono",
    description: "Dos colores con mucho contraste, estilo afiche.",
    prompt:
      "a bold duotone poster style illustration using only two colors, high contrast, simple shapes, plain background",
  },
];

export const DEFAULT_COVER_STYLE: CoverStyle = "flat_icon";

export const isCoverStyle = (v: unknown): v is CoverStyle => COVER_STYLES.some((s) => s.key === v);

export function coverStyleInfo(style: unknown): CoverStyleInfo {
  return COVER_STYLES.find((s) => s.key === style) ?? COVER_STYLES[0]!;
}

/**
 * Prompt base por defecto (editable por el negocio). Variables:
 * {nombre}, {tipo}, {descripcion}, {rubro}.
 */
export const DEFAULT_BASE_PROMPT =
  "Cover image for the service \"{nombre}\" ({tipo}) of a {rubro}. Show what the service is about: {descripcion}.";

/**
 * Prompt por defecto para productos (no servicios): el sujeto es el producto
 * tal cual lo reconoce un comprador. No usa el rubro: con "tienda de ropa"
 * el modelo metía perchas en la imagen de un aceite.
 */
export const DEFAULT_PRODUCT_PROMPT =
  "Image of the retail product \"{nombre}\"{categoria}.{detalle} Show only this exact product on its own, centered, as a shopper would recognize it on a store shelf, with no unrelated objects. Any label or packaging must be completely blank: never write the product name or any other text on it.";

export const BASE_PROMPT_MAX = 1500;

/** Reglas fijas del final (no se pueden pisar desde el prompt base). */
export const COVER_RULES =
  "Square 1:1 composition. The subject fills about 85 to 90 percent of the frame, tightly framed and centered, with only a thin even margin of background around it (no large empty space). High resolution, sharp focus, crisp clean edges and fine detail. Absolutely no text, no letters, no numbers, no words, no watermarks and no logos anywhere in the image. Single clear subject, professional and friendly, suitable as a product thumbnail.";

export interface CoverPromptInput {
  name: string;
  /** Tipo de servicio (Informe, Visita...) o "producto". */
  type?: string | null;
  description?: string | null;
  /** Rubro del negocio en palabras ("laboratorio de bromatología"). */
  business?: string | null;
  style?: unknown;
  /** #RRGGBB opcional. */
  accent?: string | null;
  /** Prompt base del negocio (null o vacío = el default). */
  basePrompt?: string | null;
  /** "product" usa DEFAULT_PRODUCT_PROMPT si el negocio no cargó uno propio. */
  kind?: "product" | "service" | null;
  /** Categoría del producto, da contexto ("Almacén > Aceites"). */
  category?: string | null;
}

const clean = (v: string | null | undefined, max: number) =>
  String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Prompt final que se manda al modelo. Determinístico (testeable). */
export function buildCoverPrompt(input: CoverPromptInput): string {
  const style = coverStyleInfo(input.style);
  const custom = clean(input.basePrompt, BASE_PROMPT_MAX);
  const isProduct = input.kind === "product";
  const base = custom || (isProduct ? DEFAULT_PRODUCT_PROMPT : DEFAULT_BASE_PROMPT);
  const name = clean(input.name, 120) || (isProduct ? "product" : "service");
  const rawDesc = clean(input.description, 400);
  const category = clean(input.category, 80);
  const type = clean(input.type, 40) || "service";
  const desc = clean(input.description, 400) || name;
  const business = clean(input.business, 80) || "small business";
  const filled = base
    .replace(/\{nombre\}/gi, name)
    .replace(/\{tipo\}/gi, type)
    .replace(/\{descripcion\}/gi, desc)
    .replace(/\{descripción\}/gi, desc)
    .replace(/\{rubro\}/gi, business)
    .replace(/\{categoria\}/gi, category ? ` (category: ${category})` : "")
    .replace(/\{detalle\}/gi, rawDesc && rawDesc.toLowerCase() !== name.toLowerCase() ? ` Details: ${rawDesc}.` : "");
  const accent = input.accent && HEX.test(input.accent) ? ` Use ${input.accent.toUpperCase()} as the main accent color.` : "";
  return `${filled} Style: ${style.prompt}.${accent} ${COVER_RULES}`;
}
