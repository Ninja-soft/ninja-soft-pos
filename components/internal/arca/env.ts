import type { ArcaEnv } from "@/lib/arca/labels";

// El certificado de la plataforma se configura sólo en PRODUCCIÓN desde la UI
// (pedido del dueño, 2026-10). Homologación sigue soportada por la Edge
// `arca_wsfe` (acciones platform_* con `environment`), `arca_platform` y
// `arca_padron_config`: para volver a mostrarla alcanza con parametrizar este
// valor. Ver la nota de ADR-133 en docs/17-decision-log.md.
export const ARCA_CERT_ENV: ArcaEnv = "produccion";
