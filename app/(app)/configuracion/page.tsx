"use client";

import { Suspense, useState } from "react";
import { CreditCard, Palette, ReceiptText, ShieldCheck, SlidersHorizontal, Store, Tag } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
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
import { BrandingCard } from "@/components/dashboard-team/BrandingCard";
import { PaymentMethodsCard } from "@/components/dashboard-team/PaymentMethodsCard";
import { OperationSettingsCard } from "@/components/dashboard-team/OperationSettingsCard";
import { WarrantyPlansManager } from "@/components/products/WarrantyPlansManager";
import { RubroCard } from "@/components/dashboard-team/RubroCard";
import { TicketTemplatesCard } from "@/components/tickets/TicketTemplatesCard";

type Section =
  | "apariencia"
  | "rubro"
  | "marca"
  | "tickets"
  | "pagos"
  | "operacion"
  | "garantias";
const SECTIONS: { key: Section; label: string; icon: React.ElementType }[] = [
  { key: "apariencia", label: "Apariencia", icon: Palette },
  { key: "rubro", label: "Rubro del negocio", icon: Tag },
  { key: "marca", label: "Marca del negocio", icon: Store },
  { key: "tickets", label: "Tickets", icon: ReceiptText },
  { key: "pagos", label: "Medios de pago", icon: CreditCard },
  { key: "operacion", label: "Operación del POS", icon: SlidersHorizontal },
  { key: "garantias", label: "Garantías extendidas", icon: ShieldCheck },
];

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {children}
    </div>
  );
}

export default function ConfiguracionPage() {
  const { theme, setTheme } = useTheme();
  const {
    display,
    price,
    bg,
    priceAccent,
    setDisplay,
    setPrice,
    setBg,
    setPriceAccent,
  } = useAppearance();
  const [section, setSection] = useState<Section>("apariencia");

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Eyebrow>Preferencias</Eyebrow>
      <Display className="mt-3">Configuración</Display>
      <p className="mt-2 text-muted-foreground">
        Ajustá NinjaPos a tu medida. Los cambios se aplican al instante y quedan
        guardados en tu cuenta, disponibles en cualquier dispositivo.
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-[210px_1fr]">
        {/* Menú de secciones */}
        <nav className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition md:w-full",
                  active
                    ? "bg-ninja-flame/12 font-medium text-ninja-flameSoft"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon size={17} />
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Contenido de la sección */}
        <div className="min-w-0">
          {section === "apariencia" && (
            <Card>
              <CardContent className="space-y-7 p-6">
            <Field label="Tema">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {THEMES.map((t) => {
                  const sw = THEME_SWATCH[t.name];
                  const active = theme === t.name;
                  return (
                    <button
                      key={t.name}
                      onClick={() => setTheme(t.name)}
                      className={cn(
                        "rounded-lg border p-2 text-left transition",
                        active
                          ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                          : "border-border hover:border-ninja-flameSoft/40",
                      )}
                    >
                      <div
                        className="relative h-16 w-full overflow-hidden rounded-lg border border-black/5"
                        style={{ background: sw.bg }}
                      >
                        <span
                          className="absolute bottom-2 left-2 h-3.5 w-3.5 rounded-full"
                          style={{ background: sw.a }}
                        />
                        <span
                          className="absolute bottom-2 left-7 h-3.5 w-3.5 rounded-full"
                          style={{ background: sw.b }}
                        />
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            active ? "bg-ninja-flame" : "bg-transparent",
                          )}
                        />
                        {t.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Fuente de títulos">
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
              <p
                className="pt-1 text-2xl font-extrabold tracking-tight"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Ninja Pos es ágil y seguro
              </p>
            </Field>

            <Field label="Fuente de precios">
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
              <p className="price-hl pt-1 font-price text-2xl font-bold tabular-nums">
                {formatCurrency(1234567.89)}
              </p>
            </Field>

            <Field label="Resalte de precios">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(PRICE_ACCENTS) as PriceAccent[]).map((k) => {
                  const active = priceAccent === k;
                  const grad = PRICE_ACCENTS[k].gradient;
                  return (
                    <button
                      key={k}
                      onClick={() => setPriceAccent(k)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                        active
                          ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                          : "border-border hover:border-ninja-flameSoft/40",
                      )}
                    >
                      <span
                        className="h-5 w-5 rounded-full border border-black/10"
                        style={{
                          background: grad || "var(--foreground)",
                        }}
                      />
                      {PRICE_ACCENTS[k].label}
                    </button>
                  );
                })}
              </div>
              <p className="price-hl pt-2 font-price text-2xl font-bold tabular-nums">
                {formatCurrency(98765.43)}
              </p>
            </Field>

            <Field label="Fondo">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {(Object.keys(BG_STYLES) as BgStyle[]).map((k) => {
                  const active = bg === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setBg(k)}
                      className={cn(
                        "rounded-lg border p-2 transition",
                        active
                          ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                          : "border-border hover:border-ninja-flameSoft/40",
                      )}
                    >
                      <div
                        className="h-12 w-full rounded-lg border border-black/10"
                        style={{ backgroundColor: "#14102e", ...BG_PREVIEW[k] }}
                      />
                      <div className="mt-1.5 truncate text-xs font-medium">
                        {BG_STYLES[k]}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>
              </CardContent>
            </Card>
          )}

          {/* Rubro del negocio (solo owner/manager; se auto-oculta) */}
          {section === "rubro" && <RubroCard />}

          {/* Marca del negocio (solo owner/manager; el componente se auto-oculta) */}
          {section === "marca" && <BrandingCard />}

          {/* Modelos de ticket (escritura protegida por RLS) */}
          {section === "tickets" && <TicketTemplatesCard />}

          {/* Medios de pago (solo owner/manager; se auto-oculta) */}
          {section === "pagos" && (
            <Suspense fallback={null}>
              <PaymentMethodsCard />
            </Suspense>
          )}

          {/* Operación del POS (solo owner/manager; se auto-oculta) */}
          {section === "operacion" && <OperationSettingsCard />}

          {/* Garantías extendidas */}
          {section === "garantias" && (
            <Card>
              <CardContent className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <ShieldCheck size={18} className="text-ninja-flameSoft" />
                  <span className="font-semibold">Planes de garantía extendida</span>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Definí los planes que ofrecés al cobrar (meses, prima fija o % del
                  precio, comisión del vendedor).
                </p>
                <WarrantyPlansManager />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
