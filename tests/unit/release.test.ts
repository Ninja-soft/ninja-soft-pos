// scripts/release.mjs (OPS-53 · ADR-193): versión por deploy, corte del
// CHANGELOG y registro de lo que aplicó cada deploy.
import { describe, expect, it } from "vitest";
import {
  addedMigrations,
  affectedFunctions,
  assertNextVersion,
  bumpPackageJson,
  changelogAnchor,
  changelogSection,
  cutChangelog,
  extractFlags,
  functionStatus,
  groupBlocks,
  migrationStatus,
  parseCommitSubject,
  parseDeployMerge,
  parseImports,
  parseNameStatus,
  parseSemver,
  releaseNotes,
  removedFunctions,
  renderRecord,
} from "@/scripts/release.mjs";

const CHANGELOG = `# Changelog

---

## [Unreleased]

> Nota de cómo se versiona.

### Added

- Cosa nueva (ABC-1).

### Fixed

- Bug (ABC-2).

---

## [0.1.0] - 2026-01-15

Primer commit.

---

## Plantilla

\`\`\`markdown
## [X.Y.Z] - YYYY-MM-DD
\`\`\`
`;

describe("versiones", () => {
  it("parseSemver acepta sólo X.Y.Z", () => {
    expect(parseSemver("0.2.0")).toEqual([0, 2, 0]);
    expect(parseSemver("10.0.31")).toEqual([10, 0, 31]);
    for (const bad of ["0.2", "v0.2.0", "0.2.0-rc.1", "01.2.3", "", "abc"]) expect(parseSemver(bad)).toBeNull();
  });

  it("assertNextVersion rechaza no-semver y versiones que no suben", () => {
    expect(assertNextVersion("0.1.0", "0.2.0")).toBe("0.2.0");
    expect(assertNextVersion("0.2.0", "0.2.1")).toBe("0.2.1");
    expect(assertNextVersion("0.2.9", "0.2.10")).toBe("0.2.10");
    expect(() => assertNextVersion("0.2.0", "0.2.0")).toThrow(/mayor/);
    expect(() => assertNextVersion("0.2.1", "0.2.0")).toThrow(/mayor/);
    expect(() => assertNextVersion("0.10.0", "0.9.9")).toThrow(/mayor/);
    expect(() => assertNextVersion("0.1.0", "0.2")).toThrow(/inválida/);
    expect(() => assertNextVersion("0.1.0", "v0.2.0")).toThrow(/inválida/);
  });

  it("bumpPackageJson cambia sólo el campo version", () => {
    const pkg = `{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "y": "1.0.0" }\n}\n`;
    const out = bumpPackageJson(pkg, "0.2.0");
    expect(out).toBe(pkg.replace(`"version": "0.1.0"`, `"version": "0.2.0"`));
    expect(() => bumpPackageJson(pkg, "0.1.0")).toThrow();
  });
});

