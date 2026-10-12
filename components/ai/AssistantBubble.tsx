"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import {
  AssistantLauncher,
  AssistantPanel,
  type ChatMessage,
  type ConversationSummary,
} from "./AssistantChat";

// Retención del historial (debe coincidir con purge_ai_conversations, 15 días).
const HISTORY_DAYS = 15;

// ChatMessage: `consultedData` marca respuestas del asistente que usaron
// herramientas de solo lectura (function-calling) para traer datos reales del
// negocio. El panel lo muestra como un microcopy sutil bajo la respuesta.

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

// Burbuja flotante del Asistente IA. Visible para TODO usuario autenticado del
// tenant: con el complemento → chat normal; sin él → al abrir muestra el
// explicador comercial + botón para contratarlo. El guard fuerte (acceso real a
// los datos) vive en la Edge Function ai_assistant.
export function AssistantBubble() {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "history">("chat");
  // La última conversación se carga sola una vez, al primer abrir.
  const autoLoaded = useRef(false);
  const [quota, setQuota] = useState<{ used: number; cap: number } | null>(
    null,
  );
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // ¿Este tenant tiene acceso real al asistente? (addon / flag / beta).
  // Un error del RPC se propaga para que React Query reintente: antes se
  // devolvía false y un fallo transitorio (p. ej. refresh de token al cargar)
  // dejaba la burbuja "bloqueada" 5 minutos aunque el addon estuviera activo.
  const { data: available, isLoading: availableLoading } = useQuery({
    queryKey: ["ai-available"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("ai_available");
      if (error) throw error;
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
      // OJO: bind(supabase) es obligatorio — asignar el método a una variable
      // le pierde el `this` y el RPC explotaba con TypeError, dejando la
      // burbuja SIEMPRE con el ícono genérico en vez del logo del proveedor.
      const rpc = (
        supabase.rpc as unknown as (
          fn: string,
        ) => Promise<{ data: unknown; error: unknown }>
      ).bind(supabase);
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
  // El launcher es siempre la marca del asistente (isotipo Ninja). Con addon
  // suma en la esquina un badge con la imagen del proveedor activo; sin addon,
  // un candado. Esta URL es la que hay que precargar antes de mostrarlo.
  const iconUrl = locked ? "" : providerImage;

  // Estado de carga del badge: el launcher queda en spinner hasta que la
  // imagen del proveedor termina de cargar (o falla), para que el logo no
  // "salte" después. Se resetea cada vez que cambia la URL.
  const [iconReady, setIconReady] = useState(false);
  useEffect(() => {
    setIconReady(false);
  }, [iconUrl]);

  // La burbuja está lista cuando: sabemos el acceso, terminó de cargar la config
  // pública, y la imagen del proveedor ya cargó (o no hay URL → listo directo).
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

  // Historial propio (RLS: sólo las conversaciones del usuario en este negocio).
  const conversations = useQuery({
    queryKey: ["ai-conversations"],
    enabled: open && available === true,
    queryFn: async (): Promise<ConversationSummary[]> => {
      const since = new Date(
        Date.now() - HISTORY_DAYS * 86_400_000,
      ).toISOString();
      const { data, error } = await supabase
        .from("ai_conversations")
        .select("id, title, updated_at")
        .is("deleted_at", null)
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });

  const loadConversation = useMutation({
    mutationFn: async (id: string): Promise<ChatMessage[]> => {
      const { data, error } = await supabase
        .from("ai_messages")
        .select("role, content, tool_summary, created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []).map((m): ChatMessage => {
        const tools = (m.tool_summary as { tools?: unknown } | null)?.tools;
        return {
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
          consultedData: Array.isArray(tools) && tools.length > 0,
        };
      });
    },
    onSuccess: (msgs, id) => {
      setMessages(msgs);
      setConversationId(id);
      setView("chat");
    },
    onError: (e) => {
      toast({
        title: "No se pudo abrir la conversación",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    },
  });

  const deleteConversation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.functions.invoke("ai_assistant", {
        body: { action: "delete_conversation", conversation_id: id },
      });
      if (error) throw new Error(await edgeErrorToMessage(error));
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ConversationSummary[]>(
        ["ai-conversations"],
        (prev) => (prev ?? []).filter((c) => c.id !== id),
      );
      if (id === conversationId) {
        setMessages([]);
        setConversationId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["ai-conversations"] });
    },
    onError: (e) => {
      toast({
        title: "No se pudo borrar la conversación",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    },
  });

  const send = useMutation({
    mutationFn: async (
      history: ChatMessage[],
    ): Promise<{ reply: string; consultedData: boolean }> => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: {
          messages: history.map(({ role, content }) => ({ role, content })),
          conversation_id: conversationId,
        },
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
        conversation_id?: string | null;
      };
      // Defensa en profundidad: si alguna vez la Edge devolviera un error en un
      // cuerpo 200, igual lo mapeamos al mismo copy amigable.
      if (res?.error) {
        throw new Error(friendlyAiError(res.error, res.detail));
      }
      if (res.quota) setQuota(res.quota);
      // La Edge guarda el turno y devuelve la conversación (nueva o la misma).
      if (res.conversation_id) {
        setConversationId(res.conversation_id);
        void queryClient.invalidateQueries({ queryKey: ["ai-conversations"] });
      }
      return {
        reply: res?.reply ?? "",
        consultedData:
          Array.isArray(res.tools_used) && res.tools_used.length > 0,
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

  // Al abrir con acceso por primera vez, retoma la última conversación.
  useEffect(() => {
    if (
      !open ||
      locked ||
      autoLoaded.current ||
      !conversations.isSuccess ||
      send.isPending
    ) {
      return;
    }
    autoLoaded.current = true;
    const last = conversations.data[0];
    if (last && messages.length === 0 && conversationId === null) {
      loadConversation.mutate(last.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, locked, conversations.isSuccess]);

  // Al cerrar, el foco vuelve al launcher (accesibilidad de teclado).
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) launcherRef.current?.focus();
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  function submit(text: string) {
    if (!text || send.isPending || loadConversation.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    send.mutate(next);
  }

  const explainer =
    intro.data?.trim() ||
    publicCfg?.commercial_text?.trim() ||
    FALLBACK_COMMERCIAL;
  const price = (publicCfg?.addon_price_ars ?? "").trim();

  return (
    <>
      {/* Precarga oculta del logo del proveedor: el launcher queda en spinner
          hasta que la imagen carga (o falla), así el badge del proveedor
          aparece de una sola vez, sin saltos. */}
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

      {!open && (
        <AssistantLauncher
          ref={launcherRef}
          ready={bubbleReady}
          locked={locked}
          providerImage={providerImage}
          providerName={aiLabel}
          onOpen={() => setOpen(true)}
        />
      )}

      {open && (
        <AssistantPanel
          locked={locked}
          providerName={aiLabel}
          providerImage={providerImage}
          messages={messages}
          pending={send.isPending}
          quota={quota}
          explainer={explainer}
          explainerLoading={intro.isPending}
          price={price}
          onSend={submit}
          onReset={() => {
            // No se limpia con una respuesta en vuelo: llegaría a un chat vacío.
            if (send.isPending) return;
            setMessages([]);
            setConversationId(null);
          }}
          onClose={close}
          view={view}
          onToggleHistory={() => {
            if (send.isPending) return;
            setView((v) => (v === "history" ? "chat" : "history"));
          }}
          conversations={conversations.data ?? []}
          conversationsLoading={conversations.isLoading}
          activeConversationId={conversationId}
          loadingConversation={loadConversation.isPending}
          deletingConversationId={
            deleteConversation.isPending
              ? (deleteConversation.variables ?? null)
              : null
          }
          onOpenConversation={(id) => {
            if (send.isPending || loadConversation.isPending) return;
            if (id === conversationId) {
              setView("chat");
              return;
            }
            setView("chat");
            loadConversation.mutate(id);
          }}
          onDeleteConversation={(id) => deleteConversation.mutate(id)}
        />
      )}
    </>
  );
}
