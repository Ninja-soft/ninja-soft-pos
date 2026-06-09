"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Sparkles, X, Send, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { useToast } from "@/components/ui/Toast";
import { Spinner } from "@/components/ui/Spinner";

// `consultedData` marca respuestas del asistente que usaron herramientas de
// solo lectura (function-calling) para traer datos reales del negocio. El front
// lo muestra como un microcopy sutil bajo la respuesta.
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  consultedData?: boolean;
};

// Config pública del addon IA (avatar + proveedor activo + texto comercial +
// precio). La trae el RPC ai_public_config() — NO expone la api_key. Sirve para
// el explicador que ve un dueño sin el complemento contratado y para mostrar qué
// IA está activa (provider) en el chat.
type PublicCfg = {
  image_url: string;
  provider: string;
  commercial_text: string;
  addon_price_ars: string;
};

// Nombre comercial legible del proveedor IA activo (provider de ai_config). Se
// muestra como badge "Con tecnología de …" en el chat. Cualquier valor
// desconocido cae a "IA".
function providerLabel(provider: string): string {
  const p = provider.trim().toLowerCase();
  if (p === "gemini") return "Gemini";
  if (p === "claude") return "Claude";
  return "IA";
}

// Mapea un código de error de la Edge Function ai_assistant a un copy amigable.
// La Edge devuelve { error, detail } con códigos estables (quota_exceeded,
// addon_required, ai_not_configured, ai_disabled, ai_provider_error). El detail
// es el fallback cuando el código no está mapeado.
function friendlyAiError(code: string, detail?: string): string {
  switch (code) {
    case "quota_exceeded":
      return "Alcanzaste el límite de uso de este mes.";
    case "addon_required":
      return detail || "Necesitás el complemento Asistente IA.";
    case "ai_not_configured":
      return "El asistente todavía no está configurado.";
    case "ai_disabled":
      return detail || "El Asistente IA está temporalmente desactivado.";
    case "ai_provider_error":
      return detail || "El asistente no pudo responder en este momento.";
    default:
      return detail || code || "El asistente no pudo responder.";
  }
}

// Convierte el `error` de supabase.functions.invoke en un Error con mensaje
// amigable. En un non-2xx, supabase-js deja data=null y el cuerpo real (JSON
// { error, detail }) viaja en error.context (un Response). Sin leerlo, el chat
// solo veía "Edge Function returned a non-2xx status code" y nunca mostraba
// "Alcanzaste el límite" ni "Necesitás el complemento". Mismo patrón que
// modules/tiendita/storefront.ts. Si no hay cuerpo legible, cae al mensaje
// original del error.
async function edgeErrorToMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx) {
    const body = (await ctx.json().catch(() => null)) as {
      error?: string;
      detail?: string;
    } | null;
    if (body?.error || body?.detail) {
      return friendlyAiError(String(body.error ?? ""), body.detail);
    }
  }
  return error instanceof Error
    ? error.message
    : "El asistente no pudo responder.";
}

// Texto comercial de respaldo si la config no trae commercial_text y la llamada
// {intro:true} tampoco devuelve nada (debería ser raro: la Edge Function ya
// tiene su propio default).
const FALLBACK_COMMERCIAL =
  "El Asistente IA responde sobre tu negocio en lenguaje natural: ventas, " +
  "stock bajo, productos más vendidos, clientes y cómo usar cada pantalla. " +
  "Es un complemento opcional que activás desde el panel del dueño.";

// Ícono del círculo cuando el dueño NO tiene el addon contratado: gif de marca
// servido por la app. Con el addon, el ícono es la imagen del proveedor activo
// (ai_public_config.image_url).
const UNSCREEN_GIF = "/ia/ia-unscreen.gif";

