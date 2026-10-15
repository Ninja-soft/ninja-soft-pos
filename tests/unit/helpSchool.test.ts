// Ayuda contextual, Escuela y checklist por rubro (F15 · H69, H71, H72 · ADR-086).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HELP_ARTICLES, HELP_SYNONYMS, getArticle } from "@/lib/help/content";
import {
  articlesForContext,
  expandQuery,
  normalize,
  relatedArticles,
  roleNoteFor,
  routeMatches,
  searchArticles,
  stem,
  tokenize,
} from "@/lib/help/search";
import { COURSES } from "@/lib/school/courses";
import { pendingLessons, quizComplete, scoreQuiz, sortCoursesForRole, toPublicCourse } from "@/lib/school/quiz";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import {
  buildActivationChecklist,
  checklistProfile,
  checklistProgress,
} from "@/lib/onboarding/activationChecklist";
import { getProfile } from "@/lib/profiles/businessProfiles";
import type { HelpRole } from "@/lib/help/types";

const ROOT = process.cwd();
const search = (q: string, role: HelpRole | null, pathname = "/dashboard") =>
  searchArticles(HELP_ARTICLES, q, { role, pathname, synonyms: HELP_SYNONYMS });
const top = (q: string, role: HelpRole | null, pathname?: string) => search(q, role, pathname)[0]?.article.id;

