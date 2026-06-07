"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Sparkles, X, Send, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { useToast } from "@/components/ui/Toast";

type ChatMessage = { role: "user" | "assistant"; content: string };

// Config pública del addon IA (avatar + texto comercial + precio). La trae el
// RPC ai_public_config() — NO expone la api_key. Sirve para el explicador que
// ve un dueño sin el complemento contratado.
type PublicCfg = {
  image_url: string;
  commercial_text: string;
  addon_price_ars: string;
};

// Texto comercial de respaldo si la config no trae commercial_text y la llamada
// {intro:true} tampoco devuelve nada (debería ser raro: la Edge Function ya
// tiene su propio default).
const FALLBACK_COMMERCIAL =
  "El Asistente IA responde sobre tu negocio en lenguaje natural: ventas, " +
  "stock bajo, productos más vendidos, clientes y cómo usar cada pantalla. " +
  "Es un complemento opcional que activás desde el panel del dueño.";

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
  const { data: available } = useQuery({
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
  const { data: publicCfg } = useQuery({
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
        commercial_text: String(c.commercial_text ?? ""),
        addon_price_ars: String(c.addon_price_ars ?? ""),
      };
    },
    staleTime: 10 * 60_000,
  });

  const locked = available === false;
  const avatarUrl = (publicCfg?.image_url ?? "").trim();

  // Explicador comercial: cuando la burbuja está bloqueada y se abre, pedimos el
  // texto a la Edge Function con {intro:true} (devuelve config o su default). Se
  // hace una sola vez por apertura; cae al texto del RPC o a una constante.
  const intro = useMutation({
    mutationFn: async (): Promise<string> => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: { intro: true },
      });
      if (error) throw error;
      const res = data as { reply?: string; locked?: boolean };
      return res?.reply ?? "";
    },
  });

  const send = useMutation({
    mutationFn: async (history: ChatMessage[]): Promise<string> => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: { messages: history },
      });
      if (error) throw error;
      const res = data as {
        reply?: string;
        error?: string;
        detail?: string;
        quota?: { used: number; cap: number };
      };
      if (res?.error) {
        if (res.error === "quota_exceeded")
          throw new Error("Alcanzaste el límite de uso de este mes.");
        if (res.error === "addon_required")
          throw new Error(res.detail || "Necesitás el complemento Asistente IA.");
        if (res.error === "ai_not_configured")
          throw new Error("El asistente todavía no está configurado.");
        throw new Error(res.detail || res.error);
      }
      if (res.quota) setQuota(res.quota);
      return res?.reply ?? "";
    },
    onSuccess: (reply) => {
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
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

  // Mientras no sabemos el estado de acceso, no parpadeamos la burbuja.
  if (available === undefined) return null;

  const explainer =
    intro.data?.trim() ||
    publicCfg?.commercial_text?.trim() ||
    FALLBACK_COMMERCIAL;
  const price = (publicCfg?.addon_price_ars ?? "").trim();

  return (
    <>
      {/* Botón flotante */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Abrir asistente IA"
          className="fixed bottom-4 right-4 z-40 grid h-14 w-14 place-items-center overflow-hidden rounded-full bg-ninja-gradient text-ninja-voidViolet shadow-ninjaGlow ring-1 ring-white/10 backdrop-blur-xl transition hover:brightness-110 active:scale-95"
        >
          <BubbleAvatar url={avatarUrl} size={56} iconSize={24} />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-4 right-4 z-40 flex h-[min(560px,80dvh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background/80 shadow-2xl backdrop-blur-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="flex items-center gap-2 font-semibold text-foreground">
              <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-lg bg-ninja-gradient text-ninja-voidViolet">
                <BubbleAvatar url={avatarUrl} size={28} iconSize={16} />
              </span>
              Asistente IA
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
                <span className="grid h-16 w-16 place-items-center overflow-hidden rounded-2xl bg-ninja-gradient text-ninja-voidViolet shadow-ninjaGlow">
                  <BubbleAvatar url={avatarUrl} size={64} iconSize={30} />
                </span>
                <h3 className="mt-3 flex items-center gap-1.5 text-base font-semibold text-foreground">
                  <Lock size={14} /> Asistente IA
                </h3>
                <p className="mt-1 text-xs font-medium text-ninja-flameSoft">
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
                      "flex",
                      m.role === "user" ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                        m.role === "user"
                          ? "bg-ninja-flame/15 text-ninja-flameSoft"
                          : "bg-muted text-foreground",
                      )}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {send.isPending && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1 rounded-2xl bg-muted px-3 py-2.5">
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
                  Powered by IA
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
