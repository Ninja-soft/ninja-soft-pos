import { describe, expect, it } from "vitest";
import {
  CHEQUE_STATUSES,
  actionLabel,
  canChequeTransition,
  chequeMovementSign,
  daysToPayment,
  manualActions,
} from "@/lib/treasury/cheques";

describe("máquina de estados de cheques", () => {
  it("terceros en cartera: se entregan, depositan o rechazan", () => {
    expect(canChequeTransition("third_party", "en_cartera", "entregado")).toBe(true);
    expect(canChequeTransition("third_party", "en_cartera", "depositado")).toBe(true);
    expect(canChequeTransition("third_party", "en_cartera", "rechazado")).toBe(true);
    expect(canChequeTransition("third_party", "en_cartera", "anulado")).toBe(false);
  });

  it("un cheque propio nunca está en cartera", () => {
    for (const to of CHEQUE_STATUSES) expect(canChequeTransition("own", "en_cartera", to)).toBe(false);
  });

  it("entregado: terceros vuelve a cartera, propio se anula (anulación de la OP)", () => {
    expect(canChequeTransition("third_party", "entregado", "en_cartera")).toBe(true);
    expect(canChequeTransition("third_party", "entregado", "anulado")).toBe(false);
    expect(canChequeTransition("own", "entregado", "anulado")).toBe(true);
    expect(canChequeTransition("own", "entregado", "en_cartera")).toBe(false);
    expect(canChequeTransition("own", "entregado", "depositado")).toBe(true);
  });

  it("depositado sólo puede rechazarse; rechazado y anulado son finales", () => {
    expect(canChequeTransition("third_party", "depositado", "rechazado")).toBe(true);
    expect(canChequeTransition("third_party", "depositado", "en_cartera")).toBe(false);
    for (const to of CHEQUE_STATUSES) {
      expect(canChequeTransition("third_party", "rechazado", to)).toBe(false);
      expect(canChequeTransition("own", "anulado", to)).toBe(false);
    }
  });

  it("acciones manuales disponibles en Tesorería", () => {
    expect(manualActions("third_party", "en_cartera")).toEqual(["depositado", "rechazado"]);
    expect(manualActions("own", "entregado")).toEqual(["depositado", "rechazado"]);
    expect(manualActions("own", "depositado")).toEqual(["rechazado"]);
    expect(manualActions("own", "anulado")).toEqual([]);
    expect(actionLabel("own", "depositado")).toBe("Marcar debitado");
    expect(actionLabel("third_party", "depositado")).toBe("Depositar");
  });

  it("efecto en la cuenta: depósito suma, débito resta y el rechazo revierte", () => {
    expect(chequeMovementSign("third_party", "en_cartera", "depositado")).toBe(1);
    expect(chequeMovementSign("own", "entregado", "depositado")).toBe(-1);
    expect(chequeMovementSign("third_party", "depositado", "rechazado")).toBe(-1);
    expect(chequeMovementSign("own", "depositado", "rechazado")).toBe(1);
    expect(chequeMovementSign("third_party", "en_cartera", "rechazado")).toBe(0);
    expect(chequeMovementSign("third_party", "rechazado", "depositado")).toBe(0);
  });

  it("días hasta la fecha de pago", () => {
    expect(daysToPayment("2026-10-20", "2026-10-12")).toBe(8);
    expect(daysToPayment("2026-10-01", "2026-10-12")).toBe(-11);
  });
});
