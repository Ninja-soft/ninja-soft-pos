"use client";

import { useMemo, useState } from "react";
import { Check, Lock, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Segmented } from "@/components/ui/Segmented";
import { SearchField } from "@/components/ui/SearchField";
import { useToast } from "@/components/ui/Toast";
import { FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import { RiskBadge, RoleChip } from "@/components/permissions/permUi";
import {
  BASE_LABEL,
  CAPABILITY_BY_KEY,
  MODULES,
  baseAllows,
  searchCapabilities,
  toggleCapability,
  type ModuleKey,
} from "@/lib/permissions/capabilities";
import { permissionErrorMessage } from "@/lib/permissions/editor";
import { usePermissionMutations } from "@/modules/permissions/hooks";
import type { PermRole } from "@/modules/permissions/api";
import { cn } from "@/lib/utils/cn";

/**
 * Matriz capacidades × roles (modo avanzado). Los roles de sistema se leen;
 * los propios se editan en la celda con las dependencias resueltas y se
 * guardan juntos. En mobile la matriz se desliza de costado con la columna
 * de permisos fija.
 */
export function PermissionMatrix({ roles, editable }: { roles: PermRole[]; editable: boolean }) {
  const { toast } = useToast();
  const m = usePermissionMutations();
  const [q, setQ] = useState("");
  const [mod, setMod] = useState<"all" | ModuleKey>("all");
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const capsOf = (r: PermRole) => draft[r.id] ?? r.capabilities;
  const dirty = Object.keys(draft);
  const rows = useMemo(() => searchCapabilities(q).filter((c) => mod === "all" || c.module === mod), [q, mod]);
  const labels = (keys: string[]) => keys.map((k) => CAPABILITY_BY_KEY.get(k)?.label ?? k).join(", ");

  function toggle(r: PermRole, key: string, on: boolean) {
    const res = toggleCapability(capsOf(r), key, on, r.base);
    setDraft((d) => ({ ...d, [r.id]: res.next }));
    if (res.addedDeps.length) setNotice(`${r.name}: también se prendió ${labels(res.addedDeps)}.`);
    else if (res.removedDependents.length) setNotice(`${r.name}: también se apagó ${labels(res.removedDependents)}.`);
    else setNotice(null);
  }

  async function saveAll() {
    setSaving(true);
    try {
      for (const id of dirty) {
        const r = roles.find((x) => x.id === id);
        if (!r) continue;
        await m.saveRole.mutateAsync({
          id: r.id,
          name: r.name,
          description: r.description,
          color: r.color,
          icon: r.icon,
          base: r.base,
          capabilities: draft[id]!,
          template: r.template_key,
        });
      }
      toast({ variant: "success", title: dirty.length === 1 ? "Rol guardado" : `${dirty.length} roles guardados` });
      setDraft({});
      setNotice(null);
    } catch (e) {
      toast({ variant: "error", title: permissionErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchField value={q} onValueChange={setQ} placeholder="Buscar permiso" className="lg:max-w-xs" />
        <Segmented
          scrollOnMobile
          size="sm"
          value={mod}
          onChange={setMod}
          aria-label="Módulo"
          options={[{ value: "all" as const, label: "Todos" }, ...MODULES.map((x) => ({ value: x.key, label: x.label }))]}
        />
      </div>

      {notice && (
        <Callout tone="info" icon={Sparkles}>
          {notice}
        </Callout>
      )}

      <div className={cn(FLAT_PANEL, "overflow-x-auto")}>
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="sticky left-0 z-10 w-[150px] min-w-[150px] bg-card px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground sm:w-auto sm:min-w-[300px]">
                Permiso
              </th>
              {roles.map((r) => (
                <th key={r.id} scope="col" className="px-2 py-2.5 text-center align-bottom">
                  <div className="flex flex-col items-center gap-1">
                    <RoleChip name={r.name} color={r.color} className="max-w-[120px]" />
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {r.system ? "Sistema" : BASE_LABEL[r.base]}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MODULES.filter((mo) => rows.some((c) => c.module === mo.key)).map((mo) => (
              <ModuleRows key={mo.key} label={mo.label} span={roles.length + 1}>
                {rows
                  .filter((c) => c.module === mo.key)
                  .map((c) => (
                    <tr key={c.key} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <th scope="row" className="sticky left-0 z-10 w-[150px] min-w-[150px] max-w-[150px] whitespace-normal bg-card px-3 py-2 text-left font-normal sm:w-auto sm:max-w-none">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold">{c.label}</span>
                          <RiskBadge risk={c.risk} />
                        </span>
                        {c.dependsOn.length > 0 && (
                          <span className="hidden text-[11px] text-muted-foreground sm:block">Necesita: {labels(c.dependsOn)}</span>
                        )}
                      </th>
                      {roles.map((r) => {
                        const on = r.base === "owner" || capsOf(r).includes(c.key);
                        const locked = c.minBase === "owner" ? r.base !== "owner" : !baseAllows(r.base, c.minBase);
                        const canEdit = editable && !r.system && !locked;
                        return (
                          <td key={r.id} className={cn("px-2 py-2 text-center", draft[r.id] && "bg-muted/40")}>
                            {canEdit ? (
                              <span className="inline-flex p-2">
                                <Checkbox
                                  checked={on}
                                  onCheckedChange={(v) => toggle(r, c.key, v)}
                                  aria-label={`${c.label} en ${r.name}`}
                                />
                              </span>
                            ) : locked && !on ? (
                              <Lock size={13} className="mx-auto text-muted-foreground/60" aria-label="No disponible para este nivel" />
                            ) : on ? (
                              <Check size={16} className="mx-auto text-foreground" aria-label="Sí" />
                            ) : (
                              <span className="text-muted-foreground/50" aria-label="No">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </ModuleRows>
            ))}
          </tbody>
        </table>
      </div>

      {dirty.length > 0 && (
        <div className={cn(FLAT_PANEL, "sticky bottom-3 flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between")}>
          <p className="text-sm">
            Cambios sin guardar en {dirty.length === 1 ? "1 rol" : `${dirty.length} roles`}.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setDraft({}); setNotice(null); }}>
              Descartar
            </Button>
            <Button size="sm" className={SOLID_CTA} onClick={saveAll} loading={saving}>
              Guardar cambios
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
PermissionMatrix.displayName = "PermissionMatrix";

function ModuleRows({ label, span, children }: { label: string; span: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="border-b border-border bg-muted/40">
        <th colSpan={span} scope="colgroup" className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </th>
      </tr>
      {children}
    </>
  );
}
