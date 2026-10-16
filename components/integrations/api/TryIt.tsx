"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { FlaskConical, Play, Plug, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { Input } from "@/components/ui/Input";
import { API_BASE_PATH, type EndpointSpec } from "@/lib/api/spec";
import { DEMO_CLIENT_ID, DEMO_CLIENT_SECRET, isDemoClient } from "@/lib/api/sandboxConstants";
import {
  checkBody,
  checkSandboxCreds,
  initialQuery,
  maskToken,
  SHOWN_RESPONSE_HEADERS,
  tryUrl,
} from "@/lib/api/tryit";
import { CodeBlock } from "./CodeBlock";

// "Probar" del portal (ADR-159): consola contra el sandbox. Sólo credenciales
// de prueba (nsc_test_): las escrituras hacen dry_run en la base y no guardan
// nada. Credenciales y token viven sólo en memoria (este estado de React).
// En la página pública /developers (ADR-163) el mismo componente apunta a
// /api/sandbox/v1 y ofrece las credenciales de ejemplo (dataset ficticio).

type Session = { clientId: string; clientSecret: string; token: string | null; expiresAt: number };

type SandboxCtx = {
  session: Session | null;
  /** /api/v1 (panel) o /api/sandbox/v1 (página pública). */
  basePath: string;
  /** Ofrece las credenciales de ejemplo (sólo la página pública). */
  demo: boolean;
  /** Precarga credenciales (p. ej. la credencial de prueba recién creada). */
  loadCredentials: (clientId: string, clientSecret: string) => void;
  connect: (clientId: string, clientSecret: string) => Promise<TryResult>;
  disconnect: () => void;
  /** Token vigente (lo renueva si venció). */
  ensureToken: () => Promise<string | null>;
};

const Ctx = createContext<SandboxCtx | null>(null);

export type TryResult = {
  status: number;
  ms: number;
  headers: [string, string][];
  body: string;
};

