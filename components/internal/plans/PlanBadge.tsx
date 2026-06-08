"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { PlanIcon } from "./planIcons";

// Identidad visual reutilizable de un plan.
//
// Reglas (de la spec):
//   - Si hay imagen → la imagen es el "logo" del plan; debajo, el nombre
//     comercial secundario en NARANJA (ninja-flame).
//   - Si NO hay imagen (o la imagen falla al cargar) → se muestra el NOMBRE
//     grande (ej. "PRO") y, debajo, el nombre secundario en flame más chico.
//
// Se usa en: preview del editor, filas de PlansManager, panel del dueño
// (SubscriptionCard) y la comparación/selector de planes (PlanCards). Por eso
// recibe una forma mínima del plan, no el tipo completo, y soporta variantes de
// tamaño. Es robusto: si la imagen no carga, cae al render de ícono+nombre para
// que SIEMPRE se vea algo de marca (no un ícono de imagen rota).

export interface PlanBadgePlan {
  name: string;
  secondaryName?: string | null;
  imageUrl?: string | null;
  icon?: string | null;
}

type PlanBadgeSize = "sm" | "md" | "lg";

const SIZES: Record<
  PlanBadgeSize,
  {
    img: string;
    name: string;
    secondary: string;
    iconBox: string;
    iconSize: number;
    gap: string;
  }
> = {
  sm: {
    img: "h-7 max-w-[88px]",
    name: "text-base",
    secondary: "text-[11px]",
    iconBox: "h-8 w-8",
    iconSize: 16,
    gap: "gap-2.5",
  },
  md: {
    img: "h-10 max-w-[140px]",
    name: "text-2xl",
    secondary: "text-xs",
    iconBox: "h-11 w-11",
    iconSize: 22,
    gap: "gap-3",
  },
  lg: {
    img: "h-16 max-w-[220px]",
    name: "text-4xl",
    secondary: "text-sm",
    iconBox: "h-14 w-14",
    iconSize: 28,
    gap: "gap-3.5",
  },
};

export function PlanBadge({
  plan,
  size = "md",
  className,
  align = "start",
}: {
  plan: PlanBadgePlan;
  size?: PlanBadgeSize;
  className?: string;
  align?: "start" | "center";
}) {
  const s = SIZES[size];
  const secondary = plan.secondaryName?.trim() || null;
  const centered = align === "center";
  // Si la imagen no carga (URL rota, bucket movido, red), caemos al ícono+nombre.
  const [imgFailed, setImgFailed] = useState(false);
  const hasImage = Boolean(plan.imageUrl) && !imgFailed;

  if (hasImage) {
    return (
      <div
        className={cn(
          "flex flex-col",
          centered ? "items-center text-center" : "items-start",
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={plan.imageUrl as string}
          alt={plan.name}
          onError={() => setImgFailed(true)}
          className={cn("w-auto object-contain", s.img)}
        />
        {secondary && (
          <span
            className={cn(
              "mt-1 font-display font-semibold uppercase tracking-wide text-ninja-flame",
              s.secondary,
            )}
          >
            {secondary}
          </span>
        )}
      </div>
    );
  }

  // Sin imagen: ícono + nombre grande, con el secundario en flame debajo.
  return (
    <div
      className={cn(
        "flex items-center",
        s.gap,
        centered && "justify-center text-center",
        className,
      )}
    >
      {plan.icon && (
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-lg bg-muted text-ninja-flameSoft",
            s.iconBox,
          )}
        >
          <PlanIcon iconKey={plan.icon} size={s.iconSize} />
        </span>
      )}
      <div className={cn("flex min-w-0 flex-col", centered && "items-center")}>
        <span
          className={cn(
            "font-display font-black uppercase leading-none tracking-tight text-foreground",
            s.name,
          )}
        >
          {plan.name}
        </span>
        {secondary && (
          <span
            className={cn(
              "mt-1 font-display font-semibold uppercase tracking-wide text-ninja-flame",
              s.secondary,
            )}
          >
            {secondary}
          </span>
        )}
      </div>
    </div>
  );
}
