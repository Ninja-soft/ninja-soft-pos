// Catálogo de logísticas (ADR-103): adaptadores vs. semilla de la base,
// esqueletos sin endpoints inventados, keys de plan (§6 de CLAUDE.md), copy y
// formulario de conexión, y la etiqueta ZPL a la cola de impresión (ADR-101).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVE_ADAPTERS, ADAPTERS } from "@/supabase/functions/_shared/shipping/registry";
import { GENERIC_STATUS_MAP } from "@/supabase/functions/_shared/shipping/skeleton";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";
import {
  PROVIDER_GUIDES,
  SHIPPING_PROVIDER_FEATURE,
  missingRequired,
  shippingProviderFeature,
  splitConnectionValues,
} from "@/lib/shipping/providers";
import { buildCreatePayload, shipmentFormSchema, shippingErrorMessage } from "@/lib/shipping/form";
import { PRINT_DOC_LABELS, fromBase64, parseQueue } from "@/lib/print/queue";
import { enqueueZplLabel, zplBytes } from "@/lib/shipping/print";

const MIG = path.join(process.cwd(), "supabase", "migrations");
const nucleo = fs.readFileSync(path.join(MIG, "20261110300100_envios_nucleo.sql"), "utf8");
const features = fs.readFileSync(path.join(MIG, "20261110300000_features_envios.sql"), "utf8");

