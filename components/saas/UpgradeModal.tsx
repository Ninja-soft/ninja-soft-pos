"use client";

import dynamic from "next/dynamic";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import type { UpgradeModalProps } from "./UpgradeModalBody";

// El modal de upgrade (con el catálogo de copy de todas las funciones,
// lib/saas/featureInfo.ts) vive en su propio chunk y se monta recién la primera
// vez que se abre. Antes venía en el bundle inicial de todo el panel (lo importa
// el menú lateral) y cada ítem bloqueado pedía los planes al montar, aunque
// nadie abriera el modal.
const UpgradeModalBody = dynamic(() => import("./UpgradeModalBody").then((m) => m.UpgradeModalBody), {
  ssr: false,
});

export function UpgradeModal(props: UpgradeModalProps) {
  return (
    <MountWhenOpened open={props.open}>
      <UpgradeModalBody {...props} />
    </MountWhenOpened>
  );
}
