"use client";

// =============================================================================
// Participación y gastos del staff (F21 · ADR-121, spec docs/40 §20). El
// super_admin ve el panel completo; el resto del staff, sólo su participación.
// El servidor decide (internal_staff_access / RLS): la UI sólo elige la vista.
// =============================================================================

import { Suspense } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { StaffPayoutsAdmin } from "@/components/internal/staff-payouts/StaffPayoutsAdmin";
import { MyParticipation } from "@/components/internal/staff-payouts/MyParticipation";
import { useStaffAccess } from "@/modules/staffPayouts/api";

export default function InternalParticipacionPage() {
  const { data, isLoading } = useStaffAccess();
  if (isLoading) return <Skeleton className="h-[160px] rounded-lg" />;
  if (data?.is_owner) {
    return (
      <Suspense fallback={<Skeleton className="h-[160px] rounded-lg" />}>
        <StaffPayoutsAdmin />
      </Suspense>
    );
  }
  return <MyParticipation />;
}
