"use client";

import { useState, type ReactNode } from "react";

// Monta `children` recién la primera vez que `open` pasa a true y lo deja
// montado después (así la animación de cierre y el estado interno se conservan).
// Pensado para modales pesados que hoy se montan cerrados: mientras nunca se
// abrieron no corren sus hooks/queries ni se re-renderizan con cada tecla de la
// pantalla que los contiene, y su chunk (next/dynamic) no se pide hasta usarlos.
export function MountWhenOpened({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened ? <>{children}</> : null;
}
