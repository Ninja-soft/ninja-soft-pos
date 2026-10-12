// Tokens visuales de las pantallas de personal, cajas y seguridad (ADR-051):
// sin degradados, sin sombras, radios chicos, selección neutra (choice-on).

/** CTA sólido (mismo acento que Cobrar del POS), sin degradado ni sombra. */
export const SOLID_CTA =
  "bg-none bg-[var(--pos-solid)] text-[color:var(--pos-on)] shadow-none hover:bg-[var(--pos-solid-hover)] hover:brightness-100";

/** Panel plano: borde sutil, sin sombra ni blur. */
export const FLAT_PANEL = "rounded-lg border border-border bg-card shadow-none";

/** Etiqueta chica en mayúsculas. */
export const EYEBROW = "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";

/** Número grande tabular. */
export const KPI = "font-display text-2xl font-bold tabular-nums leading-none";
