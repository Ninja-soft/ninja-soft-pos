"use client";

import type { UseFormRegister, UseFormSetValue, UseFormWatch } from "react-hook-form";
import { Lock } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { IVA_CODES, IVA_RATES, type IvaCode } from "@/lib/tax/catalog";
import { computeSaleTaxes, type InternalTax } from "@/lib/tax/engine";
import { formatCurrency as formatMoney } from "@/lib/utils/format";
import { useFeature } from "@/modules/saas/gating";
import type { ProductInput } from "@/modules/products/schemas";

// Ficha del producto · Impuestos (F18 · H103, ADR-068): alícuota de IVA del
// catálogo, servicio e impuestos internos (feature impuestos_internos; el
// servidor rechaza cargarlos sin el plan). Muestra cómo se desglosa el precio.

const IVA_HINT: Partial<Record<IvaCode, string>> = {
  "10.5": "Algunos alimentos, bienes de capital, medicina prepaga",
  "27": "Servicios como energía o telecomunicaciones a responsables inscriptos",
  exento: "Libros, leche sin aditivos y otros exentos por ley",
  no_gravado: "Fuera del objeto del IVA (se informa aparte del exento)",
};

export function ProductTaxFields({
  register,
  watch,
  setValue,
  price,
  cost,
}: {
  register: UseFormRegister<ProductInput>;
  watch: UseFormWatch<ProductInput>;
  setValue: UseFormSetValue<ProductInput>;
  price: number;
  cost: number;
}) {
  const internosOn = useFeature("impuestos_internos") !== false;
  const code = (watch("tax_rate_code") ?? "21") as IvaCode;
  const mode = watch("internal_tax_mode") ?? "none";
  const base = watch("internal_tax_base") ?? "price";
  const included = watch("internal_tax_included") ?? true;
  const isService = Boolean(watch("is_service"));
  const rate = Number(watch("internal_tax_rate") ?? 0) || 0;
  const amount = Number(watch("internal_tax_amount") ?? 0) || 0;

  const internal: InternalTax = { mode, base, rate, amount, included: true };
  const final = included ? price : null;
  const preview =
    final && final > 0
      ? computeSaleTaxes({
          lines: [{ gross: final, quantity: 1, rateCode: code, internal, unitCost: cost }],
          total: final,
          discriminates: true,
          internalEnabled: internosOn,
        }).lines[0]
      : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="IVA"
          value={code}
          onChange={(v) => setValue("tax_rate_code", v, { shouldDirty: true })}
          hint={IVA_HINT[code]}
          options={IVA_CODES.map((c) => ({ value: c, label: IVA_RATES[c].label }))}
        />
        <label className="flex items-center justify-between gap-3 self-end pb-2 text-sm">
          <span>
            Es un servicio
            <span className="block text-[13px] text-muted-foreground">Para el concepto de la factura electrónica.</span>
          </span>
          <Switch
            checked={isService}
            onCheckedChange={(v) => setValue("is_service", v, { shouldDirty: true })}
            label="Es un servicio"
          />
        </label>
      </div>

      <div className="space-y-3">
        <Select
          label="Impuestos internos"
          value={mode}
          disabled={!internosOn && mode === "none"}
          onChange={(v) => setValue("internal_tax_mode", v, { shouldDirty: true })}
          hint={!internosOn ? "Desde el plan Pro" : undefined}
          options={[
            { value: "none", label: "No tiene" },
            { value: "pct", label: "Porcentaje (tasa nominal)" },
            { value: "fixed", label: "Monto fijo por unidad" },
          ]}
        />
        {!internosOn && mode !== "none" && (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Lock size={13} /> Tu plan no incluye impuestos internos: no se van a discriminar en la venta.
          </p>
        )}
        {mode !== "none" && (
          <div className="grid gap-3 sm:grid-cols-3">
            {mode === "pct" ? (
              <>
                <Input
                  variant="filled"
                  label="Tasa nominal %"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  {...register("internal_tax_rate")}
                />
                <Select
                  label="Sobre"
                  value={base}
                  onChange={(v) => setValue("internal_tax_base", v, { shouldDirty: true })}
                  options={[
                    { value: "price", label: "Precio de venta" },
                    { value: "cost", label: "Costo" },
                  ]}
                />
              </>
            ) : (
              <Input
                variant="filled"
                label="Monto por unidad"
                type="number"
                step="0.01"
                inputMode="decimal"
                {...register("internal_tax_amount")}
              />
            )}
            <label className="flex items-center justify-between gap-3 self-end pb-2 text-sm">
              Incluido en el precio
              <Switch
                checked={included}
                onCheckedChange={(v) => setValue("internal_tax_included", v, { shouldDirty: true })}
                label="Incluido en el precio"
              />
            </label>
          </div>
        )}
        {mode === "pct" && base === "price" && rate > 0 && (
          <p className="text-[13px] text-muted-foreground">
            La tasa nominal integra su propia base: {String(rate).replace(".", ",")} % nominal equivale a{" "}
            {String(Math.round((rate / (100 - rate)) * 10000) / 100).replace(".", ",")} % sobre el neto.
          </p>
        )}
        {mode !== "none" && !included && (
          <p className="text-[13px] text-muted-foreground">
            Adicional: el POS suma los internos al precio que cargás (y a los de las listas).
          </p>
        )}
      </div>

      {preview && (
        <div className="rounded-lg bg-muted/60 p-3 text-[13px]">
          <p className="mb-1.5 font-medium">Así se desglosa {formatMoney(price)} (responsable inscripto)</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
            <dt className="text-muted-foreground">Neto</dt>
            <dd className="text-right font-mono tabular-nums sm:text-left">{formatMoney(preview.net)}</dd>
            <dt className="text-muted-foreground">IVA</dt>
            <dd className="text-right font-mono tabular-nums sm:text-left">{formatMoney(preview.iva)}</dd>
            {preview.internal > 0 && (
              <>
                <dt className="text-muted-foreground">Internos</dt>
                <dd className="text-right font-mono tabular-nums sm:text-left">{formatMoney(preview.internal)}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
