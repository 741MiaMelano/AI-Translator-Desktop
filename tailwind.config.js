/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        main: "var(--color-bg-main)",
        card: "var(--color-bg-card)",
        "card-soft": "var(--color-bg-card-soft)",
        sidebar: "var(--color-sidebar)",
        "sidebar-soft": "var(--color-sidebar-soft)",
        gold: "var(--color-gold)",
        "gold-light": "var(--color-gold-light)",
        "gold-dark": "var(--color-gold-dark)",
        "gold-wash": "var(--color-gold-wash)",
        line: "var(--color-border)",
        "line-strong": "var(--color-border-strong)",
        ink: "var(--color-text-main)",
        muted: "var(--color-text-muted)",
        ok: "var(--color-success)",
        warn: "var(--color-warning)",
        stop: "var(--color-danger)",
        "ok-wash": "var(--color-success-wash)",
        "warn-wash": "var(--color-warning-wash)",
        "stop-wash": "var(--color-danger-wash)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        soft: "var(--shadow-soft)",
        pop: "var(--shadow-pop)",
        gold: "var(--shadow-gold)",
      },
      fontFamily: {
        mono: "var(--font-mono)",
      },
    },
  },
  plugins: [],
};
