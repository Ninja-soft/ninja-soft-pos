"use client";

// H9b PR2 — Render del modo HTML: variables {{x}} + sanitizado DOMPurify.
// El HTML lo escribe el owner/manager del tenant; igual se sanitiza para
// neutralizar scripts/handlers (defensa contra self-XSS y datos pegados).
import DOMPurify from "dompurify";
import { useMemo } from "react";
import { renderTemplate } from "@/lib/email/templates";
import { buildHtmlVars } from "@/lib/tickets/htmlVars";
import type { TicketData } from "@/components/tickets/TicketRenderer";

interface Props {
  html: string;
  data: TicketData;
  paper: "58" | "80" | "a4";
  showNinjaLogo: boolean;
  className?: string;
}

export function HtmlTicketRenderer({ html, data, paper, showNinjaLogo, className }: Props) {
  const width = paper === "58" ? "58mm" : paper === "80" ? "80mm" : "210mm";
  const rendered = useMemo(() => {
    const filled = renderTemplate(html, buildHtmlVars(data));
    // DOMPurify necesita un DOM. En SSR/prerender no hay window: devolvemos
    // vacío y el contenido se hidrata en el cliente (componente "use client").
    if (typeof window === "undefined") return "";
    return DOMPurify.sanitize(filled, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "form", "input", "iframe"],
      ADD_ATTR: ["target"],
    });
  }, [html, data]);
  return (
    <div
      className={`mx-auto overflow-hidden rounded-lg border border-border bg-white p-3 text-black ${className ?? ""}`}
      style={{ width, maxWidth: "100%" }}
    >
      <div dangerouslySetInnerHTML={{ __html: rendered }} />
      {showNinjaLogo && (
        <div className="mt-3 flex justify-center opacity-70">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/ninjapos-logo-light-mode.webp" alt="NinjaSoft" className="h-4 w-auto" />
        </div>
      )}
    </div>
  );
}