describe("CHANGELOG", () => {
  it("corta Unreleased en la versión y deja Unreleased vacío con su nota", () => {
    const out = cutChangelog(CHANGELOG, "0.2.0", "2026-11-18");
    expect(out).toContain("## [Unreleased]\n\n> Nota de cómo se versiona.\n\n---\n\n## [0.2.0] - 2026-11-18\n\n### Added\n\n- Cosa nueva (ABC-1).");
    expect(out.indexOf("## [0.2.0]")).toBeLessThan(out.indexOf("## [0.1.0]"));
    expect(out).toContain("- Bug (ABC-2).\n\n---\n\n## [0.1.0] - 2026-01-15");
    expect(out).toContain("## [X.Y.Z] - YYYY-MM-DD");
    expect(changelogSection(out, "0.2.0")).toBe("### Added\n\n- Cosa nueva (ABC-1).\n\n### Fixed\n\n- Bug (ABC-2).");
    expect(changelogSection(out, "0.1.0")).toBe("Primer commit.");
    expect(changelogSection(out, "9.9.9")).toBeNull();
  });

  it("rechaza Unreleased vacío (o sólo con la nota), versión repetida y fecha inválida", () => {
    const once = cutChangelog(CHANGELOG, "0.2.0", "2026-11-18");
    expect(() => cutChangelog(once, "0.2.1", "2026-11-19")).toThrow(/vacío/);
    expect(() => cutChangelog(CHANGELOG, "0.1.0", "2026-11-18")).toThrow(/ya tiene/);
    expect(() => cutChangelog(CHANGELOG, "0.2.0", "18/11/2026")).toThrow(/fecha/);
    expect(() => cutChangelog("# Changelog\n", "0.2.0", "2026-11-18")).toThrow(/Unreleased/);
  });

  it("el segundo corte mueve sólo lo nuevo", () => {
    const once = cutChangelog(CHANGELOG, "0.2.0", "2026-11-18");
    const withNew = once.replace("> Nota de cómo se versiona.\n", "> Nota de cómo se versiona.\n\n### Fixed\n\n- Otro (ABC-3).\n");
    const twice = cutChangelog(withNew, "0.2.1", "2026-11-19");
    expect(changelogSection(twice, "0.2.1")).toBe("### Fixed\n\n- Otro (ABC-3).");
    expect(changelogSection(twice, "0.2.0")).toContain("Cosa nueva");
  });

  it("notas del release: completas si entran, compactas si no", () => {
    const body =
      "> Estado.\n\n### Added\n\n- **Algo nuevo (ABC-1).** Detalle largo del cambio.\n  sigue el detalle\n\n### Fixed\n\n- **Bug (ABC-2).** Más detalle.";
    expect(releaseNotes(body, { record: "docs/releases/v0.2.0.md" })).toBe(
      `${body}\n\n---\n\nRegistro del deploy (PRs, migraciones, Edge Functions): \`docs/releases/v0.2.0.md\`.\n`,
    );
    const small = releaseNotes(body, { record: null, changelogUrl: "https://x/CHANGELOG.md#020", limit: 50 });
    expect(small).toContain("> Estado.\n\n### Added\n\n- **Algo nuevo (ABC-1).**\n\n### Fixed\n\n- **Bug (ABC-2).**");
    expect(small).not.toContain("Detalle largo");
    expect(small).not.toContain("sigue el detalle");
    expect(small).toContain("[CHANGELOG.md](https://x/CHANGELOG.md#020)");
  });

  it("ancla de GitHub de la sección", () => {
    expect(changelogAnchor("0.2.0", "2026-11-18")).toBe("#020---2026-11-18");
  });
});

describe("commits", () => {
  it("PR, tarea y título del squash", () => {
    expect(parseCommitSubject("fix(modo): modo_webhook no aplica estados; 503 para reintento (SEC-63) (#599)")).toEqual({
      pr: 599,
      task: "SEC-63",
      type: "fix",
      scope: "modo",
      title: "fix(modo): modo_webhook no aplica estados; 503 para reintento",
    });
    expect(parseCommitSubject("docs(db): historial igual al repo (SEC-02, ADR-183) (#555)").task).toBe("SEC-02, ADR-183");
    expect(parseCommitSubject("fix(arca): fecha real (FIS-001) (#590)").task).toBe("FIS-001");
    expect(parseCommitSubject("feat: algo (SEC-07/SEC-08) (#1)").task).toBe("SEC-07, SEC-08");
    const noTask = parseCommitSubject("chore: limpiar (sin tarea) (#12)");
    expect(noTask.pr).toBe(12);
    expect(noTask.task).toBeNull();
    expect(noTask.title).toBe("chore: limpiar (sin tarea)");
    const direct = parseCommitSubject("hotfix directo en main");
    expect(direct.pr).toBeNull();
    expect(direct.type).toBeNull();
  });

  it("reconoce el merge de deploy de una tanda", () => {
    expect(parseDeployMerge("Merge pull request #587 from Ninja-soft/tanda/2026-11-17-4")).toEqual({ pr: 587, branch: "tanda/2026-11-17-4" });
    expect(parseDeployMerge("Merge pull request #12 from Ninja-soft/feature/x")).toBeNull();
    expect(parseDeployMerge("feat: algo (#3)")).toBeNull();
  });

  it("agrupa el first-parent por deploy y deja el bloque final pendiente", () => {
    const fp = [
      { sha: "m1", parents: ["base", "t1"], date: "2026-11-16", subject: "Merge pull request #10 from Org/tanda/2026-11-16-1" },
      { sha: "h1", parents: ["m1"], date: "2026-11-16", subject: "fix: hotfix directo (OPS-1) (#11)" },
      { sha: "m2", parents: ["h1", "t2"], date: "2026-11-17", subject: "Merge pull request #12 from Org/tanda/2026-11-17-1" },
      { sha: "c3", parents: ["m2"], date: "2026-11-17", subject: "feat: c (ABC-3) (#13)" },
    ];
    const inner: Record<string, { sha: string; parents: string[]; date: string; subject: string }[]> = {
      t1: [{ sha: "a1", parents: ["base"], date: "2026-11-16", subject: "feat: a (ABC-1) (#8)" }],
      t2: [{ sha: "b1", parents: ["h1"], date: "2026-11-17", subject: "feat: b (ABC-2) (#9)" }],
    };
    const blocks = groupBlocks("base", fp, (_a: string, b: string) => inner[b] ?? []);
    expect(blocks.map((b) => [b.kind, b.branch, b.base, b.end, b.commits.map((c) => c.sha)])).toEqual([
      ["deploy", "tanda/2026-11-16-1", "base", "m1", ["a1"]],
      ["deploy", "tanda/2026-11-17-1", "m1", "m2", ["h1", "b1"]],
      ["pending", null, "m2", "c3", ["c3"]],
    ]);
    expect(blocks[1]?.pr).toBe(12);
    expect(groupBlocks("x", [], () => [])).toEqual([]);
  });
});

