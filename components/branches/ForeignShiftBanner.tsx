"use client";

import { Lock } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { useBranchScope } from "@/modules/branches/hooks";
import { useSecuritySettings } from "@/modules/security/hooks";
import { useStaffPeople } from "@/modules/staff/hooks";
import { registerSituation } from "@/lib/cash/ownership";
import { capitalizeName } from "@/lib/utils/format";

type ShiftLike = { id: string; opened_by: string; status: string; opened_at: string } | null | undefined;

// ¿El turno de la caja de este dispositivo es usable por el usuario? (ADR-051,
// H114). Ajeno = de otra persona y sin caja compartida: se ve, pero no se vende.
export function useShiftOwnership(shift: ShiftLike) {
  const me = useBranchScope().data?.userId ?? null;
  const { data: security } = useSecuritySettings();
  const situation = registerSituation(shift, me, security?.shared_shift ?? false);
  return { situation, usable: situation === "mine" || situation === "shared", foreign: situation === "foreign" };
}

// Aviso en el POS cuando la caja elegida la tiene abierta otra persona.
export function ForeignShiftBanner({ shift }: { shift: ShiftLike }) {
  const { foreign } = useShiftOwnership(shift);
  const { data: people } = useStaffPeople(foreign);
  if (!foreign || !shift) return null;
  const owner = (people ?? []).find((p) => p.user_id === shift.opened_by);
  const since = new Date(shift.opened_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return (
    <Callout tone="warning" icon={Lock} title={`Esta caja la tiene abierta ${owner ? capitalizeName(owner.name) : "otra persona"} desde las ${since}`}>
      Para cobrar elegí otra caja arriba (en la sucursal y caja) y abrila a tu nombre. Nadie vende en la caja de otro.
    </Callout>
  );
}
ForeignShiftBanner.displayName = "ForeignShiftBanner";
