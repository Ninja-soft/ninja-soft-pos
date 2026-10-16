// Ejemplos de pedido (curl, JavaScript, Python) para cada endpoint del spec
// (ADR-159). Nunca llevan un secreto real: usan marcadores que la
// integración reemplaza por sus variables de entorno.

import { API_BASE_PATH, type EndpointSpec } from "./spec";

export type SnippetLang = "curl" | "javascript" | "python";

export const SNIPPET_LANGS: { id: SnippetLang; label: string }[] = [
  { id: "curl", label: "curl" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

/** Parámetros de query del ejemplo: los obligatorios o, si no hay, uno representativo. */
export function exampleQuery(e: EndpointSpec): [string, string][] {
  const query = e.params.filter((p) => p.in === "query");
  const required = query.filter((p) => p.required);
  const picked = required.length
    ? required
    : query.filter((p) => p.name === "updated_since" || (p.name === "sku" && !query.some((x) => x.name === "updated_since")));
  return picked.map((p) => [p.name, String(p.example ?? "")]);
}

function url(origin: string, e: EndpointSpec, query: [string, string][]): string {
  const qs = query.length ? "?" + query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
  return `${origin.replace(/\/+$/, "")}${API_BASE_PATH}${e.path}${qs}`;
}

function idem(e: EndpointSpec): boolean {
  return e.params.some((p) => p.name === "Idempotency-Key");
}

function json(v: unknown, indent = 2): string {
  return JSON.stringify(v, null, indent);
}

function tokenBody(): string {
  return "grant_type=client_credentials";
}

export function snippet(lang: SnippetLang, e: EndpointSpec, origin: string): string {
  const q = exampleQuery(e);
  const u = url(origin, e, q);

  if (e.auth === "client_credentials") {
    if (lang === "curl") {
      return [
        `curl -X POST "${u}" \\`,
        `  -u "$NINJA_CLIENT_ID:$NINJA_CLIENT_SECRET" \\`,
        `  -H "Content-Type: application/x-www-form-urlencoded" \\`,
        `  -d "${tokenBody()}"`,
      ].join("\n");
    }
    if (lang === "javascript") {
      return [
        `const basic = Buffer.from(\`\${process.env.NINJA_CLIENT_ID}:\${process.env.NINJA_CLIENT_SECRET}\`).toString("base64");`,
        `const res = await fetch("${u}", {`,
        `  method: "POST",`,
        `  headers: { Authorization: \`Basic \${basic}\`, "Content-Type": "application/x-www-form-urlencoded" },`,
        `  body: "${tokenBody()}",`,
        `});`,
        `const { access_token, expires_in } = await res.json();`,
      ].join("\n");
    }
    return [
      `import os, requests`,
      ``,
      `res = requests.post(`,
      `    "${u}",`,
      `    auth=(os.environ["NINJA_CLIENT_ID"], os.environ["NINJA_CLIENT_SECRET"]),`,
      `    data={"grant_type": "client_credentials"},`,
      `    timeout=30,`,
      `)`,
      `token = res.json()["access_token"]`,
    ].join("\n");
  }

  const body = e.body ? e.body.example : null;
  const withIdem = idem(e);

  if (lang === "curl") {
    const lines = [`curl${e.method === "GET" ? "" : " -X " + e.method} "${u}" \\`, `  -H "Authorization: Bearer $NINJA_TOKEN"`];
    if (body) {
      lines[lines.length - 1] += " \\";
      lines.push(`  -H "Content-Type: application/json" \\`);
      if (withIdem) lines.push(`  -H "Idempotency-Key: $(uuidgen)" \\`);
      lines.push(`  -d '${json(body)}'`);
    }
    return lines.join("\n");
  }

  if (lang === "javascript") {
    const headers = [`Authorization: \`Bearer \${process.env.NINJA_TOKEN}\``];
    if (body) headers.push(`"Content-Type": "application/json"`);
    if (body && withIdem) headers.push(`"Idempotency-Key": crypto.randomUUID()`);
    const lines = [`const res = await fetch("${u}", {`];
    if (e.method !== "GET") lines.push(`  method: "${e.method}",`);
    lines.push(`  headers: { ${headers.join(", ")} },`);
    if (body) lines.push(`  body: JSON.stringify(${json(body).replace(/\n/g, "\n  ")}),`);
    lines.push(`});`, `const data = await res.json();`);
    return lines.join("\n");
  }

  const lines = [`import os, requests${body && withIdem ? ", uuid" : ""}`, ``];
  const headers = [`"Authorization": f"Bearer {os.environ['NINJA_TOKEN']}"`];
  if (body && withIdem) headers.push(`"Idempotency-Key": str(uuid.uuid4())`);
  lines.push(`res = requests.${e.method.toLowerCase()}(`, `    "${u}",`, `    headers={${headers.join(", ")}},`);
  if (body) lines.push(`    json=${pyLiteral(body, 4)},`);
  lines.push(`    timeout=30,`, `)`, `data = res.json()`);
  return lines.join("\n");
}

/** JSON a literal de Python (True/False/None). */
export function pyLiteral(v: unknown, indent = 0): string {
  const s = JSON.stringify(v, null, 4)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
  return s.replace(/\n/g, "\n" + " ".repeat(indent));
}
