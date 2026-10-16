"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";

// Bloque de código del portal de la API (ADR-159): fondo neutro, sin bordes de
// color, con botón copiar. `tabs` muestra varias versiones (curl, JS, Python).

export function CopyButton({ value, label = "Copiar" }: { value: string; label?: string }) {
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast({ title: "No se pudo copiar", variant: "error" }),
        );
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
      <span className="hidden sm:inline">{done ? "Copiado" : "Copiar"}</span>
    </Button>
  );
}
CopyButton.displayName = "CopyButton";

export function CodeBlock({
  code,
  label,
  className,
  maxHeight = true,
}: {
  code: string;
  label?: string;
  className?: string;
  maxHeight?: boolean;
}) {
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg bg-muted", className)}>
      <div className="flex items-center justify-between gap-2 px-3 pt-1.5">
        <span className="truncate text-xs font-medium text-muted-foreground">{label ?? ""}</span>
        <CopyButton value={code} label={label ? `Copiar ${label}` : "Copiar"} />
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-3 pb-3 pt-1 font-mono text-xs leading-relaxed text-foreground",
          maxHeight && "max-h-96 overflow-y-auto",
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
CodeBlock.displayName = "CodeBlock";

export function CodeTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: { id: T; label: string; code: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const current = tabs.find((t) => t.id === value) ?? tabs[0];
  return (
    <div className="space-y-2">
      <Segmented
        size="sm"
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        options={tabs.map((t) => ({ value: t.id, label: t.label }))}
      />
      {current && <CodeBlock code={current.code} label={current.label} />}
    </div>
  );
}

/** Descarga un JSON generado en el navegador. */
export function downloadJson(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
