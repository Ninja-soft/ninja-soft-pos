"use client";

import { useRouter } from "next/navigation";
import { LogOut, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Isotype } from "@/components/brand/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Button } from "@/components/ui/Button";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";

export function DashboardHeader({ email }: { email: string }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Isotype className="h-7 w-auto" priority />

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="secondary" size="sm">
                <User size={16} />
                Cuenta
              </Button>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownLabel>{email}</DropdownLabel>
              <DropdownSeparator />
              <DropdownItem onSelect={signOut} className="text-destructive">
                <LogOut size={15} />
                Cerrar sesión
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
        </div>
      </div>
    </header>
  );
}
