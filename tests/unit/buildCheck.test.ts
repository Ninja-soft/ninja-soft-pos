import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkBuild } from "@/scripts/build-check.mjs";

const SCRIPT = join(__dirname, "..", "..", "scripts", "build-check.mjs");

describe("build-check (OPS-55)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "build-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("falla si no hay BUILD_ID (next build murió y salió 0)", () => {
    const r = checkBuild(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no existe .*BUILD_ID/);
  });

  it("falla si BUILD_ID está vacío", () => {
    writeFileSync(join(dir, "BUILD_ID"), "  \n");
    const r = checkBuild(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/vacío/);
  });

  it("pasa con BUILD_ID presente", () => {
    writeFileSync(join(dir, "BUILD_ID"), "abc123\n");
    expect(checkBuild(dir)).toEqual({ ok: true, buildId: "abc123" });
  });

  it("como CLI sale 1 sin build y 0 con build", () => {
    const sin = spawnSync(process.execPath, [SCRIPT, `--dist=${dir}`], { encoding: "utf8" });
    expect(sin.status).toBe(1);
    expect(sin.stderr).toMatch(/build-check: next build terminó sin generar el build/);

    writeFileSync(join(dir, "BUILD_ID"), "abc123");
    const con = spawnSync(process.execPath, [SCRIPT, `--dist=${dir}`], { encoding: "utf8" });
    expect(con.status).toBe(0);
    expect(con.stdout).toMatch(/BUILD_ID abc123/);
  });
});
