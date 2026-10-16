"use client";

import { useMemo, useState } from "react";
import { BookOpen, Download, FileJson, FlaskConical, Gauge, KeyRound, Lock, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/utils/cn";
import { buildOpenApi } from "@/lib/api/openapi";
import { SNIPPET_LANGS, snippet, type SnippetLang } from "@/lib/api/snippets";
import {
  API_BASE_PATH,
  API_DESCRIPTION,
  AUTH_DOC,
  ENDPOINTS,
  ERRORS,
  MODELS,
  OPENAPI_PATH,
  RATE_LIMIT_DOC,
  RESOURCES,
  RESPONSE_FORMAT_DOC,
  SANDBOX_DOC,
  errorSpec,
  scopeList,
  type EndpointSpec,
  type FieldSpec,
  type ParamSpec,
} from "@/lib/api/spec";
import { CodeBlock, CodeTabs, downloadJson } from "./CodeBlock";
import { TryIt } from "./TryIt";

// Portal de desarrolladores de la API pública (ADR-159, H68b): guía y
// referencia generadas desde lib/api/spec.ts, con "Probar" contra el sandbox.
// Navegación lateral desde lg; en mobile, un selector arriba.

export const PORTAL_START = "intro";

type GuideId = "intro" | "credentials" | "auth" | "sandbox" | "limits" | "errors" | "downloads";

const GUIDES: { id: GuideId; label: string; icon: typeof BookOpen }[] = [
  { id: "intro", label: "Introducción", icon: BookOpen },
  { id: "credentials", label: "Credenciales", icon: KeyRound },
  { id: "auth", label: "Autenticación", icon: Lock },
  { id: "sandbox", label: "Sandbox y pruebas", icon: FlaskConical },
  { id: "limits", label: "Límites", icon: Gauge },
  { id: "errors", label: "Errores", icon: ShieldAlert },
  { id: "downloads", label: "Postman y OpenAPI", icon: Download },
];

const isGuide = (id: string): id is GuideId => GUIDES.some((g) => g.id === id);

export function MethodBadge({ method }: { method: EndpointSpec["method"] }) {
  return (
    <Badge tone={method === "GET" ? "info" : "success"} className="w-12 justify-center font-mono">
      {method}
    </Badge>
  );
}

function typeLabel(f: FieldSpec): string {
  let t: string = f.type;
  if (f.format) t += ` (${f.format})`;
  if (f.nullable) t += " | null";
  return t;
}

function constraints(f: FieldSpec): string[] {
  const out: string[] = [];
  if (f.enum) out.push(`Valores: ${f.enum.join(", ")}`);
  if (f.minLength !== undefined || f.maxLength !== undefined) {
    out.push(`Largo ${f.minLength ?? 0} a ${f.maxLength ?? "∞"}`);
  }
  if (f.minimum !== undefined || f.maximum !== undefined) {
    out.push(`Rango ${f.minimum ?? "-∞"} a ${f.maximum ?? "∞"}`);
  }
  if (f.default !== undefined) out.push(`Por defecto ${String(f.default)}`);
  return out;
}

const SHAPE_TEXT: Record<EndpointSpec["response"]["shape"], string> = {
  token: "El cuerpo es el token.",
  page: "{ data: [...], next_cursor }. Cada elemento de data:",
  data: "{ data: [...] }. Cada elemento de data:",
  batch: "{ summary, results: [...] }. Cada elemento de results:",
};

function FieldList({
  fields,
  title,
  showRequired = true,
}: {
  fields: (FieldSpec | ParamSpec)[];
  title: string;
  showRequired?: boolean;
}) {
  if (!fields.length) return null;
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="divide-y divide-border rounded-lg bg-muted/40">
        {fields.map((f) => (
          <div key={f.name} className="space-y-1 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm font-medium text-foreground">{f.name}</code>
              <span className="font-mono text-xs text-muted-foreground">{typeLabel(f)}</span>
              {"in" in f && f.in === "header" && <Badge tone="neutral">header</Badge>}
              {showRequired &&
                (f.required ? <Badge tone="warning">obligatorio</Badge> : <Badge tone="neutral">opcional</Badge>)}
            </div>
            <p className="text-sm text-muted-foreground">{f.description}</p>
            {constraints(f).length > 0 && <p className="text-xs text-muted-foreground">{constraints(f).join(" · ")}</p>}
            {f.fields && f.fields.length > 0 && (
              <div className="mt-2 pl-3">
                <FieldList
                  title={f.type === "array" ? `Cada elemento de ${f.name}` : `Campos de ${f.name}`}
                  fields={f.fields}
                  showRequired={showRequired}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="space-y-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function EndpointPage({ e, origin }: { e: EndpointSpec; origin: string }) {
  const [lang, setLang] = useState<SnippetLang>("curl");
  const query = e.params.filter((p) => p.in === "query");
  const headers = e.params.filter((p) => p.in === "header");
  const errs = e.errors.map((c) => errorSpec(c)).filter((x): x is NonNullable<typeof x> => Boolean(x));
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{RESOURCES.find((r) => r.id === e.resource)?.title}</p>
        <h2 className="text-lg font-semibold">{e.title}</h2>
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted px-3 py-2">
          <MethodBadge method={e.method} />
          <code className="min-w-0 break-all font-mono text-sm">
            {API_BASE_PATH}
            {e.path}
          </code>
        </div>
        <p className="text-sm text-muted-foreground">{e.description}</p>
        <div className="flex flex-wrap gap-2 text-xs">
          {e.scope ? (
            <Badge tone="neutral" className="font-mono">
              alcance {e.scope}
            </Badge>
          ) : (
            <Badge tone="neutral">client_id + client_secret</Badge>
          )}
          <Badge tone="neutral">{e.auth === "bearer" ? "Authorization: Bearer" : "Basic o cuerpo"}</Badge>
        </div>
        {e.notes?.map((n) => (
          <p key={n} className="text-sm text-muted-foreground">
            {n}
          </p>
        ))}
      </header>

      <FieldList title="Parámetros de la URL" fields={query} />
      <FieldList title="Headers" fields={headers} />

      {e.body && (
        <section className="space-y-3">
          <h4 className="text-sm font-semibold">Cuerpo ({e.body.contentType})</h4>
          <p className="text-sm text-muted-foreground">{e.body.description}</p>
          {e.body.itemFields && <FieldList title="Campos de cada ítem de items[]" fields={e.body.itemFields} />}
          {e.body.fields && <FieldList title="Campos" fields={e.body.fields} />}
          <CodeBlock code={JSON.stringify(e.body.example, null, 2)} label="Ejemplo de cuerpo" />
        </section>
      )}

      <section className="space-y-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          Respuesta <Badge tone="success">{e.response.status}</Badge>
        </h4>
        <p className="text-sm text-muted-foreground">
          {e.response.description} {SHAPE_TEXT[e.response.shape]}
        </p>
        <FieldList
          title={MODELS[e.response.model].title}
          fields={MODELS[e.response.model].fields}
          showRequired={false}
        />
        <CodeBlock code={JSON.stringify(e.response.example, null, 2)} label="Ejemplo de respuesta" />
      </section>

      {e.itemErrors && e.itemErrors.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Errores por ítem (en results[], el pedido responde 200)</h4>
          <div className="divide-y divide-border rounded-lg bg-muted/40">
            {e.itemErrors.map((x) => (
              <div key={x.code} className="px-3 py-2.5">
                <code className="font-mono text-sm">{x.code}</code>
                <p className="text-sm text-muted-foreground">{x.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Errores posibles</h4>
        <div className="divide-y divide-border rounded-lg bg-muted/40">
          {errs.map((x) => (
            <div key={x.code} className="flex items-start gap-3 px-3 py-2.5">
              <Badge tone={x.status >= 500 ? "danger" : "warning"} className="font-mono">
                {x.status}
              </Badge>
              <div className="min-w-0">
                <code className="font-mono text-sm">{x.code}</code>
                <p className="text-sm text-muted-foreground">{x.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <Callout tone="info" icon={FlaskConical} title="Con una credencial de prueba">
        {e.sandbox}
      </Callout>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Ejemplos</h4>
        <CodeTabs
          ariaLabel="Lenguaje del ejemplo"
          value={lang}
          onChange={setLang}
          tabs={SNIPPET_LANGS.map((l) => ({ id: l.id, label: l.label, code: snippet(l.id, e, origin) }))}
        />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Probar en el sandbox</h4>
        <TryIt endpoint={e} />
      </section>
    </article>
  );
}

function Intro({ origin, go }: { origin: string; go: (id: string) => void }) {
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">API pública v1</h2>
        <p className="text-sm text-muted-foreground">{API_DESCRIPTION}</p>
      </header>
      <Section title="URL base">
        <CodeBlock code={`${origin}${API_BASE_PATH}`} label="Base" />
      </Section>
      <Section title="Primeros pasos">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>Creá una credencial de prueba en Credenciales.</li>
          <li>Descargá la colección de Postman o probá desde esta página.</li>
          <li>Cuando la integración funciona, creá una credencial de producción con los mismos permisos.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => go("credentials")}>
            <KeyRound size={15} /> Credenciales
          </Button>
          <Button size="sm" variant="secondary" onClick={() => go("sandbox")}>
            <FlaskConical size={15} /> Sandbox
          </Button>
          <Button size="sm" variant="secondary" onClick={() => go("downloads")}>
            <Download size={15} /> Postman y OpenAPI
          </Button>
        </div>
      </Section>
      <Section title="Recursos">
        <div className="grid gap-3 sm:grid-cols-2">
          {RESOURCES.map((r) => {
            const first = ENDPOINTS.find((e) => e.resource === r.id);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => first && go(first.id)}
                className="rounded-lg bg-muted/50 p-3 text-left transition hover:bg-muted"
              >
                <span className="block text-sm font-medium">{r.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{r.description}</span>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Formato">
        <List
          items={[
            "JSON en UTF-8. Fechas en ISO 8601 con zona. Montos en pesos con decimales.",
            "Listas paginadas con cursor: { data, next_cursor }. Seguí next_cursor hasta que venga null.",
            "Lotes: { items: [...] } y respuesta { summary, results } con el resultado de cada ítem en el mismo orden.",
            "Los campos desconocidos dan 422: la API nunca ignora un campo en silencio.",
            "Webhooks: todavía no existen. Para enterarte de cambios, consultá con updated_since.",
          ]}
        />
      </Section>
    </article>
  );
}

function AuthGuide({ origin }: { origin: string }) {
  const token = ENDPOINTS.find((e) => e.id === "oauth.token")!;
  const [lang, setLang] = useState<SnippetLang>("curl");
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Autenticación</h2>
        <p className="text-sm text-muted-foreground">OAuth2 client_credentials con permisos por alcance.</p>
      </header>
      <Section title="Cómo funciona">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          {AUTH_DOC.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </Section>
      <Section title="Pedir el token">
        <CodeTabs
          ariaLabel="Lenguaje del ejemplo"
          value={lang}
          onChange={setLang}
          tabs={SNIPPET_LANGS.map((l) => ({ id: l.id, label: l.label, code: snippet(l.id, token, origin) }))}
        />
        <CodeBlock code={JSON.stringify(token.response.example, null, 2)} label="Respuesta" />
      </Section>
      <Section title="Alcances">
        <div className="divide-y divide-border rounded-lg bg-muted/40">
          {scopeList().map((s) => (
            <div key={s.scope} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-sm">{s.scope}</code>
                <span className="text-sm font-medium">{s.label}</span>
              </div>
              <p className="text-sm text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Seguridad">
        <List items={AUTH_DOC.security} />
      </Section>
      <Section title="Probar">
        <TryIt endpoint={token} />
      </Section>
    </article>
  );
}

function SandboxGuide({ go }: { go: (id: string) => void }) {
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Sandbox y pruebas</h2>
        <p className="text-sm text-muted-foreground">{SANDBOX_DOC.summary}</p>
      </header>
      <Section title="Qué pasa con una credencial de prueba">
        <List items={SANDBOX_DOC.rules} />
      </Section>
      <Section title="Ejemplo de respuesta simulada">
        <CodeBlock
          label="POST /api/v1/products/batch con nsat_test_"
          code={JSON.stringify(
            {
              summary: { created: 1, updated: 0, unchanged: 0, failed: 0 },
              results: [{ index: 0, sku: "ALM-ARROZ-1KG", id: "5b0c5e7e-3f6a-4f0e-9a51-2d1f0f6b8c11", status: "created" }],
              dry_run: true,
            },
            null,
            2,
          )}
        />
      </Section>
      <Section title="Probar desde esta página">
        <p className="text-sm text-muted-foreground">
          Cada endpoint tiene su consola Probar. Conectate una vez con tu credencial de prueba y quedás conectado mientras
          no cierres la pestaña. No acepta credenciales de producción.
        </p>
        <Button size="sm" variant="secondary" onClick={() => go("oauth.token")}>
          <FlaskConical size={15} /> Conectar y probar
        </Button>
      </Section>
    </article>
  );
}

function LimitsGuide() {
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Límites</h2>
        <p className="text-sm text-muted-foreground">{RATE_LIMIT_DOC.summary}</p>
      </header>
      <Section title="Headers del límite">
        <div className="divide-y divide-border rounded-lg bg-muted/40">
          {RATE_LIMIT_DOC.headers.map((h) => (
            <div key={h.name} className="px-3 py-2.5">
              <code className="font-mono text-sm">{h.name}</code>
              <p className="text-sm text-muted-foreground">{h.description}</p>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Otros límites">
        <List items={RATE_LIMIT_DOC.limits} />
      </Section>
      <Section title="Reintentos">
        <List
          items={[
            "429: esperá los segundos de Retry-After y reintentá.",
            "409 conflict, 500 y 503: reintentá con espera creciente (1, 2, 4, 8 segundos).",
            "Para reintentar escrituras sin duplicar, mandá siempre la misma Idempotency-Key.",
          ]}
        />
      </Section>
    </article>
  );
}

function ErrorsGuide() {
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Errores</h2>
        <p className="text-sm text-muted-foreground">
          Todos los errores tienen el mismo formato: un code estable para tu código y un message en español para mostrar.
          El pedido de token usa el formato de OAuth ({"{error, error_description}"}).
        </p>
      </header>
      <CodeBlock code={JSON.stringify(RESPONSE_FORMAT_DOC.errorExample, null, 2)} label="Formato" />
      <Section title="Códigos">
        <div className="divide-y divide-border rounded-lg bg-muted/40">
          {ERRORS.map((x) => (
            <div key={x.code} className="flex items-start gap-3 px-3 py-2.5">
              <Badge tone={x.status >= 500 ? "danger" : "warning"} className="font-mono">
                {x.status}
              </Badge>
              <div className="min-w-0">
                <code className="font-mono text-sm">{x.code}</code>
                <p className="text-sm text-muted-foreground">{x.description}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Headers de cada respuesta">
        <div className="divide-y divide-border rounded-lg bg-muted/40">
          {RESPONSE_FORMAT_DOC.headers.map((h) => (
            <div key={h.name} className="px-3 py-2.5">
              <code className="font-mono text-sm">{h.name}</code>
              <p className="text-sm text-muted-foreground">{h.description}</p>
            </div>
          ))}
        </div>
      </Section>
    </article>
  );
}

function DownloadsGuide({ origin, onPostman }: { origin: string; onPostman: () => void }) {
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">Postman y OpenAPI</h2>
        <p className="text-sm text-muted-foreground">
          Todo sale de la misma definición que esta página: lo que ves acá es lo que trae la colección y la especificación.
        </p>
      </header>
      <Section title="Colección de Postman">
        <p className="text-sm text-muted-foreground">
          Formato v2.1, una carpeta por recurso, cada pedido con su explicación, ejemplos de cuerpo y de respuesta. Variables
          base_url, client_id y client_secret; el token se pide solo antes del primer pedido y se renueva.
        </p>
        <Button size="sm" onClick={onPostman}>
          <Download size={15} /> Descargar colección de Postman
        </Button>
      </Section>
      <Section title="OpenAPI 3.1">
        <p className="text-sm text-muted-foreground">
          Para generar clientes (openapi-generator, Swagger, Insomnia, Bruno). Pública, sin datos del negocio.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => downloadJson(buildOpenApi(origin), "ninjasoft-api-v1.openapi.json")}>
            <FileJson size={15} /> Descargar OpenAPI
          </Button>
        </div>
        <CodeBlock code={`${origin}${OPENAPI_PATH}`} label="URL de la especificación" />
      </Section>
    </article>
  );
}

export function ApiPortal({
  credentials,
  onPostman,
  active,
  onNavigate,
}: {
  /** Sección de credenciales (sólo el dueño la ve completa). */
  credentials: React.ReactNode;
  onPostman: () => void;
  /** Sección visible: id de guía o de endpoint. */
  active: string;
  onNavigate: (id: string) => void;
}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = useMemo(() => ENDPOINTS.find((e) => e.id === active) ?? null, [active]);

  const go = (id: string) => {
    onNavigate(id);
    const top = typeof document === "undefined" ? null : document.getElementById("api-portal-top");
    if (top && typeof top.scrollIntoView === "function") top.scrollIntoView({ block: "start" });
  };

  const options = [
    ...GUIDES.map((g) => ({ value: g.id as string, label: g.label })),
    ...ENDPOINTS.map((e) => ({
      value: e.id,
      label: `${e.method} ${e.title}`,
      description: `${RESOURCES.find((r) => r.id === e.resource)?.title} · ${API_BASE_PATH}${e.path}`,
    })),
  ];

  return (
    <div id="api-portal-top" className="scroll-mt-4 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6">
      <div className="mb-4 lg:hidden">
        <Select aria-label="Sección de la documentación" value={active} onChange={go} options={options} />
      </div>

      <nav aria-label="Documentación de la API" className="hidden lg:block">
        <div className="sticky top-4 max-h-[calc(100vh-2rem)] space-y-5 overflow-y-auto pb-4 pr-1">
          <div className="space-y-0.5">
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Guía</p>
            {GUIDES.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => go(g.id)}
                aria-current={active === g.id ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
                  active === g.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/50",
                )}
              >
                <g.icon size={14} aria-hidden /> {g.label}
              </button>
            ))}
          </div>
          {RESOURCES.map((r) => (
            <div key={r.id} className="space-y-0.5">
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{r.title}</p>
              {ENDPOINTS.filter((e) => e.resource === r.id).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => go(e.id)}
                  aria-current={active === e.id ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
                    active === e.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/50",
                  )}
                >
                  <span
                    className={cn(
                      "w-9 shrink-0 font-mono text-[11px] font-semibold",
                      e.method === "GET" ? "text-info" : "text-success",
                    )}
                  >
                    {e.method}
                  </span>
                  <span className="min-w-0 truncate">{e.title}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="min-w-0">
        {active === "credentials" ? (
          credentials
        ) : (
          <Card className="p-4 sm:p-6">
            {endpoint ? (
              <EndpointPage key={endpoint.id} e={endpoint} origin={origin} />
            ) : active === "auth" ? (
              <AuthGuide origin={origin} />
            ) : active === "sandbox" ? (
              <SandboxGuide go={go} />
            ) : active === "limits" ? (
              <LimitsGuide />
            ) : active === "errors" ? (
              <ErrorsGuide />
            ) : active === "downloads" ? (
              <DownloadsGuide origin={origin} onPostman={onPostman} />
            ) : isGuide(active) ? (
              <Intro origin={origin} go={go} />
            ) : (
              <Callout tone="warning" icon={TriangleAlert}>
                Sección inexistente.
              </Callout>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
ApiPortal.displayName = "ApiPortal";