async function requestToken(
  basePath: string,
  clientId: string,
  clientSecret: string,
): Promise<{ result: TryResult; token?: string; expiresIn?: number }> {
  const started = performance.now();
  const res = await fetch(`${basePath}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const token = res.ok && typeof parsed?.access_token === "string" ? parsed.access_token : undefined;
  // El token no se muestra entero en la consola.
  const shown = parsed && token ? { ...parsed, access_token: maskToken(token) } : parsed;
  return {
    result: {
      status: res.status,
      ms: Math.round(performance.now() - started),
      headers: pickHeaders(res.headers),
      body: shown ? JSON.stringify(shown, null, 2) : text,
    },
    token,
    expiresIn: typeof parsed?.expires_in === "number" ? parsed.expires_in : undefined,
  };
}

function pickHeaders(h: Headers): [string, string][] {
  const out: [string, string][] = [];
  for (const k of SHOWN_RESPONSE_HEADERS) {
    const v = h.get(k);
    if (v) out.push([k, v]);
  }
  return out;
}

export function SandboxProvider({
  children,
  basePath = API_BASE_PATH,
  demo = false,
}: {
  children: React.ReactNode;
  basePath?: string;
  demo?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);

  const loadCredentials = useCallback((clientId: string, clientSecret: string) => {
    setSession({ clientId, clientSecret, token: null, expiresAt: 0 });
  }, []);

  const connect = useCallback(async (clientId: string, clientSecret: string) => {
    const r = await requestToken(basePath, clientId.trim(), clientSecret.trim());
    if (r.token) {
      setSession({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        token: r.token,
        expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000,
      });
    }
    return r.result;
  }, [basePath]);

  const disconnect = useCallback(() => setSession(null), []);

  const ensureToken = useCallback(async () => {
    if (!session) return null;
    if (session.token && Date.now() < session.expiresAt - 60_000) return session.token;
    const r = await requestToken(basePath, session.clientId, session.clientSecret);
    if (!r.token) return null;
    setSession({ ...session, token: r.token, expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000 });
    return r.token;
  }, [session, basePath]);

  const value = useMemo(
    () => ({ session, basePath, demo, loadCredentials, connect, disconnect, ensureToken }),
    [session, basePath, demo, loadCredentials, connect, disconnect, ensureToken],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSandbox(): SandboxCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSandbox fuera de SandboxProvider");
  return c;
}

function ResultView({ r }: { r: TryResult }) {
  const tone = r.status < 300 ? "success" : r.status < 500 ? "warning" : "danger";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone={tone}>{r.status}</Badge>
        <span>{r.ms} ms</span>
        {r.headers.map(([k, v]) => (
          <span key={k} className="font-mono">
            {k}: <span className="text-foreground">{v}</span>
          </span>
        ))}
      </div>
      <CodeBlock code={r.body || "(sin cuerpo)"} label="Respuesta" />
    </div>
  );
}

/** Conexión al sandbox (pantalla de token y cabecera de cada consola). */
export function SandboxConnect({ compact = false }: { compact?: boolean }) {
  const { session, connect, disconnect, demo } = useSandbox();
  const [clientId, setClientId] = useState(session?.clientId ?? "");
  const [secret, setSecret] = useState(session?.clientSecret ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [lastSession, setLastSession] = useState(session);
  if (session !== lastSession) {
    setLastSession(session);
    if (session) {
      setClientId(session.clientId);
      setSecret(session.clientSecret);
    }
  }

  if (session?.token) {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs">
          <span className="flex items-center gap-2 font-medium text-foreground">
            <Plug size={14} aria-hidden /> Conectado al sandbox
            <Badge tone="info">{isDemoClient(session.clientId) ? "Datos ficticios" : "Prueba"}</Badge>
          </span>
          <span className="mt-0.5 block break-all font-mono text-muted-foreground">
            {session.clientId} · token hasta{" "}
            {new Date(session.expiresAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={disconnect}>
          <Unplug size={15} /> Desconectar
        </Button>
      </div>
    );
  }

  const submit = async () => {
    const check = checkSandboxCreds(clientId, secret);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await connect(clientId, secret);
      setResult(r);
      if (r.status !== 200) setError("No se pudo obtener el token. Revisá la respuesta.");
    } catch {
      setError("No se pudo conectar. Revisá tu conexión y reintentá.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg bg-muted/60 p-3">
      {!compact && (
        <p className="flex items-center gap-2 text-sm font-medium">
          <FlaskConical size={15} className="text-info" aria-hidden /> Conectate al sandbox
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <CredentialInput
          label="client_id de prueba"
          mono
          placeholder="nsc_test_…"
          value={clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setClientId(e.target.value)}
        />
        <CredentialInput
          label="client_secret de prueba"
          mono
          secret
          placeholder="nss_test_…"
          value={secret}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Queda sólo en esta pestaña: no se guarda en el navegador.</p>
        <div className="flex flex-wrap gap-2">
          {demo && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setClientId(DEMO_CLIENT_ID);
                setSecret(DEMO_CLIENT_SECRET);
                setError(null);
              }}
            >
              <FlaskConical size={15} /> Usar credenciales de ejemplo
            </Button>
          )}
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            <Plug size={15} /> Conectar
          </Button>
        </div>
      </div>
      {result && <ResultView r={result} />}
    </div>
  );
}

/** Consola de un endpoint. */
export function TryIt({ endpoint }: { endpoint: EndpointSpec }) {
  const { session, ensureToken, basePath } = useSandbox();
  const [query, setQuery] = useState<Record<string, string>>(() => initialQuery(endpoint));
  const [body, setBody] = useState(() => (endpoint.body ? JSON.stringify(endpoint.body.example, null, 2) : ""));
  const [idemKey, setIdemKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TryResult | null>(null);
  const [lastId, setLastId] = useState(endpoint.id);
  if (endpoint.id !== lastId) {
    setLastId(endpoint.id);
    setQuery(initialQuery(endpoint));
    setBody(endpoint.body ? JSON.stringify(endpoint.body.example, null, 2) : "");
    setIdemKey("");
    setResult(null);
    setError(null);
  }

  if (endpoint.auth === "client_credentials") return <SandboxConnect />;

  const queryParams = endpoint.params.filter((p) => p.in === "query");
  const hasIdem = endpoint.params.some((p) => p.name === "Idempotency-Key");

  const send = async () => {
    setError(null);
    let payload: string | undefined;
    if (endpoint.body) {
      const b = checkBody(body);
      if (!b.ok) {
        setError(b.message);
        return;
      }
      payload = b.text;
    }
    setBusy(true);
    try {
      const token = await ensureToken();
      if (!token) {
        setError("El sandbox no tiene un token válido. Volvé a conectarte.");
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (payload) headers["Content-Type"] = "application/json";
      if (hasIdem && idemKey.trim()) headers["Idempotency-Key"] = idemKey.trim();
      const started = performance.now();
      const res = await fetch(tryUrl(endpoint, query, basePath), { method: endpoint.method, headers, body: payload });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* texto tal cual */
      }
      setResult({ status: res.status, ms: Math.round(performance.now() - started), headers: pickHeaders(res.headers), body: pretty });
    } catch {
      setError("No se pudo enviar el pedido. Revisá tu conexión.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <SandboxConnect compact />
      {session?.token && (
        <>
          {queryParams.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {queryParams.map((p) => (
                <Input
                  key={p.name}
                  variant="filled"
                  label={`${p.name}${p.required ? " *" : ""}`}
                  className="font-mono text-xs"
                  placeholder={p.example !== undefined ? String(p.example) : p.default !== undefined ? String(p.default) : ""}
                  value={query[p.name] ?? ""}
                  onChange={(e) => setQuery({ ...query, [p.name]: e.target.value })}
                />
              ))}
            </div>
          )}
          {hasIdem && (
            <Input
              variant="filled"
              label="Idempotency-Key (opcional)"
              className="font-mono text-xs"
              placeholder="sync-2026-10-15-0001"
              value={idemKey}
              onChange={(e) => setIdemKey(e.target.value)}
            />
          )}
          {endpoint.body && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Cuerpo (JSON)</span>
              <textarea
                className="min-h-48 w-full rounded-xl border-0 bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none transition focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]"
                spellCheck={false}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
          )}
          {endpoint.method !== "GET" && (
            <Callout tone="info" icon={FlaskConical}>
              {session && isDemoClient(session.clientId)
                ? "Datos ficticios: se valida contra el negocio de ejemplo y se simula. No se guarda nada."
                : "Sandbox: se valida y se simula, pero no se guarda nada (dry_run)."}
            </Callout>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void send()} disabled={busy}>
              <Play size={15} /> Enviar
            </Button>
          </div>
          {result && <ResultView r={result} />}
        </>
      )}
    </div>
  );
}
TryIt.displayName = "TryIt";
