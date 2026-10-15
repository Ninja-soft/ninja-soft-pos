"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock,
  Copy,
  KeyRound,
  Lock,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Ticket,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { IntegrationLogo, integrationLabel, type IntegrationKey } from "@/components/ui/IntegrationLogo";
import { LocalQr } from "@/components/pos/LocalQr";
import { EYEBROW, FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import {
  useMyAuthHistory,
  useMyPins,
  useMyPinsMutations,
  useOneTimeList,
  usePinMutations,
  useRotatingCode,
} from "@/modules/security/hooks";
import type { MyPins, OneTimeCreated, TotpEnrollment } from "@/modules/security/api";
import { ACTION_INFO, PIN_ACTIONS, type PinAction } from "@/lib/security/pinPolicy";
import {
  ONE_TIME_MINUTES_OPTIONS,
  PIN_MODE_INFO,
  formatCountdown,
  groupCode,
  oneTimeState,
  otpauthUri,
  secondsLeft,
  shareCodeText,
  whatsappShareUrl,
  type PinMode,
} from "@/lib/security/otp";
import { pinProblem } from "@/lib/account/pin";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Mis PINes (ADR-060): el dueño y los supervisores ven su PIN rotativo con la
// cuenta regresiva, generan PIN de un uso para pasarle al empleado, vinculan
// una app autenticadora y miran quién usó sus autorizaciones. Los secretos
// nunca llegan al navegador: sólo el código vigente, calculado en el servidor.

function fmtDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" }) : "";
}
function fmtTime(iso: string | Date) {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}
function fmtWhen(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `Hoy ${fmtTime(d)}`
    : d.toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Re-render cada `ms` (cuentas regresivas). */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function shortLeft(seconds: number) {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return `${seconds} s`;
}

/** Anillo de cuenta regresiva: trazo sólido sobre un riel neutro, sin degradado. */
export function CountdownRing({ left, total, size = 84 }: { left: number; total: number; size?: number }) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
  const low = total > 0 && left / total < 0.15;
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke="currentColor" className="text-foreground/10" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke="currentColor"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className={cn(low ? "text-warning" : "text-[color:var(--pos-solid)]", "transition-[stroke-dashoffset] duration-1000 ease-linear")}
        />
      </svg>
      <span className="absolute text-xs font-semibold tabular-nums" aria-hidden>
        {shortLeft(left)}
      </span>
    </div>
  );
}
CountdownRing.displayName = "CountdownRing";

function CodeActions({ code, until, kind, actionLabel }: { code: string; until: string; kind: PinMode; actionLabel?: string | null }) {
  const { toast } = useToast();
  const text = shareCodeText({ code, until, kind, actionLabel });
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            toast({ title: "Código copiado", variant: "success" });
          } catch {
            toast({ title: "No se pudo copiar", variant: "error" });
          }
        }}
      >
        <Copy size={15} /> Copiar
      </Button>
      <a
        href={whatsappShareUrl(text)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-secondary px-3 text-sm font-semibold text-secondary-foreground hover:bg-secondary/70"
      >
        <MessageCircle size={15} /> WhatsApp
      </a>
    </div>
  );
}

function BigCode({ code }: { code: string }) {
  return (
    <p className="whitespace-nowrap font-display text-[2rem] font-bold leading-tight tabular-nums tracking-[0.1em] sm:text-5xl" aria-label={`Código ${code.split("").join(" ")}`}>
      {groupCode(code)}
    </p>
  );
}

function CardHeader({ icon: Icon, title, desc, right }: { icon: typeof KeyRound; title: string; desc: string; right?: React.ReactNode }) {
  return (
    <header className="flex items-start gap-3 border-b border-border p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
        <Icon size={18} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      {right}
    </header>
  );
}

