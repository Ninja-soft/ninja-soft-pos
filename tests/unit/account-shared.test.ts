import { describe, it, expect } from "vitest";
import { fmtDate, waLink, whatsappDebtMessage } from "@/components/account/shared";
import { accountErrorMessage } from "@/modules/customers/account";

describe("helpers de cuenta corriente (UI)", () => {
  it("waLink normaliza números argentinos locales", () => {
    expect(waLink("11 1234-5678", "hola")).toBe("https://wa.me/5491112345678?text=hola");
    expect(waLink("+54 9 11 1234 5678", "a b")).toBe("https://wa.me/5491112345678?text=a%20b");
  });

  it("mensaje de deuda con y sin vencido", () => {
    expect(whatsappDebtMessage({ name: "Ana", balance: "$ 100" })).toContain("Tu saldo de cuenta corriente es $ 100.");
    const m = whatsappDebtMessage({ name: "Ana", balance: "$ 100", overdue: "$ 50", oldestDue: "10/10/2026" });
    expect(m).toContain("$ 50 vencido desde el 10/10/2026");
    expect(m).not.toContain("—");
  });

  it("fmtDate sin zona horaria", () => {
    expect(fmtDate("2026-11-10")).toBe("10/11/2026");
    expect(fmtDate(null)).toBe("");
  });

  it("traduce los códigos de error de las RPC", () => {
    expect(accountErrorMessage(new Error("account_overdue_blocked"))).toMatch(/bloqueada/);
    expect(accountErrorMessage(new Error("feature_not_in_plan: cc_punitorios"))).toMatch(/punitorios/);
    expect(accountErrorMessage(new Error("algo raro"))).toBe("algo raro");
  });
});
