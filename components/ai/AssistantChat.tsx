"use client";

import { forwardRef, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  ArrowUpRight,
  Database,
  Lock,
  PackageSearch,
  SquarePen,
  Sparkles,
  TrendingUp,
  Trophy,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";
import { AssistantMark } from "./AssistantMark";
import { ChatMarkdown } from "./ChatMarkdown";

// Presentación del Asistente IA (launcher flotante + panel de chat). No toca
// datos: AssistantBubble resuelve acceso, config pública, cuota y llamadas a la
// Edge Function, y le pasa todo por props.

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  consultedData?: boolean;
};

// Sugerencias del estado vacío: un toque las envía tal cual.
const SUGGESTIONS: { icon: LucideIcon; text: string }[] = [
  { icon: TrendingUp, text: "¿Cuánto vendí hoy?" },
  { icon: PackageSearch, text: "¿Qué productos tienen stock bajo?" },
  { icon: Trophy, text: "¿Cuáles son mis productos más vendidos este mes?" },
  { icon: Wallet, text: "¿Cómo hago el cierre de caja?" },
];

// ── Launcher ────────────────────────────────────────────────────────────────

export const AssistantLauncher = forwardRef<
  HTMLButtonElement,
  {
    ready: boolean;
    locked: boolean;
    providerImage: string;
    providerName: string;
    onOpen: () => void;
  }
>(function AssistantLauncher(
  { ready, locked, providerImage, providerName, onOpen },
  ref,
) {
  const [badgeBroken, setBadgeBroken] = useState(false);
  useEffect(() => setBadgeBroken(false), [providerImage]);
  const showProvider = ready && !locked && providerImage && !badgeBroken;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      disabled={!ready}
      aria-label={ready ? "Abrir asistente IA" : "Cargando asistente IA"}
      aria-busy={!ready}
      className="group fixed bottom-[max(1rem,calc(env(safe-area-inset-bottom)+0.5rem))] right-4 z-40 grid h-14 w-14 place-items-center rounded-[30%] outline-none transition-transform duration-200 ease-out hover:scale-[1.06] focus-visible:ring-2 focus-visible:ring-ninja-flame focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-95 disabled:cursor-default disabled:hover:scale-100 sm:bottom-6 sm:right-6"
    >
      {/* Halo de fuego que "respira" detrás del ícono. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -inset-1.5 rounded-[38%] bg-ninja-gradient blur-xl",
          ready ? "ai-halo" : "opacity-20",
        )}
      />
      {/* Sombra de apoyo: separa el ícono de cualquier fondo (claro u oscuro). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[30%] shadow-[0_10px_24px_-6px_rgba(11,7,32,0.55)]"
      />
      <AssistantMark
        size={56}
        animated={ready}
        className={cn("transition-opacity", !ready && "opacity-70")}
      />

      {/* Esquina inferior derecha: proveedor activo, candado o spinner. */}
      {!ready ? (
        <CornerBadge>
          <Spinner
            size={12}
            className="border-[1.5px] border-ninja-slate/30 border-t-ninja-flame"
          />
        </CornerBadge>
      ) : locked ? (
        <CornerBadge>
          <Lock size={11} strokeWidth={2.5} className="text-ninja-flame" />
        </CornerBadge>
      ) : showProvider ? (
        <CornerBadge>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={providerImage}
            alt=""
            width={14}
            height={14}
            className="h-3.5 w-3.5 object-contain"
            onError={() => setBadgeBroken(true)}
          />
        </CornerBadge>
      ) : null}

      {/* Etiqueta al pasar el mouse (solo desktop). */}
      {ready && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-[calc(100%+12px)] top-1/2 hidden -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-full bg-popover px-3.5 py-2 text-[13px] font-medium text-popover-foreground opacity-0 shadow-[0_8px_24px_-8px_rgba(11,7,32,0.45)] transition duration-200 ease-out group-hover:translate-x-0 group-hover:opacity-100 sm:block"
        >
          {locked
            ? "Conocé el Asistente IA"
            : `Asistente IA con ${providerName}`}
        </span>
      )}
    </button>
  );
});

function CornerBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-popover shadow-[0_0_0_2px_var(--background),0_2px_6px_rgba(11,7,32,0.35)]">
      {children}
    </span>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

