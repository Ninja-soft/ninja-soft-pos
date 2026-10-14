"use client";

import { InfoHint } from "@/components/ui/InfoHint";
import { letterReason } from "@/lib/billing/letter";

// "¿Por qué C?" junto al comprobante de una venta (ADR-123). Archivo aparte
// para no sumar al POS los hooks de la guía de configuración.

/** "¿Por qué C?": ayuda breve junto a la letra de un comprobante emitido. */
export function WhyLetter({ letter, cbteTipo }: { letter: string | null | undefined; cbteTipo?: number | null }) {
  const text = letterReason(letter, { cbteTipo });
  if (!text || !letter) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <InfoHint label={`¿Por qué ${letter}?`} title={`¿Por qué ${letter}?`} size={14}>
        <p className="font-semibold">¿Por qué {letter}?</p>
        <p className="mt-1 text-muted-foreground">{text}</p>
        <p className="mt-1 text-muted-foreground">La letra no la elegís en la caja: sale de tu condición frente al IVA y la del cliente.</p>
      </InfoHint>
      <span aria-hidden>¿Por qué {letter}?</span>
    </span>
  );
}
WhyLetter.displayName = "WhyLetter";
