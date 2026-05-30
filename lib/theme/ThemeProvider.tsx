"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type ThemeName = "ninja-dark" | "ninja-light";

const STORAGE_KEY = "ninja-theme";
const DEFAULT_THEME: ThemeName = "ninja-dark";

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: ThemeName) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);

  // Sincroniza con lo que el script anti-FOUC dejó en el <html>.
  useEffect(() => {
    const current = document.documentElement.getAttribute(
      "data-theme",
    ) as ThemeName | null;
    if (current === "ninja-dark" || current === "ninja-light") {
      setThemeState(current);
    }
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage no disponible: el tema vive solo en memoria.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "ninja-dark" ? "ninja-light" : "ninja-dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme debe usarse dentro de <ThemeProvider>");
  }
  return ctx;
}

/** Script inline que setea el tema antes de la hidratación (evita flash). */
export const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var theme = stored === 'ninja-light' || stored === 'ninja-dark' ? stored : '${DEFAULT_THEME}';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', '${DEFAULT_THEME}');
  }
})();
`;
