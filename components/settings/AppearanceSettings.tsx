"use client";

import { Segmented } from "@/components/ui/Segmented";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { cn } from "@/lib/utils/cn";
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
import { formatCurrency } from "@/lib/utils/format";

const THEME_SWATCH: Record<ThemeName, { bg: string; a: string; b: string }> = {
  "ninja-dark": { bg: "#0a0518", a: "#ff5a2c", b: "#ffd21f" },
  "ninja-noir": { bg: "#0b0c0f", a: "#ff5a2c", b: "#ffc23d" },
  "ninja-light": { bg: "#f6f5fc", a: "#e8431b", b: "#e8a400" },
  "ninja-sand": { bg: "#fbf7f1", a: "#e8431b", b: "#e08900" },
};

// Preview del patrón de fondo sobre un mini tile oscuro.
const BG_PREVIEW: Record<BgStyle, React.CSSProperties> = {
  dots: {
    backgroundImage: "radial-gradient(rgba(255,255,255,0.35) 1px, transparent 1px)",
    backgroundSize: "9px 9px",
  },
  grid: {
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.28) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.28) 1px, transparent 1px)",
    backgroundSize: "12px 12px",
  },
  crosses: {
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.2) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(255,255,255,0.2) 1.5px, transparent 1.5px), linear-gradient(rgba(255,75,34,0.6) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(255,75,34,0.6) 1.5px, transparent 1.5px)",
    backgroundSize: "14px 14px, 14px 14px, 42px 42px, 42px 42px",
  },
  diagonal: {
    backgroundImage:
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.28) 0, rgba(255,255,255,0.28) 1px, transparent 1px, transparent 8px)",
  },
  mesh: {
    backgroundImage:
      "radial-gradient(circle at 25% 20%, rgba(255,75,34,0.5), transparent 45%), radial-gradient(circle at 80% 30%, rgba(95,58,214,0.6), transparent 50%)",
  },
};

// Apariencia personal: tema, tipografías, resalte de precios y fondo. Cada
// cambio se aplica al instante (AppearanceProvider / ThemeProvider).
export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const { display, price, bg, priceAccent, setDisplay, setPrice, setBg, setPriceAccent } =
    useAppearance();

  return (
    <>
      <SettingsCard title="Tema y fondo" description="Colores base de la app y patrón de las pantallas.">
        <SettingRow label="Tema" description="Oscuro para el salón o la noche, claro para mostradores con mucha luz.">
          <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
            {THEMES.map((t) => {
              const sw = THEME_SWATCH[t.name];
              const active = theme === t.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTheme(t.name)}
                  className={cn(
                    "rounded-lg border p-2 text-left transition",
                    active ? "choice-on choice-check" : "border-border hover:bg-muted",
                  )}
                >
                  <div
                    className="relative h-14 w-full overflow-hidden rounded-md border border-black/5"
                    style={{ background: sw.bg }}
                  >
                    <span
                      className="absolute bottom-2 left-2 h-3 w-3 rounded-full"
                      style={{ background: sw.a }}
                    />
                    <span
                      className="absolute bottom-2 left-6 h-3 w-3 rounded-full"
                      style={{ background: sw.b }}
                    />
                  </div>
                  <div className="mt-2 text-xs font-medium">{t.label}</div>
                </button>
              );
            })}
          </div>
        </SettingRow>

        <SettingRow label="Fondo" description="Patrón sutil detrás de las pantallas del panel.">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            {(Object.keys(BG_STYLES) as BgStyle[]).map((k) => {
              const active = bg === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBg(k)}
                  className={cn(
                    "rounded-lg border p-2 text-left transition",
                    active ? "choice-on choice-check" : "border-border hover:bg-muted",
                  )}
                >
                  <div
                    className="h-11 w-full rounded-md border border-black/10"
                    style={{ backgroundColor: "#14102e", ...BG_PREVIEW[k] }}
                  />
                  <div className="mt-1.5 truncate text-xs font-medium">{BG_STYLES[k]}</div>
                </button>
              );
            })}
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Tipografía y precios" description="Cómo se leen los títulos y los importes.">
        <SettingRow label="Fuente de títulos" description="Se usa en encabezados y nombres destacados.">
          <Segmented
            aria-label="Fuente de títulos"
            value={display}
            onChange={(v) => setDisplay(v as DisplayFont)}
            options={Object.entries(DISPLAY_FONTS).map(([k, v]) => ({
              value: k,
              label: v.label,
              preview: <span style={{ fontFamily: `var(${v.var})` }}>{v.label}</span>,
            }))}
          />
          <p
            className="mt-3 text-xl font-extrabold tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Ninja Pos es ágil y seguro
          </p>
        </SettingRow>

        <SettingRow label="Fuente de precios" description="Para importes, totales y tickets en pantalla.">
          <Segmented
            aria-label="Fuente de precios"
            value={price}
            onChange={(v) => setPrice(v as PriceFont)}
            options={Object.entries(PRICE_FONTS).map(([k, v]) => ({
              value: k,
              label: v.label,
              preview: <span style={{ fontFamily: `var(${v.var})` }}>{v.label}</span>,
            }))}
          />
          <p className="price-hl mt-3 font-price text-xl font-bold tabular-nums">
            {formatCurrency(1234567.89)}
          </p>
        </SettingRow>

        <SettingRow label="Resalte de precios" description="Color con el que se destacan los montos.">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PRICE_ACCENTS) as PriceAccent[]).map((k) => {
              const active = priceAccent === k;
              const swatch = PRICE_ACCENTS[k].gradient;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPriceAccent(k)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                    active ? "choice-on" : "border-border hover:bg-muted",
                  )}
                >
                  <span
                    className="h-4 w-4 rounded-full border border-black/10"
                    style={{ background: swatch || "var(--foreground)" }}
                  />
                  {PRICE_ACCENTS[k].label}
                </button>
              );
            })}
          </div>
          <p className="price-hl mt-3 font-price text-xl font-bold tabular-nums">
            {formatCurrency(98765.43)}
          </p>
        </SettingRow>
      </SettingsCard>
    </>
  );
}
AppearanceSettings.displayName = "AppearanceSettings";
