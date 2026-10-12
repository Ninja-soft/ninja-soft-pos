import { describe, expect, it } from "vitest";
import {
  cbuLabel,
  detectEntity,
  displayDataOf,
  formatCbu,
  formatCuit,
  initialsOf,
  isCvu,
  isValidAlias,
  isValidCbu,
  isValidCuit,
  resolveTransferConfig,
  toAccountRow,
  validateTransferAccount,
  type TransferAccount,
  type TransferAccountInput,
} from "@/lib/payments/transfer";
import { toSalePayments } from "@/modules/pos/api";
import { CONFIG_FIELDS, fieldAppliesTo, fieldType, resolveEffective } from "@/lib/config/inheritance";

// CBU / CVU con dígitos verificadores correctos (generados con el algoritmo
// del BCRA: bloque 1 pesos 7139713, bloque 2 pesos 3971397139713).
const CBU_NACION = "0110599520000012345678";
const CBU_GALICIA = "0070999000000045678901";
const CBU_MACRO = "2850590994000000123456";
const CVU_MP = "0000003110000123456781";

describe("CBU / CVU", () => {
  it("acepta CBU y CVU con sus dos dígitos verificadores", () => {
    for (const v of [CBU_NACION, CBU_GALICIA, CBU_MACRO, CVU_MP]) expect(isValidCbu(v), v).toBe(true);
  });

  it("rechaza un dígito verificador mal en cualquiera de los dos bloques", () => {
    const badBlock1 = `${CBU_NACION.slice(0, 7)}9${CBU_NACION.slice(8)}`;
    const badBlock2 = `${CBU_NACION.slice(0, 21)}0`;
    expect(isValidCbu(badBlock1)).toBe(false);
    expect(isValidCbu(badBlock2)).toBe(false);
  });

  it("rechaza largos distintos de 22 e ignora espacios", () => {
    expect(isValidCbu("0110599")).toBe(false);
    expect(isValidCbu(`${CBU_NACION}1`)).toBe(false);
    expect(isValidCbu(formatCbu(CBU_NACION))).toBe(true);
  });

  it("distingue CVU (000) de CBU", () => {
    expect(isCvu(CVU_MP)).toBe(true);
    expect(isCvu(CBU_NACION)).toBe(false);
    expect(cbuLabel(CVU_MP)).toBe("CVU");
    expect(cbuLabel(CBU_GALICIA)).toBe("CBU");
  });

  it("formatea en sus dos bloques", () => {
    expect(formatCbu(CBU_NACION)).toBe("01105995 20000012345678");
  });
});

describe("detección de la entidad por el prefijo", () => {
  it("CBU: código de entidad del BCRA (3 primeros dígitos)", () => {
    expect(detectEntity(CBU_NACION)?.slug).toBe("nacion");
    expect(detectEntity(CBU_GALICIA)?.slug).toBe("galicia");
    expect(detectEntity(CBU_MACRO)?.slug).toBe("macro");
    expect(detectEntity("072")?.slug).toBe("santander");
  });

  it("CVU: proveedor de pagos (dígitos 4 a 7)", () => {
    expect(detectEntity(CVU_MP)?.slug).toBe("mercado-pago");
  });

  it("sin datos suficientes o código desconocido: null", () => {
    expect(detectEntity("01")).toBeNull();
    expect(detectEntity("000")).toBeNull();
    expect(detectEntity("999")).toBeNull();
  });
});

describe("CUIT y alias", () => {
  it("valida el dígito verificador del CUIT", () => {
    expect(isValidCuit("20123456786")).toBe(true);
    expect(isValidCuit("20-12345678-6")).toBe(true);
    expect(isValidCuit("20123456787")).toBe(false);
    expect(formatCuit("30712345671")).toBe("30-71234567-1");
  });

  it("alias de 6 a 20 caracteres con letras, números, punto y guion", () => {
    expect(isValidAlias("mi.negocio.mp")).toBe(true);
    expect(isValidAlias("corto")).toBe(false);
    expect(isValidAlias("con espacio")).toBe(false);
    expect(isValidAlias("a".repeat(21))).toBe(false);
  });
});

