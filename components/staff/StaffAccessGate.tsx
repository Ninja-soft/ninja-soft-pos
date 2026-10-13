"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, LogOut, ShieldAlert, UserX } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Isotype } from "@/components/brand/Logo";
import { LEAVE_LABEL, type LeaveType } from "@/lib/staff/status";
import { staffApi } from "@/modules/staff/api";
import { useMyStaffStatus } from "@/modules/staff/hooks";
import { FLAT_PANEL } from "@/components/security/styles";

function fmt(d: string | null | undefined): string | null {
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

// Pantalla de bloqueo para quien está suspendido, de licencia o de baja en el
// negocio activo (F17 · H113). La barrera real es el servidor (sin sucursales,
// sin caja, sin ventas); esto evita una app a medio cargar con errores.
export function StaffAccessGate({ email }: { email: string }) {
  const router = useRouter();
  const { data } = useMyStaffStatus();
  if (!data || data.status === "active") return null;

  const until = fmt(data.until);
  const title =
    data.status === "suspended"
      ? "Tu acceso está suspendido"
      : data.status === "on_leave"
        ? "Estás de licencia"
        : "Tu usuario está dado de baja";
  const Icon = data.status === "terminated" ? UserX : data.status === "on_leave" ? CalendarClock : ShieldAlert;
  const detail =
    data.status === "on_leave"
      ? `${data.subtype && data.subtype in LEAVE_LABEL ? LEAVE_LABEL[data.subtype as LeaveType] : "Licencia"}${until ? `, hasta el ${until}` : ""}.`
      : data.status === "suspended"
        ? until
          ? `Hasta el ${until}. Mientras tanto no podés abrir caja ni vender.`
          : "Mientras dure no podés abrir caja ni vender."
        : "Ya no tenés acceso a este negocio. Si es un error, hablá con el dueño.";

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="app-bg fixed inset-0 z-[60] flex items-center justify-center p-4" role="alertdialog" aria-modal>
      <div className={`${FLAT_PANEL} w-full max-w-md p-6 sm:p-8`}>
        <div className="mb-5 flex items-center gap-3">
          <Isotype className="h-8 w-auto" />
          <span className="grid h-10 w-10 place-items-center rounded-md bg-warning/15 text-warning">
            <Icon size={20} aria-hidden />
          </span>
        </div>
        <h1 className="text-2xl font-black tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
        {data.reason && data.status !== "on_leave" && (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Motivo: </span>
            {data.reason}
          </p>
        )}
        <Button variant="secondary" className="mt-6 w-full" onClick={signOut}>
          <LogOut size={16} /> Cerrar sesión
        </Button>
        <p className="mt-5 text-center text-[11px] text-muted-foreground">
          Sesión iniciada como <span className="font-medium">{email}</span>
        </p>
      </div>
    </div>
  );
}
StaffAccessGate.displayName = "StaffAccessGate";

// Autocuración (B-01, ADR-083): un usuario con membresía activa y sin negocio
// activo válido en el JWT (invitado antes del fix, o con un negocio del que lo
// dieron de baja) recibe el de su primera membresía activa y se refresca la
// sesión. El servidor decide si el negocio del JWT sigue valiendo y devuelve
// true sólo cuando hay que refrescar, así no hay recargas en bucle.
export function TenantClaimHealer() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void (async () => {
      const sb = createClient();
      const { data } = await sb.auth.getUser();
      if (!data.user) return;
      if (await staffApi.ensureCurrentTenant()) {
        await sb.auth.refreshSession();
        // Recarga completa: el usuario y las queries cacheadas tienen el JWT viejo.
        window.location.reload();
      }
    })();
  }, []);
  return null;
}
TenantClaimHealer.displayName = "TenantClaimHealer";
