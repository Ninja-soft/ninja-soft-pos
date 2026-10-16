import { Suspense } from "react";
import { RoutesPage } from "@/components/logistics/routes/RoutesPage";

// Logística › Reparto (ADR-161): hojas de ruta del día, paradas, orden por
// cercanía, asignación de camión y repartidor, impresión y seguimiento.
export default function RepartoPanelPage() {
  return (
    <Suspense fallback={null}>
      <RoutesPage />
    </Suspense>
  );
}