type PanelProps = {
  locked: boolean;
  providerName: string;
  providerImage: string;
  messages: ChatMessage[];
  pending: boolean;
  quota: { used: number; cap: number } | null;
  explainer: string;
  explainerLoading: boolean;
  price: string;
  onSend: (text: string) => void;
  onReset: () => void;
  onClose: () => void;
};

export function AssistantPanel(props: PanelProps) {
  const { locked, providerName, providerImage, messages, onClose, onReset } =
    props;
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  // Escape cierra el chat desde cualquier lugar del panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Fondo del bottom sheet (solo mobile): tocar afuera cierra. */}
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-40 animate-overlay-in bg-ninja-black/55 backdrop-blur-[2px] sm:hidden"
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "ai-panel-in fixed inset-x-0 bottom-0 z-40 flex h-[88dvh] flex-col overflow-hidden rounded-t-[28px] bg-popover text-popover-foreground outline-none",
          "shadow-[0_-12px_48px_-12px_rgba(11,7,32,0.55)]",
          "sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[min(680px,calc(100dvh-3rem))] sm:w-[400px] sm:rounded-[28px] sm:shadow-[0_28px_80px_-16px_rgba(11,7,32,0.6),0_0_0_1px_rgba(127,117,166,0.14)]",
        )}
      >
        {/* Resplandor de marca arriba: identidad sin bordes de color. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-70"
          style={{
            background:
              "radial-gradient(80% 100% at 15% 0%, rgba(255,75,34,0.16) 0%, rgba(255,138,31,0.06) 45%, rgba(255,138,31,0) 75%)",
          }}
        />

        {/* Grabber del sheet (mobile). */}
        <div className="relative flex justify-center pt-2.5 sm:hidden">
          <span className="h-1.5 w-10 rounded-full bg-ninja-slate/35" />
        </div>

        {/* Header */}
        <header className="relative flex items-center gap-3 px-4 pb-3 pt-3 sm:px-5 sm:pt-5">
          <AssistantMark size={40} sparkle={false} />
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="font-display text-[17px] font-semibold leading-tight tracking-tight text-foreground"
            >
              Asistente IA
            </h2>
            {locked ? (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <Lock size={11} /> Complemento opcional
              </p>
            ) : (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative grid h-2 w-2 place-items-center">
                  <span className="h-2 w-2 rounded-full bg-success" />
                </span>
                <span className="truncate">
                  Activo con{" "}
                  <span className="font-medium text-foreground">
                    {providerName}
                  </span>
                </span>
                <ProviderLogo url={providerImage} />
              </p>
            )}
          </div>
          {!locked && messages.length > 0 && (
            <HeaderButton label="Nueva conversación" onClick={onReset}>
              <SquarePen size={17} />
            </HeaderButton>
          )}
          <HeaderButton label="Cerrar asistente" onClick={onClose}>
            <X size={18} />
          </HeaderButton>
        </header>

        {locked ? (
          <LockedBody {...props} panelRef={panelRef} />
        ) : (
          <ChatBody {...props} panelRef={panelRef} />
        )}
      </section>
    </>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-ninja-flame active:scale-95"
    >
      {children}
    </button>
  );
}

function ProviderLogo({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (!url || broken) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={14}
      height={14}
      className="h-3.5 w-3.5 shrink-0 object-contain"
      onError={() => setBroken(true)}
    />
  );
}

// ── Chat (con acceso) ───────────────────────────────────────────────────────