export function MyPinsPanel() {
  const { data: pins, isLoading } = useMyPins();

  if (isLoading) return <SpinnerBlock className="py-10" />;
  if (!pins) {
    return (
      <Callout tone="neutral" icon={KeyRound}>
        Mis PINes todavía no está disponible en este negocio.
      </Callout>
    );
  }
  if (!pins.can_have_pin) {
    return (
      <Callout tone="neutral" icon={KeyRound}>
        No sos supervisor en este negocio, así que no tenés PINes para autorizar. Si hace falta, el dueño te puede sumar.
      </Callout>
    );
  }

  const has = (m: PinMode) => pins.modes.includes(m);
  // Una sola columna a todo el ancho (modal y Seguridad), en el orden de uso:
  // 1. PIN rotativo, arriba si está activo (es el que se dicta en el día).
  // 2. PIN fijo, la credencial de base que todo supervisor tiene.
  // 3. PIN de un uso y sus activos: se generan en el momento, para un caso
  //    puntual, así que van después de los PINes de todos los días.
  // 4. PIN rotativo apagado (sólo la invitación a activarlo).
  // 5. App autenticadora al final, con su estado de conexión.
  const rotatingOn = pins.rotating.enabled;

  return (
    <div className="space-y-5">
      {pins.locked_until && (
        <Callout tone="danger" icon={Lock}>
          Tus autorizaciones están bloqueadas por intentos fallidos hasta las {fmtTime(pins.locked_until)}. El dueño las puede
          desbloquear en Supervisores.
        </Callout>
      )}
      {!pins.feature && (
        <Callout tone="neutral" icon={ShieldCheck}>
          PIN rotativo, PIN de un uso y app autenticadora vienen desde el plan Pro. Hoy autorizás con tu PIN fijo.
        </Callout>
      )}
      {has("rotating") && rotatingOn && <RotatingCard pins={pins} />}
      {has("fixed") && <FixedPinCard />}
      {has("one_time") && (
        <>
          <OneTimeCard pins={pins} />
          <ActiveOneTimeList />
        </>
      )}
      {has("rotating") && !rotatingOn && <RotatingCard pins={pins} />}
      {has("totp") && <TotpCard pins={pins} />}
      <HistoryList />
    </div>
  );
}
MyPinsPanel.displayName = "MyPinsPanel";

// ── PIN rotativo ──────────────────────────────────────────────────────────────
function RotatingCard({ pins }: { pins: MyPins }) {
  const { toast } = useToast();
  const { rotatingEnable, rotatingDisable } = useMyPinsMutations();
  const enabled = pins.rotating.enabled;
  const code = useRotatingCode(enabled);
  const now = useNow();
  const [confirm, setConfirm] = useState<"regen" | "off" | null>(null);

  // Desfase entre el reloj del servidor y el del dispositivo.
  const skewMs = useMemo(
    () => (code.data ? new Date(code.data.server_time).getTime() - code.dataUpdatedAt : 0),
    [code.data, code.dataUpdatedAt],
  );
  const left = code.data ? secondsLeft(code.data.valid_until, now + skewMs) : 0;
  const total = (code.data?.period_hours ?? pins.rotation_hours) * 3600;
  const hours = pins.rotation_hours;

  return (
    <section className={FLAT_PANEL}>
      <CardHeader
        icon={RefreshCw}
        title="PIN rotativo"
        desc={`Cambia solo cada ${hours} ${hours === 1 ? "hora" : "horas"}. Pasáselo al empleado cuando tenga que autorizar.`}
        right={enabled ? <Badge tone="success">Activo</Badge> : undefined}
      />
      <div className="p-4">
        {!enabled ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              El código se calcula en el servidor con un secreto que nunca sale de ahí. El anterior sigue valiendo 5 minutos
              después del cambio.
            </p>
            <Button
              className={SOLID_CTA}
              loading={rotatingEnable.isPending}
              onClick={async () => {
                try {
                  await rotatingEnable.mutateAsync(false);
                  toast({ title: "PIN rotativo activado", variant: "success" });
                } catch {
                  toast({ title: "No se pudo activar", variant: "error" });
                }
              }}
            >
              <RefreshCw size={16} /> Activar PIN rotativo
            </Button>
          </div>
        ) : code.isLoading || !code.data ? (
          <SpinnerBlock className="py-6" />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <CountdownRing left={left} total={total} />
              <div className="min-w-0">
                <BigCode code={code.data.code} />
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  Cambia en {formatCountdown(left)} (a las {fmtTime(code.data.valid_until)})
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CodeActions code={code.data.code} until={code.data.valid_until} kind="rotating" />
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("regen")}>
                  Cambiar secreto
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("off")}>
                  Desactivar
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "regen" ? "Cambiar el secreto del PIN rotativo" : "Desactivar el PIN rotativo"}
        description={
          confirm === "regen"
            ? "El código actual deja de valer al instante y empieza una secuencia nueva. Sirve si alguien lo vio de más."
            : "Tu PIN rotativo deja de valer. Podés volver a activarlo cuando quieras (con un secreto nuevo)."
        }
        confirmLabel={confirm === "regen" ? "Cambiar secreto" : "Desactivar"}
        danger={confirm === "off"}
        loading={rotatingEnable.isPending || rotatingDisable.isPending}
        onConfirm={async () => {
          try {
            if (confirm === "regen") await rotatingEnable.mutateAsync(true);
            else await rotatingDisable.mutateAsync();
            toast({ title: confirm === "regen" ? "Secreto cambiado" : "PIN rotativo desactivado", variant: "success" });
          } catch {
            toast({ title: "No se pudo guardar", variant: "error" });
          }
          setConfirm(null);
        }}
      />
    </section>
  );
}

