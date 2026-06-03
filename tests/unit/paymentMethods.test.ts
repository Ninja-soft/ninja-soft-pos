import { describe, it, expect } from "vitest";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";

describe("PAYMENT_METHOD_LABELS", () => {
  it("incluye vale y cuenta corriente", () => {
    expect(PAYMENT_METHOD_LABELS.store_credit).toBe("Vale");
    expect(PAYMENT_METHOD_LABELS.account).toBe("Cuenta corriente");
  });
  it("mapea los medios base", () => {
    expect(PAYMENT_METHOD_LABELS.cash).toBe("Efectivo");
    expect(PAYMENT_METHOD_LABELS.qr).toBe("QR");
  });
});
