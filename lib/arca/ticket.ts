// Datos fiscales del ticket (F3 · ADR-072). PURO: arma, desde el comprobante
// fiscal de la venta, lo que imprime el ticket (tipo, letra, número, CAE o
// CAEA, vencimiento y QR) o el aviso de pendiente.
import { CBTE_LABEL, letterOfTipo } from "@/supabase/functions/_shared/arca/comprobante";
import { formatFiscalDate, formatFiscalNumber } from "./labels";

export interface TicketFiscal {
  status: string;
  /** "Factura B", "Nota de crédito A". */
  cbteLabel: string;
  letter: string | null;
  /** Código del tipo de comprobante (006). */
  codigo: string | null;
  ptoVta: string | null;
  /** "00003-00000012". */
  numero: string | null;
  cae: string | null;
  caeVto: string | null;
  qrUrl: string | null;
  emissionType: "CAE" | "CAEA";
  homologacion: boolean;
}

interface DocLike {
  status: string;
  cbte_tipo: number | null;
  cbte_letter?: string | null;
  pto_vta: number | null;
  cbte_nro: number | null;
  cae: string | null;
  cae_vto: string | null;
  qr_url: string | null;
  emission_type?: "CAE" | "CAEA" | null;
  environment?: string | null;
  origin?: string | null;
}

export function ticketFiscal(doc: DocLike | null | undefined): TicketFiscal | null {
  if (!doc || doc.status === "cancelado") return null;
  const approved = doc.status === "aprobado" && doc.cae != null && doc.cbte_nro != null;
  const tipo = doc.cbte_tipo;
  return {
    status: doc.status,
    cbteLabel: tipo != null ? CBTE_LABEL[tipo] ?? "Comprobante" : "Factura",
    letter: (tipo != null ? letterOfTipo(tipo) : null) ?? doc.cbte_letter ?? null,
    codigo: tipo != null ? String(tipo).padStart(3, "0") : null,
    ptoVta: doc.pto_vta != null ? String(doc.pto_vta).padStart(5, "0") : null,
    numero: approved ? formatFiscalNumber(doc.pto_vta, doc.cbte_nro) : null,
    cae: approved ? doc.cae : null,
    caeVto: approved ? formatFiscalDate(doc.cae_vto) : null,
    qrUrl: approved ? doc.qr_url : null,
    emissionType: doc.emission_type === "CAEA" ? "CAEA" : "CAE",
    homologacion: doc.environment === "homologacion",
  };
}

/** ¿El ticket imprime la factura autorizada? */
export const fiscalApproved = (f: TicketFiscal | null | undefined): f is TicketFiscal =>
  Boolean(f && f.status === "aprobado" && f.cae && f.numero);

export const FISCAL_PENDING_TEXT = "Comprobante pendiente de autorización ARCA";
