import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Isotype, WordmarkPos } from "@/components/brand/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export default async function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/internal/tenants");

  const isInternal =
    (user.app_metadata as { is_internal?: boolean } | null)?.is_internal ===
    true;
  if (!isInternal) redirect("/dashboard");

  return (
    <div className="app-bg min-h-screen text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-5">
            <Link href="/internal/tenants" className="flex items-center gap-2.5">
              <Isotype className="h-7 w-auto" priority />
              <WordmarkPos className="h-5 w-auto" priority />
              <span className="rounded-md bg-ninja-flame/12 px-2 py-0.5 text-xs font-semibold text-ninja-flameSoft">
                Interno
              </span>
            </Link>
            <nav className="hidden items-center gap-1 sm:flex">
              <Link
                href="/internal/tenants"
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                Negocios
              </Link>
              <Link
                href="/internal/staff"
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                Staff
              </Link>
            </nav>
          </div>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
