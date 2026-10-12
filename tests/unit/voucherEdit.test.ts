import { describe, expect, it } from "vitest";
import {
  buildVoucherPatch,
  groupVoucherEdits,
  normalizeVoucherValue,
  validateVoucherValue,
  voucherDraftFrom,
  voucherEditAccess,
  voucherErrorMessage,
  type VoucherDraft,
} from "@/lib/reports/voucherEdit";
import { dayLongLabel, normalizeCardPayment } from "@/lib/reports/cardReconciliation";

const base: VoucherDraft = {
  lote: "12",
  cupon: "345",
  autorizacion: "A1B2",
  ultimos4: "1234",
  comercio: "111",
  cuotas: "",
};

describe("normalizeVoucherValue", () => {
  it("recorta, saca espacios en códigos y pasa la autorización a mayúsculas", () => {
    expect(normalizeVoucherValue("lote", "  00 12 ")).toBe("0012");
    expect(normalizeVoucherValue("autorizacion", " ab12 ")).toBe("AB12");
    expect(normalizeVoucherValue("comercio", "123 456")).toBe("123456");
  });
});

describe("validateVoucherValue", () => {
  it("últimos 4 tienen que ser exactamente 4 números", () => {
    expect(validateVoucherValue("ultimos4", "1234")).toBeNull();
    expect(validateVoucherValue("ultimos4", "123")).not.toBeNull();
    expect(validateVoucherValue("ultimos4", "12a4")).not.toBeNull();
  });
  it("lote, cupón y comercio son numéricos con tope", () => {
    expect(validateVoucherValue("lote", "0012")).toBeNull();
    expect(validateVoucherValue("lote", "12A")).not.toBeNull();
    expect(validateVoucherValue("lote", "12345678901")).not.toBeNull();
    expect(validateVoucherValue("cupon", "123456789012")).toBeNull();
    expect(validateVoucherValue("cupon", "1234567890123")).not.toBeNull();
    expect(validateVoucherValue("comercio", "12-34")).not.toBeNull();
  });
  it("autorización alfanumérica hasta 20", () => {
    expect(validateVoucherValue("autorizacion", "abc123")).toBeNull();
    expect(validateVoucherValue("autorizacion", "ab-12")).not.toBeNull();
    expect(validateVoucherValue("autorizacion", "A".repeat(21))).not.toBeNull();
  });
  it("cuotas entre 1 y 99", () => {
    expect(validateVoucherValue("cuotas", "6")).toBeNull();
    expect(validateVoucherValue("cuotas", "0")).not.toBeNull();
    expect(validateVoucherValue("cuotas", "100")).not.toBeNull();
  });
  it("vacío es válido (borra el dato)", () => {
    expect(validateVoucherValue("ultimos4", "   ")).toBeNull();
  });
});

describe("buildVoucherPatch", () => {
  it("manda sólo lo que cambia, normalizado", () => {
    const r = buildVoucherPatch(base, { ...base, lote: " 13 ", autorizacion: "a1b2" });
    expect(r.errors).toEqual({});
    expect(r.changed).toEqual(["lote"]);
    expect(r.patch).toEqual({ lote: "13" });
  });
  it("vaciar un campo viaja como null y cuotas como número", () => {
    const r = buildVoucherPatch(base, { ...base, comercio: "", cuotas: "3" });
    expect(r.patch).toEqual({ comercio: null, cuotas: 3 });
    expect(r.changed).toEqual(["comercio", "cuotas"]);
  });
  it("con errores no arma esos campos", () => {
    const r = buildVoucherPatch(base, { ...base, ultimos4: "12" });
    expect(r.errors.ultimos4).toBeTruthy();
    expect(r.patch).toEqual({});
  });
  it("sin cambios, patch vacío", () => {
    expect(buildVoucherPatch(base, { ...base }).changed).toEqual([]);
  });
});

describe("voucherDraftFrom", () => {
  it("toma las cuotas como texto", () => {
    expect(
      voucherDraftFrom({ lote: "1", cupon: "2", autorizacion: "3", ultimos4: "", comercio: "", installments: 6 }).cuotas,
    ).toBe("6");
  });
});

describe("voucherEditAccess", () => {
  const me = "u1";
  it("dueño y encargado editan todo, aunque esté conciliado", () => {
    expect(voucherEditAccess({ role: "owner", userId: me, shiftOpenedBy: "otro", reconciled: true })).toEqual({
      canEdit: true,
      asSupervisor: true,
    });
    expect(voucherEditAccess({ role: "manager", userId: me, shiftOpenedBy: null, reconciled: false }).canEdit).toBe(true);
  });
  it("el cajero sólo edita cobros de su turno y pendientes", () => {
    expect(voucherEditAccess({ role: "cashier", userId: me, shiftOpenedBy: me, reconciled: false })).toEqual({
      canEdit: true,
      asSupervisor: false,
    });
    expect(voucherEditAccess({ role: "cashier", userId: me, shiftOpenedBy: "otro", reconciled: false })).toEqual({
      canEdit: false,
      reason: "not_own_shift",
    });
    expect(voucherEditAccess({ role: "cashier", userId: me, shiftOpenedBy: me, reconciled: true })).toEqual({
      canEdit: false,
      reason: "reconciled",
    });
  });
  it("solo lectura nunca", () => {
    expect(voucherEditAccess({ role: "viewer", userId: me, shiftOpenedBy: me, reconciled: false }).canEdit).toBe(false);
  });
});

describe("groupVoucherEdits", () => {
  it("agrupa por cobro, más nueva primero, y filtra claves desconocidas", () => {
    const map = groupVoucherEdits([
      {
        id: "e1",
        payment_id: "p1",
        edited_at: "2026-10-10T10:00:00Z",
        edited_by_name: "Ana",
        changed_keys: ["lote", "otra"],
        before_data: { lote: "1" },
        after_data: { lote: "2" },
        was_reconciled: false,
        reason: null,
      },
      {
        id: "e2",
        payment_id: "p1",
        edited_at: "2026-10-11T10:00:00Z",
        edited_by_name: null,
        changed_keys: ["cuotas"],
        before_data: {},
        after_data: { cuotas: 3 },
        was_reconciled: true,
        reason: " corregido ",
      },
    ]);
    const list = map.get("p1")!;
    expect(list.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(list[0]!.editedBy).toBe("Usuario");
    expect(list[0]!.changes).toEqual([{ field: "cuotas", before: "", after: "3" }]);
    expect(list[0]!.reason).toBe("corregido");
    expect(list[1]!.changes).toEqual([{ field: "lote", before: "1", after: "2" }]);
  });
});

describe("voucherErrorMessage", () => {
  it("traduce los códigos de la RPC", () => {
    expect(voucherErrorMessage(new Error("not_own_shift"))).toMatch(/tus turnos/);
    expect(voucherErrorMessage({ message: "reconciled_locked" })).toMatch(/conciliado/);
    expect(voucherErrorMessage(new Error("invalid_value: lote"))).toMatch(/formato/);
  });
});

describe("cardReconciliation: turno y día largo", () => {
  it("toma quién abrió el turno de la venta", () => {
    const r = normalizeCardPayment({
      id: "p",
      method: "debit",
      amount: 10,
      reference: null,
      created_at: "2026-10-12T15:00:00Z",
      reconciled_at: null,
      card_voucher: {},
      sales: { number: 1, cash_shift: { opened_by: "u1" } },
    });
    expect(r?.shiftOpenedBy).toBe("u1");
  });
  it("dayLongLabel arma el día de la semana", () => {
    expect(dayLongLabel("2026-10-12")).toBe("Lunes 12/10/2026");
  });
});