// ── PIN de un uso ─────────────────────────────────────────────────────────────
function OneTimeCard({ pins }: { pins: MyPins }) {
  const { toast } = useToast();
  const { oneTimeCreate } = useMyPinsMutations();
  const options = useMemo(
    () => ONE_TIME_MINUTES_OPTIONS.filter((m) => m <= pins.one_time_max_minutes),
    [pins.one_time_max_minutes],
  );
  const [minutes, setMinutes] = useState<number>(Math.min(5, pins.one_time_max_minutes));
  const [action, setAction] = useState<PinAction | "">("");
  const [maxAmount, setMaxAmount] = useState("");
  const [note, setNote] = useState("");
  // El código vive sólo en este estado: el servidor guarda el hash.
  const [created, setCreated] = useState<(OneTimeCreated & { total: number }) | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!(options as readonly number[]).includes(minutes) && options.length) setMinutes(options[options.length - 1]!);
  }, [options, minutes]);

  const unit = action ? ACTION_INFO[action].unit : "money";
  const left = created ? secondsLeft(created.expires_at, now) : 0;

  async function generate() {
    const amount = maxAmount.trim() ? Number(maxAmount.replace(",", ".")) : null;
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      toast({ title: "El monto máximo no es válido", variant: "error" });
      return;
    }
    try {
      const r = await oneTimeCreate.mutateAsync({
        minutes,
        action: action || null,
        maxAmount: amount,
        note: note.trim() || null,
      });
      setCreated({ ...r, total: minutes * 60 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast({
        title: "No se pudo generar",
        description: /too_many_active/.test(msg) ? "Tenés 20 PIN de un uso activos: revocá alguno." : undefined,
        variant: "error",
      });
    }
  }

  return (
    <section className={FLAT_PANEL}>
      <CardHeader
        icon={Ticket}
        title="PIN de un uso"
        desc={`Se genera en el momento, sirve una sola vez y vence en ${pins.one_time_max_minutes === 1 ? "1 minuto" : `hasta ${pins.one_time_max_minutes} minutos`}.`}
      />
      <div className="space-y-4 p-4">
        {created && left > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <CountdownRing left={left} total={created.total} />
              <div className="min-w-0">
                <BigCode code={created.code} />
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  Vence en {formatCountdown(left)}
                  {created.action ? ` · sólo ${ACTION_INFO[created.action].label.toLowerCase()}` : ""}
                  {created.max_amount != null
                    ? ` · hasta ${created.action && ACTION_INFO[created.action].unit === "pct" ? `${created.max_amount} %` : formatCurrency(created.max_amount)}`
                    : ""}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Este código no se vuelve a mostrar. Si lo perdés, generá otro y revocá este.
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CodeActions
                code={created.code}
                until={created.expires_at}
                kind="one_time"
                actionLabel={created.action ? ACTION_INFO[created.action].label : null}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>
                <Check size={15} /> Listo
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <span className={cn(EYEBROW, "mb-2 block")}>Dura</span>
              <Segmented
                size="sm"
                value={String(minutes)}
                onChange={(v) => setMinutes(Number(v))}
                aria-label="Duración del PIN"
                options={options.map((m) => ({ value: String(m), label: `${m} min` }))}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">Para (opcional)</span>
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value as PinAction | "")}
                  className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
                >
                  <option value="">Cualquier acción</option>
                  {PIN_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_INFO[a].label}
                    </option>
                  ))}
                </select>
              </label>
              {(!action || ACTION_INFO[action].unit !== "none") && (
                <Input
                  label={unit === "pct" ? "Hasta % (opcional)" : "Monto máximo (opcional)"}
                  inputMode="decimal"
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
                  placeholder={unit === "pct" ? "Ej. 30" : "Ej. 20000"}
                />
              )}
            </div>
            <Input
              label="Nota (opcional)"
              value={note}
              maxLength={120}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ej. Anulación del ticket 1234"
            />
            <Button className={cn(SOLID_CTA, "w-full sm:w-auto")} loading={oneTimeCreate.isPending} onClick={generate}>
              <Ticket size={16} /> Generar PIN de un uso
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function ActiveOneTimeList() {
  const { toast } = useToast();
  const { data = [], isLoading } = useOneTimeList();
  const { oneTimeRevoke } = useMyPinsMutations();
  const now = useNow();
  const active = data.filter((c) => oneTimeState(c, now) === "active");

  return (
    <section className={FLAT_PANEL}>
      <CardHeader icon={Clock} title="PIN de un uso activos" desc="Los que generaste y todavía nadie usó. Revocá los que ya no hacen falta." />
      {isLoading ? (
        <SpinnerBlock className="py-6" />
      ) : active.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No tenés PIN de un uso activos.</p>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((c) => (
            <li key={c.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.action ? ACTION_INFO[c.action].label : "Cualquier acción"}</p>
                <p className="text-xs text-muted-foreground">
                  Creado {fmtTime(c.created_at)} · vence en {formatCountdown(secondsLeft(c.expires_at, now))}
                  {c.max_amount != null
                    ? ` · hasta ${c.action && ACTION_INFO[c.action].unit === "pct" ? `${c.max_amount} %` : formatCurrency(c.max_amount)}`
                    : ""}
                  {c.note ? ` · ${c.note}` : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={oneTimeRevoke.isPending && oneTimeRevoke.variables === c.id}
                onClick={async () => {
                  try {
                    await oneTimeRevoke.mutateAsync(c.id);
                    toast({ title: "PIN revocado", variant: "success" });
                  } catch {
                    toast({ title: "No se pudo revocar", variant: "error" });
                  }
                }}
              >
                <X size={15} /> Revocar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── App autenticadora ─────────────────────────────────────────────────────────
// Las más usadas. El servidor no sabe con cuál se escaneó el QR (el estándar
// TOTP no lo informa), así que se muestran todas como compatibles.
const AUTHENTICATOR_APPS = [
  "google_authenticator",
  "microsoft_authenticator",
  "authy",
  "onepassword",
  "bitwarden",
] as const satisfies readonly IntegrationKey[];

function AuthenticatorApps() {
  return (
    <div>
      <span className={cn(EYEBROW, "mb-2 block")}>Compatible con</span>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {AUTHENTICATOR_APPS.map((k) => (
          <li key={k} className="flex items-center gap-2 text-sm">
            <IntegrationLogo name={k} size={22} bare />
            <span className="whitespace-nowrap text-muted-foreground">{integrationLabel(k)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TotpCard({ pins }: { pins: MyPins }) {
  const { toast } = useToast();
  const { totpBegin, totpConfirm, totpDisable } = useMyPinsMutations();
  const [step, setStep] = useState<30 | 60>(30);
  const [enroll, setEnroll] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const uri = enroll ? otpauthUri({ secretBase32: enroll.secret_base32, account: enroll.account, step: enroll.step }) : "";

  return (
    <section className={FLAT_PANEL}>
      <CardHeader
        icon={Smartphone}
        title="App autenticadora"
        desc="Un código que cambia cada 30 o 60 segundos en tu celular, aunque no tengas internet."
        right={
          pins.totp.enabled ? <Badge tone="success">Conectada</Badge> : <Badge tone="neutral">No conectada</Badge>
        }
      />
      <div className="space-y-4 p-4">
        {pins.totp.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Conectada el {fmtDate(pins.totp.confirmed_at)} · el código cambia cada {pins.totp.step} s. Abrí la app y dictale el
              código al empleado.
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
              Desvincular
            </Button>
          </div>
        ) : enroll ? (
          <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
            <LocalQr value={uri} label="QR para vincular la app autenticadora" size={180} />
            <div className="min-w-0 space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>En la app, tocá Agregar cuenta y escaneá el QR.</li>
                <li>Si no podés escanear, cargá la clave a mano.</li>
                <li>Escribí el código de 6 números que muestra la app.</li>
              </ol>
              <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-sm tracking-wider">
                {enroll.secret_base32.replace(/(.{4})/g, "$1 ").trim()}
              </p>
              <div className="flex items-end gap-2">
                <Input
                  label="Código de la app"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
                <Button
                  className={SOLID_CTA}
                  disabled={code.length !== 6}
                  loading={totpConfirm.isPending}
                  onClick={async () => {
                    try {
                      await totpConfirm.mutateAsync(code);
                      setEnroll(null);
                      setCode("");
                      toast({ title: "App vinculada", variant: "success" });
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : "";
                      toast({
                        title: /totp_not_pending/.test(msg) ? "Pasaron más de 15 minutos: empezá de nuevo" : "El código no coincide",
                        description: /totp_invalid/.test(msg) ? "Revisá que la hora del celular esté en automático." : undefined,
                        variant: "error",
                      });
                    }
                  }}
                >
                  Confirmar
                </Button>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEnroll(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className={cn(EYEBROW, "mb-2 block")}>El código cambia cada</span>
              <Segmented
                size="sm"
                value={String(step) as "30" | "60"}
                onChange={(v) => setStep(Number(v) as 30 | 60)}
                aria-label="Paso de la app"
                options={[
                  { value: "30", label: "30 s" },
                  { value: "60", label: "60 s" },
                ]}
              />
            </div>
            <Button
              className={SOLID_CTA}
              loading={totpBegin.isPending}
              onClick={async () => {
                try {
                  setEnroll(await totpBegin.mutateAsync(step));
                } catch {
                  toast({ title: "No se pudo empezar la vinculación", variant: "error" });
                }
              }}
            >
              <Smartphone size={16} /> Vincular app
            </Button>
          </div>
        )}
        <AuthenticatorApps />
      </div>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Desvincular la app autenticadora"
        description="Los códigos de la app dejan de valer. Para volver a usarla hay que escanear un QR nuevo."
        confirmLabel="Desvincular"
        danger
        loading={totpDisable.isPending}
        onConfirm={async () => {
          try {
            await totpDisable.mutateAsync();
            toast({ title: "App desvinculada", variant: "success" });
          } catch {
            toast({ title: "No se pudo desvincular", variant: "error" });
          }
          setConfirmOff(false);
        }}
      />
    </section>
  );
}

// ── PIN fijo (ADR-051) ────────────────────────────────────────────────────────
export function FixedPinCard() {
  const { toast } = useToast();
  const { data: pins } = useMyPins();
  const { setPin } = usePinMutations();
  const [pin, setPinValue] = useState("");
  const [repeat, setRepeat] = useState("");
  const problem = pin ? pinProblem(pin) : null;
  const mismatch = repeat.length > 0 && repeat !== pin;
  const canSave = pin.length >= 4 && !problem && repeat === pin;
  const fixed = pins?.fixed;

  async function save() {
    if (!canSave) return;
    try {
      await setPin.mutateAsync(pin);
      setPinValue("");
      setRepeat("");
      toast({ title: fixed?.has_pin ? "PIN actualizado" : "PIN guardado", variant: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast({
        title: "No se pudo guardar el PIN",
        description: /weak_pin/.test(msg) ? "Es muy fácil: evitá repetidos o escaleras." : undefined,
        variant: "error",
      });
    }
  }

  return (
    <section className={FLAT_PANEL}>
      <CardHeader
        icon={KeyRound}
        title={PIN_MODE_INFO.fixed.label}
        desc={
          fixed?.has_pin
            ? `Cargado el ${fmtDate(fixed.set_at)}${fixed.expires_at ? `, vence el ${fmtDate(fixed.expires_at)}` : ""}.`
            : "Todavía no cargaste tu PIN fijo."
        }
        right={fixed?.expired ? <Badge tone="warning">Vencido</Badge> : undefined}
      />
      <div className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input
          label={fixed?.has_pin ? "PIN nuevo" : "PIN (4 a 6 números)"}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={pin}
          onChange={(e) => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 6))}
          error={problem ?? undefined}
        />
        <Input
          label="Repetilo"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value.replace(/\D/g, "").slice(0, 6))}
          error={mismatch ? "No coincide" : undefined}
        />
        <Button className={SOLID_CTA} disabled={!canSave} loading={setPin.isPending} onClick={save}>
          <KeyRound size={16} /> {fixed?.has_pin ? "Cambiar" : "Guardar"}
        </Button>
      </div>
    </section>
  );
}
FixedPinCard.displayName = "FixedPinCard";

// ── Historial ─────────────────────────────────────────────────────────────────
function HistoryList() {
  const { data = [], isLoading } = useMyAuthHistory();
  return (
    <section className={FLAT_PANEL}>
      <CardHeader icon={ShieldCheck} title="Quién usó tus autorizaciones" desc="Las últimas autorizaciones e intentos fallidos con tus PINes." />
      {isLoading ? (
        <SpinnerBlock className="py-6" />
      ) : data.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Todavía nadie usó tus PINes.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((h) => {
            const ok = h.event === "supervisor_authorized";
            const locked = h.event === "supervisor_pin_locked";
            return (
              <li key={h.id} className="flex items-start gap-3 p-4">
                <span
                  className={cn(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    ok ? "bg-success" : locked ? "bg-danger" : "bg-warning",
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{h.requested_by_name ?? "Alguien"}</span>{" "}
                    {ok ? "autorizó" : locked ? "bloqueó tu PIN con" : "falló un intento para"}{" "}
                    {h.pin_action ? ACTION_INFO[h.pin_action]?.label.toLowerCase() ?? h.pin_action : "una acción"}
                    {h.amount != null && h.pin_action && ACTION_INFO[h.pin_action]?.unit === "money"
                      ? ` por ${formatCurrency(Number(h.amount))}`
                      : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtWhen(h.created_at)}
                    {h.auth_mode ? ` · ${PIN_MODE_INFO[h.auth_mode]?.label ?? h.auth_mode}` : ""}
                    {h.reason ? ` · ${h.reason}` : ""}
                  </p>
                </div>
                <Badge tone={ok ? "success" : locked ? "danger" : "warning"}>{ok ? "Autorizado" : locked ? "Bloqueo" : "Fallido"}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
