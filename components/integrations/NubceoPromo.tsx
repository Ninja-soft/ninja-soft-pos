"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ExternalLink, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { useNubceoAccess, useNubceoConfig } from "@/modules/integrations/nubceo/hooks";

const DISMISS_KEY = "ninja.nubceo.promo.dismissed";
const NUBCEO_URL = "https://www.nubceo.com";

// Aviso en Conciliación: qué es NubCeo, qué hace y cómo conectarlo. Se oculta
// cuando la integración ya envía ventas (sin simular) o si el usuario lo cierra.
export function NubceoPromo({ className }: { className?: string }) {
  const access = useNubceoAccess();
  const { data: cfg } = useNubceoConfig(access.enabled);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const active = Boolean(cfg?.settings?.enabled && !cfg.settings.simulate);
  if (!access.ready || dismissed || active) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* sin storage: se oculta sólo en esta visita */
    }
  };

  return (
    <section
      aria-label="Integración con NubCeo"
      className={cn("relative rounded-lg border border-border bg-card p-4 sm:p-5", className)}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Ocultar aviso de NubCeo"
        className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X size={16} />
      </button>
      <div className="flex flex-col gap-4 pr-8 sm:flex-row sm:items-center">
        <div className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/integrations/nubceo-wordmark.webp" alt="NubCeo" className="logo-on-light h-7 w-auto" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/integrations/nubceo-wordmark-on-dark.webp" alt="NubCeo" className="logo-on-dark h-7 w-auto" />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-foreground">¿Querés conciliar todo en automático? Conectá NubCeo</p>
          <p className="mt-1 text-muted-foreground">
            NubCeo es una plataforma de conciliación para comercios: junta las liquidaciones de tarjetas, billeteras y
            bancos, te muestra comisiones, retenciones y cuánto y cuándo vas a cobrar, y arma los asientos contables.
            NinjaPos le envía tus ventas solo y trae los asientos de vuelta.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {access.enabled ? (
              <Link
                href={"/configuracion?seccion=nubceo" as Route}
                className={buttonVariants({ size: "sm" })}
              >
                Conectar NubCeo
              </Link>
            ) : (
              <Link
                href={"/configuracion?seccion=nubceo" as Route}
                className={buttonVariants({ size: "sm", variant: "secondary" })}
              >
                Disponible en el plan Business
              </Link>
            )}
            <a
              href={NUBCEO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "gap-1.5")}
            >
              Conocer NubCeo <ExternalLink size={14} aria-hidden />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