describe("contenido de la ayuda", () => {
  it("tiene al menos 25 artículos con ids únicos", () => {
    expect(HELP_ARTICLES.length).toBeGreaterThanOrEqual(25);
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("los relacionados existen y no se apuntan a sí mismos", () => {
    for (const a of HELP_ARTICLES) {
      for (const r of a.related) {
        expect(getArticle(r), `${a.id} -> ${r}`).not.toBeNull();
        expect(r).not.toBe(a.id);
      }
    }
  });

  it("las rutas apuntan a pantallas que existen", () => {
    const groups = readdirSync(join(ROOT, "app")).filter((d) => d.startsWith("("));
    for (const a of HELP_ARTICLES) {
      for (const r of a.routes) {
        const seg = r.split("/").filter(Boolean);
        const found = groups.some((g) => existsSync(join(ROOT, "app", g, ...seg)));
        expect(found, `${a.id}: ${r}`).toBe(true);
      }
    }
  });

  it("las features citadas tienen copy en featureInfo", () => {
    for (const a of HELP_ARTICLES) if (a.feature) expect(FEATURE_INFO[a.feature], `${a.id}: ${a.feature}`).toBeDefined();
  });

  it("sin em dash en ningún archivo de contenido", () => {
    const dir = join(ROOT, "content", "help");
    const files = [
      ...readdirSync(join(dir, "articles")).map((f) => join(dir, "articles", f)),
      join(dir, "courses.json"),
      join(dir, "synonyms.json"),
    ];
    for (const f of files) expect(readFileSync(f, "utf8").includes(String.fromCharCode(0x2014)), f).toBe(false);
  });

  it("cada nota por rol es para un rol que ve el artículo", () => {
    for (const a of HELP_ARTICLES) {
      for (const r of Object.keys(a.roleNotes)) expect(a.roles, `${a.id}: ${r}`).toContain(r);
    }
  });
});

describe("normalización y sinónimos", () => {
  it("saca tildes, signos y stopwords", () => {
    expect(normalize("¿Cómo ANULO la Venta?")).toBe("como anulo la venta");
    expect(tokenize("¿Cómo anulo una venta?")).toEqual(["anulo", "venta"]);
  });

  it("raíz simple para plurales", () => {
    expect(stem("ventas")).toBe("venta");
    expect(stem("devoluciones")).toBe("devolucion");
    expect(stem("sucursales")).toBe("sucursal");
  });

  it("expande por frase y por palabra suelta", () => {
    expect(expandQuery("cancelar venta", HELP_SYNONYMS)).toContain("anular");
    expect(expandQuery("fiado", HELP_SYNONYMS)).toContain("corriente");
    expect(expandQuery("xyz", HELP_SYNONYMS)).toEqual([]);
  });
});

describe("buscador", () => {
  it("criterio H72: un cajero en /pos busca 'anular venta' y ve la guía para su rol", () => {
    const hits = search("anular venta", "cashier", "/pos");
    expect(hits[0]?.article.id).toBe("pos-anular-venta");
    const note = roleNoteFor(hits[0]!.article, "cashier");
    expect(note).toMatch(/sólo ventas del día/);
  });

  it("encuentra por sinónimos y variantes", () => {
    expect(top("cancelar venta", "cashier")).toBe("pos-anular-venta");
    expect(top("devolución", "cashier")).toBe("pos-devoluciones");
    expect(top("devoluciones", "manager")).toBe("pos-devoluciones");
    expect(top("cerrar caja", "cashier")).toBe("caja-cerrar");
    expect(top("cierre de caja", "manager")).toBe("caja-cerrar");
    expect(top("arqueo", "cashier")).toBe("caja-arqueo");
    expect(top("cierre z", "owner")).toBe("caja-cierre-z");
    expect(top("fiado", "owner")).toBe("clientes-cuenta-corriente");
    expect(top("se cortó internet", "cashier")).toBe("pos-venta-offline");
    expect(top("importar excel", "owner")).toBe("productos-importar-excel");
    expect(top("caea", "owner")).toBe("arca-caea");
    expect(top("pasar a producción arca", "owner")).toBe("arca-homologacion-produccion");
    expect(top("2x1", "manager")).toBe("promociones");
    expect(top("invitar cajero", "owner")).toBe("usuarios-permisos");
  });

  it("no muestra artículos que no son para el rol", () => {
    expect(search("importar excel", "cashier").map((h) => h.article.id)).not.toContain("productos-importar-excel");
    expect(search("anular venta", "viewer").map((h) => h.article.id)).not.toContain("pos-anular-venta");
    expect(search("facturación arca", "cashier").map((h) => h.article.id)).not.toContain("arca-facturacion");
  });

  it("rol desconocido (cargando o staff) ve todo", () => {
    expect(search("importar excel", null).map((h) => h.article.id)).toContain("productos-importar-excel");
  });

  it("la pantalla actual suma puntos y se marca", () => {
    const hits = search("caja", "cashier", "/caja");
    expect(hits.find((h) => h.article.id === "caja-movimientos")?.here).toBe(true);
    expect(hits.find((h) => h.article.id === "pos-cobrar-venta")?.here ?? false).toBe(false);
  });

  it("consulta vacía o sin resultados", () => {
    expect(search("", "owner")).toEqual([]);
    expect(search("de la", "owner")).toEqual([]);
    expect(search("zzzzqqq", "owner")).toEqual([]);
  });

  it("respeta el límite", () => {
    expect(searchArticles(HELP_ARTICLES, "caja", { limit: 2, synonyms: HELP_SYNONYMS })).toHaveLength(2);
  });
});

describe("filtro por pantalla y rol", () => {
  it("routeMatches por prefijo de segmento", () => {
    expect(routeMatches("/caja", "/caja/monitor")).toBe(true);
    expect(routeMatches("/caja", "/cajas")).toBe(false);
    expect(routeMatches("/configuracion", "/configuracion?seccion=pagos")).toBe(true);
    expect(routeMatches("/pos", null)).toBe(false);
  });

  it("en /pos el cajero ve las guías del POS y no las de dueño", () => {
    const ids = articlesForContext(HELP_ARTICLES, "/pos", "cashier").map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["pos-cobrar-venta", "caja-abrir", "caja-cerrar", "pos-medios-de-pago"]));
    expect(ids).not.toContain("productos-importar-excel");
  });

  it("en /ventas aparece anular; solo lectura no lo ve", () => {
    expect(articlesForContext(HELP_ARTICLES, "/ventas", "cashier").map((a) => a.id)).toContain("pos-anular-venta");
    expect(articlesForContext(HELP_ARTICLES, "/ventas", "viewer").map((a) => a.id)).not.toContain("pos-anular-venta");
  });

  it("subrutas: /escuela/pos-basico muestra la guía de la Escuela", () => {
    expect(articlesForContext(HELP_ARTICLES, "/escuela/pos-basico", "cashier").map((a) => a.id)).toContain(
      "escuela-como-funciona",
    );
  });

  it("relacionados filtrados por rol", () => {
    const a = getArticle("productos-alta")!;
    expect(relatedArticles(a, HELP_ARTICLES, "cashier").map((x) => x.id)).not.toContain("productos-importar-excel");
    expect(relatedArticles(a, HELP_ARTICLES, "owner").map((x) => x.id)).toContain("productos-importar-excel");
  });
});

