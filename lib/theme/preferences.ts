"use client";

import { createClient } from "@/lib/supabase/client";

// Preferencias de UI persistidas en public.users.settings (cross-device).
export interface UiPrefs {
  theme?: string;
  display?: string;
  price?: string;
  bg?: string;
}

const KEYS = {
  theme: "ninja-theme",
  display: "ninja-display",
  price: "ninja-price",
  bg: "ninja-bg",
};

export function readLocalPrefs(): UiPrefs {
  if (typeof window === "undefined") return {};
  const g = (k: string) => localStorage.getItem(k) ?? undefined;
  return {
    theme: g(KEYS.theme),
    display: g(KEYS.display),
    price: g(KEYS.price),
    bg: g(KEYS.bg),
  };
}

/** Escribe en Supabase las prefs actuales (lee del localStorage ya actualizado). */
export async function persistPrefs(): Promise<void> {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    await supabase
      .from("users")
      .update({ settings: readLocalPrefs() as never })
      .eq("id", session.user.id);
  } catch {
    // sin sesión / sin red: queda solo en localStorage
  }
}

/** Lee las prefs guardadas del usuario logueado (o null). */
export async function loadRemotePrefs(): Promise<UiPrefs | null> {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return null;
    const { data } = await supabase
      .from("users")
      .select("settings")
      .eq("id", session.user.id)
      .maybeSingle();
    return (data?.settings as UiPrefs | null) ?? null;
  } catch {
    return null;
  }
}
