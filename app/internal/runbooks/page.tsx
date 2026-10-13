"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BookOpenCheck, Search } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
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
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        eyebrow="Soporte"
        title="Runbooks"
        icon={BookOpenCheck}
        description="Qué revisar, cómo reintentar, cuándo escalar y cómo cerrar cada incidente. Las pantallas del negocio se abren entrando como el negocio."
      />

      <div className="mt-6 space-y-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por síntoma: QR rechazado, factura sin CAE, caja sin señal"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Área">
          {AREAS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setArea(a)}
              className={cn(
                "min-h-9 rounded-full px-3 text-sm font-semibold",
                area === a ? "bg-ninja-flame/15 text-ninja-flameSoft" : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {a === "todas" ? "Todas" : RUNBOOK_AREA_LABEL[a]}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={BookOpenCheck} title="Ningún runbook coincide" description="Probá con otra palabra o área." />
      ) : (
        <ul className="mt-6 divide-y divide-border border-t-2 border-ninja-flame">
          {list.map((r) => {
            const expanded = open === r.id;
            return (
              <li key={r.id} className="py-3">
                <button
                  type="button"
                  className="flex min-h-11 w-full items-start justify-between gap-3 text-left"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : r.id)}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{r.title}</span>
                    <span className="block text-xs text-muted-foreground">{r.symptoms[0]}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone="neutral">{RUNBOOK_AREA_LABEL[r.area]}</Badge>
                    <Badge tone={SEVERITY_TONE[r.severity]}>{RUNBOOK_SEVERITY_LABEL[r.severity]}</Badge>
                  </span>
                </button>
                {expanded && (
                  <div className="mt-3 space-y-4">
                    {r.symptoms.length > 1 && (
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        {r.symptoms.slice(1).map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    )}
                    {RUNBOOK_SECTIONS.map((sec) => (
                      <div key={sec.key}>
                        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{sec.label}</h3>
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