const input = (p: Partial<TransferAccountInput> = {}): TransferAccountInput => ({
  bank_slug: "galicia",
  bank_name: "",
  holder_name: "Kiosco Ninja SRL",
  cuit: "30-71234567-1",
  cbu: CBU_GALICIA,
  alias: "kiosco.ninja",
  account_type: "cuenta_corriente",
  currency: "ARS",
  note: "",
  ...p,
});

describe("formulario de la cuenta", () => {
  it("una cuenta completa no tiene errores y se normaliza", () => {
    expect(validateTransferAccount(input())).toEqual({});
    const row = toAccountRow(input({ cbu: formatCbu(CBU_GALICIA), alias: " kiosco.ninja " }));
    expect(row.cbu).toBe(CBU_GALICIA);
    expect(row.cuit).toBe("30712345671");
    expect(row.alias).toBe("kiosco.ninja");
    expect(row.bank_slug).toBe("galicia");
    expect(row.bank_name.length).toBeGreaterThan(0);
  });

  it("pide CBU o alias, titular y entidad", () => {
    const e = validateTransferAccount(input({ cbu: "", alias: "", holder_name: " ", bank_slug: null, bank_name: "" }));
    expect(e.cbu).toBeTruthy();
    expect(e.holder_name).toBeTruthy();
    expect(e.bank_name).toBeTruthy();
  });

  it("alcanza con el alias (sin CBU)", () => {
    expect(validateTransferAccount(input({ cbu: "" }))).toEqual({});
  });

  it("marca CBU, CUIT y alias inválidos", () => {
    const e = validateTransferAccount(input({ cbu: "0110599520000012345670", cuit: "20123456787", alias: "x" }));
    expect(e.cbu).toMatch(/no es válido/);
    expect(e.cuit).toBeTruthy();
    expect(e.alias).toBeTruthy();
  });

  it("entidad 'Otra' con nombre propio", () => {
    const row = toAccountRow(input({ bank_slug: null, bank_name: "Cooperativa del Pueblo" }));
    expect(row.bank_slug).toBeNull();
    expect(row.bank_name).toBe("Cooperativa del Pueblo");
  });

  it("monograma con las iniciales sin 'Banco'", () => {
    expect(initialsOf("Banco de la Provincia")).toBe("PR");
    expect(initialsOf("Cooperativa del Pueblo")).toBe("CP");
  });
});

const acc = (id: string, p: Partial<TransferAccount> = {}): TransferAccount => ({
  id,
  bank_slug: "galicia",
  bank_name: "Banco Galicia",
  custom_logo_path: null,
  custom_logo_url: null,
  holder_name: "Kiosco",
  cuit: null,
  cbu: CBU_GALICIA,
  alias: null,
  account_type: "caja_ahorro",
  currency: "ARS",
  note: null,
  is_default: false,
  is_active: true,
  sort: 0,
  deleted_at: null,
  ...p,
});

describe("cuentas por sucursal o caja (espejo de _transfer_effective)", () => {
  const A = acc("a", { sort: 1 });
  const B = acc("b", { is_default: true, sort: 2 });
  const C = acc("c", { sort: 3, is_active: false });
  const D = acc("d", { sort: 0, deleted_at: "2026-10-01" });

  it("sólo cuentas activas y vivas, la por defecto primero", () => {
    const cfg = resolveTransferConfig([A, B, C, D], {}, true);
    expect(cfg.accounts.map((x) => x.id)).toEqual(["b", "a"]);
    expect(cfg.defaultAccountId).toBe("b");
    expect(cfg.showScreen).toBe(true);
    expect(cfg.requireReference).toBe(false);
  });

  it("la sucursal oculta cuentas y elige su por defecto", () => {
    const cfg = resolveTransferConfig([A, B], { transfer_accounts: { b: false }, transfer_default_account: "a" }, true);
    expect(cfg.accounts.map((x) => x.id)).toEqual(["a"]);
    expect(cfg.defaultAccountId).toBe("a");
  });

  it("una cuenta por defecto oculta no se usa", () => {
    const cfg = resolveTransferConfig([A, B], { transfer_accounts: { a: false }, transfer_default_account: "a" }, true);
    expect(cfg.defaultAccountId).toBe("b");
  });

  it("sin transferencia_multicuenta: sólo la por defecto y sin elecciones por sucursal", () => {
    const cfg = resolveTransferConfig([A, B], { transfer_accounts: { b: false }, transfer_default_account: "a" }, false);
    expect(cfg.accounts.map((x) => x.id)).toEqual(["b"]);
    expect(cfg.defaultAccountId).toBe("b");
  });

  it("la caja puede omitir la pantalla y el n° de operación se hereda", () => {
    const cfg = resolveTransferConfig([B], { transfer_show_screen: false, transfer_require_reference: true }, true);
    expect(cfg.showScreen).toBe(false);
    expect(cfg.requireReference).toBe(true);
  });

  it("sin cuentas: nada por defecto", () => {
    expect(resolveTransferConfig([], {}, true)).toMatchObject({ accounts: [], defaultAccountId: null });
  });

  it("los datos para la pantalla del cliente no llevan ids internos", () => {
    const d = displayDataOf(acc("x", { bank_slug: null, bank_name: "Otra", custom_logo_url: "https://x/logo.png", cbu: CVU_MP }));
    expect(d).not.toHaveProperty("id");
    expect(d.logoUrl).toBe("https://x/logo.png");
    expect(d.cbuLabel).toBe("CVU");
  });
});

