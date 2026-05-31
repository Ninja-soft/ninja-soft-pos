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
