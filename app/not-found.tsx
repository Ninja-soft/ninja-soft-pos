import Link from "next/link";
import { SearchX } from "lucide-react";

// 404 con mensaje humano (ADR-098).
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 py-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-lg bg-ninja-flame/10 text-ninja-flameSoft" aria-hidden>
        <SearchX size={24} strokeWidth={1.75} />
      </span>
      <div className="max-w-md space-y-1">
        <h1 className="text-lg font-semibold text-foreground">No encontramos esta página</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Puede que el link esté mal escrito o que la página ya no exista.
        </p>
      </div>
      <Link
        href="/"
        className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--pos-solid)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--pos-solid-hover)]"
      >
        Ir al inicio
      </Link>
    </main>
  );
}
