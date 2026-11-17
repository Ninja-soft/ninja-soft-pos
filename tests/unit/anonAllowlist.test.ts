// @vitest-environment node
// SEC-13: las funciones SECURITY DEFINER que anon puede ejecutar son
// exactamente las de supabase/security/anon-allowlist.json. Junto con la
// paridad estricta de grants (la base de CI = grants.expected.json), una
// función nueva expuesta a anon sin pasar por la allowlist rompe CI.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "supabase", "security", f), "utf8"));

describe("allowlist de la superficie anónima", () => {
  it("las SECURITY DEFINER ejecutables por anon son exactamente las de la allowlist", () => {
    const allow = (read("anon-allowlist.json").functions as { sig: string; reason: string }[]).map((f) => f.sig).sort();
    const exposed = (read("grants.expected.json").functions as { sig: string; secdef: boolean; anon: boolean }[])
      .filter((f) => f.secdef && f.anon)
      .map((f) => f.sig)
      .sort();
    expect(exposed).toEqual(allow);
  });

  it("cada entrada tiene motivo y grupo", () => {
    for (const f of read("anon-allowlist.json").functions as { sig: string; reason: string; group: string }[]) {
      expect(f.reason.length, f.sig).toBeGreaterThan(10);
      expect(f.group, f.sig).toBeTruthy();
    }
  });
});
