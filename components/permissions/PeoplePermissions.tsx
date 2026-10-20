"use client";

import { useMemo, useState } from "react";
import { Check, ListChecks, MapPin, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { EYEBROW, FLAT_PANEL } from "@/components/security/styles";
import { MODULE_ICON, RiskBadge, RoleChip } from "@/components/permissions/permUi";
import { BASE_LABEL, CAPABILITIES, CAPABILITY_BY_KEY, MODULES, overrideAllowed } from "@/lib/permissions/capabilities";
import {
  BLOCK_LABEL,
  SOURCE_LABEL,
  assignableRoles,
  explainPerson,
  permissionErrorMessage,
} from "@/lib/permissions/editor";
import { usePermissionMutations } from "@/modules/permissions/hooks";
import type { PermOverview, PermPerson, PermRole } from "@/modules/permissions/api";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { DiscountCapField } from "./DiscountCapField";

const STORE_DEFAULT = "__negocio__";

/** Personas: rol de cada una, rol por sucursal y "qué puede hacer". */
export function PeoplePermissions({ data }: { data: PermOverview }) {
  const { toast } = useToast();
  const m = usePermissionMutations();
  const [q, setQ] = useState("");
  const [detail, setDetail] = useState<PermPerson | null>(null);
  const roleById = useMemo(() => new Map(data.roles.map((r) => [r.id, r])), [data.roles]);
  const storeById = useMemo(() => new Map(data.stores.map((s) => [s.id, s])), [data.stores]);
  const assignable = assignableRoles(data.roles, {
    actorIsOwner: data.is_owner,
    actorCaps: data.my_capabilities,
    featureOn: data.feature,
  });

  const list = data.people.filter((p) =>
    `${p.name} ${p.email ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()),
  );

  const canTouch = (p: PermPerson) =>
    data.can_manage && p.user_id !== data.me && p.base !== "owner" && (data.is_owner || p.base === "cashier" || p.base === "viewer");

  async function assign(p: PermPerson, roleId: string) {
    if (roleId === p.role_id) return;
    try {
      await m.assignRole.mutateAsync({ userId: p.user_id, roleId });
      toast({ variant: "success", title: `${capitalizeName(p.name)} ahora es ${roleById.get(roleId)?.name ?? "otro rol"}` });
    } catch (e) {
      toast({ variant: "error", title: permissionErrorMessage(e) });
    }
  }

  async function branch(p: PermPerson, storeId: string, roleId: string) {
    try {
      await m.setBranchRole.mutateAsync({ userId: p.user_id, storeId, roleId: roleId === STORE_DEFAULT ? null : roleId });
      toast({ variant: "success", title: "Rol de la sucursal actualizado" });
    } catch (e) {
      toast({ variant: "error", title: permissionErrorMessage(e) });
    }
  }

  return (
    <div className="space-y-4">
      {data.people.length > 3 && (
        <SearchField value={q} onValueChange={setQ} placeholder="Buscar por nombre o email" className="sm:max-w-xs" />
      )}
      <ul className="grid items-start gap-3 lg:grid-cols-2">
        {list.map((p) => {
          const role = roleById.get(p.role_id);
          const editable = canTouch(p);
          const options = assignable.some((r) => r.id === p.role_id) ? assignable : role ? [role, ...assignable] : assignable;
          return (
            <li key={p.user_id} className={cn(FLAT_PANEL, "flex flex-col gap-3 p-3.5")}>
              <div className="flex items-start gap-3">
                <Avatar name={p.name} avatar={p.avatar} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    {capitalizeName(p.name)}
                    {p.user_id === data.me && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(vos)</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{p.email ?? BASE_LABEL[p.base]}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setDetail(p)} aria-label={`Qué puede hacer ${p.name}`}>
                  <ListChecks size={16} /> <span className="hidden sm:inline">Qué puede hacer</span>
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {editable ? (
                  <Select
                    aria-label={`Rol de ${p.name}`}
                    className="min-w-[200px] flex-1"
                    value={p.role_id}
                    onChange={(v) => assign(p, v)}
                    options={options.map((r) => ({
                      value: r.id,
                      label: r.name,
                      description: r.system ? `Sistema · nivel ${BASE_LABEL[r.base]}` : `Propio · nivel ${BASE_LABEL[r.base]}`,
                    }))}
                  />
                ) : (
                  role && <RoleChip name={role.name} color={role.color} />
                )}
                {p.overrides.length > 0 && (
                  <Badge tone="info">
                    {p.overrides.length === 1 ? "1 permiso puntual" : `${p.overrides.length} permisos puntuales`}
                  </Badge>
                )}
                {p.status === "invited" && <Badge tone="neutral">Invitación pendiente</Badge>}
              </div>

              {data.multi_sucursal && p.stores.length > 0 && p.base !== "owner" && (
                <div className="space-y-2 border-t border-border pt-3">
                  <p className={EYEBROW}>Rol por sucursal</p>
                  {p.stores.map((s) => {
                    const store = storeById.get(s.store_id);
                    const current = s.base ? (s.role_id ?? STORE_DEFAULT) : STORE_DEFAULT;
                    return (
                      <div key={`${s.store_id}-${s.kind}`} className="flex flex-wrap items-center gap-2">
                        <span className="flex min-w-[110px] items-center gap-1.5 text-sm">
                          <MapPin size={13} className="text-muted-foreground" aria-hidden />
                          {store?.short_name || store?.name || "Sucursal"}
                        </span>
                        {editable ? (
                          <Select
                            aria-label={`Rol en ${store?.name ?? "la sucursal"}`}
                            className="min-w-[180px] flex-1"
                            value={current}
                            onChange={(v) => branch(p, s.store_id, v)}
                            options={[
                              { value: STORE_DEFAULT, label: "Como en el negocio" },
                              ...assignable.map((r) => ({ value: r.id, label: r.name })),
                            ]}
                          />
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {s.role_id ? (roleById.get(s.role_id)?.name ?? "Rol propio") : "Como en el negocio"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <EffectiveModal person={detail} data={data} onClose={() => setDetail(null)} />
    </div>
  );
}
PeoplePermissions.displayName = "PeoplePermissions";

type OverrideChoice = "role" | "grant" | "revoke";

/** Qué puede hacer una persona, de dónde sale cada permiso y permisos puntuales. */
export function EffectiveModal({ person, data, onClose }: { person: PermPerson | null; data: PermOverview; onClose: () => void }) {
  const { toast } = useToast();
  const m = usePermissionMutations();
  const [where, setWhere] = useState<string>(STORE_DEFAULT);
  const [onlyOn, setOnlyOn] = useState<"all" | "yes" | "no">("all");

  const ctx = useMemo(() => {
    if (!person) return null;
    const store = where === STORE_DEFAULT ? null : person.stores.find((s) => s.store_id === where && s.base);
    const roleId = store ? (store.role_id ?? person.role_id) : person.role_id;
    const base = store?.base ?? person.base;
    const res = explainPerson(
      { base, role_id: roleId, overrides: person.overrides },
      data.roles,
      data.feature,
      data.grant_features ?? [],
    );
    return { res, role: data.roles.find((r) => r.id === roleId) as PermRole | undefined, base };
  }, [person, where, data.roles, data.feature, data.grant_features]);

  if (!person || !ctx) return <Modal open={false} onOpenChange={() => undefined} />;
  const p = person;
  // Con roles_permisos, cualquier permiso; sin ella, los otorgables de
  // Inventario si el plan tiene su feature (grantFeature).
  const canOverride = (cap: string) =>
    data.is_owner && p.base !== "owner" && overrideAllowed(cap, data.feature, data.grant_features ?? []);
  const serverMismatch =
    where === STORE_DEFAULT &&
    [...ctx.res.effective].sort().join(",") !== [...p.effective].sort().join(",");

  async function setOverride(cap: string, choice: OverrideChoice) {
    try {
      await m.setOverride.mutateAsync({ userId: p.user_id, capability: cap, effect: choice === "role" ? null : choice, reason: null });
    } catch (e) {
      toast({ variant: "error", title: permissionErrorMessage(e) });
    }
  }

  const stores = p.stores.filter((s) => s.base);
  const total = ctx.res.effective.size;

  return (
    <Modal
      open={Boolean(person)}
      onOpenChange={(o) => !o && onClose()}
      title={`Qué puede hacer ${p.name}`}
      className="sm:max-w-2xl"
      header={
        <div className="flex items-center gap-3">
          <Avatar name={p.name} avatar={p.avatar} size={48} />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{capitalizeName(p.name)}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {ctx.role && <RoleChip name={ctx.role.name} color={ctx.role.color} />}
              <Badge tone="neutral">Nivel {BASE_LABEL[ctx.base]}</Badge>
              <Badge tone="neutral">{total} permisos</Badge>
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {stores.length > 0 ? (
            <Select
              aria-label="Dónde"
              className="sm:max-w-xs"
              value={where}
              onChange={setWhere}
              options={[
                { value: STORE_DEFAULT, label: "En el negocio" },
                ...stores.map((s) => ({ value: s.store_id, label: `En ${data.stores.find((x) => x.id === s.store_id)?.name ?? "la sucursal"}` })),
              ]}
            />
          ) : (
            <span />
          )}
          <Segmented
            size="sm"
            value={onlyOn}
            onChange={setOnlyOn}
            aria-label="Filtro"
            options={[
              { value: "all", label: "Todo" },
              { value: "yes", label: "Puede" },
              { value: "no", label: "No puede" },
            ]}
          />
        </div>
        {p.base === "owner" && <p className="text-sm text-muted-foreground">El dueño puede todo, siempre.</p>}
        {data.is_owner && p.base !== "owner" && (
          <section className={cn(FLAT_PANEL, "p-3.5")}>
            <DiscountCapField userId={p.user_id} />
          </section>
        )}
        {ctx.res.usedSystemFallback && (
          <p className="text-sm text-muted-foreground">
            Tu plan no incluye roles a medida: hoy cuenta como {BASE_LABEL[ctx.base]}.
          </p>
        )}
        {serverMismatch && (
          <p className="text-sm text-muted-foreground">Hay cambios recién guardados: recargá para ver lo último.</p>
        )}
        {MODULES.map((mo) => {
          const Icon = MODULE_ICON[mo.key];
          const items = CAPABILITIES.filter((c) => c.module === mo.key).filter((c) => {
            const g = ctx.res.detail.get(c.key)?.granted ?? false;
            return onlyOn === "all" || (onlyOn === "yes" ? g : !g);
          });
          if (items.length === 0) return null;
          return (
            <section key={mo.key}>
              <p className={cn(EYEBROW, "flex items-center gap-1.5")}>
                <Icon size={12} aria-hidden /> {mo.label}
              </p>
              <ul className={cn(FLAT_PANEL, "mt-2 divide-y divide-border")}>
                {items.map((c) => {
                  const det = ctx.res.detail.get(c.key)!;
                  const ov = p.overrides.find((o) => o.capability === c.key);
                  const choice: OverrideChoice = ov ? ov.effect : "role";
                  return (
                    <li key={c.key} className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center">
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span
                          className={cn(
                            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md",
                            det.granted ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                          )}
                          aria-label={det.granted ? "Puede" : "No puede"}
                        >
                          {det.granted ? <Check size={13} /> : <X size={13} />}
                        </span>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                            {c.label} <RiskBadge risk={c.risk} />
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {det.granted
                              ? SOURCE_LABEL[det.source ?? "role"]
                              : det.blocked === "missing_dependency"
                                ? `Le falta: ${det.missing.map((k) => CAPABILITY_BY_KEY.get(k)?.label ?? k).join(", ")}`
                                : BLOCK_LABEL[det.blocked ?? "not_granted"]}
                          </p>
                        </div>
                      </div>
                      {canOverride(c.key) && c.minBase !== "owner" && (
                        <Segmented
                          size="sm"
                          value={choice}
                          onChange={(v) => setOverride(c.key, v)}
                          aria-label={`Permiso puntual: ${c.label}`}
                          options={[
                            { value: "role", label: "Según el rol" },
                            { value: "grant", label: "Dar" },
                            { value: "revoke", label: "Quitar" },
                          ]}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
EffectiveModal.displayName = "EffectiveModal";
