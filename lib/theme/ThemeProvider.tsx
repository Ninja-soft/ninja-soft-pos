"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type ThemeName =
  | "ninja-dark"
  | "ninja-noir"
  | "ninja-light"
  | "ninja-sand";

export const THEMES: { name: ThemeName; label: string; dark: boolean }[] = [
  { name: "ninja-dark", label: "Void (violeta)", dark: true },
  { name: "ninja-noir", label: "Noir (carbón)", dark: true },
  { name: "ninja-light", label: "Lavanda (claro)", dark: false },
  { name: "ninja-sand", label: "Arena (claro cálido)", dark: false },
];

const STORAGE_KEY = "ninja-theme";
const DEFAULT_THEME: ThemeName = "ninja-dark";
const VALID = THEMES.map((t) => t.name);

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);

  useEffect(() => {
    const current = document.documentElement.getAttribute(
      "data-theme",
    ) as ThemeName | null;
    if (current && VALID.includes(current)) setThemeState(current);
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // sin persistencia
    }
  }, []);

  // Toggle rápido claro/oscuro (alterna entre el dark y light por defecto).
  const toggleTheme = useCallback(() => {
    setTheme(
      theme === "ninja-light" || theme === "ninja-sand"
        ? "ninja-dark"
        : "ninja-light",
    );
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme debe usarse dentro de <ThemeProvider>");
  return ctx;
}

export const themeInitScript = `
(function () {
  try {
    var valid = ${JSON.stringify(VALID)};
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var theme = valid.indexOf(stored) !== -1 ? stored : '${DEFAULT_THEME}';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', '${DEFAULT_THEME}');
  }
})();
`;
