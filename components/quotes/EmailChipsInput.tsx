"use client";

// Emails del cliente como chips (ADR-123): se escriben o pegan separados por
// coma, punto y coma, espacio o Enter; los inválidos quedan en el campo con el
// aviso. Hasta QUOTE_EMAIL_MAX_RECIPIENTS.
import { useId, useState } from "react";
import { X } from "lucide-react";
import { QUOTE_EMAIL_MAX_RECIPIENTS, parseEmails } from "@/lib/quotes/logic";
import { cn } from "@/lib/utils/cn";

export function EmailChipsInput({
  label,
  hint,
  value,
  onChange,
  placeholder = "cliente@empresa.com",
  disabled,
  id,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = value.length >= QUOTE_EMAIL_MAX_RECIPIENTS;

  function commit(raw: string): boolean {
    const { valid, invalid } = parseEmails(raw);
    const next = [...value];
    for (const e of valid) if (!next.includes(e) && next.length < QUOTE_EMAIL_MAX_RECIPIENTS) next.push(e);
    if (next.length !== value.length) onChange(next);
    if (invalid.length) {
      setDraft(invalid.join(", "));
      setError(`No parece un email: ${invalid.join(", ")}`);
      return false;
    }
    setDraft("");
    setError(valid.some((e) => !next.includes(e)) ? `Hasta ${QUOTE_EMAIL_MAX_RECIPIENTS} emails.` : null);
    return true;
  }

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div
        className={cn(
          "flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2 py-1.5 transition-colors focus-within:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]",
          error && "border-danger/60",
          disabled && "opacity-60",
        )}
      >
        {value.map((e) => (
          <span key={e} className="inline-flex max-w-full items-center gap-1 rounded-md bg-fg-6 py-1 pl-2 pr-1 text-[13px] text-foreground">
            <span className="truncate">{e}</span>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== e))}
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-fg-10 hover:text-foreground"
                aria-label={`Quitar ${e}`}
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </span>
        ))}
        <input
          id={inputId}
          type="email"
          inputMode="email"
          autoComplete="off"
          disabled={disabled || full}
          value={draft}
          placeholder={value.length === 0 ? placeholder : full ? "" : "Agregar otro"}
          onChange={(e) => {
            const v = e.target.value;
            setError(null);
            if (/[,;\s]$/.test(v)) commit(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[,;\s]/.test(text.trim())) {
              e.preventDefault();
              commit(`${draft}${text}`);
            }
          }}
          className="h-8 min-w-[10rem] flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
