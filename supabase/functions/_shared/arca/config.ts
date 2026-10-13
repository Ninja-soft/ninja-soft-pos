// =============================================================================
// Ambientes y endpoints de ARCA (ADR-072). PURO.
//
// Por defecto los oficiales; se pueden pisar por secret de Edge (por ejemplo
// para apuntar a un mock): ARCA_WSAA_URL_HOMO, ARCA_WSFE_URL_HOMO,
// ARCA_WSAA_URL_PROD, ARCA_WSFE_URL_PROD. Sólo se aceptan https de
// afip.gov.ar / afip.gob.ar / arca.gob.ar, o http(s)://localhost para pruebas.
// =============================================================================

export type ArcaEnv = "homologacion" | "produccion";

export interface ArcaEndpoints {
  wsaa: string;
  wsfe: string;
}

export const DEFAULT_ENDPOINTS: Record<ArcaEnv, ArcaEndpoints> = {
  homologacion: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  },
  produccion: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
  },
};

export function allowedEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if ((u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    return u.protocol === "https:" && /(^|\.)(afip\.gov\.ar|afip\.gob\.ar|arca\.gob\.ar)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Endpoints del ambiente con los overrides válidos del entorno. */
export function endpointsFor(env: ArcaEnv, vars: Record<string, string | undefined> = {}): ArcaEndpoints {
  const sfx = env === "produccion" ? "PROD" : "HOMO";
  const def = DEFAULT_ENDPOINTS[env];
  const wsaa = vars[`ARCA_WSAA_URL_${sfx}`];
  const wsfe = vars[`ARCA_WSFE_URL_${sfx}`];
  return {
    wsaa: allowedEndpoint(wsaa) ? (wsaa as string) : def.wsaa,
    wsfe: allowedEndpoint(wsfe) ? (wsfe as string) : def.wsfe,
  };
}

/** Emisor del certificado según ambiente (CN de la CA de ARCA). */
export const EXPECTED_ISSUER_CN: Record<ArcaEnv, string> = {
  homologacion: "Computadores Test",
  produccion: "Computadores",
};
