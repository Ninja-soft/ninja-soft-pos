"use client";

import { useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { SearchField } from "@/components/ui/SearchField";
import { cn } from "@/lib/utils/cn";
import {
  filterSettingsGroups,
  type SettingsGroup,
  type SettingsSectionDef,
  type SettingsSectionKey,
} from "@/components/settings/sections";

type NavProps = {
  groups: SettingsGroup[];
  active: SettingsSectionKey;
  /** Secciones con feature de plan no incluida (candado). */
  locked: (s: SettingsSectionDef) => boolean;
  onSelect: (s: SettingsSectionDef) => void;
};

// Menú lateral del centro de Configuración (desktop): buscador + grupos con
// ítems compactos de una línea. Sticky dentro del <main> que scrollea.
export function SettingsSideNav({ groups, active, locked, onSelect }: NavProps) {
  const [query, setQuery] = useState("");
  const shown = filterSettingsGroups(groups, query);

  return (
    <nav aria-label="Secciones de configuración" className="flex flex-col gap-4">
      <SearchField
        value={query}
        onValueChange={setQuery}
        placeholder="Buscar ajuste"
        aria-label="Buscar ajuste"
        className="[&_input]:h-10 [&_input]:rounded-lg"
      />
      {shown.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">
          Sin resultados para &quot;{query.trim()}&quot;.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((g) => (
            <div key={g.title}>
              <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
                {g.title}
              </div>
              <ul className="flex flex-col gap-0.5">
                {g.sections.map((s) => {
                  const Icon = s.icon;
                  const isLocked = locked(s);
                  const isActive = active === s.key;
                  return (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => onSelect(s)}
                        aria-current={isActive ? "page" : undefined}
                        title={isLocked ? `${s.title}: no incluida en tu plan` : s.title}
                        className={cn(
                          "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] transition",
                          isActive
                            ? "choice-on font-medium"
                            : isLocked
                              ? "text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon
                          size={16}
                          className={cn("shrink-0", isActive && "text-ninja-flameSoft")}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">{s.label}</span>
                        {isLocked && (
                          <Lock size={13} className="shrink-0 text-muted-foreground" aria-label="No incluida en tu plan" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
SettingsSideNav.displayName = "SettingsSideNav";

// Selector de sección para mobile y tablet: un select nativo agrupado (hoja del
// sistema en iOS/Android), sin scroll horizontal.
export function SettingsMobileNav({ groups, active, locked, onSelect }: NavProps) {
  const all = groups.flatMap((g) => g.sections);
  const current = all.find((s) => s.key === active);
  const Icon = current?.icon;

  return (
    <label className="relative block">
      <span className="sr-only">Sección de configuración</span>
      {Icon && (
        <Icon
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ninja-flameSoft"
          aria-hidden
        />
      )}
      <select
        value={active}
        onChange={(e) => {
          const s = all.find((x) => x.key === e.target.value);
          if (s) onSelect(s);
        }}
        className="h-12 w-full appearance-none rounded-lg border border-border bg-card pl-11 pr-10 text-[15px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {groups.map((g) => (
          <optgroup key={g.title} label={g.title}>
            {g.sections.map((s) => (
              <option key={s.key} value={s.key}>
                {s.title}
                {locked(s) ? " (no incluida en tu plan)" : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown
        size={17}
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </label>
  );
}
SettingsMobileNav.displayName = "SettingsMobileNav";
