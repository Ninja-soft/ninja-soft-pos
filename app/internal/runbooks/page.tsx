"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BookOpenCheck, ChevronRight, Search } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { SearchField } from "@/components/ui/SearchField";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";
import {
  RUNBOOK_AREA_LABEL,
  RUNBOOK_SECTIONS,
  RUNBOOK_SEVERITY_LABEL,
  searchRunbooks,
  type RunbookArea,
  type RunbookSeverity,
} from "@/lib/internal/runbooks";

const SEVERITY_TONE: Record<RunbookSeverity, BadgeTone> = { critica: "danger", alta: "warning", media: "info" };
const AREAS: (RunbookArea | "todas")[] = ["todas", "pagos", "fiscal", "integraciones", "cajas", "ventas", "stock"];

// Runbooks operativos para soporte (F16 · H85, ADR-091): qué revisar, cómo
// reintentar, cómo escalar y cómo cerrar, sin consultar SQL. Las rutas del
// negocio se abren entrando "como el negocio" (ADR-084).
export default function InternalRunbooksPage() {
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<RunbookArea | "todas">("todas");
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(() => searchRunbooks(query, area), [query, area]);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        eyebrow="Soporte"
        title="Runbooks"
        icon={BookOpenCheck}
        description="Qué revisar, cómo reintentar, cuándo escalar y cómo cerrar cada incidente. Las pantallas del negocio se abren entrando como el negocio."
      />

      <div className="mt-6 space-y-3">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="Buscar por síntoma: QR rechazado, factura sin CAE, caja sin señal"
          aria-label="Buscar runbook"
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Área">
          {AREAS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={area === a}
              onClick={() => setArea(a)}
              className={cn(
                "min-h-9 rounded-md px-3 text-sm font-medium transition",
                area === a
                  ? "choice-on text-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {a === "todas" ? "Todas" : RUNBOOK_AREA_LABEL[a]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {list.length} {list.length === 1 ? "runbook" : "runbooks"}
        </p>
      </div>

      {list.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-card">
          <EmptyState icon={Search} title="Ningún runbook coincide" description="Probá con otra palabra o área." />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
          {list.map((r) => {
            const expanded = open === r.id;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full flex-col gap-2 px-4 py-3 text-left transition hover:bg-muted/40 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : r.id)}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <ChevronRight
                      size={16}
                      aria-hidden
                      className={cn(
                        "mt-0.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                        expanded && "rotate-90",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{r.title}</span>
                      <span className="block text-xs text-muted-foreground">{r.symptoms[0]}</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
                    <Badge tone="neutral">{RUNBOOK_AREA_LABEL[r.area]}</Badge>
                    <Badge tone={SEVERITY_TONE[r.severity]}>{RUNBOOK_SEVERITY_LABEL[r.severity]}</Badge>
                  </span>
                </button>
                {expanded && (
                  <div className="space-y-4 border-t border-border bg-muted/30 px-4 py-4 sm:pl-10">
                    {r.symptoms.length > 1 && (
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        {r.symptoms.slice(1).map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    )}
                    {RUNBOOK_SECTIONS.map((sec) => (
                      <div key={sec.key}>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sec.label}</h3>
                        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
                          {r[sec.key].map((st) => (
                            <li key={st.text}>
                              {st.text}
                              {st.href && (
                                <>
                                  {" "}
                                  {st.href.startsWith("/internal") ? (
                                    <Link href={st.href as never} className="font-semibold text-ninja-flameSoft hover:underline">
                                      Abrir
                                    </Link>
                                  ) : (
                                    <code className="rounded bg-muted px-1 text-xs">{st.href}</code>
                                  )}
                                </>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
