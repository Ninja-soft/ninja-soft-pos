import { Suspense } from "react";
import { LiveMapPage } from "@/components/logistics/map/LiveMapPage";

// Logística › Mapa en vivo (ADR-164): camiones, paradas, entregas y desvíos.
export default function MapaEnVivoPage() {
  return (
    <Suspense fallback={null}>
      <LiveMapPage />
    </Suspense>
  );
}
