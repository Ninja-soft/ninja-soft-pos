"use client";

import { createClient } from "@/lib/supabase/client";

// Preferencias de UI persistidas en public.users.settings (cross-device).
export interface UiPrefs {
  theme?: string;
  display?: string;
  price?: string;
  bg?: string;
  priceAccent?: string;
}

const KEYS = {
  theme: "ninja-theme",
  display: "ninja-display",
  price: "ninja-price",
  bg: "ninja-bg",
  priceAccent: "ninja-price-accent",
};

export function readLocalPrefs(): UiPrefs {
  if (typeof window === "undefined") return {};
  const g = (k: string) => localStorage.getItem(k) ?? undefined;
  return {
    theme: g(KEYS.theme),
    display: g(KEYS.display),
    price: g(KEYS.price),
    bg: g(KEYS.bg),
    priceAccent: g(KEYS.priceAccent),
  };
}

async function readRemoteSettings(): Promise<Record<string, unknown>> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return {};
  const { data } = await supabase
    .from("users")
    .select("settings")
    .eq("id", session.user.id)
    .maybeSingle();
  return (data?.settings as Record<string, unknown> | null) ?? {};
}

/** Merge de un patch en public.users.settings (no pisa otras claves). */
async function patchRemoteSettings(patch: Record<string, unknown>): Promise<void> {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const current = await readRemoteSettings();
    await supabase
      .from("users")
      .update({ settings: { ...current, ...patch } as never })
      .eq("id", session.user.id);
  } catch {
    // sin sesión / sin red
  }
}

/** Escribe las prefs de apariencia (merge; conserva otras claves como reports). */
export async function persistPrefs(): Promise<void> {
  await patchRemoteSettings(readLocalPrefs() as Record<string, unknown>);
}

/** Lee las prefs guardadas del usuario logueado (o null). */
export async function loadRemotePrefs(): Promise<UiPrefs | null> {
  try {
    const s = await readRemoteSettings();
    return s as UiPrefs;
  } catch {
    return null;
  }
}

// --- Preferencias de reportes (TX-5): qué reportes ver, por usuario. ---
export type ReportPrefs = Record<string, boolean>;

export async function loadReportPrefs(): Promise<ReportPrefs | null> {
  try {
    const s = await readRemoteSettings();
    return (s.reports as ReportPrefs | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveReportPrefs(prefs: ReportPrefs): Promise<void> {
  await patchRemoteSettings({ reports: prefs });
}

// --- Orden y filtros guardados de reportes (TX-5 · ADR-100). Sin sanear acá:
// lo sanea lib/reports/savedFilters.ts (resolveOrder / sanitizePresets).
export interface ReportSettingsRaw {
  visibility: ReportPrefs | null;
  order: unknown;
  presets: unknown;
}

/** Una sola lectura de users.settings para todo lo de Reportes. */
export async function loadReportSettings(): Promise<ReportSettingsRaw> {
  try {
    const s = await readRemoteSettings();
    return {
      visibility: (s.reports as ReportPrefs | undefined) ?? null,
      order: s.reports_order ?? null,
      presets: s.report_presets ?? null,
    };
  } catch {
    return { visibility: null, order: null, presets: null };
  }
}

export async function saveReportOrder(order: string[]): Promise<void> {
  await patchRemoteSettings({ reports_order: order });
}

export async function saveReportPresets(state: { presets: unknown[]; defaultId: string | null }): Promise<void> {
  await patchRemoteSettings({ report_presets: state });
}

// --- Diseño del POS por usuario (override de pos_settings.pos_layout). ---
// Sin validar acá: lo sanea resolveLayout (lib/pos/layout.ts). null = usa el
// diseño del negocio.
export async function loadPosLayoutPref(): Promise<unknown> {
  try {
    const s = await readRemoteSettings();
    return s.pos_layout ?? null;
  } catch {
    return null;
  }
}

export async function savePosLayoutPref(layout: Record<string, unknown> | null): Promise<void> {
  await patchRemoteSettings({ pos_layout: layout });
}

// --- Menú lateral personalizado (ADR-134): orden y ocultos por usuario y por
// negocio, en settings.nav_menu = { [tenantId]: layout }. Sin validar acá: lo
// sanea lib/nav/menuLayout.ts (sanitizeLayout + mergeLayout).
export async function loadNavMenuPref(tenantKey: string): Promise<unknown> {
  try {
    const s = await readRemoteSettings();
    const all = (s.nav_menu ?? null) as Record<string, unknown> | null;
    return all && typeof all === "object" ? (all[tenantKey] ?? null) : null;
  } catch {
    return null;
  }
}

/** null borra la personalización de ese negocio (vuelve al menú por defecto). */
export async function saveNavMenuPref(tenantKey: string, layout: unknown): Promise<void> {
  try {
    const s = await readRemoteSettings();
    const all = { ...((s.nav_menu ?? {}) as Record<string, unknown>) };
    if (layout === null) delete all[tenantKey];
    else all[tenantKey] = layout;
    await patchRemoteSettings({ nav_menu: all });
  } catch {
    // sin sesión / sin red: queda la caché local
  }
}
