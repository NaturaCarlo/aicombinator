"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  function cycle() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  const className = compact
    ? "flex items-center gap-2.5 rounded-none px-3 py-2 text-xs font-medium transition-colors text-muted-foreground hover:bg-secondary hover:text-foreground w-full"
    : "inline-flex items-center justify-center rounded-none p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";

  return (
    <button type="button" onClick={cycle} className={className}>
      <Sun className="h-3.5 w-3.5 shrink-0 dark:hidden" />
      <Moon className="h-3.5 w-3.5 shrink-0 hidden dark:block" />
      {compact && <span>Toggle theme</span>}
    </button>
  );
}
