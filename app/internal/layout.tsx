import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InternalShell } from "@/components/layout/InternalShell";

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

  const meta = (user.app_metadata as {
    is_internal?: boolean;
    internal_level?: string;
  } | null) ?? null;
  if (meta?.is_internal !== true) redirect("/dashboard");

  return (
    <InternalShell email={user.email ?? ""} level={meta?.internal_level ?? null}>
      {children}
    </InternalShell>
  );
}
