"use client";

import { Suspense } from "react";
import { StaffBoard } from "@/components/staff/StaffBoard";
import type { StaffRole } from "@/modules/branches/logic";

// Equipo del Panel del dueño (F17 · H113, ADR-051). El tablero de personal
// (estados, sucursales, historial, alta e invitación) vive en
// components/staff/StaffBoard; esto mantiene la API del panel.
export function TeamSection({
  currentUserId,
  tenantId,
  canManage,
  role,
}: {
  currentUserId: string;
  tenantId: string;
  canManage: boolean;
  role?: StaffRole | null;
}) {
  // StaffBoard lee ?invitar=1 (useSearchParams): va dentro de Suspense.
  return (
    <Suspense fallback={null}>
      <StaffBoard
        currentUserId={currentUserId}
        tenantId={tenantId}
        myRole={role ?? (canManage ? "manager" : "viewer")}
      />
    </Suspense>
  );
}
