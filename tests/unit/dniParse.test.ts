import { describe, it, expect } from "vitest";
import { parseDni } from "@/lib/customers/dniParse";

describe("parseDni", () => {
  it("parsea el formato típico del DNI tarjeta (8 campos separados por @)", () => {
    // nro trámite @ apellido @ nombre @ sexo @ dni @ ejemplar @ nac @ emisión
    const raw =
      "00123456789@PEREZ@JUAN CARLOS@M@30123456@A@15/06/1985@20/03/2015";
    const r = parseDni(raw);
    expect(r).not.toBeNull();
    expect(r!.apellido).toBe("Perez");
    expect(r!.nombre).toBe("Juan Carlos");
    expect(r!.nombreCompleto).toBe("Juan Carlos Perez");
    expect(r!.sexo).toBe("M");
    expect(r!.dni).toBe("30123456");
    expect(r!.fechaNac).toBe("1985-06-15");
  });

  it("capitaliza apellido y nombre en mayúsculas, respeta acentos", () => {
    const raw = "01100200300@GÓMEZ DÍAZ@MARÍA JOSÉ@F@27888999@B@02/12/1990@01/01/2018";
    const r = parseDni(raw);
    expect(r!.apellido).toBe("Gómez Díaz");
    expect(r!.nombre).toBe("María José");
    expect(r!.nombreCompleto).toBe("María José Gómez Díaz");
    expect(r!.sexo).toBe("F");
  });

  it("saca ceros a la izquierda del número de DNI", () => {
    const raw = "00100200300@LOPEZ@ANA@F@00027888999@A@02/12/1990@01/01/2018";
    const r = parseDni(raw);
    expect(r!.dni).toBe("27888999");
  });

  it("soporta sexo X (no binario) del DNI nuevo", () => {
    const raw = "00100200300@SOSA@ALEX@X@31222333@A@10/10/1995@10/10/2020";
    const r = parseDni(raw);
    expect(r!.sexo).toBe("X");
  });

  it("normaliza la fecha con guiones a ISO", () => {
    const raw = "00100200300@RUIZ@PEDRO@M@28111222@A@05-03-1980@01-01-2015";
    const r = parseDni(raw);
    expect(r!.fechaNac).toBe("1980-03-05");
  });

  it("acepta DNI sin fecha de emisión ni nacimiento (variante corta de 5 campos)", () => {
    const raw = "00100200300@FERNANDEZ@LAURA@F@26999888";
    const r = parseDni(raw);
    expect(r).not.toBeNull();
    expect(r!.dni).toBe("26999888");
    expect(r!.fechaNac).toBeNull();
  });

  it("tolera espacios sobrantes alrededor de los campos", () => {
    const raw = " 00100200300 @ PEREZ @ JUAN @ M @ 30123456 @ A @ 15/06/1985 @ 20/03/2015 ";
    const r = parseDni(raw);
    expect(r!.apellido).toBe("Perez");
    expect(r!.dni).toBe("30123456");
    expect(r!.fechaNac).toBe("1985-06-15");
  });

  it("acepta separadores por salto de línea o tab (algunos lectores)", () => {
    const raw = "00100200300\tPEREZ\tJUAN\tM\t30123456\tA\t15/06/1985\t20/03/2015";
    const r = parseDni(raw);
    expect(r).not.toBeNull();
    expect(r!.apellido).toBe("Perez");
    expect(r!.dni).toBe("30123456");
  });

  it("ignora una fecha de nacimiento inválida sin romper", () => {
    const raw = "00100200300@PEREZ@JUAN@M@30123456@A@99/99/9999@20/03/2015";
    const r = parseDni(raw);
    expect(r).not.toBeNull();
    expect(r!.fechaNac).toBeNull();
  });

  // --- No debe romper ni dar falsos positivos con basura ---

  it("devuelve null con string vacío", () => {
    expect(parseDni("")).toBeNull();
  });

  it("devuelve null con un EAN-13 (código de producto)", () => {
    expect(parseDni("7790001001234")).toBeNull();
  });

  it("devuelve null con texto cualquiera", () => {
    expect(parseDni("hola mundo")).toBeNull();
    expect(parseDni("foo@bar@baz")).toBeNull();
  });

  it("devuelve null si falta el sexo válido", () => {
    const raw = "00100200300@PEREZ@JUAN@Z@30123456@A@15/06/1985@20/03/2015";
    expect(parseDni(raw)).toBeNull();
  });

  it("devuelve null si el DNI no tiene 7-9 dígitos", () => {
    const raw = "00100200300@PEREZ@JUAN@M@123@A@15/06/1985@20/03/2015";
    expect(parseDni(raw)).toBeNull();
  });

  it("devuelve null si el apellido o nombre no tienen letras", () => {
    const raw = "00100200300@1234@5678@M@30123456@A@15/06/1985@20/03/2015";
    expect(parseDni(raw)).toBeNull();
  });

  it("no rompe con un QR/URL", () => {
    expect(parseDni("https://example.com/foo?x=1@2")).toBeNull();
  });
});
