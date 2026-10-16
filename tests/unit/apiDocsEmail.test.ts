// @vitest-environment node
// Documentación de la API por email con credenciales (ADR-163, pedido del
// dueño 16/10). El secreto nunca se persiste: la Edge envía directo (sin la
// cola system_emails), la base sólo recibe sha256 y audita sin el secreto.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  API_DOCS_SUBJECT,
  POSTMAN_SCHEMA as EDGE_POSTMAN_SCHEMA,
  buildApiDocsEmail,
  checkApiDocsRequest,
  checkAttachments,
  safeError,
} from "@/supabase/functions/_shared/apiDocsEmail";
import { POSTMAN_SCHEMA, buildPostmanCollection } from "@/lib/api/postman";
import { buildDocsHtml } from "@/lib/api/docsHtml";
import { CLIENT_ID_RE, CLIENT_SECRET_RE } from "@/lib/api-publica/formats";
import {
  CLIENT_ID_RE as EDGE_CLIENT_ID_RE,
  CLIENT_SECRET_RE as EDGE_SECRET_RE,
  DEMO_CLIENT_SECRET as EDGE_DEMO_SECRET,
} from "@/supabase/functions/_shared/apiDocsEmail";
import { DEMO_CLIENT_SECRET } from "@/lib/api/sandboxConstants";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ID = `nsc_test_${"a".repeat(24)}`;
const SECRET = `nss_test_${"c".repeat(64)}`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("pedido de la Edge", () => {
  it("espeja los formatos de la API y el esquema de Postman", () => {
    expect(EDGE_CLIENT_ID_RE.source).toBe(CLIENT_ID_RE.source);
    expect(EDGE_SECRET_RE.source).toBe(CLIENT_SECRET_RE.source);
    expect(EDGE_POSTMAN_SCHEMA).toBe(POSTMAN_SCHEMA);
    // El secreto de ejemplo (público) aparece en la documentación y se permite.
    expect(EDGE_DEMO_SECRET).toBe(DEMO_CLIENT_SECRET);
  });

  it("valida email, nota, credencial y secreto", () => {
    expect(checkApiDocsRequest({ to: "x" })).toEqual({ ok: false, error: "invalid_email" });
    expect(checkApiDocsRequest({ to: "a@b.example", note: "x".repeat(501) })).toEqual({ ok: false, error: "note_too_long" });
    expect(checkApiDocsRequest({ to: "a@b.example", client_id: "otro" })).toEqual({ ok: false, error: "client_not_found" });
    // Secreto sin credencial, cruzado de ambiente o sin confirmar.
    expect(checkApiDocsRequest({ to: "a@b.example", client_secret: SECRET, ack_secret: true }).ok).toBe(false);
    expect(
      checkApiDocsRequest({ to: "a@b.example", client_id: ID, client_secret: `nss_${"c".repeat(64)}`, ack_secret: true }),
    ).toEqual({ ok: false, error: "secret_mismatch" });
    expect(checkApiDocsRequest({ to: "a@b.example", client_id: ID, client_secret: SECRET })).toEqual({
      ok: false,
      error: "secret_ack_required",
    });
    const ok = checkApiDocsRequest({ to: " A@B.example ", client_id: ID, client_secret: SECRET, ack_secret: true });
    expect(ok.ok && ok.value.to).toBe("a@b.example");
  });

  it("rechaza adjuntos que no son base64 o son enormes", () => {
    expect(checkApiDocsRequest({ to: "a@b.example", postman: "no base64!" })).toEqual({ ok: false, error: "invalid_attachment" });
    expect(checkApiDocsRequest({ to: "a@b.example", docs_html: "A".repeat(2_000_004) })).toEqual({
      ok: false,
      error: "invalid_attachment",
    });
  });
});

describe("adjuntos", () => {
  const origin = "https://pos.soft.ninja";
  const withSecret = JSON.stringify(buildPostmanCollection({ origin, clientId: ID, clientSecret: SECRET, environment: "test", id: "x" }));
  const without = JSON.stringify(buildPostmanCollection({ origin, clientId: ID, environment: "test", id: "x" }));
  const html = buildDocsHtml({ origin });

  it("la colección y el HTML que arma el navegador pasan el control", () => {
    expect(checkAttachments(withSecret, html, SECRET)).toBeNull();
    expect(checkAttachments(without, html, null)).toBeNull();
  });

  it("no deja pasar un secreto que no se declaró ni uno ajeno", () => {
    expect(checkAttachments(withSecret, null, null)).toBe("attachment_secret_mismatch");
    expect(checkAttachments(withSecret, null, `nss_test_${"f".repeat(64)}`)).toBe("attachment_secret_mismatch");
    expect(checkAttachments(null, `${html}${SECRET}`, SECRET)).toBe("attachment_secret_mismatch");
  });

  it("sólo Postman v2.1 y HTML de verdad", () => {
    expect(checkAttachments(JSON.stringify({ info: { schema: "otro" } }), null, null)).toBe("invalid_attachment");
    expect(checkAttachments("no json", null, null)).toBe("invalid_attachment");
    expect(checkAttachments(null, "<script>alert(1)</script>", null)).toBe("invalid_attachment");
    expect(b64(html).length).toBeLessThan(2_000_000);
  });
});

