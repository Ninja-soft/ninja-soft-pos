import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Isotype } from "@/components/brand/Logo";
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
  if (!user) redirect("/login");

  const isInternal =
    (user.app_metadata as { is_internal?: boolean } | null)?.is_internal ===
    true;
  if (!isInternal) redirect("/dashboard-team");

  return (
    <div className="app-bg min-h-screen text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Isotype className="h-7 w-auto" />
            <span className="text-sm font-semibold">
              NinjaSoft <span className="text-ninja-flameSoft">· Interno</span>
            </span>
            <Link
              href="/internal/tenants"
              className="ml-4 text-sm text-muted-foreground hover:text-foreground"
            >
              Tenants
            </Link>
          </div>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
