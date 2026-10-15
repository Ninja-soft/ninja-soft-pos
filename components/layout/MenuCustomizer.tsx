"use client";

// Modo "Personalizar menú" del menú lateral (ADR-134). Se carga con dynamic
// import sólo al entrar al modo: @dnd-kit no viaja en el camino normal.
//
// - Mouse: arrastre directo (4px de umbral). Touch: mantener apretado (250ms).
// - Teclado: Espacio o Enter toma y suelta, flechas mueven (cruzando grupos y
//   "Ocultos"), Escape cancela. Lo maneja este componente (no el KeyboardSensor
//   de dnd-kit) para que el movimiento entre grupos sea predecible y no dependa
//   de medir el DOM. Anuncios por aria-live.
// - El lugar donde caería el ítem se ve con un borde punteado animado
//   (.nav-drop-placeholder en globals.css); el resto se corre con transform.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Eye, EyeOff, GripVertical, LayoutDashboard, Lock, Pin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import {
  HIDDEN_ID,
  TOP_GROUP,
  containers,
  findContainer,
  moveGroupBy,
  moveItemBy,
  placeGroup,
  placeItem,
  toggleHidden,
  type MenuDefaults,
  type MenuLayout,
} from "@/lib/nav/menuLayout";

export interface CustomizerItem {
  id: string;
  label: string;
  icon: React.ElementType;
  locked?: boolean;
}

export interface MenuCustomizerProps {
  /** Layout visible (sólo ítems que el usuario puede ver). */
  layout: MenuLayout;
  defaults: MenuDefaults;
  items: Record<string, CustomizerItem>;
  groupLabels: Record<string, string>;
  onChange: (l: MenuLayout) => void;
  onDone: () => void;
  onReset: () => void;
  canReset: boolean;
}

const G = "group:";
const L = "list:";
const HIDDEN_LABEL = "Ocultos";

type Picked = { kind: "item" | "group"; id: string; snapshot: MenuLayout };

function itemsOf(l: MenuLayout, cid: string): string[] {
  return containers(l).find((c) => c.id === cid)?.items ?? [];
}

function transformStyle(
  t: { x: number; y: number; scaleX: number; scaleY: number } | null,
  transition: string | undefined,
): React.CSSProperties {
  return {
    transform: t ? `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` : undefined,
    transition,
  };
}

