// =============================================================================
// Ticket de WSAA con el certificado de la PLATAFORMA (arca_platform) para un
// servicio de ARCA (padrón: ws_sr_constancia_inscripcion). Cache del ticket en
// arca_platform_tickets (12 h, compartido por todos los que lo usan).
//
// Lo usan las Edges platform_billing (ADR-117) y arca_padron (ADR-133).
// La clave privada se descifra sólo en memoria con ARCA_KEY_ENC; ni la clave
// ni Token/Sign se loguean ni se devuelven al navegador.
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { endpointsFor, type ArcaEnv } from "./config.ts";
import { loginCms, type FetchLike } from "./client.ts";
import { buildTra, classifyWsaaFault, ticketUsable } from "./wsaa.ts";
import { signCms } from "./pki.ts";
import { decryptSecret, keyAad } from "./crypto.ts";

export type PlatformAuth =
  | { ok: true; token: string; sign: string; cuit: string }
  | { ok: false; transient: boolean; code: string; message: string };

export async function platformAuth(
  admin: SupabaseClient,
  env: ArcaEnv,
  service: string,
  fetcher: FetchLike,
): Promise<PlatformAuth> {
  const { data } = await admin.from("arca_platform").select("cuit, cert_pem, key_enc, not_after").eq("environment", env).maybeSingle();
  const p = data as { cuit: string | null; cert_pem: string | null; key_enc: string | null; not_after: string | null } | null;
  if (!p?.cuit || !p.cert_pem || !p.key_enc) {
    return { ok: false, transient: false, code: "platform_not_configured", message: "Falta el certificado de la plataforma" };
  }
  const readTicket = async () => {
    const { data: t } = await admin
      .from("arca_platform_tickets")
      .select("token, sign, expires_at")
      .eq("environment", env)
      .eq("service", service)
      .maybeSingle();
    return (t as { token: string; sign: string; expires_at: string } | null) ?? null;
  };
  const cached = await readTicket();
  if (cached && ticketUsable(cached.expires_at)) return { ok: true, token: cached.token, sign: cached.sign, cuit: p.cuit };

  let cms: string;
  try {
    const keyPem = await decryptSecret(p.key_enc, Deno.env.get("ARCA_KEY_ENC") ?? "", keyAad("platform", env));
    cms = signCms(buildTra(service), p.cert_pem, keyPem);
  } catch {
    return { ok: false, transient: false, code: "certificado_ilegible", message: "No se pudo firmar con el certificado de la plataforma" };
  }
  const r = await loginCms(fetcher, endpointsFor(env, Deno.env.toObject()).wsaa, cms);
  if (r.transport || !r.result) return { ok: false, transient: true, code: "sin_respuesta", message: "El servicio de acceso de ARCA no respondió" };
  if (r.result.ok) {
    const t = r.result.ticket;
    await admin.from("arca_platform_tickets").upsert(
      {
        environment: env,
        service,
        token: t.token,
        sign: t.sign,
        generated_at: t.generationTime || new Date().toISOString(),
        expires_at: t.expirationTime,
      },
      { onConflict: "environment,service" },
    );
    return { ok: true, token: t.token, sign: t.sign, cuit: p.cuit };
  }
  if (classifyWsaaFault(r.result.code) === "already") {
    const again = await readTicket();
    if (again && ticketUsable(again.expires_at, new Date(), 60_000)) return { ok: true, token: again.token, sign: again.sign, cuit: p.cuit };
  }
  // Típico: el certificado no tiene autorizado el servicio en ARCA.
  return { ok: false, transient: false, code: r.result.code || "wsaa_error", message: r.result.message };
}
