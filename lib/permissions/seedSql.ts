// Seed SQL del catálogo de capacidades y de los roles de sistema (ADR-138),
// generado desde lib/permissions/capabilities.ts. La migración
// 20261204100100_permisos_capacidades lo lleva entre los marcadores
// @@SEED-INICIO@@ y @@SEED-FIN@@; tests/unit/permissionsCatalog.test.ts falla
// si se separan (y muestra el SQL esperado para pegar en una migración nueva).
import { CAPABILITIES, SYSTEM_ROLES, requiresAll } from "./capabilities";

const q = (s: string | number) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (a: readonly string[]) => (a.length ? `array[${a.map(q).join(", ")}]::text[]` : `'{}'::text[]`);

export function buildSeedSql(): string {
  let out =
    "insert into permission_capabilities (key, module, label, description, level, risk, depends_on, requires_all, min_base, enforced, sort) values\n";
  out += CAPABILITIES.map(
    (c, i) =>
      `  (${q(c.key)}, ${q(c.module)}, ${q(c.label)}, ${q(c.description)}, ${q(c.level)}, ${q(c.risk)}, ${arr(c.dependsOn)}, ${arr(requiresAll(c.key))}, ${q(c.minBase)}, ${q(c.enforced)}, ${(i + 1) * 10})`,
  ).join(",\n");
  out +=
    "\non conflict (key) do update set module = excluded.module, label = excluded.label, description = excluded.description,\n" +
    "  level = excluded.level, risk = excluded.risk, depends_on = excluded.depends_on, requires_all = excluded.requires_all,\n" +
    "  min_base = excluded.min_base, enforced = excluded.enforced, sort = excluded.sort, updated_at = now();\n\n";
  out += "insert into permission_roles (id, tenant_id, key, name, description, color, icon, base_role, sort) values\n";
  out += SYSTEM_ROLES.map(
    (r, i) =>
      `  (${q(r.id)}, null, ${q(r.key)}, ${q(r.name)}, ${q(r.description)}, ${q(r.color)}, ${q(r.icon)}, ${q(r.base)}, ${(i + 1) * 10})`,
  ).join(",\n");
  out +=
    "\non conflict (id) do update set key = excluded.key, name = excluded.name, description = excluded.description,\n" +
    "  color = excluded.color, icon = excluded.icon, base_role = excluded.base_role, sort = excluded.sort, updated_at = now();\n\n";
  out += "delete from permission_role_capabilities where tenant_id is null;\n";
  out += "insert into permission_role_capabilities (role_id, capability, tenant_id) values\n";
  const rows: string[] = [];
  for (const r of SYSTEM_ROLES) for (const k of r.capabilities) rows.push(`  (${q(r.id)}, ${q(k)}, null)`);
  out += rows.join(",\n") + ";\n";
  return out;
}
