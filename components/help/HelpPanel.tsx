"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, CircleHelp, GraduationCap, Route as RouteIcon, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { SearchField } from "@/components/ui/SearchField";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { articlesForContext, relatedArticles, searchArticles } from "@/lib/help/search";
import { MODULE_LABELS, type HelpArticle, type HelpRole } from "@/lib/help/types";
import { normalizeRole } from "@/lib/permissions/roles";
import { useArticleVote, useVoteArticle } from "@/modules/help/hooks";
import { HelpArticleView } from "./HelpArticleView";
import { HELP_OPEN_EVENT, requestTour, useToursForMe } from "@/modules/onboarding/guidance";

// Ayuda contextual (F15 · H72 · ADR-086). Botón "?" en el shell que abre un
// panel lateral (pantalla completa en el celular) con los artículos de la
// pantalla actual filtrados por el rol, un buscador con sinónimos y el voto
// útil/no útil. El contenido se carga recién al abrir (import dinámico).

function loadContent() {
  return import("@/lib/help/content");
}

export function HelpButton({ role, className }: { role: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Una sugerencia puede pedir el panel ("Pedir ayuda"). El shell monta dos
  // botones (barra lateral y header del celular): abre el que está a la vista.
  useEffect(() => {
    const onOpen = () => {
      if (btnRef.current?.offsetParent) setOpen(true);
    };
    window.addEventListener(HELP_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(HELP_OPEN_EVENT, onOpen);
  }, []);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ayuda"
        title="Ayuda"
        className={cn(
          "grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <CircleHelp size={18} />
      </button>
      {open && <HelpPanel role={normalizeRole(role)} onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpPanel({ role, onClose }: { role: HelpRole | null; onClose: () => void }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 150);
  const [current, setCurrent] = useState<HelpArticle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: content, isLoading } = useQuery({
    queryKey: ["help-content"],
    queryFn: loadContent,
    staleTime: Infinity,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const here = useMemo(
    () => (content ? articlesForContext(content.HELP_ARTICLES, pathname, role) : []),
    [content, pathname, role],
  );
  const hits = useMemo(
    () =>
      content && debounced.trim()
        ? searchArticles(content.HELP_ARTICLES, debounced, {
            role,
            pathname,
            synonyms: content.HELP_SYNONYMS,
            limit: 12,
          })
        : [],
    [content, debounced, role, pathname],
  );

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Ayuda">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-popover pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] sm:w-[420px]">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          {current ? (
            <button
              type="button"
              onClick={() => setCurrent(null)}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft size={16} /> Volver
            </button>
          ) : (
            <h2 className="flex items-center gap-2 font-display text-base font-bold">
              <CircleHelp size={18} className="text-ninja-flameSoft" /> Ayuda
            </h2>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ayuda"
            className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </header>

        <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {isLoading || !content ? (
            <SpinnerBlock />
          ) : current ? (
            <ArticleDetail
              article={current}
              all={content.HELP_ARTICLES}
              role={role}
              pathname={pathname}
              onOpen={setCurrent}
            />
          ) : (
            <div className="space-y-5">
              <SearchField
                ref={inputRef}
                value={query}
                onValueChange={setQuery}
                placeholder="¿Qué necesitás hacer? Ej: anular venta"
                aria-label="Buscar en la ayuda"
              />

              {debounced.trim() ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Resultados</h3>
                  {hits.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No encontramos nada para &quot;{debounced}&quot;. Probá con otras palabras, por ejemplo
                      &quot;cerrar caja&quot; o &quot;devolución&quot;.
                    </p>
                  ) : (
                    <ArticleList items={hits.map((h) => ({ article: h.article, here: h.here }))} onOpen={setCurrent} />
                  )}
                </section>
              ) : (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    En esta pantalla
                  </h3>
                  {here.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Todavía no hay guías para esta pantalla. Buscá arriba lo que necesitás.
                    </p>
                  ) : (
                    <ArticleList items={here.map((a) => ({ article: a, here: false }))} onOpen={setCurrent} />
                  )}
                </section>
              )}

              <ToursSection role={role} onClose={onClose} />

              <Link
                href={"/escuela" as Route}
                onClick={onClose}
                className="flex items-center gap-3 rounded-md border border-border bg-card p-3 text-sm transition hover:bg-muted"
              >
                <GraduationCap size={18} className="shrink-0 text-ninja-flameSoft" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-foreground">Escuela NinjaSoft</span>
                  <span className="block text-xs text-muted-foreground">Cursos cortos por rol, con prueba y certificado.</span>
                </span>
                <ChevronRight size={16} className="text-muted-foreground" />
              </Link>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// Recorridos guiados disponibles para el usuario (F15 · H70 · ADR-089).
function ToursSection({ role, onClose }: { role: HelpRole | null; onClose: () => void }) {
  const { data: tours } = useToursForMe(Boolean(role));
  if (!tours?.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recorridos guiados</h3>
      <ul className="divide-y divide-border rounded-md border border-border">
        {tours.map((t) => (
          <li key={t.tour_id}>
            <button
              type="button"
              onClick={() => {
                onClose();
                requestTour(t.key);
              }}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-muted"
            >
              <RouteIcon size={16} className="mt-0.5 shrink-0 text-ninja-flameSoft" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{t.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {t.completed ? "Hecho. Tocá para repasarlo." : `${t.steps.length} pasos`}
                </span>
              </span>
              <ChevronRight size={16} className="mt-0.5 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArticleList({
  items,
  onOpen,
}: {
  items: { article: HelpArticle; here: boolean }[];
  onOpen: (a: HelpArticle) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map(({ article, here }) => (
        <li key={article.id}>
          <button
            type="button"
            onClick={() => onOpen(article)}
            className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-muted"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{article.title}</span>
              <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{article.summary}</span>
              <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                {MODULE_LABELS[article.module]}
                {here && (
                  <span className="inline-flex items-center gap-1 text-ninja-flameSoft">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--pos-solid)]" aria-hidden /> En esta pantalla
                  </span>
                )}
              </span>
            </span>
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ArticleDetail({
  article,
  all,
  role,
  pathname,
  onOpen,
}: {
  article: HelpArticle;
  all: readonly HelpArticle[];
  role: HelpRole | null;
  pathname: string | null;
  onOpen: (a: HelpArticle) => void;
}) {
  const related = relatedArticles(article, all, role);
  return (
    <div className="space-y-6">
      <HelpArticleView article={article} role={role} />
      <Feedback article={article} pathname={pathname} />
      {related.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relacionado</h4>
          <ArticleList items={related.map((a) => ({ article: a, here: false }))} onOpen={onOpen} />
        </section>
      )}
    </div>
  );
}

function Feedback({ article, pathname }: { article: HelpArticle; pathname: string | null }) {
  const { toast } = useToast();
  const { data: vote } = useArticleVote(article.id);
  const mutate = useVoteArticle();
  const send = (helpful: boolean) =>
    mutate.mutate(
      { articleId: article.id, version: article.version, helpful, route: pathname },
      {
        onSuccess: () => toast({ title: "¡Gracias!", description: "Con tu respuesta mejoramos la ayuda.", variant: "success" }),
        onError: () => toast({ title: "No se pudo guardar tu respuesta", variant: "error" }),
      },
    );
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm">
      <span className="text-muted-foreground">¿Te sirvió?</span>
      {(
        [
          [true, "Sí", ThumbsUp],
          [false, "No", ThumbsDown],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={label}
          type="button"
          disabled={mutate.isPending}
          aria-pressed={vote === value}
          onClick={() => send(value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 transition",
            vote === value
              ? "border-[var(--pos-solid)] text-foreground"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}
