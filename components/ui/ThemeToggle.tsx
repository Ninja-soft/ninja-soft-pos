"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Button } from "@/components/ui/Button";

// Alterna ninja-dark / ninja-light. Ver UI-NinjaSof.md §41.
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "ninja-dark";

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={toggleTheme}
      aria-label={isDark ? "Activar tema claro" : "Activar tema oscuro"}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
      {isDark ? "Light" : "Dark"}
    </Button>
  );
}
