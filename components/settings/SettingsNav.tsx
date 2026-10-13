"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { SearchField } from "@/components/ui/SearchField";
import { cn } from "@/lib/utils/cn";
import { iconSizeInBox, type SettingsIcon } from "@/components/settings/brandIcons";
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

// Menú del centro de Configuración. Una sola lista (NavList) para desktop y
// celular, así el orden es siempre el mismo:
//   - buscador arriba, fijo al scrollear la lista;
//   - grupos colapsables (estado recordado en localStorage) con su título en
//     tipografía normal, no en mayúsculas, y un contador cuando está cerrado;
//   - cada ítem con su ícono en una caja cuadrada igual para todos (los logos
//     de ARCA, Mercado Libre y NubCeo entran en la misma caja);
//   - activo: relleno (--choice-fill), texto fuerte, caja del ícono tintada y
//     un punto. Nunca borde lateral de color ni sombra;
//   - sin el plan: texto apagado + candado, y un total al pie.
// Teclado: Tab recorre, flechas arriba/abajo saltan entre ítems, Enter en el
// buscador abre el primer resultado y Escape lo limpia.

const STORAGE_KEY = "ninja:settings-nav:collapsed";

function readCollapsed(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsed(titles: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(titles));
  } catch {
    // Sin almacenamiento (modo privado, bloqueado): queda sólo en memoria.
  }
}

/** Grupos cerrados, compartidos entre el menú de desktop y el de celular. */
function useCollapsedGroups(activeGroup: string | undefined) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Se lee después de montar: el server no conoce el localStorage.
  useEffect(() => setCollapsed(readCollapsed()), []);
  // Si se llega a una sección de un grupo cerrado (link, ?seccion=), se abre.
  useEffect(() => {
    if (!activeGroup) return;
    setCollapsed((prev) => {
      if (!prev.includes(activeGroup)) return prev;
      const next = prev.filter((t) => t !== activeGroup);
      writeCollapsed(next);
      return next;
    });
  }, [activeGroup]);
  const toggle = useCallback((title: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title];
      writeCollapsed(next);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

function NavIcon({
  icon: Icon,
  active,
  locked,
  touch,
}: {
  icon: SettingsIcon;
  active: boolean;
  locked: boolean;
  touch: boolean;
}) {
  const box = touch ? 28 : 24;
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-[5px] transition-colors",
        active ? "bg-ninja-flame/15 text-ninja-flameSoft" : "bg-muted text-foreground/75",
        locked && "opacity-55",
      )}
      style={{ width: box, height: box }}
    >
      <Icon size={iconSizeInBox(Icon, touch ? 16 : 15, box - 2)} className="shrink-0" aria-hidden />
    </span>
  );
}