type Seed = { key: string; status: string; caps: Record<string, boolean>; formats: string[] };
function seed(): Seed[] {
  const out: Seed[] = [];
  const re = /\('([a-z_]+)', '[^']+', '([a-z]+)', '([a-z]+)',\s*'(\{[^']*\})', (array\[[^\]]*\]|'\{\}')/g;
  for (const m of nucleo.matchAll(re)) {
    out.push({
      key: m[1]!,
      status: m[3]!,
      caps: JSON.parse(m[4]!),
      formats: m[5]!.startsWith("array") ? Array.from(m[5]!.matchAll(/'([a-z]+)'/g)).map((x) => x[1]!) : [],
    });
  }
  return out;
}

describe("catálogo vs. adaptadores", () => {
  const rows = seed();

  it("la semilla tiene simulador, Andreani, esqueletos y las planificadas", () => {
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining(["simulador", "andreani", "correo_argentino", "oca", "enviopack", "pickit", "hop", "andesmar", "bluemail", "cabify_logistics"]),
    );
  });

  it("cada logística activa o esqueleto tiene adaptador con las mismas capacidades y formatos", () => {
    for (const r of rows.filter((x) => x.status !== "planned")) {
      const a = ADAPTERS[r.key];
      expect(a, r.key).toBeTruthy();
      expect(a!.capabilities, r.key).toEqual(r.caps);
      expect(a!.labelFormats, r.key).toEqual(r.formats);
    }
    expect(rows.filter((r) => r.status === "active").map((r) => r.key).sort()).toEqual([...ACTIVE_ADAPTERS].sort());
  });

  it("las planificadas no tienen adaptador (no se inventan endpoints)", () => {
    for (const r of rows.filter((x) => x.status === "planned")) expect(ADAPTERS[r.key], r.key).toBeUndefined();
  });

  it("los esqueletos fallan con not_implemented en todo", async () => {
    const ctx = { sandbox: true, config: {}, secrets: {}, fetch: async () => new Response(""), now: () => new Date() };
    const ref = { reference: "r", external_id: "e", tracking_number: "t", service_type: "door" as const, created_at: "" };
    for (const key of ["correo_argentino", "oca", "enviopack"]) {
      const a = ADAPTERS[key]!;
      await expect(a.testConnection(ctx)).rejects.toMatchObject({ code: "not_implemented" });
      await expect(a.quote(ctx, { origin: { postal_code: "1" }, destination: { postal_code: "1" }, packages: [], declared_value: 0 })).rejects.toMatchObject({
        code: "not_implemented",
      });
      await expect(a.track(ctx, ref)).rejects.toMatchObject({ code: "not_implemented" });
      expect(a.mapStatus("Entregado")).toBe("delivered");
    }
    expect(GENERIC_STATUS_MAP.length).toBeGreaterThan(5);
  });
});

describe("features (CLAUDE.md §6)", () => {
  it("envios y una key por carrier igual a shipping_providers.key, en grupo envios y OPTIONAL", () => {
    for (const k of ["envios", "andreani", "correo_argentino", "oca", "enviopack"]) {
      expect(features, k).toMatch(new RegExp(`\\('${k}',[\\s\\S]*?'envios', false, \\d+\\)`));
      expect(FEATURE_INFO[k], k).toBeTruthy();
    }
  });

  it("espejo de shipping_provider_plan_key: el simulador lo cubre `envios`", () => {
    expect(shippingProviderFeature("simulador")).toBeNull();
    for (const k of ["andreani", "correo_argentino", "oca", "enviopack"]) expect(shippingProviderFeature(k)).toBe(k);
    expect(Object.keys(SHIPPING_PROVIDER_FEATURE).sort()).toEqual(Object.keys(ADAPTERS).sort());
  });

  it("copy: Pro para el módulo y nativos, Business para el agregador; dependen de envios", () => {
    expect(FEATURE_INFO.envios?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.andreani?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.enviopack?.minPlan).toBe("Business");
    for (const k of ["andreani", "correo_argentino", "oca", "enviopack"]) expect(featureRequires(k)).toEqual(["envios"]);
    expect(FEATURE_INFO.andreani?.needs).toMatch(/contrato/);
  });
});

describe("formulario de conexión", () => {
  it("cada logística con adaptador tiene guía; los secretos no van a la config", () => {
    for (const k of Object.keys(ADAPTERS)) expect(PROVIDER_GUIDES[k], k).toBeTruthy();
    const { config, secrets } = splitConnectionValues("andreani", {
      username: "u",
      password: "p",
      client_number: "CL1",
      contract_door: "400",
      ajeno: "x",
    });
    expect(secrets).toEqual({ username: "u", password: "p" });
    expect(config).toEqual({ client_number: "CL1", contract_door: "400" });
    // La base rechaza claves de config que parecen secretos: ninguna guía las usa como config.
    for (const g of Object.values(PROVIDER_GUIDES)) {
      for (const f of g.fields.filter((x) => !x.secret)) {
        expect(f.key, f.key).not.toMatch(/(password|passwd|clave|secret|token|api_?key|apikey)/i);
      }
    }
  });

  it("obligatorios: un secreto ya guardado cuenta como cargado", () => {
    expect(missingRequired("andreani", { client_number: "CL" }, [])).toEqual(["Usuario de la API", "Contraseña de la API"]);
    expect(missingRequired("andreani", { client_number: "CL" }, ["username", "password"])).toEqual([]);
  });
});

describe("formulario de envío", () => {
  const base = {
    store_id: "8f2a1c3e-0000-4000-8000-000000000001",
    source: "manual" as const,
    service_type: "door" as const,
    recipient: { name: "Ana Gómez", email: "" },
    destination: { street: "Alberdi", number: "3000", city: "CABA", province: "CABA", postal_code: "1406" },
    packages: [{ weight_kg: 1, length_cm: 10, width_cm: 10, height_cm: 10 }],
    declared_value: 1000,
  };

  it("valida dirección a domicilio, punto de retiro y origen", () => {
    expect(shipmentFormSchema.safeParse(base).success).toBe(true);
    expect(shipmentFormSchema.safeParse({ ...base, destination: { postal_code: "1406" } }).success).toBe(false);
    expect(shipmentFormSchema.safeParse({ ...base, service_type: "branch", destination: { postal_code: "1406" } }).success).toBe(false);
    expect(shipmentFormSchema.safeParse({ ...base, service_type: "branch", destination: { postal_code: "1406" }, pickup_point: { id: "15" } }).success).toBe(true);
    expect(shipmentFormSchema.safeParse({ ...base, source: "pos_sale" }).success).toBe(false);
    expect(shipmentFormSchema.safeParse({ ...base, destination: { ...base.destination, postal_code: "C1406ABC" } }).success).toBe(true);
    expect(shipmentFormSchema.safeParse({ ...base, destination: { ...base.destination, postal_code: "14" } }).success).toBe(false);
  });

  it("el payload lleva la clave de idempotencia y sólo se envía con cotización", () => {
    const form = shipmentFormSchema.parse(base);
    const quote = { provider_key: "andreani", service_type: "door" as const, service_code: "400", service_name: "A domicilio", cost: 5000 };
    const p = buildCreatePayload(form, { idempotencyKey: "envio:abc12345", quote, submit: true });
    expect(p).toMatchObject({ idempotency_key: "envio:abc12345", provider_key: "andreani", submit: true, service_code: "400" });
    expect(buildCreatePayload(form, { idempotencyKey: "envio:abc12345", quote: null, submit: true }).submit).toBe(false);
    expect((p.recipient as Record<string, unknown>).email).toBeUndefined();
  });

  it("mensajes de error humanos", () => {
    expect(shippingErrorMessage(new Error("feature_not_in_plan: envios"))).toMatch(/plan Pro/);
    expect(shippingErrorMessage(new Error("carrier_not_connected"))).toMatch(/Configuración > Envíos/);
    expect(shippingErrorMessage(new Error("create_uncertain"))).toMatch(/Revisá su panel/);
  });
});

describe("etiqueta ZPL a la cola de impresión del equipo (ADR-101)", () => {
  it("existe el tipo etiqueta_envio y el trabajo queda pendiente con los bytes del ZPL", () => {
    expect(PRINT_DOC_LABELS.etiqueta_envio).toBe("Etiqueta de envío");
    // Storage en memoria: Node 22+ trae un localStorage global que pisa el de jsdom.
    const mem = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, String(v)),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
      },
    });
    const pending = enqueueZplLabel("^XA^FDHola^FS^XZ", "Envío SIM1");
    expect(pending).toBe(1);
    const q = parseQueue(JSON.parse(window.localStorage.getItem("ninja-print-queue") ?? "[]"));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ doc: "etiqueta_envio", status: "pending", printerId: "simulator", label: "Envío SIM1" });
    expect(new TextDecoder().decode(fromBase64(q[0]!.payload))).toBe("^XA^FDHola^FS^XZ");
  });

  it("los caracteres no ASCII se reemplazan", () => {
    expect(Array.from(zplBytes("añ"))).toEqual([97, 63]);
  });
});
