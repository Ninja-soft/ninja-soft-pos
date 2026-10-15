"use client";

import { useEffect, useMemo, useState } from "react";
import { Info, Lock, ShieldAlert, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Segmented } from "@/components/ui/Segmented";
import { SearchField } from "@/components/ui/SearchField";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { useToast } from "@/components/ui/Toast";
import { EYEBROW, FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import { MODULE_ICON, RiskBadge, RoleBadgeIcon, ROLE_ICON } from "@/components/permissions/permUi";
import {
  BASE_LABEL,
  CAPABILITY_BY_KEY,
  LEVEL_LABEL,
  MODULES,
  ROLE_COLORS,
  ROLE_ICONS,
  SYSTEM_ROLES,
  baseAllows,
  capabilitiesOfModule,
  levelsOfModule,
  moduleIsPartial,
  moduleLevel,
  normalizeCapabilities,
  searchCapabilities,
  setModuleLevel,
  toggleCapability,
  type BaseRole,
  type ModuleKey,
  type ModuleLevel,
  type RoleColor,
  type RoleIcon,
} from "@/lib/permissions/capabilities";
import { EDITABLE_TOTAL, permissionErrorMessage, ROLE_COLOR_HEX, ROLE_COLOR_LABEL, sensitiveCount } from "@/lib/permissions/editor";
import { usePermissionMutations } from "@/modules/permissions/hooks";
import type { PermRole } from "@/modules/permissions/api";
import { cn } from "@/lib/utils/cn";

export type EditorMode = "simple" | "advanced";

export interface RoleDraft {
  id: string | null;
  name: string;
  description: string;
  color: RoleColor;
  icon: RoleIcon;
  base: BaseRole;
  capabilities: string[];
  template: string | null;
}

export function draftFromRole(r: PermRole): RoleDraft {
  return {
    id: r.system ? null : r.id,
    name: r.name,
    description: r.description ?? "",
    color: r.color,
    icon: r.icon,
    base: r.base,
    capabilities: [...r.capabilities],
    template: r.template_key,
  };
}

const BASES: BaseRole[] = ["manager", "cashier", "viewer"];
const BASE_HINT: Record<BaseRole, string> = {
  owner: "",
  manager: "Lo que no está en esta lista lo hace como un encargado.",
  cashier: "Lo que no está en esta lista lo hace como un cajero.",
  viewer: "Nunca cambia datos: sólo mira.",
};
const TEMPLATES = SYSTEM_ROLES.filter((r) => r.key !== "owner");

/**
 * Editor de un rol: modo simple (tarjetas por módulo con Ver / Operar /
 * Administrar y plantillas) y avanzado (capacidad por capacidad con búsqueda,
 * filtros, riesgo y dependencias resueltas con aviso). Un rol de sistema se ve
 * sólo para leer: se duplica para cambiarlo.
 */
export function RoleEditorModal({
  open,
  onOpenChange,
  initial,
  readOnly,
  members,
  takenNames,
  initialMode = "simple",
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: RoleDraft | null;
  readOnly: boolean;
  members: number;
  takenNames: string[];
  initialMode?: EditorMode;
  onSaved?: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = usePermissionMutations();
  const [d, setD] = useState<RoleDraft | null>(initial);
  const [mode, setMode] = useState<EditorMode>(initialMode);
  const [q, setQ] = useState("");
  const [mod, setMod] = useState<"all" | ModuleKey>("all");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setD(initial);
      setMode(initialMode);
      setQ("");
      setMod("all");
      setNotice(null);
    }
  }, [open, initial, initialMode]);

  const originalBase = initial?.base ?? null;
  const caps = useMemo(() => d?.capabilities ?? [], [d]);
  const nameTaken = Boolean(
    d && takenNames.some((n) => n.trim().toLowerCase() === d.name.trim().toLowerCase()),
  );

  if (!d) return <Modal open={false} onOpenChange={onOpenChange} />;
  const draft = d;
  const update = (patch: Partial<RoleDraft>) => setD({ ...draft, ...patch });

  const labels = (keys: string[]) => keys.map((k) => CAPABILITY_BY_KEY.get(k)?.label ?? k).join(", ");

  function toggle(key: string, on: boolean) {
    const r = toggleCapability(caps, key, on, draft.base);
    update({ capabilities: r.next });
    if (r.addedDeps.length) setNotice(`También se prendió lo que hace falta: ${labels(r.addedDeps)}.`);
    else if (r.removedDependents.length) setNotice(`También se apagó lo que dependía de esto: ${labels(r.removedDependents)}.`);
    else setNotice(null);
  }

  function setLevel(module: ModuleKey, level: ModuleLevel) {
    update({ capabilities: setModuleLevel(caps, module, level, draft.base) });
    setNotice(null);
  }

  function setBase(base: BaseRole) {
    const next = normalizeCapabilities(caps, base);
    const dropped = caps.filter((k) => !next.includes(k));
    update({ base, capabilities: next });
    setNotice(dropped.length ? `Con nivel ${BASE_LABEL[base]} no cuentan: ${labels(dropped)}.` : null);
  }

  function applyTemplate(key: string) {
    const t = SYSTEM_ROLES.find((r) => r.key === key);
    if (!t) return;
    update({ base: t.base, capabilities: [...t.capabilities], template: t.key });
    setNotice(`Partís de ${t.name}. Cambiá lo que quieras.`);
  }

  async function save() {
    const name = draft.name.trim();
    if (!name) {
      toast({ variant: "error", title: "Ponele un nombre al rol" });
      return;
    }
    try {
      const id = await m.saveRole.mutateAsync({
        id: draft.id,
        name,
        description: draft.description.trim() || null,
        color: draft.color,
        icon: draft.icon,
        base: draft.base,
        capabilities: caps,
        template: draft.template,
      });
      toast({ variant: "success", title: draft.id ? "Rol actualizado" : "Rol creado", description: name });
      onSaved?.(id);
      onOpenChange(false);
    } catch (e) {
      toast({ variant: "error", title: permissionErrorMessage(e) });
    }
  }

  const visible = searchCapabilities(q).filter((c) => mod === "all" || c.module === mod);
  const sensitive = sensitiveCount(caps);
  const baseChanged = draft.id !== null && originalBase !== null && originalBase !== draft.base && members > 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={readOnly ? draft.name : draft.id ? `Editar ${draft.name}` : "Nuevo rol"}
      className="sm:max-w-3xl"
      header={
        <div className="flex items-center gap-3">
          <RoleBadgeIcon color={draft.color} icon={draft.icon} size={44} />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{draft.name || "Nuevo rol"}</p>
            <p className="text-sm text-muted-foreground">
              {readOnly ? "Rol de sistema: duplicalo para cambiarlo" : `Nivel base ${BASE_LABEL[draft.base]}`}
            </p>
          </div>
        </div>
      }
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {caps.length} de {EDITABLE_TOTAL} permisos
            {sensitive > 0 ? ` · ${sensitive} sensibles` : ""}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} className="flex-1 sm:flex-none">
              {readOnly ? "Cerrar" : "Cancelar"}
            </Button>
            {!readOnly && (
              <Button onClick={save} loading={m.saveRole.isPending} disabled={nameTaken} className={cn(SOLID_CTA, "flex-1 sm:flex-none")}>
                Guardar rol
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {!readOnly && (
          <section className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Nombre"
              value={draft.name}
              maxLength={40}
              onChange={(e) => update({ name: e.target.value })}
              error={nameTaken ? "Ya hay un rol con ese nombre" : undefined}
              placeholder="Ej.: Cajero de confianza"
            />
            <Input
              label="Para qué es (opcional)"
              value={draft.description}
              maxLength={200}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="Ej.: Cierra la caja y hace devoluciones"
            />
            <div>
              <p className={EYEBROW}>Color</p>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Color del rol">
                {ROLE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === c}
                    aria-label={ROLE_COLOR_LABEL[c]}
                    onClick={() => update({ color: c })}
                    className={cn(choiceClass(draft.color === c, "grid h-9 w-9 place-items-center rounded-lg", { check: false }))}
                  >
                    <span className="h-4 w-4 rounded-full" style={{ background: ROLE_COLOR_HEX[c] }} />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className={EYEBROW}>Ícono</p>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Ícono del rol">
                {ROLE_ICONS.map((i) => {
                  const Icon = ROLE_ICON[i];
                  return (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={draft.icon === i}
                      aria-label={i}
                      onClick={() => update({ icon: i })}
                      className={cn(choiceClass(draft.icon === i, "grid h-9 w-9 place-items-center rounded-lg", { check: false }))}
                    >
                      <Icon size={16} />
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {!readOnly && (
          <section>
            <p className={EYEBROW}>Nivel base</p>
            <Segmented
              className="mt-2"
              size="sm"
              value={draft.base}
              onChange={setBase}
              aria-label="Nivel base"
              options={BASES.map((b) => ({ value: b, label: BASE_LABEL[b] }))}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">{BASE_HINT[draft.base]}</p>
            {baseChanged && (
              <Callout tone="warning" icon={ShieldAlert} className="mt-3" title="Cambia el nivel de quienes tienen este rol">
                {members === 1 ? "1 persona" : `${members} personas`} pasan a nivel {BASE_LABEL[draft.base]} al guardar.
              </Callout>
            )}
          </section>
        )}

        {!readOnly && (
          <section>
            <p className={EYEBROW}>Empezar desde</p>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {TEMPLATES.map((t) => (
                <Button key={t.key} size="sm" variant="secondary" onClick={() => applyTemplate(t.key)} className="shrink-0">
                  Como {t.name}
                </Button>
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            aria-label="Modo del editor"
            options={[
              { value: "simple", label: "Simple" },
              { value: "advanced", label: "Avanzado" },
            ]}
          />
          {mode === "advanced" && (
            <SearchField value={q} onValueChange={setQ} placeholder="Buscar permiso" className="w-full sm:max-w-xs" />
          )}
        </div>

        {notice && (
          <Callout tone="info" icon={Sparkles}>
            {notice}
          </Callout>
        )}

        {mode === "simple" ? (
          <ul className="grid gap-3">
            {MODULES.map((mo) => {
              const Icon = MODULE_ICON[mo.key];
              const levels = levelsOfModule(mo.key);
              const usable = capabilitiesOfModule(mo.key).some((c) => c.minBase !== "owner" && baseAllows(draft.base, c.minBase));
              const lvl = moduleLevel(caps, mo.key, draft.base);
              const partial = moduleIsPartial(caps, mo.key, draft.base);
              return (
                <li key={mo.key} className={cn(FLAT_PANEL, "p-3.5")}>
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Icon size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold">{mo.label}</p>
                        {partial && <Badge tone="info" className="px-1.5 py-0 text-[10px]">A medida</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">{mo.description}</p>
                    </div>
                  </div>
                  {usable ? (
                    <Segmented
                      className="mt-3"
                      size="sm"
                      fill
                      value={lvl}
                      onChange={(v) => !readOnly && setLevel(mo.key, v)}
                      aria-label={`Acceso a ${mo.label}`}
                      options={[
                        { value: "none" as ModuleLevel, label: "Nada" },
                        ...levels.map((l) => ({ value: l as ModuleLevel, label: LEVEL_LABEL[l] })),
                      ]}
                    />
                  ) : (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock size={12} aria-hidden /> Pide nivel base Encargado
                    </p>
                  )}
                  {usable && (
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                      {capabilitiesOfModule(mo.key)
                        .filter((c) => caps.includes(c.key))
                        .map((c) => c.label)
                        .join(" · ") || "Sin acceso"}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="space-y-5">
            <Segmented
              scrollOnMobile
              size="sm"
              value={mod}
              onChange={setMod}
              aria-label="Módulo"
              options={[{ value: "all" as const, label: "Todos" }, ...MODULES.map((x) => ({ value: x.key, label: x.label }))]}
            />
            {MODULES.filter((mo) => visible.some((c) => c.module === mo.key)).map((mo) => (
              <section key={mo.key}>
                <p className={EYEBROW}>{mo.label}</p>
                <ul className={cn(FLAT_PANEL, "mt-2 divide-y divide-border")}>
                  {visible
                    .filter((c) => c.module === mo.key)
                    .map((c) => {
                      const ownerOnly = c.minBase === "owner";
                      const lowBase = !ownerOnly && !baseAllows(draft.base, c.minBase);
                      const disabled = readOnly || ownerOnly || lowBase;
                      const on = caps.includes(c.key);
                      return (
                        <li key={c.key}>
                          <label className={cn("flex gap-3 px-3.5 py-3", !disabled && "cursor-pointer hover:bg-muted/50")}>
                            <span className="pt-0.5">
                              <Checkbox
                                checked={on}
                                disabled={disabled}
                                onCheckedChange={(v) => toggle(c.key, v)}
                                aria-label={c.label}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-semibold">{c.label}</span>
                                <RiskBadge risk={c.risk} />
                                {c.enforced === "server" && (
                                  <Badge tone="neutral" className="px-1.5 py-0 text-[10px]">Lo controla el servidor</Badge>
                                )}
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">{c.description}</span>
                              {c.dependsOn.length > 0 && (
                                <span className="mt-0.5 block text-xs text-muted-foreground">Necesita: {labels(c.dependsOn)}</span>
                              )}
                              {ownerOnly && (
                                <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                  <Lock size={11} aria-hidden /> Sólo el dueño
                                </span>
                              )}
                              {lowBase && (
                                <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                  <Lock size={11} aria-hidden /> Pide nivel base {BASE_LABEL[c.minBase]}
                                </span>
                              )}
                              {c.enforced === "pending" && (
                                <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                  <Info size={11} aria-hidden /> Se usa cuando Inventario pida aprobar ajustes
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
            {visible.length === 0 && <p className="text-sm text-muted-foreground">No hay permisos con esa búsqueda.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
RoleEditorModal.displayName = "RoleEditorModal";
