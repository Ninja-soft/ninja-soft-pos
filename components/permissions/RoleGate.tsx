"use client";

import { forwardRef, type ButtonHTMLAttributes, type ComponentProps } from "react";
import { Eye, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { cn } from "@/lib/utils/cn";
import { useRolePermissions } from "@/lib/permissions/useRole";

// =============================================================================
// UI de permisos por rol (ADR-071). Capa de UX sobre role_write_guard/void_sale:
// lo que el rol no puede hacer se ve deshabilitado con el motivo en el tooltip.
// No se usa `disabled` nativo para que el tooltip (title) se vea al pasar el
// mouse; el click se intercepta y aria-disabled lo anuncia.
// =============================================================================

// <Button> que se deshabilita cuando `denied` trae un motivo.
export function RoleButton({
  denied,
  children,
  onClick,
  className,
  title,
  ...rest
}: ComponentProps<typeof Button> & { denied: string | null }) {
  if (!denied) {
    return (
      <Button onClick={onClick} className={className} title={title} {...rest}>
        {children}
      </Button>
    );
  }
  return (
    <Button
      {...rest}
      className={cn("cursor-not-allowed opacity-60", className)}
      onClick={(e) => e.preventDefault()}
      aria-disabled
      title={denied}
    >
      <Lock size={14} className="opacity-80" />
      {children}
    </Button>
  );
}

// Botón de ícono crudo (acciones por fila) con el mismo criterio.
export const RoleIconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { denied: string | null }
>(function RoleIconButton({ denied, className, onClick, title, ...rest }, ref) {
  if (!denied) {
    return <button ref={ref} type="button" className={className} onClick={onClick} title={title} {...rest} />;
  }
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      aria-disabled
      title={denied}
      onClick={(e) => e.preventDefault()}
      className="cursor-not-allowed rounded-md p-2 text-muted-foreground/40"
    />
  );
});
RoleIconButton.displayName = "RoleIconButton";

// Aviso fijo para el rol "Solo lectura": explica por qué no hay acciones.
export function ReadOnlyBanner() {
  const { readOnly } = useRolePermissions();
  if (!readOnly) return null;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
      <Callout tone="neutral" icon={Eye} title="Modo solo lectura">
        Tu usuario puede consultar productos, stock, ventas y reportes, pero no modificar datos. Si necesitás cargar
        algo, pedíselo a un encargado o al dueño.
      </Callout>
    </div>
  );
}