describe("Escuela: cursos y prueba", () => {
  it("las lecciones existen y las respuestas están en rango", () => {
    for (const c of COURSES) {
      for (const l of c.lessons) expect(getArticle(l), `${c.key}: ${l}`).not.toBeNull();
      const qids = c.quiz.map((q) => q.id);
      expect(new Set(qids).size).toBe(qids.length);
      for (const q of c.quiz) expect(q.answer).toBeLessThan(q.options.length);
    }
  });

  it("POS básico es para el cajero y da certificado", () => {
    const pos = COURSES.find((c) => c.key === "pos-basico")!;
    expect(pos.roles).toContain("cashier");
    expect(pos.certificate).toBe("POS básico");
    expect(pos.quiz.length).toBeGreaterThanOrEqual(3);
    expect(pos.quiz.length).toBeLessThanOrEqual(5);
  });

  it("puntaje: todo bien, redondeo y umbral", () => {
    const quiz = [
      { id: "q1", answer: 0 },
      { id: "q2", answer: 2 },
      { id: "q3", answer: 1 },
    ];
    expect(scoreQuiz(quiz, { q1: 0, q2: 2, q3: 1 }, 80)).toMatchObject({ score: 3, total: 3, pct: 100, passed: true });
    // 2 de 3 = 66,67 -> 67: aprueba con 66, no con 80.
    expect(scoreQuiz(quiz, { q1: 0, q2: 2, q3: 0 }, 66)).toMatchObject({ score: 2, pct: 67, passed: true });
    expect(scoreQuiz(quiz, { q1: 0, q2: 2, q3: 0 }, 80).passed).toBe(false);
  });

  it("puntaje: faltantes, no enteros y claves de más cuentan como incorrectas", () => {
    const quiz = [
      { id: "q1", answer: 1 },
      { id: "q2", answer: 1 },
    ];
    const r = scoreQuiz(quiz, { q1: 1.0000001, q3: 1 } as Record<string, number>, 50);
    expect(r.score).toBe(0);
    expect(r.results).toEqual([
      { id: "q1", correct: false },
      { id: "q2", correct: false },
    ]);
    expect(scoreQuiz([], {}, 50).passed).toBe(false);
  });

  it("4 de 5 aprueba POS básico (80%)", () => {
    const pos = COURSES.find((c) => c.key === "pos-basico")!;
    const answers = Object.fromEntries(pos.quiz.map((q) => [q.id, q.answer]));
    answers.q1 = (pos.quiz[0]!.answer + 1) % pos.quiz[0]!.options.length;
    expect(scoreQuiz(pos.quiz, answers, pos.passPct)).toMatchObject({ score: 4, pct: 80, passed: true });
  });

  it("prueba completa, lecciones pendientes y curso público sin respuestas", () => {
    const c = COURSES[0]!;
    expect(quizComplete(c.quiz, {})).toBe(false);
    expect(quizComplete(c.quiz, Object.fromEntries(c.quiz.map((q) => [q.id, 0])))).toBe(true);
    expect(quizComplete(c.quiz, Object.fromEntries(c.quiz.map((q) => [q.id, 99])))).toBe(false);
    expect(pendingLessons(c, [c.lessons[0]!])).toEqual(c.lessons.slice(1));
    const pub = toPublicCourse(c);
    expect(JSON.stringify(pub)).not.toMatch(/"answer"|"explain"/);
  });

  it("ordena primero los cursos del rol", () => {
    expect(sortCoursesForRole(COURSES, "cashier")[0]!.key).toBe("pos-basico");
    expect(sortCoursesForRole(COURSES, null).map((c) => c.key)).toEqual(COURSES.map((c) => c.key));
  });

  it("la migración siembra los mismos cursos y respuestas que content/help/courses.json", () => {
    const sql = readFileSync(join(ROOT, "supabase/migrations/20261108100100_escuela.sql"), "utf8");
    const m = sql.match(/\$courses\$\s*([\s\S]*?)\s*\$courses\$/);
    expect(m).not.toBeNull();
    const seeded = JSON.parse(m![1]!);
    const expected = COURSES.map((c) => ({
      key: c.key,
      version: c.version,
      title: c.title,
      roles: c.roles,
      lessons: c.lessons,
      passPct: c.passPct,
      certificate: c.certificate,
      quiz: c.quiz.map((q) => ({ id: q.id, answer: q.answer, explain: q.explain })),
    }));
    expect(seeded).toEqual(expected);
  });
});

