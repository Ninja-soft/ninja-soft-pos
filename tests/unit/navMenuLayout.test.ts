import { describe, expect, it } from "vitest";
import {
  HIDDEN_ID,
  TOP_GROUP,
  applyVisible,
  isDefault,
  mergeLayout,
  moveGroupBy,
  moveItemBy,
  placeGroup,
  sanitizeLayout,
  toggleHidden,
  visibleLayout,
  type MenuDefaults,
  type MenuLayout,
} from "@/lib/nav/menuLayout";

const DEFAULTS: MenuDefaults = {
  groups: [
    { id: TOP_GROUP, items: ["/panel", "/escuela"] },
    { id: "op", items: ["/pos", "/caja", "/ventas"] },
    { id: "cat", items: ["/productos", "/etiquetas"] },
  ],
};

const L = (groups: [string, string[]][], hidden: string[] = []): MenuLayout => ({
  v: 1,
  groups: groups.map(([id, items]) => ({ id, items })),
  hidden,
});

describe("mergeLayout", () => {
  it("sin nada guardado devuelve el menú por defecto", () => {
    const m = mergeLayout(DEFAULTS, null);
    expect(m.groups).toEqual(DEFAULTS.groups);
    expect(m.hidden).toEqual([]);
    expect(isDefault(m, DEFAULTS)).toBe(true);
  });

  it("respeta el orden guardado de grupos, ítems y ocultos", () => {
    const saved = L(
      [
        [TOP_GROUP, ["/escuela", "/panel"]],
        ["cat", ["/etiquetas", "/productos", "/caja"]],
        ["op", ["/ventas", "/pos"]],
      ],
      [],
    );
    const m = mergeLayout(DEFAULTS, saved);
    expect(m.groups.map((g) => g.id)).toEqual([TOP_GROUP, "cat", "op"]);
    expect(m.groups[1]!.items).toEqual(["/etiquetas", "/productos", "/caja"]);
    expect(m.groups[2]!.items).toEqual(["/ventas", "/pos"]);
  });

  it("descarta ítems y grupos que ya no existen y los duplicados", () => {
    const saved = L([
      ["op", ["/viejo", "/caja", "/caja", "/pos"]],
      ["borrado", ["/ventas"]],
    ], ["/pos", "/otro-viejo"]);
    const m = mergeLayout(DEFAULTS, saved);
    expect(m.groups.find((g) => g.id === "borrado")).toBeUndefined();
    const op = m.groups.find((g) => g.id === "op")!;
    // /ventas venía de un grupo borrado: vuelve a Operación detrás de /caja.
    expect(op.items).toEqual(["/caja", "/ventas", "/pos"]);
    expect(m.hidden).toEqual([]);
    // Cada ítem del menú actual aparece una sola vez.
    const all = [...m.groups.flatMap((g) => g.items), ...m.hidden];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(DEFAULTS.groups.flatMap((g) => g.items).sort());
  });

  it("un ítem nuevo aparece en su grupo, después de su hermano anterior", () => {
    // Guardado con una versión que no tenía /caja; el usuario ordenó al revés.
    const saved = L([[TOP_GROUP, ["/panel", "/escuela"]], ["op", ["/ventas", "/pos"]], ["cat", ["/productos", "/etiquetas"]]]);
    const m = mergeLayout(DEFAULTS, saved);
    expect(m.groups.find((g) => g.id === "op")!.items).toEqual(["/ventas", "/pos", "/caja"]);
  });

  it("un ítem nuevo sin hermano anterior presente va antes del siguiente", () => {
    const saved = L([["op", ["/ventas", "/caja"]]]);
    const m = mergeLayout(DEFAULTS, saved);
    expect(m.groups.find((g) => g.id === "op")!.items).toEqual(["/ventas", "/pos", "/caja"]);
  });

  it("un grupo nuevo aparece en su lugar por defecto y el grupo sin título queda primero", () => {
    const saved = L([["cat", ["/productos", "/etiquetas"]], [TOP_GROUP, ["/panel", "/escuela"]]]);
    const m = mergeLayout(DEFAULTS, saved);
    // op no estaba guardado: va después del grupo que lo precede por defecto.
    expect(m.groups.map((g) => g.id)).toEqual([TOP_GROUP, "op", "cat"]);
    expect(m.groups[0]!.id).toBe(TOP_GROUP);
    expect(m.groups.find((g) => g.id === "op")!.items).toEqual(["/pos", "/caja", "/ventas"]);
  });

  it("lo oculto sigue oculto aunque cambie el menú", () => {
    const saved = L([["op", ["/pos", "/ventas"]]], ["/caja"]);
    const m = mergeLayout(DEFAULTS, saved);
    expect(m.hidden).toEqual(["/caja"]);
    expect(m.groups.find((g) => g.id === "op")!.items).toEqual(["/pos", "/ventas"]);
  });

  it("sanitizeLayout rechaza basura", () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout("x")).toBeNull();
    expect(sanitizeLayout({ groups: "no" })).toBeNull();
    const s = sanitizeLayout({ groups: [{ id: "op", items: ["/pos", 3, null] }, { nope: 1 }], hidden: [1, "/caja"] });
    expect(s).toEqual({ v: 1, groups: [{ id: "op", items: ["/pos"] }], hidden: ["/caja"] });
  });
});