describe("migraciones y Edges", () => {
  it("migraciones agregadas del name-status", () => {
    const changes = parseNameStatus(
      [
        "A\tsupabase/migrations/20270129100000_prd62_coupon_base.sql",
        "M\tsupabase/migrations/20270101100000_vieja.sql",
        "A\tsupabase/migrations/README.md",
        "R100\tsupabase/x.sql\tsupabase/migrations/20270128100000_fis001_offline_cbte_date.sql",
        "A\tlib/x.ts",
      ].join("\n"),
    );
    expect(addedMigrations(changes)).toEqual(["20270128100000_fis001_offline_cbte_date.sql", "20270129100000_prd62_coupon_base.sql"]);
  });

  it("parseImports ve import/export estáticos y dinámicos, no comentarios de texto", () => {
    const src = `import { a } from "../_shared/a.ts";
import type { T } from './types.ts';
export { b } from "../_shared/b.ts";
import "../_shared/side.ts";
import {
  c,
  d,
} from "../_shared/multi.ts";
const m = await import("../_shared/lazy.ts");
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
const s = "from '../_shared/no.ts'";`;
    expect(parseImports(src).sort()).toEqual(
      ["../_shared/a.ts", "./types.ts", "../_shared/b.ts", "../_shared/side.ts", "../_shared/multi.ts", "../_shared/lazy.ts", "https://esm.sh/@supabase/supabase-js@2.47.10"].sort(),
    );
  });

  it("Edges afectadas: carpeta propia o _shared alcanzado (transitivo)", () => {
    const R = "supabase/functions";
    const files: Record<string, string> = {
      [`${R}/mp_webhook/index.ts`]: `import { h } from "../_shared/mpWebhookHandlers.ts";`,
      [`${R}/mp_qr/index.ts`]: `import { s } from "../_shared/paymentSecrets.ts";`,
      [`${R}/arca_wsfe/index.ts`]: `import { w } from "./worker.ts";`,
      [`${R}/arca_wsfe/worker.ts`]: `import { c } from "../_shared/arca/client.ts";`,
      [`${R}/geo/index.ts`]: `import { g } from "../_shared/geocode.ts";`,
      [`${R}/_shared/mpWebhookHandlers.ts`]: `import { s } from "./paymentSecrets.ts";`,
      [`${R}/_shared/paymentSecrets.ts`]: ``,
      [`${R}/_shared/arca/client.ts`]: `import { x } from "./comprobante.ts";`,
      [`${R}/_shared/arca/comprobante.ts`]: ``,
      [`${R}/_shared/geocode.ts`]: ``,
    };
    const changed = [`${R}/_shared/paymentSecrets.ts`, `${R}/_shared/arca/comprobante.ts`, `${R}/mp_qr/index.ts`, "lib/otro.ts"];
    expect(affectedFunctions(files, changed)).toEqual([
      { slug: "arca_wsfe", own: false, via: [`${R}/_shared/arca/comprobante.ts`] },
      { slug: "mp_qr", own: true, via: [`${R}/_shared/paymentSecrets.ts`] },
      { slug: "mp_webhook", own: false, via: [`${R}/_shared/paymentSecrets.ts`] },
    ]);
    expect(affectedFunctions(files, [`${R}/_shared/geocode.ts`]).map((f) => f.slug)).toEqual(["geo"]);
    expect(affectedFunctions(files, ["docs/x.md"])).toEqual([]);
    expect(removedFunctions(files, [`${R}/vieja/index.ts`, `${R}/geo/index.ts`, `${R}/_shared/x.ts`])).toEqual(["vieja"]);
  });

  it("flags sembrados por una migración", () => {
    const sql = `-- insert into public.features values ('comentada')
insert into public.system_settings (key, value)
values ('internal_mfa_required', 'false'::jsonb)
on conflict (key) do nothing;
insert into features (key, nombre, is_basic) values
  ('dlocalgo', 'dLocal Go', false),
  ('cupones_efectivo', 'Cupones', false);
update features set grupo = 'x' where key = 'otra';`;
    expect(extractFlags(sql)).toEqual([
      { table: "system_settings", key: "internal_mfa_required" },
      { table: "features", key: "dlocalgo" },
      { table: "features", key: "cupones_efectivo" },
    ]);
  });

  it("estado de migraciones y Edges", () => {
    const f = "20270129100000_prd62_coupon_base.sql";
    expect(migrationStatus(f, { applied: null, inProd: true })).toBe("sí (en main)");
    expect(migrationStatus(f, { applied: null, inProd: false })).toBe("pendiente de verificar");
    expect(migrationStatus(f, { applied: [{ version: "20270129100000", name: null }], inProd: false })).toBe("sí (verificada)");
    // aplicada por el MCP: otra versión, mismo nombre
    expect(migrationStatus(f, { applied: [{ version: "20261118000000", name: "prd62_coupon_base" }], inProd: false })).toBe("sí (verificada)");
    expect(migrationStatus(f, { applied: [], inProd: true })).toBe("no");

    const deployed = [{ slug: "modo_webhook", updated_at: Date.parse("2026-11-17T20:00:00Z") }];
    expect(functionStatus("modo_webhook", { deployed, inProd: false, since: "2026-11-17T16:00:00-03:00" })).toBe("sí (2026-11-17)");
    expect(functionStatus("modo_webhook", { deployed, inProd: false, since: "2026-11-17T18:00:00-03:00" })).toBe("no (última 2026-11-17)");
    expect(functionStatus("otra", { deployed, inProd: false, since: null })).toBe("no desplegada");
    expect(functionStatus("otra", { deployed: null, inProd: true, since: null })).toBe("sí (en main)");
    expect(functionStatus("otra", { deployed: null, inProd: false, since: null })).toBe("pendiente");
  });
});

