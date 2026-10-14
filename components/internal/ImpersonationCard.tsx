"use client";

import { useState } from "react";
import { Copy, ExternalLink, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { useImpersonateTenant } from "@/modules/internal/hooks";
import { useEndImpersonation, useTenantImpersonations } from "@/modules/internal/opsHooks";
import { formatRelative } from "@/lib/utils/format";
import {
  DEFAULT_IMPERSONATION_MINUTES,
  IMPERSONATION_DURATIONS,
  durationLabel,
  impersonationErrorMessage,
} from "@/supabase/functions/_shared/impersonation";

function sessionState(s: {
  endedAt: string | null;
  endReason: string | null;
  claimedAt: string | null;
  expiresAt: string;
}): { label: string; dot: string; open: boolean } {
  if (s.endedAt) {
    const label =
      s.endReason === "expired" ? "Vencido" : s.endReason === "revoked" ? "Cerrado desde el panel" : "Terminado";
    return { label, dot: "bg-muted-foreground", open: false };
  }
  if (new Date(s.expiresAt) <= new Date()) return { label: "Vencido", dot: "bg-muted-foreground", open: false };
  if (s.claimedAt) return { label: "En curso", dot: "bg-warning", open: true };
  return { label: "Link sin usar", dot: "bg-ninja-flameSoft", open: true };
}

// Acceso como el negocio (ADR-073 + ADR-084): motivo, duración elegida, link
// que abre la sesión con banner y cuenta regresiva, y cierre desde el panel.
export function ImpersonationCard({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const impersonate = useImpersonateTenant();
  const { data: sessions } = useTenantImpersonations(tenantId);
  const end = useEndImpersonation(tenantId);
  const [ask, setAsk] = useState(false);
  const [minutes, setMinutes] = useState<number>(DEFAULT_IMPERSONATION_MINUTES);
  const [result, setResult] = useState<{ actionLink: string; ownerEmail: string; expiresAt: string } | null>(
    null,
  );

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast({ title: "Copiado al portapapeles", variant: "success" }));
  }

  return (
    <>
      <Card className="mt-3">
        <CardContent className="p-5">
          <Callout tone="warning" icon={ShieldAlert} className="mb-4">
            Abre una sesión como el dueño durante el tiempo que elijas, con un banner visible y cuenta regresiva.
            Al vencer se cierra sola. <strong className="text-foreground">Abrila en una ventana de incógnito</strong>{" "}
            para no cerrar tu sesión de staff.
          </Callout>

          {!result ? (
            <Button loading={impersonate.isPending} onClick={() => setAsk(true)}>
              Generar acceso
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Acceso para <span className="font-medium text-foreground">{result.ownerEmail}</span>. Vence{" "}
                {new Date(result.expiresAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}.
                El link sirve una sola vez.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={result.actionLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md bg-ninja-flame/10 px-3 py-2 text-sm font-medium text-ninja-flameSoft transition hover:bg-ninja-flame/20"
                >
                  <ExternalLink size={14} /> Abrir en nueva pestaña
                </a>
                <Button variant="secondary" size="sm" onClick={() => copy(result.actionLink)}>
                  <Copy size={14} /> Copiar link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                  Generar nuevo
                </Button>
              </div>
            </div>
          )}

          {sessions && sessions.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Últimos accesos
              </p>
              <ul className="divide-y divide-border">
                {sessions.map((s) => {
                  const st = sessionState(s);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className={`h-2 w-2 rounded-full ${st.dot}`} />
                        {st.label}
                      </span>
                      <span className="text-muted-foreground">
                        {s.staffEmail ?? "Staff"} · {durationLabel(s.durationMinutes)} ·{" "}
                        {formatRelative(s.createdAt)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.reason}>
                        Motivo: {s.reason}
                      </span>
                      {st.open && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={end.isPending && end.variables === s.id}
                          onClick={() =>
                            end.mutate(s.id, {
                              onSuccess: () => toast({ title: "Acceso cerrado", variant: "success" }),
                              onError: (e) =>
                                toast({
                                  title: "No se pudo cerrar",
                                  description: e instanceof Error ? e.message : undefined,
                                  variant: "error",
                                }),
                            })
                          }
                        >
                          Cerrar acceso
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={ask}
        onOpenChange={setAsk}
        title="Acceder como este negocio"
        description="Se genera un link de un solo uso para el dueño. La sesión muestra un banner y se cierra sola al vencer. El motivo queda en la auditoría del negocio."
        confirmLabel="Generar acceso"
        loading={impersonate.isPending}
        extra={
          <Select
            label="Duración"
            value={String(minutes)}
            options={IMPERSONATION_DURATIONS.map((m) => ({ value: String(m), label: durationLabel(m) }))}
            onChange={(v) => setMinutes(Number(v))}
          />
        }
        onConfirm={(reason) =>
          impersonate.mutate(
            { tenantId, reason, durationMinutes: minutes },
            {
              onSuccess: (res) => {
                setResult(res);
                setAsk(false);
              },
              onError: (e) =>
                toast({
                  title: "Error al generar el acceso",
                  description: impersonationErrorMessage(e instanceof Error ? e.message : null),
                  variant: "error",
                }),
            },
          )
        }
      />
    </>
  );
}