describe("permisos y plan: visibleLayout + applyVisible", () => {
  const canSee = (id: string) => id !== "/caja" && id !== "/panel";

  it("los ítems que el usuario no puede ver no se muestran aunque estén en el orden", () => {
    const full = mergeLayout(DEFAULTS, L([["op", ["/caja", "/ventas", "/pos"]]], ["/panel"]));
    const v = visibleLayout(full, canSee);
    expect(v.groups.find((g) => g.id === "op")!.items).toEqual(["/ventas", "/pos"]);
    expect(v.hidden).toEqual([]);
    expect(v.groups.find((g) => g.id === TOP_GROUP)!.items).toEqual(["/escuela"]);
  });

  it("editar lo visible no pierde ni mueve de grupo a los invisibles", () => {
    const full = mergeLayout(DEFAULTS, null); // op: pos, caja, ventas
    const v = visibleLayout(full, canSee); // op: pos, ventas
    // El usuario pasa /ventas arriba y /pos a Ocultos.
    const edited: MenuLayout = {
      ...v,
      groups: v.groups.map((g) => (g.id === "op" ? { ...g, items: ["/ventas"] } : g)),
      hidden: ["/pos"],
    };
    const next = applyVisible(full, edited, canSee);
    const op = next.groups.find((g) => g.id === "op")!.items;
    // /caja (invisible) sigue en Operación; su ancla (/pos) se fue, queda al final.
    expect(op).toEqual(["/ventas", "/caja"]);
    expect(next.hidden).toEqual(["/pos"]);
    // /panel (invisible) sigue primero en el grupo sin título.
    expect(next.groups.find((g) => g.id === TOP_GROUP)!.items).toEqual(["/panel", "/escuela"]);
  });

  it("un invisible conserva su lugar detrás del visible que tenía adelante", () => {
    const full = mergeLayout(DEFAULTS, null);
    const v = visibleLayout(full, canSee);
    const edited: MenuLayout = { ...v, groups: v.groups.map((g) => (g.id === "op" ? { ...g, items: ["/pos", "/ventas"] } : g)) };
    expect(applyVisible(full, edited, canSee).groups.find((g) => g.id === "op")!.items).toEqual([
      "/pos",
      "/caja",
      "/ventas",
    ]);
  });
});

describe("movimientos", () => {
  const base = mergeLayout(DEFAULTS, null);

  it("moveItemBy mueve dentro del grupo y cruza al vecino en los bordes", () => {
    let l = moveItemBy(base, "/caja", -1);
    expect(l.groups[1]!.items).toEqual(["/caja", "/pos", "/ventas"]);
    l = moveItemBy(l, "/caja", -1); // pasa al final del grupo de arriba
    expect(l.groups[0]!.items).toEqual(["/panel", "/escuela", "/caja"]);
    expect(l.groups[1]!.items).toEqual(["/pos", "/ventas"]);
  });

  it("moveItemBy entra a Ocultos desde el último grupo y no pasa del final", () => {
    let l = moveItemBy(base, "/etiquetas", 1);
    expect(l.hidden).toEqual(["/etiquetas"]);
    expect(moveItemBy(l, "/etiquetas", 1)).toBe(l);
    expect(moveItemBy(base, "/panel", -1)).toBe(base);
    l = moveItemBy(l, "/etiquetas", -1);
    expect(l.groups[2]!.items).toEqual(["/productos", "/etiquetas"]);
  });

  it("toggleHidden oculta y devuelve el ítem a su grupo por defecto", () => {
    const h = toggleHidden(base, "/pos", DEFAULTS);
    expect(h.hidden).toEqual(["/pos"]);
    const back = toggleHidden(h, "/pos", DEFAULTS);
    expect(back.hidden).toEqual([]);
    expect(back.groups[1]!.items).toEqual(["/caja", "/ventas", "/pos"]);
  });

  it("los grupos con título se reordenan pero nunca pasan arriba del grupo sin título", () => {
    expect(moveGroupBy(base, "cat", -1).groups.map((g) => g.id)).toEqual([TOP_GROUP, "cat", "op"]);
    expect(moveGroupBy(base, "op", -1)).toBe(base);
    expect(moveGroupBy(base, TOP_GROUP, 1)).toBe(base);
    expect(placeGroup(base, "cat", 0).groups.map((g) => g.id)).toEqual([TOP_GROUP, "cat", "op"]);
  });

  it("HIDDEN_ID no choca con ids de grupo", () => {
    expect(DEFAULTS.groups.some((g) => g.id === HIDDEN_ID)).toBe(false);
  });
});
