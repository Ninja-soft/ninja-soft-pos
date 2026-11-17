"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RotateCcw, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  MFA_CHALLENGE_PATH,
  MFA_ENROLL_PATH,
  isTotpCode,
  mfaResetErrorMessage,
  normalizeTotpCode,
} from "@/lib/auth/internalMfa";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Spinner";
import { ReasonDialog } from "@/components/internal/ReasonDialog";

type Factor = {
  id: string;
  friendly_name?: string | null;
  status: string;
  created_at: string;
};
type Enrollment = { id: string; qr: string; secret: string };
type Staff = { id: string; email: string; full_name: string | null; internal_level: string | null };

const dateFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" });

// Verificación en dos pasos del staff (SEC-23, ADR-186). Funciona con el flag
// internal_mfa_required apagado, para enrolar antes de prenderlo. Sólo TOTP.
export default function InternalMfaPage() {
  const supabase = createClient();
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [removing, setRemoving] = useState<Factor | null>(null);
  const [resetting, setResetting] = useState<Staff | null>(null);

  const { data: state, isLoading } = useQuery({
    queryKey: ["internal-mfa-state"],
    queryFn: async () => {
      const [{ data: aal }, { data: list, error }, { data: flag }, { data: auth }] = await Promise.all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        supabase.auth.mfa.listFactors(),
        supabase.rpc("internal_mfa_required"),
        supabase.auth.getUser(),
      ]);
      if (error) throw error;
      const factors: Factor[] = (list?.all ?? [])
        .filter((f) => f.factor_type === "totp")
        .map((f) => ({ id: f.id, friendly_name: f.friendly_name, status: f.status, created_at: f.created_at }));
      const meta = (auth.user?.app_metadata ?? {}) as { internal_level?: string };
      return {
        level: aal?.currentLevel ?? null,
        factors,
        flagOn: flag === true,
        userId: auth.user?.id ?? null,
        isSuper: meta.internal_level === "super_admin",
      };
    },
  });

  const verified = (state?.factors ?? []).filter((f) => f.status === "verified");
  const aal2 = state?.level === "aal2";
  // Con un factor verificado, Supabase exige aal2 para enrolar otro o borrar.
  const needsStepUp = verified.length > 0 && !aal2;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["internal-mfa-state"] });
    router.refresh();
  };

  const enrollMut = useMutation({
    mutationFn: async () => {
      // Limpia intentos sin terminar (factores sin verificar).
      for (const f of state?.factors ?? []) {
        if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `NinjaSoft ${stamp}`,
        issuer: "NinjaSoft POS",
      });
      if (error) throw error;
      return { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret } satisfies Enrollment;
    },
    onSuccess: (e) => {
      setCode("");
      setEnrollment(e);
    },
    onError: (e) =>
      toast({
        title: "No se pudo iniciar la configuración",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  const verifyMut = useMutation({
    mutationFn: async () => {
      if (!enrollment) throw new Error("Sin configuración en curso.");
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrollment.id, code });
      if (error) throw error;
    },
    onSuccess: () => {
      setEnrollment(null);
      setCode("");
      toast({ title: "Verificación en dos pasos activada", variant: "success" });
      refresh();
    },
    onError: () => {
      setCode("");
      toast({ title: "Código incorrecto o vencido", description: "Probá con el código nuevo de la app.", variant: "error" });
    },
  });

  const removeMut = useMutation({
    mutationFn: async (f: Factor) => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (error) throw error;
    },
    onSuccess: () => {
      setRemoving(null);
      toast({ title: "App autenticadora eliminada", variant: "success" });
      refresh();
    },
    onError: (e) =>
      toast({
        title: "No se pudo eliminar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  const { data: staff = [] } = useQuery({
    queryKey: ["internal-staff"],
    enabled: state?.isSuper === true,
    queryFn: async (): Promise<Staff[]> => {
      const { data, error } = await supabase.rpc("internal_list_staff");
      if (error) throw error;
      return (data ?? []) as Staff[];
    },
  });

  const resetMut = useMutation({
    mutationFn: async ({ target, reason }: { target: Staff; reason: string }) => {
      const { data, error } = await supabase.rpc("internal_mfa_reset", { p_user_id: target.id, p_motivo: reason });
      if (error) throw new Error(mfaResetErrorMessage(error.message));
      return (data as { sessions_revoked?: boolean } | null)?.sessions_revoked === true;
    },
    onSuccess: (sessionsRevoked) => {
      setResetting(null);
      toast({
        title: "Verificación reseteada",
        description: sessionsRevoked
          ? "La persona tiene que volver a entrar y configurar su app autenticadora."
          : "Se borraron sus apps, pero no se pudieron cerrar sus sesiones: quedan abiertas hasta que venzan.",
        variant: sessionsRevoked ? "success" : "warning",
      });
    },
    onError: (e) =>
      toast({
        title: "No se pudo resetear",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  return (
    <>
      <PageHeader
        eyebrow="Seguridad"
        title="Verificación en dos pasos"
        icon={KeyRound}
        description="Un código de tu app autenticadora además de la contraseña para entrar al panel interno."
      />

      {isLoading || !state ? (
        <div className="mt-10 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          {verified.length === 0 ? (
            <Callout
              className="mt-6"
              tone={state.flagOn ? "danger" : "warning"}
              icon={ShieldAlert}
              title={state.flagOn ? "Configurala para seguir usando el panel" : "Todavía no la configuraste"}
            >
              {state.flagOn
                ? "La verificación en dos pasos es obligatoria para el staff. Hasta que la configures, el panel interno no te muestra datos."
                : "Pronto va a ser obligatoria para el staff. Configurala ahora para no quedar afuera cuando se active."}
            </Callout>
          ) : needsStepUp ? (
            <Callout
              className="mt-6"
              tone="warning"
              icon={ShieldAlert}
              title="Verificá esta sesión"
              actions={
                <Link
                  href={`${MFA_CHALLENGE_PATH}?next=${encodeURIComponent(MFA_ENROLL_PATH)}` as never}
                  className={buttonVariants({ size: "sm" })}
                >
                  Ingresar código
                </Link>
              }
            >
              Iniciaste sesión sin el código. Ingresalo para administrar tus apps autenticadoras
              {state.flagOn ? " y usar el panel interno" : ""}.
            </Callout>
          ) : (
            <Callout className="mt-6" tone="success" icon={ShieldCheck} title="Activa">
              Esta sesión está verificada con tu app autenticadora.
              {state.flagOn ? " Es obligatoria para todo el staff." : " Todavía no es obligatoria para el staff."}
            </Callout>
          )}

          <Card className="mt-6">
            <CardContent className="p-4 sm:p-5">
              <SectionHeader
                title="Tus apps autenticadoras"
                icon={Smartphone}
                description="Google Authenticator, 1Password, Authy o cualquier app TOTP."
                actions={
                  !enrollment && (
                    <Button
                      size="sm"
                      onClick={() => enrollMut.mutate()}
                      loading={enrollMut.isPending}
                      disabled={needsStepUp}
                    >
                      Agregar app
                    </Button>
                  )
                }
              />

              {enrollment && (
                <form
                  className="mt-4 grid gap-4 rounded-lg bg-muted/60 p-4 sm:grid-cols-[176px_minmax(0,1fr)]"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (isTotpCode(code)) verifyMut.mutate();
                  }}
                >
                  {/* SVG que devuelve Supabase Auth como data URL. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={enrollment.qr}
                    alt="Código QR para la app autenticadora"
                    width={176}
                    height={176}
                    className="mx-auto rounded-md bg-white p-2"
                  />
                  <div className="min-w-0 space-y-3">
                    <p className="text-sm text-muted-foreground">
                      1. Escaneá el QR con la app. Si no podés, cargá esta clave a mano:
                    </p>
                    <code className="block break-all rounded-md bg-background px-3 py-2 font-mono text-xs text-foreground">
                      {enrollment.secret}
                    </code>
                    <p className="text-sm text-muted-foreground">2. Escribí el código de 6 dígitos que muestra la app.</p>
                    <Input
                      label="Código"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      value={code}
                      onChange={(e) => setCode(normalizeTotpCode(e.target.value))}
                      className="font-mono tracking-[0.3em]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" loading={verifyMut.isPending} disabled={!isTotpCode(code)}>
                        Activar
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          const id = enrollment.id;
                          setEnrollment(null);
                          void supabase.auth.mfa.unenroll({ factorId: id });
                        }}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                </form>
              )}

              {verified.length === 0 && !enrollment ? (
                <EmptyState
                  className="mt-4"
                  icon={Smartphone}
                  title="Sin apps configuradas"
                  description="Agregá una para activar la verificación en dos pasos."
                />
              ) : (
                <ul className="mt-4 divide-y divide-border">
                  {verified.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 py-3">
                      <Smartphone size={18} className="shrink-0 text-ninja-flameSoft" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {f.friendly_name || "App autenticadora"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Agregada el {dateFmt.format(new Date(f.created_at))}
                        </p>
                      </div>
                      <Badge tone="success">Verificada</Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Eliminar app autenticadora"
                        disabled={needsStepUp}
                        onClick={() => setRemoving(f)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {state.isSuper && (
            <Card className="mt-6">
              <CardContent className="p-4 sm:p-5">
                <SectionHeader
                  title="Resetear a otra persona del staff"
                  icon={RotateCcw}
                  description="Si alguien perdió el teléfono: borra sus apps autenticadoras y cierra sus sesiones. Queda auditado. Ojo: el acceso que ya tenía abierto puede seguir funcionando hasta 1 hora, hasta que vence."
                />
                <ul className="mt-4 divide-y divide-border">
                  {staff
                    .filter((s) => s.id !== state.userId)
                    .map((s) => (
                      <li key={s.id} className="flex items-center gap-3 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">{s.full_name || s.email}</p>
                          <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                        </div>
                        <Button size="sm" variant="secondary" onClick={() => setResetting(s)}>
                          Resetear
                        </Button>
                      </li>
                    ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Eliminar app autenticadora"
        description={
          verified.length === 1 && state?.flagOn
            ? "Es tu única app: vas a tener que configurar otra para seguir usando el panel interno."
            : "Ya no vas a poder entrar con los códigos de esta app."
        }
        confirmLabel="Eliminar"
        danger
        loading={removeMut.isPending}
        onConfirm={() => removing && removeMut.mutate(removing)}
      />

      <ReasonDialog
        open={resetting !== null}
        onOpenChange={(o) => !o && setResetting(null)}
        title="Resetear verificación en dos pasos"
        description={`${resetting?.email ?? ""} va a tener que volver a entrar y configurar su app autenticadora. Se cierran sus sesiones, pero el acceso que ya tenía abierto puede seguir funcionando hasta 1 hora, hasta que vence.`}
        confirmLabel="Resetear"
        danger
        loading={resetMut.isPending}
        onConfirm={(reason) => resetting && resetMut.mutate({ target: resetting, reason })}
      />
    </>
  );
}
