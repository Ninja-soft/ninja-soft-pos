"use client";

import { useState } from "react";
import { Check, Minus } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { EYEBROW, FLAT_PANEL } from "@/components/security/styles";
import { RoleChip } from "@/components/permissions/permUi";
import { CAPABILITY_BY_KEY, MODULES, compareRoles } from "@/lib/permissions/capabilities";
import type { PermRole } from "@/modules/permissions/api";
import { cn } from "@/lib/utils/cn";

/** Comparar dos roles: qué tiene cada uno que el otro no. */
export function CompareRoles({ roles }: { roles: PermRole[] }) {
  const usable = roles.filter((r) => r.base !== "owner");
  const [a, setA] = useState<string>(usable.find((r) => r.key === "cashier")?.id ?? usable[0]?.id ?? "");
  const [b, setB] = useState<string>(usable.find((r) => r.key === "manager")?.id ?? usable[1]?.id ?? "");
  const ra = usable.find((r) => r.id === a);
  const rb = usable.find((r) => r.id === b);
  if (!ra || !rb) return null;
  const diff = compareRoles(ra.capabilities, rb.capabilities);
  const options = usable.map((r) => ({ value: r.id, label: r.name }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Rol A" value={a} onChange={setA} options={options} />
        <Select label="Rol B" value={b} onChange={setB} options={options} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Summary title={`Sólo ${ra.name}`} keys={diff.onlyA} />
        <Summary title={`Sólo ${rb.name}`} keys={diff.onlyB} />
        <div className={cn(FLAT_PANEL, "p-3.5")}>
          <p className={EYEBROW}>En común</p>
          <p className="mt-1 font-display text-2xl font-bold tabular-nums">{diff.both.length}</p>
        </div>
      </div>
      <div className={cn(FLAT_PANEL, "overflow-x-auto")}>
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Permiso</th>
              <th scope="col" className="px-3 py-2"><RoleChip name={ra.name} color={ra.color} /></th>
              <th scope="col" className="px-3 py-2"><RoleChip name={rb.name} color={rb.color} /></th>
            </tr>
          </thead>
          <tbody>
            {MODULES.map((mo) => {
              const rows = diff.rows.filter((r) => CAPABILITY_BY_KEY.get(r.key)?.module === mo.key && (r.inA || r.inB));
              if (rows.length === 0) return null;
              return rows.map((r, i) => (
                <tr key={r.key} className={cn("border-b border-border last:border-0", r.inA !== r.inB && "bg-muted/40")}>
                  <td className="px-3 py-2">
                    {i === 0 && <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{mo.label}</span>}
                    {CAPABILITY_BY_KEY.get(r.key)?.label}
                  </td>
                  <td className="px-3 py-2 text-center">{r.inA ? <Check size={15} className="mx-auto" aria-label="Sí" /> : <Minus size={15} className="mx-auto text-muted-foreground/50" aria-label="No" />}</td>
                  <td className="px-3 py-2 text-center">{r.inB ? <Check size={15} className="mx-auto" aria-label="Sí" /> : <Minus size={15} className="mx-auto text-muted-foreground/50" aria-label="No" />}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
CompareRoles.displayName = "CompareRoles";

function Summary({ title, keys }: { title: string; keys: string[] }) {
  return (
    <div className={cn(FLAT_PANEL, "p-3.5")}>
      <p className={EYEBROW}>{title}</p>
      <p className="mt-1 font-display text-2xl font-bold tabular-nums">{keys.length}</p>
      {keys.length > 0 && (
        <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
          {keys.map((k) => CAPABILITY_BY_KEY.get(k)?.label ?? k).join(" · ")}
        </p>
      )}
    </div>
  );
}
