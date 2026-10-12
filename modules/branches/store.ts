"use client";

import { create } from "zustand";
import { ALL_BRANCHES, type BranchSelection } from "./logic";

// Contexto "dónde estoy" (F17 · H90), recordado por usuario y negocio en este
// dispositivo (localStorage). Guarda:
//   - selection: filtro del panel ("all" = todas las sucursales).
//   - posStoreId: sucursal donde vende este dispositivo.
//   - registerByStore: caja que usa este dispositivo en cada sucursal.
// activeShiftId no se persiste: lo actualiza useOpenShift y lo leen los RPC de
// venta, devolución y cambio para mandar el turno de la caja en uso.

interface Persisted {
  selection: BranchSelection | null;
  posStoreId: string | null;
  registerByStore: Record<string, string>;
}

interface BranchState extends Persisted {
  scopeKey: string | null;
  activeShiftId: string | null;
  hydrate: (scopeKey: string) => void;
  setSelection: (s: BranchSelection) => void;
  setPosLocation: (storeId: string, registerId?: string | null) => void;
  setActiveShiftId: (id: string | null) => void;
}

const EMPTY: Persisted = { selection: null, posStoreId: null, registerByStore: {} };
const PREFIX = "ninja.branch.v1.";

function read(key: string): Persisted {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<Persisted>;
    return {
      selection: typeof v.selection === "string" ? v.selection : null,
      posStoreId: typeof v.posStoreId === "string" ? v.posStoreId : null,
      registerByStore:
        v.registerByStore && typeof v.registerByStore === "object" ? v.registerByStore : {},
    };
  } catch {
    return EMPTY;
  }
}

function write(key: string | null, p: Persisted) {
  if (!key) return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(p));
  } catch {
    // Sin storage (modo privado): el contexto vive sólo en memoria.
  }
}

const pick = (s: BranchState): Persisted => ({
  selection: s.selection,
  posStoreId: s.posStoreId,
  registerByStore: s.registerByStore,
});

export const useBranchStore = create<BranchState>((set, get) => ({
  ...EMPTY,
  scopeKey: null,
  activeShiftId: null,
  hydrate: (scopeKey) => {
    if (get().scopeKey === scopeKey) return;
    set({ scopeKey, ...read(scopeKey), activeShiftId: null });
  },
  setSelection: (selection) => {
    set({ selection });
    // Elegir una sucursal concreta en el panel también mueve el POS ahí,
    // salvo que este dispositivo tenga un turno abierto (no se cambia de
    // sucursal con la caja abierta).
    if (selection !== ALL_BRANCHES && !get().activeShiftId) set({ posStoreId: selection });
    write(get().scopeKey, pick(get()));
  },
  setPosLocation: (storeId, registerId) => {
    const registerByStore = { ...get().registerByStore };
    if (registerId) registerByStore[storeId] = registerId;
    set({ posStoreId: storeId, registerByStore });
    write(get().scopeKey, pick(get()));
  },
  setActiveShiftId: (activeShiftId) => {
    if (get().activeShiftId !== activeShiftId) set({ activeShiftId });
  },
}));

// Turno de la caja en uso (para los RPC). Fuera de React.
export function getActiveShiftId(): string | null {
  return useBranchStore.getState().activeShiftId;
}
