import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";

// Patrón de tabla responsive: el contenedor scrollea en horizontal dentro de
// la card (nunca la página) y la tabla mantiene un ancho mínimo legible.
export function TableWrap({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "slim-scrollbar overflow-x-auto rounded-xl border border-border bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}
TableWrap.displayName = "TableWrap";

/** Fila que ocupa todo el ancho de la tabla: carga, vacío o error. */
export function TableStateRow({
  colSpan,
  loading = false,
  className,
  children,
}: {
  colSpan: number;
  loading?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("px-4 py-10 text-center", className)}>
        {loading ? <Spinner size={22} /> : children}
      </td>
    </tr>
  );
}
TableStateRow.displayName = "TableStateRow";
