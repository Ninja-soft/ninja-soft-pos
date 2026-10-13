import type { Metadata } from "next";
import { PosOfflineScreen } from "@/components/pos/offline/PosOfflineScreen";

// Shell del POS sin conexión (H65, ADR-087). Página ESTÁTICA y anónima: no
// lee la sesión ni datos del servidor, así el service worker la puede guardar
// sin guardar nada del negocio. Todo lo que muestra sale del dispositivo.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "POS sin conexión | NinjaSoft POS",
  robots: { index: false, follow: false },
};

export default function PosOfflinePage() {
  return <PosOfflineScreen />;
}
