"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles, X, Send } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { useToast } from "@/components/ui/Toast";

type ChatMessage = { role: "user" | "assistant"; content: string };

// Burbuja flotante del Asistente IA. Visible solo si el guard barato pasa
// (RPC ai_available: addon activo OR flag por tenant OR owner == beta email).
// El guard fuerte vive en la Edge Function ai_assistant.
export function AssistantBubble() {
  const supabase = createClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quota, setQuota] = useState<{ used: number; cap: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Gate barato: ¿se le muestra la burbuja a este tenant?
  const { data: available } = useQuery({
    queryKey: ["ai-available"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("ai_available");
      if (error) return false;
      return data === true;
    },
    staleTime: 5 * 60_000,
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

  if (!available) return null;

  return (
    <>
      {/* Botón flotante */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Abrir asistente IA"
          className="fixed bottom-4 right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-ninja-gradient text-ninja-voidViolet shadow-ninjaGlow ring-1 ring-white/10 backdrop-blur-xl transition hover:brightness-110 active:scale-95"
        >
          <Sparkles size={24} />
        </button>
      )}

      {/* Panel del chat */}
      {open && (
        <div className="fixed bottom-4 right-4 z-40 flex h-[min(560px,80dvh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background/80 shadow-2xl backdrop-blur-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="flex items-center gap-2 font-semibold text-foreground">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-ninja-gradient text-ninja-voidViolet">
                <Sparkles size={16} />
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

          {/* Mensajes */}
          <div
            ref={listRef}
            className="slim-scrollbar flex-1 space-y-3 overflow-y-auto p-4"
          >
            {messages.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Hola 👋 Soy tu asistente. Preguntame sobre tus ventas, tu stock o
                cómo usar el sistema.
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
        </div>
      )}
    </>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  );
}
