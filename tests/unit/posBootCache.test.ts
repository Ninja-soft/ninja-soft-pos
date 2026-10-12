import { describe, expect, it } from "vitest";
import {
  POS_BOOT_STORAGE_KEY,
  effectivePreset,
  posBootKey,
  posBootScope,
  readPosBoot,
  reconcile,
  sameValue,
  writePosBoot,
  type PosBootSnap,
} from "@/lib/pos/bootCache";
import { PRESET_DEFAULTS, resolveLayout } from "@/lib/pos/layout";

function memStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  let writes = 0;
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes++;
      data.set(k, v);
    },
    get writes() {
      return writes;
    },
  };
}

function snap(over: Partial<PosBootSnap> = {}): PosBootSnap {
  return {
    layout: resolveLayout({ preset: "boutique" }),
    dining: false,
    usingOwn: false,
    location: { full: "Centro · Caja 1", short: "Centro · C1", color: "#ff0000", pickable: true },
    shiftOpen: true,
    pinned: [{ id: "cash", group: "cash", label: "Efectivo", logo: null }],
    freeSale: true,
    quickSale: false,
    ...over,
  };
}

describe("posBootKey / posBootScope", () => {
  it("arma la clave por negocio, usuario y caja", () => {
    expect(posBootKey("t1", "u1", "r1")).toBe("t1.u1.r1");
    expect(posBootKey("t1", "u1", null)).toBe("t1.u1.-");
    expect(posBootKey(null, "u1", "r1")).toBeNull();
    expect(posBootScope("t1", "u1")).toBe("t1.u1.");
    expect(posBootScope("t1", null)).toBeNull();
  });
});

describe("readPosBoot / writePosBoot", () => {
  it("sin storage o vacío no hay foto", () => {
    expect(readPosBoot(null, "t.u.r")).toBeNull();
    expect(readPosBoot(memStorage(), "t.u.r")).toBeNull();
  });

  it("guarda y lee por clave exacta", () => {
    const st = memStorage();
    expect(writePosBoot(st, "t.u.r1", snap())).toBe(true);
    expect(readPosBoot(st, "t.u.r1")?.layout.preset).toBe("boutique");
  });

  it("sin clave (todavía no se sabe la caja) devuelve la última usada", () => {
    const st = memStorage();
    writePosBoot(st, "t.u.r1", snap(), 1);
    writePosBoot(st, "t.u.r2", snap({ layout: resolveLayout({ preset: "caja_rapida" }) }), 2);
    expect(readPosBoot(st, null)?.layout.preset).toBe("caja_rapida");
    // Caja nueva sin foto propia: la última del mismo usuario.
    expect(readPosBoot(st, "t.u.r3", "t.u.")?.layout.preset).toBe("caja_rapida");
  });

  it("descarta la última si es de otro usuario o negocio", () => {
    const st = memStorage();
    writePosBoot(st, "t.u.r1", snap());
    expect(readPosBoot(st, null, "t.otro.")).toBeNull();
    expect(readPosBoot(st, "t.otro.r1", "t.otro.")).toBeNull();
  });

  it("no reescribe si la foto no cambió", () => {
    const st = memStorage();
    writePosBoot(st, "t.u.r1", snap());
    const before = st.writes;
    expect(writePosBoot(st, "t.u.r1", snap())).toBe(false);
    expect(st.writes).toBe(before);
    expect(writePosBoot(st, "t.u.r1", snap({ shiftOpen: false }))).toBe(true);
  });

  it("ignora JSON roto o fotos inválidas", () => {
    expect(readPosBoot(memStorage({ [POS_BOOT_STORAGE_KEY]: "{no json" }), "k")).toBeNull();
    const bad = JSON.stringify({ last: "k", entries: { k: { at: 1, snap: { layout: { preset: "nada" } } } } });
    expect(readPosBoot(memStorage({ [POS_BOOT_STORAGE_KEY]: bad }), "k")).toBeNull();
  });

  it("un storage que tira (modo privado) no rompe", () => {
    const st = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPosBoot(st, "k")).toBeNull();
    expect(writePosBoot(st, "k", snap())).toBe(false);
  });

  it("poda a las 8 más recientes", () => {
    const st = memStorage();
    for (let i = 0; i < 10; i++) writePosBoot(st, `t.u.r${i}`, snap(), i);
    const file = JSON.parse(st.getItem(POS_BOOT_STORAGE_KEY)!);
    expect(Object.keys(file.entries)).toHaveLength(8);
    expect(file.entries["t.u.r0"]).toBeUndefined();
    expect(file.last).toBe("t.u.r9");
  });
});

describe("reconcile", () => {
  it("mantiene la referencia si el valor del servidor es igual", () => {
    const cached = resolveLayout({ preset: "boutique" });
    const server = JSON.parse(JSON.stringify(cached));
    expect(reconcile(cached, server)).toBe(cached);
  });

  it("toma el nuevo si es distinto", () => {
    const cached = resolveLayout({ preset: "boutique" });
    const server = resolveLayout({ preset: "boutique", accent: "mint" });
    expect(reconcile(cached, server)).toBe(server);
    expect(reconcile(null, server)).toBe(server);
  });

  it("sameValue ignora el orden de claves y los undefined", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: null }, { a: undefined })).toBe(false);
  });
});

describe("effectivePreset", () => {
  it("Salón sin modo gastronómico cae a Mostrador", () => {
    const salon = PRESET_DEFAULTS.salon;
    expect(effectivePreset(salon, false).preset).toBe("mostrador");
    expect(effectivePreset(salon, true)).toBe(salon);
    expect(effectivePreset(salon, undefined)).toBe(salon);
  });
});
