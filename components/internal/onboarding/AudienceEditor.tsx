"use client";

// Audiencia de un recorrido o sugerencia (ADR-089): plan, estado, rubro, rol
// y antigüedad. Mismos criterios y nombres que los anuncios por segmento
// (ADR-084). Un grupo sin nada marcado no filtra.
import { cn } from "@/lib/utils/cn";
import { Input } from "@/components/ui/Input";
import { VERTICALS, VERTICAL_LABELS } from "@/lib/verticals/config";
import {
  SEGMENT_PLANS,
  SEGMENT_PLAN_LABELS,
  SEGMENT_STATUSES,
  SEGMENT_STATUS_LABELS,
  toggleValue,
} from "@/lib/internal/segments";
import { AUDIENCE_ROLES, ROLE_LABELS, type Audience } from "@/lib/onboarding/schema";

export function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs transition",
        on
          ? "border-ninja-flameSoft bg-ninja-flame/10 text-ninja-flameSoft"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-semibold text-muted-foreground">{title}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

export function AudienceEditor({ value, onChange }: { value: Audience; onChange: (a: Audience) => void }) {
  const set = (k: "plans" | "statuses" | "industries" | "roles", v: string) =>
    onChange({ ...value, [k]: toggleValue((value[k] as string[] | undefined) ?? [], v) });
  const num = (raw: string): number | undefined => {
    if (raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  return (
    <div className="space-y-3">
      <Group title="Plan">
        {SEGMENT_PLANS.map((p) => (
          <Chip key={p} on={value.plans?.includes(p) ?? false} label={SEGMENT_PLAN_LABELS[p] ?? p} onClick={() => set("plans", p)} />
        ))}
      </Group>
      <Group title="Estado">
        {SEGMENT_STATUSES.map((s) => (
          <Chip key={s} on={value.statuses?.includes(s) ?? false} label={SEGMENT_STATUS_LABELS[s] ?? s} onClick={() => set("statuses", s)} />
        ))}
      </Group>
      <Group title="Rubro">
        {VERTICALS.map((v) => (
          <Chip key={v} on={value.industries?.includes(v) ?? false} label={VERTICAL_LABELS[v]} onClick={() => set("industries", v)} />
        ))}
      </Group>
      <Group title="Rol">
        {AUDIENCE_ROLES.map((r) => (
          <Chip key={r} on={value.roles?.includes(r) ?? false} label={ROLE_LABELS[r] ?? r} onClick={() => set("roles", r)} />
        ))}
      </Group>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Alta hace al menos (días)"
          type="number"
          min={0}
          value={value.min_days ?? ""}
          onChange={(e) => onChange({ ...value, min_days: num(e.target.value) })}
        />
        <Input
          label="Alta hace como mucho (días)"
          type="number"
          min={0}
          value={value.max_days ?? ""}
          onChange={(e) => onChange({ ...value, max_days: num(e.target.value) })}
        />
      </div>
    </div>
  );
}
