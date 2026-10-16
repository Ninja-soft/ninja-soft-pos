import { describe, it, expect } from "vitest";
import {
  collectAuditRefs,
  entityLabel,
  fieldLabel,
  formatAuditValue,
  formatDateAR,
  formatDateTimeAR,
  presentAuditEvent,
  sameValue,
  type NameLookup,
} from "@/lib/audit/present";

const CAT = "11111111-1111-4111-8111-111111111111";
const CAT2 = "22222222-2222-4222-8222-222222222222";
const BRAND = "33333333-3333-4333-8333-333333333333";
const STORE = "44444444-4444-4444-8444-444444444444";
const TENANT = "55555555-5555-4555-8555-555555555555";

const NAME_MAP: Record<string, string> = {
  [`category:${CAT}`]: "Almacén",
    [`category:${CAT2}`]: "Bebidas",
    [`brand:${BRAND}`]: "Gallo",
    [`store:${STORE}`]: "Centro",
};
const names: NameLookup = (kind, id) => NAME_MAP[`${kind}:${id}`];

const productBefore = {
  id: "p1",
  tenant_id: TENANT,
  name: "Arroz 1 kg",
  price: 1500,
  cost: "900.00",
  allow_negative: null,
  cost_fx_date: null,
  category_id: CAT,
  brand_id: BRAND,
  description: "",
  tags: [],
  updated_at: "2026-10-14T10:00:00Z",
};

describe("diff de auditoría", () => {
  it("sólo muestra cambios reales: null, vacío y ausente son lo mismo", () => {
    const p = presentAuditEvent(
      {
        entity_type: "products",
        action: "UPDATE",
        before_data: productBefore,
        after_data: {
          ...productBefore,
          price: 1800,
          cost: 900, // "900.00" y 900 son el mismo número
          allow_negative: undefined,
          description: null,
          tags: null,
          category_id: CAT2,
          updated_at: "2026-10-15T10:00:00Z",
        },
      },
      names,
    );
    expect(p.mode).toBe("changes");
    const fields = p.sections.flatMap((s) => s.fields);
    expect(fields.map((f) => f.key).sort()).toEqual(["category_id", "price"]);
    expect(p.fieldCount).toBe(2);
    const price = fields.find((f) => f.key === "price")!;
    expect(price.label).toBe("Precio de venta");
    expect(price.before).toBe(formatAuditValue("price", 1500));
    expect(price.after).toMatch(/1\.800,00/);
    const cat = fields.find((f) => f.key === "category_id")!;
    expect(cat).toMatchObject({ label: "Categoría", before: "Almacén", after: "Bebidas" });
  });

  it("agrupa por sección en orden fijo", () => {
    const p = presentAuditEvent(
      {
        entity_type: "products",
        action: "UPDATE",
        before_data: { name: "A", price: 1, stock_min: 2, is_active: true },
        after_data: { name: "B", price: 2, stock_min: 3, is_active: true },
      },
      names,
    );
    expect(p.sections.map((s) => s.title)).toEqual(["Datos generales", "Precios y montos", "Stock"]);
  });

  it("oculta ids técnicos, tenant_id y timestamps; resuelve los ids con nombre", () => {
    const p = presentAuditEvent({
      entity_type: "products",
      action: "INSERT",
      before_data: null,
      after_data: { id: "x", tenant_id: TENANT, created_at: "2026-10-15T10:00:00Z", intent_id: CAT, foo_id: CAT, name: "Yerba", store_id: STORE },
    }, names);
    const keys = p.sections.flatMap((s) => s.fields).map((f) => f.key);
    expect(keys).toEqual(["name", "store_id"]);
    expect(p.sections.find((s) => s.key === "ubicacion")!.fields[0]!.after).toBe("Centro");
  });

  it("un id sin nombre resuelto muestra el id corto", () => {
    expect(formatAuditValue("brand_id", BRAND)).toBe("#33333333");
  });

  it("compara objetos anidados por dentro", () => {
    const p = presentAuditEvent({
      entity_type: "plans",
      action: "UPDATE",
      before_data: { limits: { modules: { garantias: false, pos: true } } },
      after_data: { limits: { modules: { garantias: true, pos: true } } },
    });
    const f = p.sections.flatMap((s) => s.fields);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: "limits.modules.garantias", label: "Límites › Funciones › Garantias", before: "No", after: "Sí" });
  });

  it("sameValue", () => {
    expect(sameValue(null, "")).toBe(true);
    expect(sameValue(undefined, [])).toBe(true);
    expect(sameValue({}, null)).toBe(true);
    expect(sameValue("10.50", 10.5)).toBe(true);
    expect(sameValue({ a: 1, b: null }, { a: 1 })).toBe(true);
    expect(sameValue("2026-10-15T13:00:00+00:00", "2026-10-15T13:00:00.000Z")).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(false, null)).toBe(false);
  });
});

