import { describe, it, expect } from "vitest";
import { ACCOUNT_EMAIL_PREVIEWS, accountReminderEmail } from "@/lib/email/accountTemplates";

describe("vista previa de emails de cuenta corriente", () => {
  it("incluye recordatorio (antes y vencido) y estado de cuenta", () => {
    expect(ACCOUNT_EMAIL_PREVIEWS.map((p) => p.key)).toEqual([
      "account_reminder:before",
      "account_reminder:after",
      "account_statement",
    ]);
    for (const p of ACCOUNT_EMAIL_PREVIEWS) {
      const m = p.render();
      expect(m.subject).toContain("Almacén Don Pepe");
      expect(m.html).toContain("Enviado con NinjaPos");
      expect(m.html).not.toContain("—");
    }
  });

  it("escapa el nombre del cliente", () => {
    const m = accountReminderEmail(
      { name: "Kiosco", accent: "#111827" },
      { name: "<b>x</b>", kind: "after", days: 1, due: "2026-10-10", amount: 10, balance: 10 },
    );
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).toContain("hace 1 día)");
  });
});
