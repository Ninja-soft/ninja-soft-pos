"use client";

import { AlertTriangle, Lightbulb, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { MODULE_LABELS, type HelpArticle, type HelpRole } from "@/lib/help/types";
import { roleNoteFor } from "@/lib/help/search";

const ROLE_LABEL: Record<HelpRole, string> = {
  owner: "dueño",
  manager: "encargado",
  cashier: "cajero",
  viewer: "solo lectura",
};

// Cuerpo de un artículo de ayuda: lo usan el panel de Ayuda y las lecciones de
// la Escuela. Pasos numerados, nota para el rol de quien lee, errores comunes.
export function HelpArticleView({
  article,
  role,
  compact = false,
}: {
  article: HelpArticle;
  role: HelpRole | null;
  compact?: boolean;
}) {
  const note = roleNoteFor(article, role);
  return (
    <article className="space-y-4 text-sm">
      {!compact && (
        <header className="space-y-1.5">
          <Badge tone="neutral">{MODULE_LABELS[article.module]}</Badge>
          <h3 className="font-display text-lg font-bold leading-tight text-foreground">{article.title}</h3>
          <p className="text-muted-foreground">{article.summary}</p>
        </header>
      )}

      {note && (
        <div className="rounded-md border border-border border-t-2 border-t-[var(--pos-solid)] bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ninja-flameSoft">
            <UserRound size={13} aria-hidden /> Para vos como {ROLE_LABEL[role!]}
          </p>
          <p className="mt-1 text-foreground">{note}</p>
        </div>
      )}

      <ol className="space-y-2">
        {article.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted font-display text-[11px] font-bold tabular-nums text-foreground">
              {i + 1}
            </span>
            <span className="min-w-0 text-foreground">{s}</span>
          </li>
        ))}
      </ol>

      {article.errors.length > 0 && (
        <section className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <AlertTriangle size={13} aria-hidden /> Si algo falla
          </h4>
          <ul className="space-y-2">
            {article.errors.map((e, i) => (
              <li key={i} className="rounded-md bg-muted/50 p-2.5">
                <p className="font-medium text-foreground">{e.problem}</p>
                <p className="mt-0.5 text-muted-foreground">{e.fix}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {article.tips.length > 0 && (
        <section className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Lightbulb size={13} aria-hidden /> Tips
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {article.tips.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