describe("formateo", () => {
  it("moneda, centavos, dólares y porcentajes", () => {
    expect(formatAuditValue("price", 1234.5)).toMatch(/\$\s?1\.234,50/);
    expect(formatAuditValue("amount_cents", 150000)).toMatch(/\$\s?1\.500,00/);
    expect(formatAuditValue("cost_usd", 12)).toMatch(/US\$\s?12,00/);
    expect(formatAuditValue("tax_rate", 21)).toBe("21 %");
    expect(formatAuditValue("markup_pct", "35.5")).toBe("35,5 %");
  });
  it("booleanos, vacíos y enumeraciones", () => {
    expect(formatAuditValue("allow_negative", true)).toBe("Sí");
    expect(formatAuditValue("track_stock", false)).toBe("No");
    expect(formatAuditValue("description", "")).toBeNull();
    expect(formatAuditValue("description", null)).toBeNull();
    expect(formatAuditValue("ticket_mode", "ticket")).toBe("Sólo ticket");
    expect(formatAuditValue("environment", "produccion")).toBe("Real");
    expect(formatAuditValue("role", "cashier")).toBe("Cajero");
    expect(formatAuditValue("tags", ["oferta", "nuevo"])).toBe("oferta, nuevo");
  });
  it("fechas argentinas", () => {
    expect(formatDateAR("2026-10-15")).toBe("15/10/2026");
    expect(formatAuditValue("cost_fx_date", "2026-01-02")).toBe("02/01/2026");
    // 13:30 UTC = 10:30 en Buenos Aires.
    expect(formatDateTimeAR("2026-10-15T13:30:00Z")).toBe("15/10/2026 10:30");
    expect(formatAuditValue("deleted_at", "2026-10-15T13:30:00Z")).toBe("15/10/2026 10:30");
  });
  it("etiquetas en español con respaldo humanizado", () => {
    expect(fieldLabel("allow_negative")).toBe("Permite vender sin stock");
    expect(fieldLabel("cost_fx_date")).toBe("Fecha de la cotización");
    expect(fieldLabel("algo_nuevo")).toBe("Algo nuevo");
    expect(entityLabel("tabla_rara")).toBe("Tabla rara");
  });
});

describe("títulos", () => {
  it("CRUD con sujeto y género", () => {
    expect(presentAuditEvent({ entity_type: "products", action: "UPDATE", before_data: { name: "Arroz 1 kg" }, after_data: { name: "Arroz 1 kg", price: 2 } }).title).toBe(
      "Producto editado: Arroz 1 kg",
    );
    expect(presentAuditEvent({ entity_type: "stores", action: "INSERT", before_data: null, after_data: { name: "Norte" } }).title).toBe("Sucursal creada: Norte");
    expect(presentAuditEvent({ entity_type: "customers", action: "delete", before_data: { name: "Ana" }, after_data: null }).title).toBe("Cliente eliminado: Ana");
    expect(presentAuditEvent({ entity_type: "sales", action: "INSERT", before_data: null, after_data: { sale_number: 42 } }).title).toBe("Venta creada: N° 42");
  });
  it("baja lógica, restauración y desactivación", () => {
    const t = (b: object, a: object) => presentAuditEvent({ entity_type: "categories", action: "UPDATE", before_data: b, after_data: a }).headline;
    expect(t({ deleted_at: null }, { deleted_at: "2026-10-15T10:00:00Z" })).toBe("Categoría dada de baja");
    expect(t({ deleted_at: "2026-10-15T10:00:00Z" }, { deleted_at: null })).toBe("Categoría restaurada");
    expect(t({ is_active: true }, { is_active: false })).toBe("Categoría desactivada");
  });
  it("acciones con nombre", () => {
    const sale = presentAuditEvent({
      entity_type: "sales",
      action: "sale_ticket_only",
      before_data: null,
      after_data: { intent_id: CAT, customer_id: null, total: 5000, cbte_letter: "B" },
    });
    expect(sale.title).toBe("Venta con sólo ticket (sin factura)");
    expect(sale.mode).toBe("snapshot");
    expect(sale.tone).toBe("warning");
    expect(sale.sections.flatMap((s) => s.fields).map((f) => f.key).sort()).toEqual(["cbte_letter", "total"]);

    const arca = presentAuditEvent({
      entity_type: "arca_settings",
      action: "arca_ticket_mode_changed",
      before_data: { ticket_mode: "factura" },
      after_data: { ticket_mode: "preguntar" },
    });
    expect(arca.title).toBe("Comprobante por defecto cambiado");
    expect(arca.sections[0]!.fields[0]).toMatchObject({ label: "Comprobante por defecto", before: "Factura", after: "Preguntar en cada venta" });

    expect(presentAuditEvent({ entity_type: "tenant_users", action: "member_profile_updated", before_data: null, after_data: { full_name: "Juan" } }).title).toBe(
      "Perfil del usuario editado: Juan",
    );
  });
  it("acciones <sustantivo>_<verbo> y respaldo humanizado", () => {
    expect(presentAuditEvent({ entity_type: "x", action: "staff_expense_created", before_data: null, after_data: null }).title).toBe("Gasto del personal creado");
    expect(presentAuditEvent({ entity_type: "x", action: "payment_fee_rule_deleted", before_data: null, after_data: null }).title).toBe(
      "Regla de comisión de cobro eliminada",
    );
    const raw = presentAuditEvent({ entity_type: "tabla_nueva", action: "UPDATE", before_data: { a: 1 }, after_data: { a: 2 } });
    expect(raw.title).toBe("Tabla nueva editado");
    expect(presentAuditEvent({ entity_type: "x", action: "algo_muy_raro", before_data: null, after_data: null })).toMatchObject({
      title: "Algo muy raro",
      mode: "none",
    });
  });
});

describe("referencias en lote", () => {
  it("junta ids por tipo sin repetir", () => {
    const refs = collectAuditRefs([
      { entity_type: "products", action: "UPDATE", before_data: { category_id: CAT, brand_id: BRAND }, after_data: { category_id: CAT2, brand_id: BRAND } },
      { entity_type: "categories", action: "UPDATE", before_data: { parent_id: CAT }, after_data: { parent_id: null } },
      { entity_type: "tenant_users", action: "UPDATE", before_data: null, after_data: { allowed_branch_ids: [STORE], tenant_id: TENANT, sku: "no-uuid" } },
    ]);
    expect(refs).toEqual({ category: [CAT, CAT2], brand: [BRAND], store: [STORE] });
  });
});
