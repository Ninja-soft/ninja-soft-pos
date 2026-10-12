"use client";

import { useEffect } from "react";
import { useTheme, THEMES, type ThemeName } from "@/lib/theme/ThemeProvider";
import {
  useAppearance,
  DISPLAY_FONTS,
  PRICE_FONTS,
  BG_STYLES,
  PRICE_ACCENTS,
  type DisplayFont,
  type PriceFont,
  type BgStyle,
  type PriceAccent,
} from "@/lib/theme/AppearanceProvider";
import { loadRemotePrefs, readLocalPrefs } from "@/lib/theme/preferences";

// Al montar (logueado), trae las preferencias del usuario desde Supabase y las
// aplica → funcionan en cualquier dispositivo. El primer cuadro ya usa la copia
// local (scripts anti-FOUC de app/layout.tsx); acá sólo se toca lo que el
// servidor tenga DISTINTO, y sin volver a escribirlo: antes cada setter
// re-persistía las prefs locales a medio aplicar y las escrituras concurrentes
// podían pisar el valor remoto con el viejo (tema o fuente que "vuelve").
export function PrefsLoader() {
  const { setTheme } = useTheme();
  const { setDisplay, setPrice, setBg, setPriceAccent } = useAppearance();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await loadRemotePrefs();
      if (!p || cancelled) return;
      const local = readLocalPrefs();
      const quiet = { persist: false } as const;
      if (p.theme && p.theme !== local.theme && THEMES.some((t) => t.name === p.theme)) {
        setTheme(p.theme as ThemeName, quiet);
      }
      if (p.display && p.display !== local.display && p.display in DISPLAY_FONTS) {
        setDisplay(p.display as DisplayFont, quiet);
      }
      if (p.price && p.price !== local.price && p.price in PRICE_FONTS) {
        setPrice(p.price as PriceFont, quiet);
      }
      if (p.bg && p.bg !== local.bg && p.bg in BG_STYLES) {
        setBg(p.bg as BgStyle, quiet);
      }
      if (p.priceAccent && p.priceAccent !== local.priceAccent && p.priceAccent in PRICE_ACCENTS) {
        setPriceAccent(p.priceAccent as PriceAccent, quiet);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setTheme, setDisplay, setPrice, setBg, setPriceAccent]);

  return null;
}