export function MenuCustomizer({
  layout,
  defaults,
  items,
  groupLabels,
  onChange,
  onDone,
  onReset,
  canReset,
}: MenuCustomizerProps) {
  const [draft, setDraft] = useState(layout);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [live, setLive] = useState("");
  const snapshot = useRef<MenuLayout>(layout);
  const rootRef = useRef<HTMLDivElement>(null);

  // Lo de afuera (restablecer, carga del servidor) manda si no se está moviendo nada.
  useEffect(() => {
    if (!activeId && !picked) setDraft(layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const labelOf = (cid: string) =>
    cid === HIDDEN_ID ? HIDDEN_LABEL : cid === TOP_GROUP ? "Accesos" : (groupLabels[cid] ?? cid);
  const itemLabel = (id: string) => items[id]?.label ?? id;

  const whereItem = (l: MenuLayout, id: string) => {
    const cid = findContainer(l, id);
    if (!cid) return "";
    const list = itemsOf(l, cid);
    return `${labelOf(cid)}, posición ${list.indexOf(id) + 1} de ${list.length}`;
  };
  const whereGroup = (l: MenuLayout, gid: string) => {
    const titled = l.groups.filter((g) => g.id !== TOP_GROUP);
    return `posición ${titled.findIndex((g) => g.id === gid) + 1} de ${titled.length}`;
  };

  // ---------------------------------------------------------------- teclado
  useEffect(() => {
    if (!picked) return;
    const sel = `[data-nav-handle="${picked.kind}:${picked.id}"]`;
    const el = rootRef.current?.querySelector<HTMLElement>(sel);
    if (el && document.activeElement !== el) el.focus();
  }, [draft, picked]);

  function onHandleKey(e: React.KeyboardEvent, kind: "item" | "group", id: string) {
    const name = kind === "item" ? itemLabel(id) : `Grupo ${labelOf(id)}`;
    const isMine = picked?.kind === kind && picked.id === id;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!picked) {
        setPicked({ kind, id, snapshot: draft });
        setLive(`Tomaste ${name}. Usá las flechas para moverlo, Espacio para soltarlo y Escape para cancelar.`);
      } else if (isMine) {
        setPicked(null);
        onChange(draft);
        setLive(`Soltaste ${name} en ${kind === "item" ? whereItem(draft, id) : whereGroup(draft, id)}.`);
      }
      return;
    }
    if (!isMine) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const next = kind === "item" ? moveItemBy(draft, id, dir) : moveGroupBy(draft, id, dir);
      if (next === draft) {
        setLive(dir < 0 ? "Ya está arriba de todo." : "Ya está abajo de todo.");
        return;
      }
      setDraft(next);
      setLive(`${name}: ${kind === "item" ? whereItem(next, id) : whereGroup(next, id)}.`);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDraft(picked.snapshot);
      setPicked(null);
      setLive(`Cancelado. ${name} volvió a su lugar.`);
    }
  }

  function onToggleHidden(id: string) {
    const next = toggleHidden(draft, id, defaults);
    setDraft(next);
    onChange(next);
    const nowHidden = findContainer(next, id) === HIDDEN_ID;
    setLive(nowHidden ? `${itemLabel(id)} pasó a Ocultos.` : `${itemLabel(id)} volvió a ${labelOf(findContainer(next, id) ?? "")}.`);
  }

  // ---------------------------------------------------------------- arrastre
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );

  const collision: CollisionDetection = (args) => {
    const type = args.active.data.current?.type;
    const typeOf = (id: UniqueIdentifier) =>
      args.droppableContainers.find((d) => d.id === id)?.data.current?.type;
    if (type === "group") {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === "group"),
      });
    }
    const cands = args.droppableContainers.filter((c) => c.data.current?.type !== "group");
    const inside = pointerWithin({ ...args, droppableContainers: cands });
    const hitItems = inside.filter((c) => typeOf(c.id) === "item");
    if (hitItems.length) {
      return closestCenter({ ...args, droppableContainers: cands.filter((c) => hitItems.some((h) => h.id === c.id)) });
    }
    if (inside.length) return inside;
    return closestCenter({ ...args, droppableContainers: cands.filter((c) => c.data.current?.type === "item") });
  };

  function overContainer(l: MenuLayout, over: DragOverEvent["over"]): string | null {
    if (!over) return null;
    if (over.data.current?.type === "list") return over.data.current.container as string;
    return findContainer(l, String(over.id));
  }

  function onDragStart({ active }: DragStartEvent) {
    snapshot.current = draft;
    setPicked(null);
    setActiveId(String(active.id));
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (active.data.current?.type !== "item" || !over) return;
    const id = String(active.id);
    setDraft((l) => {
      const from = findContainer(l, id);
      const to = overContainer(l, over);
      if (!from || !to || from === to) return l;
      const list = itemsOf(l, to);
      let index = list.length;
      if (over.data.current?.type === "item") {
        const oi = list.indexOf(String(over.id));
        const r = active.rect.current.translated;
        const below = r ? r.top + r.height / 2 > over.rect.top + over.rect.height / 2 : false;
        index = oi < 0 ? list.length : oi + (below ? 1 : 0);
      }
      return placeItem(l, id, to, index);
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    const id = String(active.id);
    let next = draft;
    if (active.data.current?.type === "group") {
      const gid = id.slice(G.length);
      if (over && String(over.id).startsWith(G)) {
        const target = String(over.id).slice(G.length);
        next = placeGroup(draft, gid, draft.groups.findIndex((g) => g.id === target));
      }
    } else if (over) {
      const cid = findContainer(draft, id);
      if (cid && over.data.current?.type === "item" && findContainer(draft, String(over.id)) === cid) {
        next = placeItem(draft, id, cid, itemsOf(draft, cid).indexOf(String(over.id)));
      }
    }
    setDraft(next);
    onChange(next);
  }

  function onDragCancel() {
    setActiveId(null);
    setDraft(snapshot.current);
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Tomaste ${nameOfDnd(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${nameOfDnd(active.id)} sobre ${nameOfDnd(over.id)}.` : undefined),
    onDragEnd: ({ active }) => `Soltaste ${nameOfDnd(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelado. ${nameOfDnd(active.id)} volvió a su lugar.`,
  };
  function nameOfDnd(id: UniqueIdentifier) {
    const s = String(id);
    if (s.startsWith(G)) return `Grupo ${labelOf(s.slice(G.length))}`;
    if (s.startsWith(L)) return labelOf(s.slice(L.length));
    return itemLabel(s);
  }

  const titled = draft.groups.filter((g) => g.id !== TOP_GROUP);
  const top = draft.groups.find((g) => g.id === TOP_GROUP);
  const activeIsGroup = activeId?.startsWith(G);
  const ctx: Ctx = { items, picked, activeId, onHandleKey, onToggleHidden };

  // El overlay queda montado siempre (lo pide dnd-kit para la animación de
  // soltar) y va a <body>: el aside tiene backdrop-filter, que rompe el fixed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const overlay = mounted
    ? createPortal(
        <DragOverlay>
          {activeId && activeIsGroup ? (
            <div className="scale-[1.03] rounded-lg border border-border bg-popover px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
              {labelOf(activeId.slice(G.length))}
            </div>
          ) : activeId && items[activeId] ? (
            <div className="scale-[1.03] cursor-grabbing">
              <ItemBody item={items[activeId]} floating />
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )
    : null;

  return (
    <div ref={rootRef} className="space-y-1" data-testid="menu-customizer">
      <div className="sticky top-0 z-10 mb-2 rounded-lg border border-border bg-popover p-2.5">
        <p className="text-sm font-semibold text-foreground">Personalizar menú</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
          Arrastrá para ordenar o pasá a Ocultos lo que no uses. En el celular, mantené apretado.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={!canReset}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <RotateCcw size={14} aria-hidden /> Restablecer
          </button>
          <button
            type="button"
            onClick={onDone}
            className="ml-auto inline-flex h-9 items-center rounded-lg bg-[var(--pos-solid)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--pos-solid-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Listo
          </button>
        </div>
      </div>

      <div aria-live="assertive" role="status" className="sr-only" data-testid="menu-live">
        {live}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        autoScroll={{ threshold: { x: 0, y: 0.12 } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Para moverlo con el teclado, apretá Espacio, usá las flechas y volvé a apretar Espacio. Escape cancela.",
          },
        }}
      >
        {/* Inicio queda fijo arriba: es la salida segura del menú. */}
        <div className="flex items-center gap-1 rounded-lg" title="Inicio queda siempre primero">
          <span className="grid h-8 w-7 shrink-0 place-items-center text-muted-foreground/50">
            <Pin size={13} aria-hidden />
          </span>
          <span className="flex flex-1 items-center gap-3 px-2 py-2 text-sm text-muted-foreground">
            <LayoutDashboard size={17} aria-hidden />
            <span className="flex-1">Inicio</span>
            <span className="text-[11px]">Fijo</span>
          </span>
        </div>
        {top && <ItemList cid={TOP_GROUP} ids={top.items} ctx={ctx} empty="Soltá acá para dejarlo arriba" />}

        <SortableContext items={titled.map((g) => G + g.id)} strategy={verticalListSortingStrategy}>
          {titled.map((g) => (
            <SortableGroup key={g.id} id={g.id} label={labelOf(g.id)} ids={g.items} ctx={ctx} />
          ))}
        </SortableContext>

        <div className="pt-3">
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <EyeOff size={13} aria-hidden />
            {HIDDEN_LABEL}
            <span className="rounded-md bg-muted px-1.5 text-[10px] tabular-nums">{draft.hidden.length}</span>
          </div>
          <ItemList cid={HIDDEN_ID} ids={draft.hidden} ctx={ctx} empty="Arrastrá acá lo que no uses" />
        </div>
        {overlay}
      </DndContext>
    </div>
  );
}

type Ctx = {
  items: Record<string, CustomizerItem>;
  picked: Picked | null;
  activeId: string | null;
  onHandleKey: (e: React.KeyboardEvent, kind: "item" | "group", id: string) => void;
  onToggleHidden: (id: string) => void;
};

function SortableGroup({ id, label, ids, ctx }: { id: string; label: string; ids: string[]; ctx: Ctx }) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: G + id,
    data: { type: "group" },
  });
  const lifted = ctx.picked?.kind === "group" && ctx.picked.id === id;
  return (
    <div
      ref={setNodeRef}
      style={transformStyle(transform, transition)}
      className={cn("rounded-lg pt-3", isDragging && "nav-drop-placeholder", lifted && "nav-drop-placeholder is-lifted")}
    >
      <div
        {...listeners}
        className="flex cursor-grab touch-manipulation select-none items-center gap-1 rounded-md px-1 [-webkit-touch-callout:none] active:cursor-grabbing"
      >
        <button
          type="button"
          {...attributes}
          aria-roledescription="grupo movible"
          aria-pressed={lifted}
          aria-label={`Mover grupo ${label}`}
          data-nav-handle={`group:${id}`}
          onKeyDown={(e) => ctx.onHandleKey(e, "group", id)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <GripVertical size={14} aria-hidden />
        </button>
        <span className="flex-1 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </span>
      </div>
      <ItemList cid={id} ids={ids} ctx={ctx} empty="Soltá un ítem acá" />
    </div>
  );
}

function ItemList({ cid, ids, ctx, empty }: { cid: string; ids: string[]; ctx: Ctx; empty: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: L + cid, data: { type: "list", container: cid } });
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="mt-1 min-h-[2.5rem] space-y-1" data-container={cid}>
        {ids.map((id) => (ctx.items[id] ? <SortableItem key={id} item={ctx.items[id]} hidden={cid === HIDDEN_ID} ctx={ctx} /> : null))}
        {ids.length === 0 && (
          <p
            className={cn(
              "rounded-lg border border-dashed border-border px-3 py-2.5 text-center text-xs text-muted-foreground transition",
              isOver && "bg-muted text-foreground",
            )}
          >
            {empty}
          </p>
        )}
      </div>
    </SortableContext>
  );
}

function SortableItem({ item, hidden, ctx }: { item: CustomizerItem; hidden: boolean; ctx: Ctx }) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: item.id,
    data: { type: "item" },
  });
  const lifted = ctx.picked?.kind === "item" && ctx.picked.id === item.id;
  return (
    <div
      ref={setNodeRef}
      style={transformStyle(transform, transition)}
      className={cn("rounded-lg", isDragging && "nav-drop-placeholder", lifted && "nav-drop-placeholder is-lifted")}
      data-nav-item={item.id}
    >
      <div
        {...listeners}
        className="flex cursor-grab touch-manipulation select-none items-center gap-1 rounded-lg [-webkit-touch-callout:none] active:cursor-grabbing"
      >
        <button
          type="button"
          {...attributes}
          aria-roledescription="ítem movible"
          aria-pressed={lifted}
          aria-label={`Mover ${item.label}`}
          data-nav-handle={`item:${item.id}`}
          onKeyDown={(e) => ctx.onHandleKey(e, "item", item.id)}
          className="grid h-8 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <GripVertical size={14} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <ItemBody item={item} />
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={() => ctx.onToggleHidden(item.id)}
          aria-label={hidden ? `Mostrar ${item.label}` : `Ocultar ${item.label}`}
          title={hidden ? "Mostrar en el menú" : "Pasar a Ocultos"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
        </button>
      </div>
    </div>
  );
}

function ItemBody({ item, floating = false }: { item: CustomizerItem; floating?: boolean }) {
  const Icon = item.icon;
  return (
    <span
      className={cn(
        "flex items-center gap-3 rounded-lg px-2 py-2 text-sm",
        floating ? "border border-border bg-popover px-3 text-foreground" : "text-muted-foreground",
        item.locked && "text-muted-foreground/60",
      )}
    >
      <Icon size={17} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.locked && <Lock size={13} className="text-ninja-flameSoft" aria-hidden />}
    </span>
  );
}

export default MenuCustomizer;