describe("cuerpo del email", () => {
  const client = { name: "Tienda <online>", client_id: ID, environment: "test" as const, scopes: ["products:read"], rate_limit_per_min: 600 };

  it("con credencial: client_id, ambiente, alcances y URL base; el secreto sólo si se pidió", () => {
    const sin = buildApiDocsEmail({ businessName: "Olimarket", note: null, client, secret: null, appUrl: "https://pos.soft.ninja", attachments: ["postman"] });
    expect(sin.subject).toBe(API_DOCS_SUBJECT);
    expect(sin.html).toContain(ID);
    expect(sin.html).toContain("https://pos.soft.ninja/api/v1");
    expect(sin.html).toContain("products:read");
    expect(sin.html).toContain("Tienda &lt;online&gt;");
    expect(sin.html).not.toMatch(/nss_/);
    expect(sin.text).toContain("client_secret: no incluido");
    const con = buildApiDocsEmail({ businessName: "Olimarket", note: "<b>hola</b>", client, secret: SECRET, appUrl: "https://pos.soft.ninja", attachments: [] });
    expect(con.html).toContain(SECRET);
    expect(con.html).toContain("&lt;b&gt;hola&lt;/b&gt;");
    expect(con.html).toMatch(/borrá este email/);
  });

  it("los errores que se auditan nunca llevan el secreto", () => {
    expect(safeError(new Error(`resend_422: bad ${SECRET}`), SECRET)).not.toContain(SECRET);
    expect(safeError(`x nss_${"1".repeat(64)}`, null)).toBe("x [secreto]");
  });
});

describe("Edge send_api_docs_email", () => {
  const src = read("supabase/functions/send_api_docs_email/index.ts");
  const code = src.replace(/^\s*\/\/.*$/gm, "");

  it("envía directo sin la cola ni guardar el cuerpo", () => {
    expect(code).toMatch(/sendWithChain\(admin/);
    expect(code).not.toMatch(/system_emails|enqueue_system_email|\.insert\(/);
  });

  it("la base recibe sha256 del secreto, nunca el secreto", () => {
    expect(code).toMatch(/p_secret_sha256: secret \? await sha256Hex\(secret\) : null/);
    expect(code).not.toMatch(/p_client_secret|p_secret:/);
  });

  it("no loguea el secreto ni el cuerpo", () => {
    for (const m of code.match(/console\.(log|error|warn)\([^;]*\)/g) ?? []) {
      expect(m).not.toMatch(/secret\b(?!\))|raw|mail\.|r\.clientSecret/);
    }
  });

  it("CORS con x-ninja-scope y exige JWT (no es pública)", () => {
    expect(code).toMatch(/x-ninja-scope/);
    expect(code).toMatch(/auth\.getUser\(\)/);
    expect(read("supabase/config.toml")).not.toMatch(/\[functions\.send_api_docs_email\]/);
  });
});

describe("migración 20270101100100_api_docs_email_credenciales", () => {
  const MIG = read("supabase/migrations/20270101100100_api_docs_email_credenciales.sql").replace(/--.*$/gm, "");

  it("prepare: dueño, tope, credencial del negocio, hash y confirmación, audita sin secreto", () => {
    expect(MIG).toMatch(/_api_owner_assert\(false\)/);
    expect(MIG).toMatch(/too_many_emails/);
    expect(MIG).toMatch(/c\.tenant_id = v_tenant[\s\S]*c\.revoked_at is null/);
    expect(MIG).toMatch(/v_client\.secret_hash is distinct from p_secret_sha256/);
    expect(MIG).toMatch(/secret_ack_required/);
    expect(MIG).toMatch(/'api_docs_emailed'/);
    expect(MIG).toMatch(/'with_secret', v_with_secret/);
    // Nunca el secreto ni el hash en la auditoría.
    const audit = MIG.slice(MIG.indexOf("insert into audit_logs"), MIG.indexOf("returning id into v_audit"));
    expect(audit).not.toMatch(/secret_hash|p_secret_sha256/);
  });

  it("finish sólo para service_role y sin is_internal()", () => {
    expect(MIG).toMatch(/revoke all on function api_docs_email_finish\(uuid, boolean, text, text\) from public, anon, authenticated;/);
    expect(MIG).toMatch(/grant execute on function api_docs_email_finish\(uuid, boolean, text, text\) to service_role;/);
    expect(MIG).toMatch(/grant execute on function api_docs_email_prepare\([^)]*\) to authenticated;/);
    expect(MIG).not.toMatch(/is_internal\(\)|create table|create policy|system_emails/i);
  });
});
