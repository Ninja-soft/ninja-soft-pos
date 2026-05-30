"use client";

import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
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

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20";

export default function ConfiguracionPage() {
  const { display, price, bg, setDisplay, setPrice, setBg } = useAppearance();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Eyebrow>Preferencias</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Configuración</Display>
      <p className="mt-2 text-muted-foreground">
        Apariencia del sistema. Los cambios se aplican al instante y se guardan
        en este dispositivo.
      </p>

      <div className="mt-6 space-y-4">
        <Card>
          <CardContent className="space-y-3 p-5">
            <label className="block text-sm font-medium">
              Fuente de títulos y destacados
            </label>
            <select
              className={selectCls}
              value={display}
              onChange={(e) => setDisplay(e.target.value as DisplayFont)}
            >
              {Object.entries(DISPLAY_FONTS).map(([k, v]) => (
                <option key={k} value={k} className="bg-ninja-deepViolet">
                  {v.label}
                </option>
              ))}
            </select>
            <p className="font-display text-2xl font-bold">
              NinjaSoft POS — Ágil y seguro
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <label className="block text-sm font-medium">
              Fuente de precios y números
            </label>
            <select
              className={selectCls}
              value={price}
              onChange={(e) => setPrice(e.target.value as PriceFont)}
            >
              {Object.entries(PRICE_FONTS).map(([k, v]) => (
                <option key={k} value={k} className="bg-ninja-deepViolet">
                  {v.label}
                </option>
              ))}
            </select>
            <p className="font-price tabular-nums text-2xl font-bold text-ninja-gold">
              {formatCurrency(1234567.89)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <label className="block text-sm font-medium">Fondo de pantallas</label>
            <select
              className={selectCls}
              value={bg}
              onChange={(e) => setBg(e.target.value as BgStyle)}
            >
              {Object.entries(BG_STYLES).map(([k, v]) => (
                <option key={k} value={k} className="bg-ninja-deepViolet">
                  {v}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              El patrón se aplica al fondo de todas las pantallas del producto.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
