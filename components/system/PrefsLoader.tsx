"use client";

import { useEffect } from "react";
import { useTheme, THEMES, type ThemeName } from "@/lib/theme/ThemeProvider";
import {
  useAppearance,
  DISPLAY_FONTS,
  PRICE_FONTS,
  BG_STYLES,
  type DisplayFont,
  type PriceFont,
  type BgStyle,
} from "@/lib/theme/AppearanceProvider";
import { loadRemotePrefs } from "@/lib/theme/preferences";

// Al montar (logueado), trae las preferencias del usuario desde Supabase y las
// aplica → funcionan en cualquier dispositivo.
export function PrefsLoader() {
  const { setTheme } = useTheme();
  const { setDisplay, setPrice, setBg } = useAppearance();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await loadRemotePrefs();
      if (!p || cancelled) return;
      if (p.theme && THEMES.some((t) => t.name === p.theme)) {
        setTheme(p.theme as ThemeName);
      }
      if (p.display && p.display in DISPLAY_FONTS) {
        setDisplay(p.display as DisplayFont);
      }
      if (p.price && p.price in PRICE_FONTS) {
        setPrice(p.price as PriceFont);
      }
      if (p.bg && p.bg in BG_STYLES) {
        setBg(p.bg as BgStyle);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setTheme, setDisplay, setPrice, setBg]);

  return null;
}