describe("checklist de activación por rubro (H71)", () => {
  const all = { caja: true, agenda: true, escuela: true, facturacion_afip: true };
  const keys = (profile: string | null, features: Record<string, boolean> = all) =>
    buildActivationChecklist({ profile: getProfile(profile), features }).map((s) => s.key);

  it("pasos base en el orden de la puesta en marcha (ADR-150)", () => {
    expect(keys("kiosco")).toEqual([
      "marca",
      "ticket",
      "email",
      "pagos",
      "producto",
      "caja",
      "venta",
      "equipo",
      "arca",
      "escuela",
    ]);
  });

  it("gastronomía suma el salón; servicios la agenda; kiosco ninguno", () => {
    expect(keys("gastronomia")).toContain("mesas");
    expect(keys("gastronomia")).not.toContain("agenda");
    expect(keys("servicios")).toContain("agenda");
    expect(keys("kiosco")).not.toContain("mesas");
    expect(keys("kiosco")).not.toContain("agenda");
  });

  it("ARCA sólo si el plan la incluye; agenda y Escuela respetan el plan", () => {
    expect(keys("kiosco", { facturacion_afip: false })).not.toContain("arca");
    expect(keys("kiosco", {})).not.toContain("arca");
    expect(keys("servicios", { agenda: false })).not.toContain("agenda");
    expect(keys("kiosco", { escuela: false })).not.toContain("escuela");
  });

  it("sin perfil aplicado usa el sugerido por el rubro del alta", () => {
    expect(checklistProfile(null, "restaurante")?.key).toBe("gastronomia");
    expect(checklistProfile("servicios", "restaurante")?.key).toBe("servicios");
  });

  it("los pasos con ayuda apuntan a artículos existentes", () => {
    for (const s of buildActivationChecklist({ profile: getProfile("gastronomia"), features: all })) {
      if (s.helpId) expect(getArticle(s.helpId), s.key).not.toBeNull();
    }
    for (const s of buildActivationChecklist({ profile: getProfile("servicios"), features: all })) {
      if (s.helpId) expect(getArticle(s.helpId), s.key).not.toBeNull();
    }
  });

  it("progreso", () => {
    const steps = buildActivationChecklist({ profile: getProfile("kiosco"), features: {} });
    expect(checklistProgress(steps, {}).done).toBe(0);
    const allOn = Object.fromEntries(steps.map((s) => [s.key, true]));
    expect(checklistProgress(steps, allOn)).toMatchObject({ allDone: true, pct: 100 });
  });
});

describe("migraciones F15", () => {
  const files = [
    "20261108100000_ayuda_feedback.sql",
    "20261108100100_escuela.sql",
    "20261108100200_onboarding_activacion_rubro.sql",
  ].map((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));

  it("policies con (select current_tenant_id()) e internal_scope(), nunca is_internal()", () => {
    for (const sql of files) {
      const policies = sql.match(/create policy[\s\S]*?;/g) ?? [];
      for (const p of policies) {
        expect(p.replace(/\(select current_tenant_id\(\)\)/g, "")).not.toMatch(/current_tenant_id\(\)/);
        expect(p).not.toMatch(/is_internal\(\)/);
      }
    }
  });

  it("escuela es BASE y se marca en los cuatro planes", () => {
    const sql = files[1]!;
    expect(sql).toMatch(/\('escuela',[\s\S]*?'extras', true, \d+\)/);
    expect(sql).toMatch(/jsonb_build_object\('escuela', true\)/);
  });

  it("el progreso no se escribe por PostgREST y la prueba exige las lecciones", () => {
    const sql = files[1]!;
    expect(sql).toMatch(/revoke insert, update, delete on school_progress from anon, authenticated/);
    expect(sql).toMatch(/lessons_pending/);
    expect(sql).toMatch(/tenant_has_feature_for\(v_tenant, 'escuela'\)/);
  });
});
