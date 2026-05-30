"use client";

import { Eyebrow, Display, Heading } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/utils/cn";
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
import { formatCurrency } from "@/lib/utils/format";

const THEME_SWATCH: Record<ThemeName, { bg: string; a: string; b: string }> = {
  "ninja-dark": { bg: "#0a0518", a: "#ff5a2c", b: "#ffd21f" },
  "ninja-noir": { bg: "#0b0c0f", a: "#ff5a2c", b: "#ffc23d" },
  "ninja-light": { bg: "#f6f5fc", a: "#e8431b", b: "#e8a400" },
  "ninja-sand": { bg: "#fbf7f1", a: "#e8431b", b: "#e08900" },
};

function Section({
  kicker,
  title,
  desc,
  children,
}: {
  kicker: string;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <Eyebrow>{kicker}</Eyebrow>
          <Heading as="h2" className="mt-2 text-base md:text-lg">
            {title}
          </Heading>
          {desc && <p className="mt-1 text-sm text-muted-foreground">{desc}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export default function ConfiguracionPage() {
  const { theme, setTheme } = useTheme();
  const { display, price, bg, setDisplay, setPrice, setBg } = useAppearance();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Eyebrow>Preferencias</Eyebrow>
      <Display className="mt-3">Configuración</Display>
      <p className="mt-2 text-muted-foreground">
        Diseño del sistema. Los cambios se aplican al instante y se guardan en
        este dispositivo.
      </p>

      <div className="mt-8 space-y-5">
        <Section
          kicker="Diseño"
          title="Tema"
          desc="Elegí la paleta de toda la aplicación."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {THEMES.map((t) => {
              const sw = THEME_SWATCH[t.name];
              const active = theme === t.name;
              return (
                <button
                  key={t.name}
                  onClick={() => setTheme(t.name)}
                  className={cn(
                    "group rounded-xl border p-2 text-left transition",
                    active
                      ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                      : "border-border hover:border-ninja-flameSoft/40",
                  )}
                >
                  <div
                    className="relative h-14 w-full overflow-hidden rounded-lg"
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
                  <div className="mt-2 truncate text-xs font-medium">
                    {t.label}
                  </div>
                </button>
              );
            })}
          </div>
        </Section>

        <Section
          kicker="Tipografía"
          title="Fuente de títulos"
          desc="Para encabezados y destacados."
        >
          <Segmented
            value={display}
            onChange={(v) => setDisplay(v as DisplayFont)}
            options={Object.entries(DISPLAY_FONTS).map(([k, v]) => ({
              value: k,
              label: v.label,
              preview: (
                <span style={{ fontFamily: `var(${v.var})` }}>{v.label}</span>
              ),
            }))}
          />
        </Section>

        <Section
          kicker="Tipografía"
          title="Fuente de precios"
          desc="Para montos y números."
        >
          <div className="flex flex-col gap-3">
            <Segmented
              value={price}
              onChange={(v) => setPrice(v as PriceFont)}
              options={Object.entries(PRICE_FONTS).map(([k, v]) => ({
                value: k,
                label: v.label,
                preview: (
                  <span style={{ fontFamily: `var(${v.var})` }}>{v.label}</span>
                ),
              }))}
            />
            <span className="font-price text-2xl font-bold tabular-nums text-ninja-gold">
              {formatCurrency(1234567.89)}
            </span>
          </div>
        </Section>

        <Section
          kicker="Atmósfera"
          title="Fondo"
          desc="Patrón del fondo de las pantallas."
        >
          <Segmented
            value={bg}
            onChange={(v) => setBg(v as BgStyle)}
            options={Object.entries(BG_STYLES).map(([k, v]) => ({
              value: k,
              label: v,
            }))}
          />
        </Section>
      </div>
    </div>
  );
}