describe("herencia: campos de transferencia (ADR-049 + ADR-055)", () => {
  it("la caja sólo pisa mostrar u omitir la pantalla", () => {
    expect(fieldType("payment_method", "register", "transfer_show_screen")).toBe("bool");
    expect(fieldType("payment_method", "register", "transfer_accounts")).toBeNull();
    expect(fieldType("payment_method", "register", "transfer_require_reference")).toBeNull();
    expect(fieldType("payment_method", "store", "transfer_accounts")).toBe("map_any");
    expect(fieldType("payment_method", "store_group", "transfer_default_account")).toBe("text");
  });

  it("los campos de transferencia sólo aplican al medio 'transfer'", () => {
    const defs = CONFIG_FIELDS.payment_method.filter((f) => f.key.startsWith("transfer_"));
    expect(defs).toHaveLength(4);
    for (const d of defs) {
      expect(fieldAppliesTo(d, "transfer")).toBe(true);
      expect(fieldAppliesTo(d, "cash")).toBe(false);
    }
  });

  it("el mapa de cuentas se mezcla por clave entre grupo, sucursal y caja", () => {
    const eff = resolveEffective(
      "payment_method",
      "transfer",
      { transfer_accounts: {}, transfer_show_screen: true },
      [
        { scope: "store_group", scope_id: "g", domain: "payment_method", domain_key: "transfer", patch: { transfer_accounts: { a: false } } },
        { scope: "store", scope_id: "s", domain: "payment_method", domain_key: "transfer", patch: { transfer_accounts: { b: false } } },
        { scope: "register", scope_id: "r", domain: "payment_method", domain_key: "transfer", patch: { transfer_show_screen: false } },
      ],
      { groupId: "g", storeId: "s", registerId: "r", multiStore: true, multiRegister: true },
    );
    expect(eff.value.transfer_accounts).toEqual({ a: false, b: false });
    expect(eff.value.transfer_show_screen).toBe(false);
  });
});

describe("pago de la venta", () => {
  it("la cuenta viaja en card_voucher para el trigger y no sale el campo transfer", () => {
    const [p] = toSalePayments([{ method: "transfer", amount: 100, reference: "123", transfer: { accountId: "acc-1" } }]);
    expect(p).toEqual({
      method: "transfer",
      amount: 100,
      reference: "123",
      card_voucher: { transfer_pos: true, transfer_account_id: "acc-1" },
    });
  });

  it("sin cuenta elegida, sólo la marca del POS", () => {
    const [p] = toSalePayments([{ method: "transfer", amount: 50, transfer: { accountId: null } }]);
    expect(p).toEqual({ method: "transfer", amount: 50, card_voucher: { transfer_pos: true } });
  });

  it("los otros medios pasan igual", () => {
    const pays = [{ method: "cash" as const, amount: 10 }];
    expect(toSalePayments(pays)).toEqual(pays);
  });
});
