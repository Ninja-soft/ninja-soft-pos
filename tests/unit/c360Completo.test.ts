// ADR-169: reglas puras de la ficha 360 completa (adjuntos y tipos nuevos de
// la línea de tiempo).
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentErrorMessage,
  attachmentPath,
  checkAttachment,
  formatBytes,
  safeFileName,
} from "@/lib/customers/attachments";
import { KIND_LABEL, TIMELINE_KINDS, describeItem, showsAmount, type TimelineItem } from "@/lib/customers/c360";

const item = (p: Partial<TimelineItem>): TimelineItem => ({
  kind: "change",
  sub: "UPDATE",
  id: "x",
  at: "2026-10-19T12:00:00Z",
  amount: 0,
  ref: null,
  status: "ok",
  store_id: null,
  store_name: null,
  sale_id: null,
  detail: null,
  ...p,
});

describe("adjuntos de la ficha", () => {
  it("acepta PDF, imágenes, Word, Excel y texto hasta 10 MB", () => {
    expect(checkAttachment({ name: "c.pdf", size: 1000, type: "application/pdf" })).toEqual({ ok: true });
    expect(checkAttachment({ name: "f.jpg", size: ATTACHMENT_MAX_BYTES, type: "image/jpeg" })).toEqual({ ok: true });
    expect(checkAttachment({ name: "f.jpg", size: ATTACHMENT_MAX_BYTES + 1, type: "image/jpeg" }).ok).toBe(false);
    expect(checkAttachment({ name: "x.exe", size: 10, type: "application/x-msdownload" }).ok).toBe(false);
    expect(checkAttachment({ name: "v.pdf", size: 0, type: "application/pdf" }).ok).toBe(false);
  });

  it("arma una ruta segura negocio/cliente/uuid-nombre", () => {
    expect(safeFileName("Constancia de AFIP (José).pdf")).toBe("Constancia-de-AFIP-Jose.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileName("///")).toBe("archivo");
    expect(attachmentPath("t1", "c1", "u1", "DNI frente.jpg")).toBe("t1/c1/u1-DNI-frente.jpg");
  });

  it("muestra tamaños y errores en español", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(attachmentErrorMessage(new Error("attachment_limit"))).toMatch(/100 adjuntos/);
    expect(attachmentErrorMessage(new Error("feature_not_in_plan: clientes_360"))).toMatch(/plan Pro/);
    expect(attachmentErrorMessage(new Error("algo raro"))).toMatch(/Probá de nuevo/);
  });
});

describe("línea de tiempo: cambios y adjuntos", () => {
  it("suma los tipos nuevos con su rótulo", () => {
    expect(TIMELINE_KINDS).toEqual(expect.arrayContaining(["change", "attachment"]));
    expect(KIND_LABEL.change).toBe("Cambios de la ficha");
    expect(KIND_LABEL.attachment).toBe("Adjuntos");
  });

  it("describe quién cambió la ficha y no muestra monto", () => {
    const d = describeItem(item({ ref: "Ana" }));
    expect(d).toMatchObject({ title: "Ficha editada", detail: "Por Ana", tone: "info" });
    expect(describeItem(item({ sub: "INSERT" })).title).toBe("Cliente dado de alta");
    expect(describeItem(item({ sub: "customer_fiscal_verified" })).title).toMatch(/padrón/);
    expect(showsAmount(item({}))).toBe(false);
  });

  it("describe los adjuntos y su baja", () => {
    const a = describeItem(item({ kind: "attachment", sub: "active", detail: "contrato.pdf · Firmado", ref: "Ana" }));
    expect(a).toMatchObject({ title: "Archivo adjuntado", detail: "contrato.pdf · Firmado · Por Ana" });
    expect(describeItem(item({ kind: "attachment", sub: "deleted" })).title).toBe("Adjunto quitado");
    expect(showsAmount(item({ kind: "attachment" }))).toBe(false);
  });
});
