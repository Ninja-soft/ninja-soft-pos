// @vitest-environment node
// =============================================================================
// App de Mercado Libre configurable desde el panel interno (ADR-126):
// prioridad platform_secrets > secrets de Edge, validación, memo del loader,
// clasificación de "Probar conexión" y estado legible de la sección interna.
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import {
  ML_NOT_CONFIGURED,
  appIdOf,
  classifyMlTokenProbe,
  createMlConfigLoader,
  missingPlatformFields,
  readMlConfig,
  resolveMlConfig,
  validateMlAppField,
} from "@/supabase/functions/_shared/mercadolibre/config";
import { ML_TOPICS, mlReadiness, mlRedirectUri, mlWebhookDirectUrl, mlWebhookUrl, type MlAppStatus } from "@/lib/mercadolibre/appSetup";

const ENV = {
  ML_CLIENT_ID: "1111222233334444",
  ML_CLIENT_SECRET: "secretoDeEdge1234567890",
  ML_REDIRECT_URI: "https://pos.soft.ninja/api/ml/oauth/callback",
};
const DB = {
  client_id: "9999888877776666",
  client_secret: "secretoDelPanel0987654321",
  redirect_uri: "https://otro.soft.ninja/api/ml/oauth/callback",
};

describe("resolveMlConfig: prioridad de orígenes", () => {
  it("platform_secrets completo gana sobre los secrets de Edge", () => {
    const r = resolveMlConfig({ db: DB, env: ENV });
    expect(r.ok && r.origin).toBe("platform");
    expect(r.ok && r.config).toEqual({ clientId: DB.client_id, clientSecret: DB.client_secret, redirectUri: DB.redirect_uri });
  });

  it("sin platform_secrets rigen los secrets de Edge (compatibilidad con producción)", () => {
    const r = resolveMlConfig({ db: null, env: ENV });
    expect(r.ok && r.origin).toBe("env");
    expect(r.ok && r.config.clientId).toBe(ENV.ML_CLIENT_ID);
    expect(r.ok && r.config.redirectUri).toBe(ENV.ML_REDIRECT_URI);
    expect(readMlConfig(ENV)).toEqual(r);
  });

  it("platform_secrets incompleto no se mezcla con el env: rige el env entero", () => {
    const r = resolveMlConfig({ db: { client_id: DB.client_id }, env: ENV });
    expect(r.ok && r.origin).toBe("env");
    expect(r.ok && r.config.clientId).toBe(ENV.ML_CLIENT_ID);
    expect(r.ok && r.config.clientSecret).toBe(ENV.ML_CLIENT_SECRET);
    const r2 = resolveMlConfig({ db: { client_secret: DB.client_secret }, env: ENV });
    expect(r2.ok && r2.config.clientSecret).toBe(ENV.ML_CLIENT_SECRET);
  });

  it("platform_secrets con id inválido no rige", () => {
    const r = resolveMlConfig({ db: { ...DB, client_id: "yo@soft.ninja" }, env: ENV });
    expect(r.ok && r.origin).toBe("env");
  });

  it("sin redirect en el panel usa la del env (ML_REDIRECT_URI o APP_URL)", () => {
    const db = { client_id: DB.client_id, client_secret: DB.client_secret };
    const a = resolveMlConfig({ db, env: ENV });
    expect(a.ok && a.origin).toBe("platform");
    expect(a.ok && a.config.redirectUri).toBe(ENV.ML_REDIRECT_URI);
    const b = resolveMlConfig({ db, env: { APP_URL: "https://pos.soft.ninja/" } });
    expect(b.ok && b.config.redirectUri).toBe("https://pos.soft.ninja/api/ml/oauth/callback");
    const c = resolveMlConfig({ db, env: {} });
    expect(c.ok).toBe(false);
  });

  it("redirect inválida en el panel se ignora y cae a la del env", () => {
    const r = resolveMlConfig({ db: { ...DB, redirect_uri: "http://inseguro" }, env: ENV });
    expect(r.ok && r.config.redirectUri).toBe(ENV.ML_REDIRECT_URI);
  });

  it("sin nada: ml_app_not_configured", () => {
    const r = resolveMlConfig({ db: null, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ML_NOT_CONFIGURED);
  });

  it("valores no string del jsonb no rompen", () => {
    const r = resolveMlConfig({ db: { client_id: 123, client_secret: { x: 1 } } as never, env: ENV });
    expect(r.ok && r.origin).toBe("env");
  });

  it("appIdOf prefiere el App ID efectivo y si no, el del env", () => {
    expect(appIdOf(ENV, DB)).toBe(DB.client_id);
    expect(appIdOf(ENV)).toBe(ENV.ML_CLIENT_ID);
    expect(appIdOf({ ML_CLIENT_ID: "12345" })).toBe("12345");
    expect(appIdOf({})).toBeNull();
  });
});

describe("validateMlAppField", () => {
  it("App ID numérico", () => {
    expect(validateMlAppField("client_id", "1234567890")).toBeNull();
    expect(validateMlAppField("client_id", "abc")).toMatch(/sólo números/);
    expect(validateMlAppField("client_id", "yo@x.com")).toMatch(/email/);
    expect(validateMlAppField("client_id", "  ")).toBeNull();
  });
  it("Clave secreta sin espacios", () => {
    expect(validateMlAppField("client_secret", "AbCdEf1234567890")).toBeNull();
    expect(validateMlAppField("client_secret", "con espacio 123")).not.toBeNull();
    expect(validateMlAppField("client_secret", "corta")).not.toBeNull();
  });
  it("Redirect URI https y sin parámetros", () => {
    expect(validateMlAppField("redirect_uri", "https://pos.soft.ninja/api/ml/oauth/callback")).toBeNull();
    expect(validateMlAppField("redirect_uri", "http://pos.soft.ninja/cb")).toMatch(/https/);
    expect(validateMlAppField("redirect_uri", "https://pos.soft.ninja/cb?x=1")).toMatch(/parámetros/);
    expect(validateMlAppField("redirect_uri", "no es url")).toMatch(/válida/);
  });
  it("missingPlatformFields lista lo que falta", () => {
    expect(missingPlatformFields(null)).toEqual(["client_id", "client_secret", "redirect_uri"]);
    expect(missingPlatformFields(DB)).toEqual([]);
    expect(missingPlatformFields({ client_id: DB.client_id, client_secret: DB.client_secret })).toEqual(["redirect_uri"]);
  });
});

describe("createMlConfigLoader", () => {
  it("lee la base una sola vez por invocación", async () => {
    const read = vi.fn(async () => DB);
    const load = createMlConfigLoader(read, ENV);
    const [a, b] = await Promise.all([load(), load()]);
    await load();
    expect(read).toHaveBeenCalledTimes(1);
    expect(a.ok && a.origin).toBe("platform");
    expect(b).toBe(a);
  });

  it("con TTL vuelve a leer al vencer", async () => {
    let t = 0;
    const read = vi.fn(async () => DB);
    const load = createMlConfigLoader(read, ENV, { ttlMs: 60_000, now: () => t });
    await load();
    t = 30_000;
    await load();
    expect(read).toHaveBeenCalledTimes(1);
    t = 61_000;
    await load();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("si la base falla resuelve con el env y no cachea el error", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("db")).mockResolvedValue(DB);
    const load = createMlConfigLoader(read, ENV);
    const first = await load();
    expect(first.ok && first.origin).toBe("env");
    const second = await load();
    expect(second.ok && second.origin).toBe("platform");
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("classifyMlTokenProbe", () => {
  it("200 con access_token = par válido", () => {
    expect(classifyMlTokenProbe(200, { access_token: "APP_USR-x" })).toBe("valid");
  });
  it("invalid_grant con un refresh inventado = par válido", () => {
    expect(classifyMlTokenProbe(400, { error: "invalid_grant", message: "Error validating grant." })).toBe("valid");
  });
  it("invalid_client = par inválido", () => {
    expect(classifyMlTokenProbe(401, { error: "invalid_client", message: "invalid client_id or client_secret." })).toBe(
      "invalid_credentials",
    );
    expect(classifyMlTokenProbe(400, { error: "bad_request", message: "Invalid client_secret" })).toBe("invalid_credentials");
  });
  it("otra cosa = desconocido", () => {
    expect(classifyMlTokenProbe(500, null)).toBe("unknown");
    expect(classifyMlTokenProbe(400, { error: "unsupported_grant_type" })).toBe("unknown");
  });
});

describe("sección interna: URLs y estado", () => {
  const base: MlAppStatus = {
    updated_at: null,
    client_id: null,
    client_secret: false,
    redirect_uri: null,
    missing: ["client_id", "client_secret", "redirect_uri"],
    origin: null,
    effective: null,
    env: { client_id: null, client_secret: false, redirect_uri: null },
  };

  it("URLs sugeridas", () => {
    expect(mlWebhookUrl()).toBe("https://hooks.soft.ninja/ml");
    expect(mlWebhookDirectUrl("https://abc.supabase.co/")).toBe("https://abc.supabase.co/functions/v1/ml_webhook");
    expect(mlWebhookDirectUrl(undefined)).toBeNull();
    expect(mlRedirectUri("https://pos.soft.ninja/")).toBe("https://pos.soft.ninja/api/ml/oauth/callback");
  });

  it("tópicos MVP = los que procesa el worker", () => {
    expect(ML_TOPICS.filter((t) => t.phase === "mvp").map((t) => t.topic)).toEqual([
      "orders_v2",
      "items",
      "items_prices",
      "questions",
      "shipments",
    ]);
  });

  it("sin nada: sin configurar con lo que falta", () => {
    const r = mlReadiness(base);
    expect(r.tone).toBe("bad");
    expect(r.detail).toMatch(/App ID, Clave secreta/);
  });

  it("sólo secrets de Edge: configurada con aviso", () => {
    const r = mlReadiness({
      ...base,
      origin: "env",
      effective: { client_id: ENV.ML_CLIENT_ID, redirect_uri: ENV.ML_REDIRECT_URI },
      env: { client_id: ENV.ML_CLIENT_ID, client_secret: true, redirect_uri: ENV.ML_REDIRECT_URI },
    });
    expect(r.tone).toBe("warn");
    expect(r.title).toMatch(/secrets de Edge/);
  });

  it("panel a medias con env vigente: avisa qué falta para que rija", () => {
    const r = mlReadiness({
      ...base,
      client_id: DB.client_id,
      missing: ["client_secret", "redirect_uri"],
      origin: "env",
      effective: { client_id: ENV.ML_CLIENT_ID, redirect_uri: ENV.ML_REDIRECT_URI },
    });
    expect(r.detail).toMatch(/todavía no rige: falta Clave secreta/);
  });

  it("panel completo: configurada", () => {
    const r = mlReadiness({
      ...base,
      client_id: DB.client_id,
      client_secret: true,
      redirect_uri: DB.redirect_uri,
      missing: [],
      origin: "platform",
      effective: { client_id: DB.client_id, redirect_uri: DB.redirect_uri },
    });
    expect(r).toMatchObject({ tone: "ok", title: "Configurada" });
  });
});