function NavList({
  groups,
  active,
  locked,
  onSelect,
  touch = false,
}: NavProps & {
  /** Filas de 44px (celular y tablet) en lugar de 36px. */
  touch?: boolean;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const searching = query.trim().length > 0;
  const shown = filterSettingsGroups(groups, query);
  const activeGroup = groups.find((g) => g.sections.some((s) => s.key === active))?.title;
  const { collapsed, toggle } = useCollapsedGroups(activeGroup);
  const lockedCount = groups.reduce((n, g) => n + g.sections.filter(locked).length, 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // La sección abierta siempre a la vista dentro de la lista (al entrar por
  // ?seccion= o un link), moviendo sólo el scroll del menú, no el de la página.
  useEffect(() => {
    const box = scrollRef.current;
    const item = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !item) return;
    const top = item.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    if (top < box.scrollTop || top + item.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
  }, [active, collapsed]);

  // Flechas arriba/abajo entre ítems visibles (además de Tab).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-nav-item]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    // El buscador queda fijo arriba y sólo la lista scrollea (el contenedor
    // le pone el alto máximo).
    <nav aria-label="Secciones de configuración" className="flex max-h-full min-h-0 flex-col">
      <div className="shrink-0 px-1 pb-3">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="Buscar ajuste"
          aria-label="Buscar ajuste"
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            } else if (e.key === "Enter") {
              const first = shown[0]?.sections[0];
              if (first) {
                e.preventDefault();
                onSelect(first);
              }
            }
          }}
          className={cn("[&_input]:rounded-lg", touch ? "[&_input]:h-11" : "[&_input]:h-9 [&_input]:text-[13.5px]")}
        />
      </div>

      <div ref={scrollRef} className="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {shown.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground" role="status">
            Sin resultados para &quot;{query.trim()}&quot;.
          </p>
        ) : (
          <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-3">
            {shown.map((g) => {
              const open = searching || !collapsed.includes(g.title);
              const panelId = `${baseId}-${g.title.replace(/\W+/g, "-")}`;
              const hasActive = g.sections.some((s) => s.key === active);
              return (
                <div key={g.title}>
                  <button
                    type="button"
                    onClick={() => toggle(g.title)}
                    disabled={searching}
                    aria-expanded={open}
                    aria-controls={panelId}
                    className={cn(
                      "group flex w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground",
                      touch ? "h-10" : "h-7",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{g.title}</span>
                    {!open && (
                      <>
                        {hasActive && (
                          <>
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ninja-flame" />
                            <span className="sr-only">(sección abierta)</span>
                          </>
                        )}
                        <span className="text-[11px] font-medium tabular-nums text-muted-foreground/80">
                          {g.sections.length}
                        </span>
                      </>
                    )}
                    {!searching && (
                      <ChevronDown
                        size={14}
                        aria-hidden
                        className={cn(
                          "shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground",
                          !open && "-rotate-90",
                        )}
                      />
                    )}
                  </button>
                  <ul id={panelId} hidden={!open} className="mt-0.5 flex flex-col gap-px">
                    {g.sections.map((s) => {
                      const isLocked = locked(s);
                      const isActive = active === s.key;
                      return (
                        <li key={s.key}>
                          <button
                            type="button"
                            data-nav-item
                            onClick={() => onSelect(s)}
                            aria-current={isActive ? "page" : undefined}
                            title={isLocked ? `${s.title}: no incluida en tu plan` : s.title}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-md px-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              touch ? "h-11 text-[15px]" : "h-9 text-[13.5px]",
                              isActive
                                ? "bg-[var(--choice-fill)] font-semibold text-foreground"
                                : isLocked
                                  ? "text-muted-foreground hover:bg-muted/60"
                                  : "text-foreground/85 hover:bg-muted/60 hover:text-foreground",
                            )}
                          >
                            <NavIcon icon={s.icon} active={isActive} locked={isLocked} touch={touch} />
                            <span className="min-w-0 flex-1 truncate">{s.label}</span>
                            {isLocked ? (
                              <Lock
                                size={13}
                                className="mr-1 shrink-0 text-muted-foreground/80"
                                aria-label="No incluida en tu plan"
                              />
                            ) : (
                              isActive && (
                                <span aria-hidden className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ninja-flame" />
                              )
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {lockedCount > 0 && !searching && (
          <p className="mt-4 flex items-center gap-1.5 border-t border-border px-2 pt-3 text-xs text-muted-foreground">
            <Lock size={12} aria-hidden className="shrink-0" />
            {lockedCount === 1
              ? "1 sección no incluida en tu plan"
              : `${lockedCount} secciones no incluidas en tu plan`}
          </p>
        )}
      </div>
    </nav>
  );
}

// Menú lateral de desktop (lg+). La página lo pone sticky con scroll propio.
export function SettingsSideNav(props: NavProps) {
  return <NavList {...props} />;
}
SettingsSideNav.displayName = "SettingsSideNav";

// Celular y tablet: botón con la sección actual que despliega la MISMA lista
// (mismo orden, buscador y grupos) debajo, con filas de 44px. Elegir una
// sección la cierra y devuelve el foco al botón; Escape también la cierra.
export function SettingsMobileNav(props: NavProps) {
  const { groups, active, onSelect } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const group = groups.find((g) => g.sections.some((s) => s.key === active));
  const current = group?.sections.find((s) => s.key === active);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex h-14 w-full items-center gap-3 rounded-lg border border-border bg-card px-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {current && <NavIcon icon={current.icon} active locked={false} touch />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] font-medium text-muted-foreground">
            {group?.title ?? "Configuración"}
          </span>
          <span className="block truncate text-[15px] font-semibold text-foreground">
            {current?.label ?? "Elegí una sección"}
          </span>
        </span>
        <span className="sr-only">{open ? "Cerrar secciones" : "Ver todas las secciones"}</span>
        <ChevronDown
          size={18}
          aria-hidden
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-2 flex max-h-[70dvh] flex-col rounded-lg border border-border bg-card px-1 pb-2 pt-2"
        >
          <NavList
            {...props}
            touch
            onSelect={(s) => {
              onSelect(s);
              if (!props.locked(s)) close();
            }}
          />
        </div>
      )}
    </div>
  );
}
SettingsMobileNav.displayName = "SettingsMobileNav";