// Burbuja flotante del Asistente IA. Visible para TODO usuario autenticado del
// tenant: con el complemento → chat normal; sin él → al abrir muestra el
// explicador comercial + botón para contratarlo. El guard fuerte (acceso real a
// los datos) vive en la Edge Function ai_assistant.
export function AssistantBubble() {
  const supabase = createClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quota, setQuota] = useState<{ used: number; cap: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ¿Este tenant tiene acceso real al asistente? (addon / flag / beta).
  const { data: available, isLoading: availableLoading } = useQuery({
    queryKey: ["ai-available"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("ai_available");
      if (error) return false;
      return data === true;
    },
    staleTime: 5 * 60_000,
  });

  // Config pública del addon (avatar + texto comercial). Sin tipos generados
  // para el RPC nuevo → cast con `as any`.
  const { data: publicCfg, isLoading: cfgLoading } = useQuery({
    queryKey: ["ai-public-config"],
    queryFn: async (): Promise<PublicCfg | null> => {
      // El RPC ai_public_config aún no está en los tipos generados → cast.
      const rpc = supabase.rpc as unknown as (
        fn: string,
      ) => Promise<{ data: unknown; error: unknown }>;
      const { data, error } = await rpc("ai_public_config");
      if (error) return null;
      const c = (data ?? {}) as Partial<PublicCfg>;
      return {
        image_url: String(c.image_url ?? ""),
        provider: String(c.provider ?? ""),
        commercial_text: String(c.commercial_text ?? ""),
        addon_price_ars: String(c.addon_price_ars ?? ""),
      };
    },
    staleTime: 10 * 60_000,
  });

  const locked = available === false;
  // Imagen del proveedor activo (la que ve el cliente CON el addon).
  const providerImage = (publicCfg?.image_url ?? "").trim();
  // Nombre legible de la IA activa (Gemini / Claude) para el badge del chat.
  const aiLabel = providerLabel(publicCfg?.provider ?? "");
  // Ícono del círculo: sin addon → gif de marca; con addon → imagen del
  // proveedor activo (fallback al ícono Sparkles si no hubiera ninguna).
  const iconUrl = locked ? UNSCREEN_GIF : providerImage;

  // Estado de carga del ícono: el botón flotante queda en spinner hasta que la
  // imagen del logo termina de cargar (o falla), para que no aparezca el ícono
  // genérico y luego "salte" al logo real. Se resetea cada vez que cambia la URL.
  const [iconReady, setIconReady] = useState(false);
  useEffect(() => {
    setIconReady(false);
  }, [iconUrl]);

  // La burbuja está lista cuando: sabemos el acceso, terminó de cargar la config
  // pública, y el ícono ya cargó (o no hay URL → usamos Sparkles, listo directo).
  const bubbleReady =
    !availableLoading &&
    available !== undefined &&
    !cfgLoading &&
    (iconUrl === "" || iconReady);

  // Explicador comercial: cuando la burbuja está bloqueada y se abre, pedimos el
  // texto a la Edge Function con {intro:true} (devuelve config o su default). Se
  // hace una sola vez por apertura; cae al texto del RPC o a una constante.
  const intro = useMutation({
    mutationFn: async (): Promise<string> => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: { intro: true },
      });
      if (error) throw new Error(await edgeErrorToMessage(error));
      const res = data as { reply?: string; locked?: boolean };
      return res?.reply ?? "";
    },
  });

  const send = useMutation({
    mutationFn: async (
      history: ChatMessage[],
    ): Promise<{ reply: string; consultedData: boolean }> => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: { messages: history },
      });
      // En un non-2xx (quota_exceeded 429, addon_required 403,
      // ai_not_configured 400, ai_provider_error 502…) supabase-js deja
      // error=FunctionsHttpError y data=null: el cuerpo real { error, detail }
      // viaja en error.context. Lo leemos y mapeamos a un copy amigable; antes
      // este path solo mostraba el genérico "non-2xx status code".
      if (error) throw new Error(await edgeErrorToMessage(error));
      const res = data as {
        reply?: string;
        error?: string;
        detail?: string;
        quota?: { used: number; cap: number };
        tools_used?: string[];
      };
      // Defensa en profundidad: si alguna vez la Edge devolviera un error en un
      // cuerpo 200, igual lo mapeamos al mismo copy amigable.
      if (res?.error) {
        throw new Error(friendlyAiError(res.error, res.detail));
      }
      if (res.quota) setQuota(res.quota);
      return {
        reply: res?.reply ?? "",
        consultedData: Array.isArray(res.tools_used) && res.tools_used.length > 0,
      };
    },
    onSuccess: ({ reply, consultedData }) => {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: reply, consultedData },
      ]);
    },
    onError: (e) => {
      // Saca el último turno fallido del usuario para que pueda reintentar.
      setMessages((m) =>
        m[m.length - 1]?.role === "user" ? m.slice(0, -1) : m,
      );
      toast({
        title: "El asistente no pudo responder",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    },
  });

  // Al abrir en modo bloqueado, traemos el explicador una vez.
  useEffect(() => {
    if (open && locked && !intro.data && !intro.isPending) {
      intro.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, locked]);

  // Autoscroll al final cuando entran mensajes o aparece el loader.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, send.isPending]);

  function submit() {
    const text = input.trim();
    if (!text || send.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    send.mutate(next);
  }

  const explainer =
    intro.data?.trim() ||
    publicCfg?.commercial_text?.trim() ||
    FALLBACK_COMMERCIAL;
  const price = (publicCfg?.addon_price_ars ?? "").trim();

  return (
    <>
      {/* Precarga oculta del logo: dispara la carga de la imagen aunque el botón
          esté mostrando el spinner, así al estar lista hacemos UN solo swap al
          logo real (sin ícono genérico intermedio ni salto). */}
      {iconUrl && !iconReady && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={iconUrl}
          alt=""
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
          onLoad={() => setIconReady(true)}
          onError={() => setIconReady(true)}
        />
      )}

      {/* Botón flotante. Mientras carga el acceso/config/imagen queda deshabilitado
          con un spinner; recién cuando todo está listo se activa con el logo. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          disabled={!bubbleReady}
          aria-label={bubbleReady ? "Abrir asistente IA" : "Cargando asistente IA"}
          aria-busy={!bubbleReady}
          className={`fixed bottom-4 right-4 z-40 grid h-14 w-14 place-items-center overflow-hidden rounded-full shadow-ninjaGlow ring-1 backdrop-blur-xl transition hover:brightness-110 active:scale-95 disabled:cursor-default disabled:active:scale-100 ${
            locked
              ? "bg-card text-primary ring-ninja-flame/40"
              : "bg-ninja-gradient text-ninja-voidViolet ring-ninja-flame/20"
          }`}
        >
          {bubbleReady ? (
            <BubbleAvatar url={iconUrl} size={56} iconSize={24} />
          ) : (
            <Spinner size={22} className="border-ninja-voidViolet/40 border-t-ninja-voidViolet" />
          )}
        </button>
      )}

      {/* Panel: fondo sólido del tema (popover) para que el texto del chat sea
          siempre legible sobre cualquier pantalla detrás, en todos los temas
          (dark/noir/light/sand). Acento flame en el borde; sin sombras paralelas
          ni reflejos. El blur queda solo como detalle en los bordes. */}
      {open && (
        <div className="fixed bottom-4 right-4 z-40 flex h-[min(560px,80dvh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-ninja-flame/20 bg-popover text-popover-foreground backdrop-blur-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="flex items-center gap-2 font-semibold text-foreground">
              <span
                className={`grid h-7 w-7 place-items-center overflow-hidden rounded-lg ${
                  locked
                    ? "bg-secondary text-primary ring-1 ring-ninja-flame/30"
                    : "bg-ninja-gradient text-ninja-voidViolet"
                }`}
              >
                <BubbleAvatar url={iconUrl} size={28} iconSize={16} />
              </span>
              Asistente IA
              {/* Badge del proveedor IA activo (solo con acceso). Indica qué
                  modelo responde, sin exponer ninguna credencial. */}
              {!locked && (
                <span className="rounded-full border border-ninja-flame/30 bg-ninja-flame/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {aiLabel}
                </span>
              )}
            </span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Cerrar"
              className="text-muted-foreground transition hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>

          {locked ? (
            /* ── Modo bloqueado: explicador comercial + CTA ── */
            <div className="slim-scrollbar flex flex-1 flex-col overflow-y-auto p-5">
              <div className="flex flex-col items-center text-center">
                <span className="grid h-16 w-16 place-items-center overflow-hidden rounded-2xl bg-secondary text-primary ring-1 ring-ninja-flame/30">
                  <BubbleAvatar url={iconUrl} size={64} iconSize={30} />
                </span>
                <h3 className="mt-3 flex items-center gap-1.5 text-base font-semibold text-foreground">
                  <Lock size={14} /> Asistente IA
                </h3>
                <p className="mt-1 text-xs font-medium text-primary">
                  Todavía no lo tenés contratado
                </p>
              </div>

              <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {intro.isPending ? "Cargando…" : explainer}
              </div>

              {price && (
                <p className="mt-3 text-sm text-foreground">
                  <span className="font-semibold">
                    ${Number(price).toLocaleString("es-AR")}
                  </span>{" "}
                  <span className="text-muted-foreground">/ mes</span>
                </p>
              )}

              <Link
                href={"/dashboard-team" as never}
                onClick={() => setOpen(false)}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ninja-gradient px-4 py-2.5 text-sm font-semibold text-ninja-voidViolet shadow-ninjaGlow transition hover:brightness-110"
              >
                <Sparkles size={16} /> Contratar IA
              </Link>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                Se activa desde el Panel del dueño.
              </p>
            </div>
          ) : (
            /* ── Modo chat (con acceso) ── */
            <>
              <div
                ref={listRef}
                className="slim-scrollbar flex-1 space-y-3 overflow-y-auto p-4"
              >
                {messages.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Hola 👋 Soy tu asistente. Preguntame sobre tus ventas, tu
                    stock o cómo usar el sistema.
                  </p>
                )}
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex flex-col",
                      m.role === "user" ? "items-end" : "items-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed",
                        m.role === "user"
                          ? "bg-ninja-flame/25 text-foreground"
                          : "border border-border bg-secondary text-secondary-foreground",
                      )}
                    >
                      {m.content}
                    </div>
                    {/* Microcopy: la respuesta usó datos reales del negocio
                        (function-calling consultó las RPCs de solo lectura). */}
                    {m.role === "assistant" && m.consultedData && (
                      <span className="mt-1 flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
                        <Sparkles size={10} className="text-primary" />
                        Consulté los datos de tu negocio
                      </span>
                    )}
                  </div>
                ))}
                {send.isPending && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1 rounded-2xl border border-border bg-secondary px-3 py-2.5">
                      <Dot delay="0ms" />
                      <Dot delay="150ms" />
                      <Dot delay="300ms" />
                    </div>
                  </div>
                )}
              </div>

              {/* Input */}
              <div className="border-t border-border p-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    rows={1}
                    placeholder="Escribí tu mensaje…"
                    className="slim-scrollbar max-h-28 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-input bg-background p-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
                  />
                  <button
                    onClick={submit}
                    disabled={!input.trim() || send.isPending}
                    aria-label="Enviar"
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ninja-gradient text-ninja-voidViolet transition hover:brightness-110 disabled:opacity-50"
                  >
                    <Send size={17} />
                  </button>
                </div>
                <p className="mt-2 text-center text-[11px] text-muted-foreground">
                  Con tecnología de{" "}
                  <span className="font-medium text-primary">{aiLabel}</span>
                  {quota
                    ? ` • ${Math.max(0, quota.cap - quota.used).toLocaleString("es-AR")} tokens restantes este mes`
                    : ""}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// Avatar del asistente: imagen configurada (image_url) o el ícono Sparkles. El
// contenedor padre aporta el fondo/clip; acá solo el contenido.
function BubbleAvatar({
  url,
  size,
  iconSize,
}: {
  url: string;
  size: number;
  iconSize: number;
}) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt="Asistente IA"
        width={size}
        height={size}
        className="h-full w-full object-cover"
        onError={() => setBroken(true)}
      />
    );
  }
  return <Sparkles size={iconSize} />;
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  );
}