describe("registro", () => {
  it("renderiza bloques con PRs, migraciones, Edges y notas", () => {
    const md = renderRecord({
      version: "0.2.0",
      date: "2026-11-18",
      from: "81aebad8f3453c1c",
      to: "66590dc3aaaa",
      repoUrl: "https://github.com/Org/repo",
      sources: "sin datos remotos.",
      blocks: [
        {
          title: "tanda/2026-11-16-1",
          kind: "deploy",
          pr: 556,
          merge: "6002eb5336d2",
          base: "81aebad8f3453c1c",
          end: "6002eb5336d2",
          date: "2026-11-17",
          prs: [{ sha: "96818245aaaa", pr: 553, task: "PAY-01", title: "feat(pagos): vencer intents | viejos" }],
          migrations: [{ file: "20270119100200_intents_expire_sweep.sql", status: "sí (en main)" }],
          functions: [],
          removed: [],
          flags: [],
          configChanged: true,
        },
        {
          title: "tanda/2026-11-18-1 (este deploy)",
          kind: "pending",
          pr: null,
          merge: null,
          base: "4ce357d7",
          end: "66590dc3aaaa",
          date: "2026-11-17",
          prs: [],
          migrations: [],
          functions: [{ slug: "arca_padron", own: false, via: ["supabase/functions/_shared/arca/comprobante.ts"], status: "pendiente" }],
          removed: ["vieja"],
          flags: [{ table: "system_settings", key: "internal_mfa_required", file: "20270122100000_sec23_internal_mfa.sql" }],
          configChanged: false,
        },
      ],
    });
    expect(md).toContain("# v0.2.0 · 2026-11-18");
    expect(md).toContain("- **Rango:** `81aebad8..66590dc3`");
    expect(md).toContain("(../../CHANGELOG.md#020---2026-11-18)");
    expect(md).toContain("1 PRs, 1 migraciones y 1 Edge Functions en 2 bloques");
    expect(md).toContain("## 1. tanda/2026-11-16-1");
    expect(md).toContain("PR de deploy [#556](https://github.com/Org/repo/pull/556)");
    expect(md).toContain("| [#553](https://github.com/Org/repo/pull/553) | PAY-01 | feat(pagos): vencer intents \\| viejos | `96818245` |");
    expect(md).toContain("| `20270119100200_intents_expire_sweep.sql` | sí (en main) |");
    expect(md).toContain("Cambió `supabase/config.toml`");
    expect(md).toContain("## 2. tanda/2026-11-18-1 (este deploy)");
    expect(md).toContain("| `arca_padron` | `_shared/arca/comprobante.ts` | pendiente |");
    expect(md).toContain("Flag/feature sembrado: `internal_mfa_required` en `system_settings`");
    expect(md).toContain("Edge borrada del repo: `vieja`");
    expect(md).toContain("Sin PRs.");
    expect(md.endsWith("\n")).toBe(true);
  });
});
