import { Fragment, type ReactNode } from "react";

// Render liviano del markdown que devuelven los modelos (Gemini/Claude) en el
// chat del asistente. Cubre lo que realmente usan: párrafos, **negrita**,
// *itálica*, `código`, títulos (#) y listas con viñetas o numeradas. No usa
// dangerouslySetInnerHTML: todo se arma como nodos de React, así un texto del
// modelo nunca puede inyectar HTML.

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number };

const UL_RE = /^\s*[-*•]\s+(.*)$/;
const OL_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const H_RE = /^\s*#{1,6}\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = H_RE.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "h", text: h[1] ?? "" });
      continue;
    }
    const ul = UL_RE.exec(line);
    if (ul) {
      if (cur?.kind !== "ul") {
        flush();
        cur = { kind: "ul", items: [] };
      }
      cur.items.push(ul[1] ?? "");
      continue;
    }
    const ol = OL_RE.exec(line);
    if (ol) {
      if (cur?.kind !== "ol") {
        flush();
        cur = { kind: "ol", items: [], start: Number(ol[1]) || 1 };
      }
      cur.items.push(ol[2] ?? "");
      continue;
    }
    if (cur?.kind !== "p") {
      flush();
      cur = { kind: "p", lines: [] };
    }
    cur.lines.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE_RE =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (tok.startsWith("**")) {
      out.push(
        <strong key={i++} className="font-semibold text-foreground">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={i++}
          className="rounded-md bg-ninja-lavender/15 px-1.5 py-0.5 font-mono text-[0.85em]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<em key={i++}>{tok.slice(1, -1)}</em>);
    }
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, bi) => {
        if (b.kind === "h") {
          return (
            <p
              key={bi}
              className="font-display text-[15px] font-semibold text-foreground"
            >
              {renderInline(b.text)}
            </p>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul key={bi} className="space-y-1.5">
              {b.items.map((it, ii) => (
                <li key={ii} className="flex gap-2.5">
                  <span
                    aria-hidden
                    className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-ninja-flame"
                  />
                  <span className="min-w-0">{renderInline(it)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol key={bi} className="space-y-1.5">
              {b.items.map((it, ii) => (
                <li key={ii} className="flex gap-2.5">
                  <span
                    aria-hidden
                    className="mt-[0.1em] grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-ninja-flame/15 px-1 text-[11px] font-semibold tabular-nums text-primary"
                  >
                    {b.start + ii}
                  </span>
                  <span className="min-w-0">{renderInline(it)}</span>
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={bi}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
