import { describe, expect, it } from "vitest";
import { naveRegistrationEmail, naveWebhookUrl } from "@/components/dashboard-team/payments/copy";

describe("mail de registro para Nave", () => {
  it("arma la URL del webhook con el host de Supabase", () => {
    expect(naveWebhookUrl("https://abc.supabase.co/")).toBe("https://abc.supabase.co/functions/v1/nave_webhook");
  });

  it("usa el nombre del negocio y pide URL, credenciales, pos_id y terminales", () => {
    const m = naveRegistrationEmail("Kiosco Ninja", "https://abc.supabase.co/functions/v1/nave_webhook");
    expect(m.to).toBe("integraciones@navenegocios.com");
    expect(m.subject).toBe("Registro de URL de notificaciones - Kiosco Ninja");
    expect(m.body).toContain("https://abc.supabase.co/functions/v1/nave_webhook");
    expect(m.body).toMatch(/sandbox/);
    expect(m.body).toMatch(/Client ID y Client Secret/);
    expect(m.body).toMatch(/pos_id/);
    expect(m.body).toMatch(/Nave Point/);
    expect(m.mailto.startsWith("mailto:integraciones@navenegocios.com?subject=")).toBe(true);
    expect(m.text).not.toContain(String.fromCharCode(0x2014));
  });

  it("sin nombre cae en un genérico", () => {
    expect(naveRegistrationEmail(null).subject).toBe("Registro de URL de notificaciones - mi negocio");
  });
});