function ChatBody({
  messages,
  pending,
  quota,
  providerName,
  onSend,
  panelRef,
}: PanelProps & { panelRef: React.RefObject<HTMLElement> }) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  // Foco al abrir: en desktop directo al campo de texto; en pantallas táctiles
  // al panel, para no tapar las sugerencias con el teclado.
  useEffect(() => {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    if (coarse) panelRef.current?.focus();
    else inputRef.current?.focus();
  }, [panelRef]);

  // Autoscroll al final cuando entran mensajes o aparece el "escribiendo".
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  // Textarea que crece con el contenido hasta ~6 líneas.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  function submit(text = input) {
    const t = text.trim();
    if (!t || pending) return;
    onSend(t);
    setInput("");
    inputRef.current?.focus();
  }

  const remaining = quota ? Math.max(0, quota.cap - quota.used) : null;
  const canSend = input.trim().length > 0 && !pending;

  return (
    <>
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversación con el asistente"
        className="slim-scrollbar relative flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-5"
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col justify-end pb-1 pt-4">
            <div className="flex flex-col items-center px-2 text-center">
              <AssistantMark size={68} animated />
              <p className="mt-4 font-display text-[22px] font-semibold leading-tight tracking-tight text-foreground">
                ¿En qué te ayudo hoy?
              </p>
              <p className="mt-1.5 max-w-[30ch] text-sm leading-relaxed text-muted-foreground">
                Preguntame por tus ventas, tu stock o cómo usar cualquier
                pantalla del sistema.
              </p>
            </div>
            <div className="mt-6 grid gap-2">
              {SUGGESTIONS.map(({ icon: Icon, text }) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => submit(text)}
                  disabled={pending}
                  className="group flex min-h-[48px] items-center gap-3 rounded-2xl bg-secondary px-3.5 py-2.5 text-left text-sm text-foreground outline-none transition hover:bg-ninja-flame/10 focus-visible:ring-2 focus-visible:ring-ninja-flame active:scale-[0.99]"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-ninja-flame/15 text-primary">
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">{text}</span>
                  <ArrowUpRight
                    size={16}
                    className="shrink-0 text-muted-foreground opacity-60 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-100"
                  />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ai-msg-in flex justify-end pl-10">
                  <div className="whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-ninja-gradient px-4 py-2.5 text-[15px] leading-relaxed text-ninja-voidViolet shadow-[0_6px_16px_-8px_rgba(255,75,34,0.6)] sm:text-[14.5px]">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  className="ai-msg-in flex items-start gap-2.5 pr-6"
                >
                  <AssistantMark size={28} sparkle={false} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="inline-block max-w-full break-words rounded-[20px] rounded-tl-md bg-secondary px-4 py-3 text-[15px] leading-relaxed text-secondary-foreground sm:text-[14.5px]">
                      <ChatMarkdown text={m.content} />
                    </div>
                    {/* La respuesta usó datos reales del negocio (function-
                        calling sobre las RPCs de solo lectura). */}
                    {m.consultedData && (
                      <span className="mt-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                        <Database size={11} className="text-primary" />
                        Consulté los datos de tu negocio
                      </span>
                    )}
                  </div>
                </div>
              ),
            )}
            {pending && (
              <div className="ai-msg-in flex items-start gap-2.5">
                <AssistantMark size={28} sparkle={false} className="mt-0.5" />
                <div
                  role="status"
                  aria-label="El asistente está escribiendo"
                  className="flex h-[42px] items-center gap-1.5 rounded-[20px] rounded-tl-md bg-secondary px-4"
                >
                  {[0, 160, 320].map((d) => (
                    <span
                      key={d}
                      className="ai-dot h-2 w-2 rounded-full bg-ninja-gradient"
                      style={{ animationDelay: `${d}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="relative px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4 sm:pb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-end gap-2 rounded-[24px] bg-secondary py-1.5 pl-4 pr-1.5 transition-colors focus-within:bg-ninja-flame/[0.07]"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            aria-label="Mensaje para el asistente"
            aria-describedby={hintId}
            placeholder="Preguntá lo que necesites"
            className="slim-scrollbar max-h-36 min-h-[36px] flex-1 resize-none bg-transparent py-[7px] text-base leading-[22px] text-foreground outline-none placeholder:text-muted-foreground sm:text-[14.5px]"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Enviar mensaje"
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-ninja-flame focus-visible:ring-offset-2 focus-visible:ring-offset-popover active:scale-90",
              canSend
                ? "bg-ninja-gradient text-ninja-voidViolet shadow-[0_4px_12px_-4px_rgba(255,75,34,0.7)]"
                : "bg-ninja-slate/20 text-muted-foreground",
            )}
          >
            {pending ? (
              <Spinner
                size={16}
                className="border-ninja-slate/30 border-t-ninja-flame"
              />
            ) : (
              <ArrowUp size={18} strokeWidth={2.5} />
            )}
          </button>
        </form>
        <p id={hintId} className="sr-only">
          Enter para enviar, Shift más Enter para una línea nueva.
        </p>
        <div className="mt-2 flex items-center justify-between gap-2 px-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Sparkles size={11} className="text-primary" />
            Con tecnología de{" "}
            <span className="font-medium text-foreground">{providerName}</span>
          </span>
          {remaining !== null && (
            <span className="tabular-nums">
              {remaining.toLocaleString("es-AR")} tokens restantes
            </span>
          )}
        </div>
      </div>
    </>
  );
}

// ── Sin complemento: explicador comercial + CTA ─────────────────────────────

function LockedBody({
  explainer,
  explainerLoading,
  price,
  onClose,
  panelRef,
}: PanelProps & { panelRef: React.RefObject<HTMLElement> }) {
  const ctaRef = useRef<HTMLAnchorElement>(null);
  // En desktop el foco va al CTA; en táctil queda en el panel.
  useEffect(() => {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    if (coarse) panelRef.current?.focus();
    else ctaRef.current?.focus({ preventScroll: true });
  }, [panelRef]);

  return (
    <>
      <div className="slim-scrollbar relative flex flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-2 sm:px-5">
        {/* Hero: siempre "noche violeta" (como el ícono), en cualquier tema. */}
        <div
          className="relative shrink-0 overflow-hidden rounded-3xl px-5 pb-5 pt-5 text-ninja-softWhite"
          style={{
            background:
              "radial-gradient(90% 70% at 50% 120%, rgba(255,75,34,0.45) 0%, rgba(255,138,31,0.12) 45%, rgba(255,138,31,0) 70%), linear-gradient(160deg, #24145E 0%, #140B3A 50%, #0B0720 100%)",
          }}
        >
          <div className="flex flex-col items-center text-center">
            <AssistantMark size={56} animated />
            <span className="mt-3.5 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-[#FFD9A8]">
              <Lock size={11} /> Todavía no lo tenés contratado
            </span>
            <p className="mt-3 font-display text-[21px] font-semibold leading-tight tracking-tight text-white">
              Tu negocio, respondido al instante
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">
              Preguntá en lenguaje natural y obtené la respuesta con tus datos.
            </p>
          </div>
        </div>

        <div className="mt-4 min-h-[3rem] shrink-0 text-sm leading-relaxed text-muted-foreground">
          {explainerLoading ? (
            <div className="flex justify-center py-3">
              <Spinner size={20} />
            </div>
          ) : (
            <p className="whitespace-pre-wrap">{explainer}</p>
          )}
        </div>

        <ul
          className="mt-3 grid shrink-0 gap-2"
          aria-label="Ejemplos de preguntas"
        >
          {SUGGESTIONS.slice(0, 3).map(({ icon: Icon, text }) => (
            <li
              key={text}
              className="flex items-center gap-3 rounded-2xl bg-secondary px-3.5 py-2.5 text-sm text-foreground"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ninja-flame/15 text-primary">
                <Icon size={14} />
              </span>
              {text}
            </li>
          ))}
        </ul>
      </div>

      {/* Footer fijo: el CTA queda siempre a la vista, aunque el texto scrollee. */}
      <div className="relative shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:pb-5">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-popover to-transparent"
        />
        {price && (
          <p className="mb-2.5 flex items-baseline justify-center gap-1.5 text-foreground">
            <span className="font-display text-2xl font-semibold tabular-nums tracking-tight">
              ${Number(price).toLocaleString("es-AR")}
            </span>
            <span className="text-sm text-muted-foreground">por mes</span>
          </p>
        )}
        <CtaLink ref={ctaRef} onClick={onClose} />
        <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
          Se activa desde el Panel del dueño.
        </p>
      </div>
    </>
  );
}

const CtaLink = forwardRef<HTMLAnchorElement, { onClick: () => void }>(
  function CtaLink({ onClick }, ref) {
    return (
      <Link
        ref={ref}
        href={"/dashboard-team" as never}
        onClick={onClick}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-ninja-gradient text-[15px] font-semibold text-ninja-voidViolet shadow-[0_10px_24px_-10px_rgba(255,75,34,0.8)] outline-none transition hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ninja-flame focus-visible:ring-offset-2 focus-visible:ring-offset-popover active:scale-[0.98]"
      >
        <Sparkles size={17} /> Contratar Asistente IA
      </Link>
    );
  },
);
