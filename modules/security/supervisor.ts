"use client";

import { create } from "zustand";
import {
  supervisorRequiredAction,
  type PinAction,
} from "@/lib/security/pinPolicy";
import { withSupervisorToken } from "@/lib/security/supervisorToken";

// Pedido global de autorización de supervisor (F17 · H116, ADR-051).
// Cualquier flujo (POS, Caja, Ventas) puede envolver su llamada al servidor en
// withSupervisor(): si el servidor contesta 'supervisor_required:<acción>',
// se abre el diálogo de PIN (SupervisorPinHost, montado en el AppShell), se
// obtiene el token y se reintenta la MISMA llamada con el header.

export class SupervisorCancelled extends Error {
  constructor() {
    super("supervisor_cancelled");
    this.name = "SupervisorCancelled";
  }
}

export interface SupervisorRequest {
  action: PinAction;
  amount: number | null;
  context?: string;
  resolve: (token: string) => void;
  reject: (e: Error) => void;
}

interface PromptState {
  request: SupervisorRequest | null;
  open: (r: SupervisorRequest) => void;
  close: () => void;
}

export const useSupervisorPrompt = create<PromptState>((set) => ({
  request: null,
  open: (r) => set({ request: r }),
  close: () => set({ request: null }),
}));

/** Abre el diálogo de PIN y espera el token (o SupervisorCancelled). */
export function requestSupervisorToken(
  action: PinAction,
  amount: number | null,
  context?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const prev = useSupervisorPrompt.getState().request;
    if (prev) prev.reject(new SupervisorCancelled());
    useSupervisorPrompt.getState().open({
      action,
      amount,
      context,
      resolve: (t) => {
        useSupervisorPrompt.getState().close();
        resolve(t);
      },
      reject: (e) => {
        useSupervisorPrompt.getState().close();
        reject(e);
      },
    });
  });
}

export type SupervisorAmounts = Partial<Record<PinAction, number | null>>;

/**
 * Corre `fn`; si el servidor pide supervisor, pide el PIN y la reintenta con el
 * token. `amounts` da el monto de cada acción posible (el token queda atado a
 * ese monto). `pre` fuerza pedir el PIN antes de intentar (cuando la UI ya sabe
 * que hace falta).
 */
export async function withSupervisor<T>(
  fn: () => Promise<T>,
  amounts: SupervisorAmounts | (() => Promise<SupervisorAmounts>) = {},
  opts: { pre?: PinAction | null; context?: string } = {},
): Promise<T> {
  const resolveAmounts = async () =>
    typeof amounts === "function" ? await amounts() : amounts;
  if (opts.pre) {
    const a = await resolveAmounts();
    const token = await requestSupervisorToken(
      opts.pre,
      a[opts.pre] ?? null,
      opts.context,
    );
    return withSupervisorToken(token, fn);
  }
  try {
    return await fn();
  } catch (e) {
    const action = supervisorRequiredAction(e);
    if (!action) throw e;
    const a = await resolveAmounts();
    const token = await requestSupervisorToken(
      action,
      a[action] ?? null,
      opts.context,
    );
    return withSupervisorToken(token, fn);
  }
}
