"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { persistPrefs } from "./preferences";

export type DisplayFont = "sora" | "bricolage" | "syne" | "outfit";
export type PriceFont = "inter" | "spacemono" | "plexmono" | "jetbrains";
export type BgStyle = "dots" | "grid" | "crosses" | "diagonal" | "mesh";

export const DISPLAY_FONTS: Record<DisplayFont, { var: string; label: string }> = {
  sora: { var: "--font-sora", label: "Sora" },
  bricolage: { var: "--font-bricolage", label: "Bricolage Grotesque" },
  syne: { var: "--font-syne", label: "Syne" },
  outfit: { var: "--font-outfit", label: "Outfit" },
};
export const PRICE_FONTS: Record<PriceFont, { var: string; label: string }> = {
  inter: { var: "--font-inter", label: "Inter tabular" },
  spacemono: { var: "--font-spacemono", label: "Space Mono" },
  plexmono: { var: "--font-plexmono", label: "IBM Plex Mono" },
  jetbrains: { var: "--font-jetbrains", label: "JetBrains Mono" },
};
export const BG_STYLES: Record<BgStyle, string> = {
  dots: "Dot grid",
  grid: "Grid de líneas",
  crosses: "Cruces tech",
  diagonal: "Diagonales",
  mesh: "Mesh / glow",
};

const KEYS = { display: "ninja-display", price: "ninja-price", bg: "ninja-bg" };
const DEFAULTS = { display: "sora", price: "inter", bg: "dots" } as const;

interface AppearanceValue {
  display: DisplayFont;
  price: PriceFont;
  bg: BgStyle;
  setDisplay: (v: DisplayFont) => void;
  setPrice: (v: PriceFont) => void;
  setBg: (v: BgStyle) => void;
}

const Ctx = createContext<AppearanceValue | null>(null);

function applyDisplay(v: DisplayFont) {
  document.documentElement.style.setProperty(
    "--font-display",
    `var(${DISPLAY_FONTS[v].var})`,
  );
}
function applyPrice(v: PriceFont) {
  document.documentElement.style.setProperty(
    "--font-price",
    `var(${PRICE_FONTS[v].var})`,
  );
}
function applyBg(v: BgStyle) {
  document.documentElement.setAttribute("data-bg", v);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [display, setDisplayS] = useState<DisplayFont>(DEFAULTS.display);
  const [price, setPriceS] = useState<PriceFont>(DEFAULTS.price);
  const [bg, setBgS] = useState<BgStyle>(DEFAULTS.bg);

  useEffect(() => {
    const d = localStorage.getItem(KEYS.display) as DisplayFont | null;
    const p = localStorage.getItem(KEYS.price) as PriceFont | null;
    const b = localStorage.getItem(KEYS.bg) as BgStyle | null;
    if (d && d in DISPLAY_FONTS) setDisplayS(d);
    if (p && p in PRICE_FONTS) setPriceS(p);
    if (b && b in BG_STYLES) setBgS(b);
  }, []);

  const setDisplay = useCallback((v: DisplayFont) => {
    setDisplayS(v);
    applyDisplay(v);
    try { localStorage.setItem(KEYS.display, v); } catch {}
    void persistPrefs();
  }, []);
  const setPrice = useCallback((v: PriceFont) => {
    setPriceS(v);
    applyPrice(v);
    try { localStorage.setItem(KEYS.price, v); } catch {}
    void persistPrefs();
  }, []);
  const setBg = useCallback((v: BgStyle) => {
    setBgS(v);
    applyBg(v);
    try { localStorage.setItem(KEYS.bg, v); } catch {}
    void persistPrefs();
  }, []);

  return (
    <Ctx.Provider value={{ display, price, bg, setDisplay, setPrice, setBg }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppearance(): AppearanceValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppearance dentro de <AppearanceProvider>");
  return v;
}

// Anti-FOUC: aplica fuentes/fondo antes de la hidratación.
export const appearanceInitScript = `
(function(){
  try{
    var DF={sora:'--font-sora',bricolage:'--font-bricolage',syne:'--font-syne',outfit:'--font-outfit'};
    var PF={inter:'--font-inter',spacemono:'--font-spacemono',plexmono:'--font-plexmono',jetbrains:'--font-jetbrains'};
    var d=localStorage.getItem('${KEYS.display}'); d=DF[d]?d:'${DEFAULTS.display}';
    var p=localStorage.getItem('${KEYS.price}'); p=PF[p]?p:'${DEFAULTS.price}';
    var bgs=['dots','grid','crosses','diagonal','mesh'];
    var b=localStorage.getItem('${KEYS.bg}'); b=bgs.indexOf(b)!==-1?b:'${DEFAULTS.bg}';
    var r=document.documentElement;
    r.style.setProperty('--font-display','var('+DF[d]+')');
    r.style.setProperty('--font-price','var('+PF[p]+')');
    r.setAttribute('data-bg',b);
  }catch(e){
    document.documentElement.setAttribute('data-bg','grid');
  }
})();
`;
