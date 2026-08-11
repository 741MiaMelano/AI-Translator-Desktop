import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark";
export type AccentColor = "gold" | "green" | "blue" | "purple" | "red";

interface ThemeContextValue {
  mode: ThemeMode;
  accent: AccentColor;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentColor) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  return localStorage.getItem("translator-theme-mode") === "dark" ? "dark" : "light";
}

function readStoredAccent(): AccentColor {
  const value = localStorage.getItem("translator-accent-color");
  return value === "green" || value === "blue" || value === "purple" || value === "red" ? value : "gold";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);
  const [accent, setAccent] = useState<AccentColor>(readStoredAccent);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    document.documentElement.dataset.accent = accent;
    localStorage.setItem("translator-theme-mode", mode);
    localStorage.setItem("translator-accent-color", accent);
  }, [mode, accent]);

  const value = useMemo(() => ({ mode, accent, setMode, setAccent }), [mode, accent]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return context;
}
