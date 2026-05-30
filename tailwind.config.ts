import type { Config } from "tailwindcss";

// Tokens de marca y semánticos de NinjaSoft. Ver UI-NinjaSof.md §13-14.
// Los tokens semánticos (background, primary, ...) apuntan a variables CSS
// definidas en app/globals.css, lo que permite cambiar ninja-dark/ninja-light
// vía el atributo [data-theme] sin recompilar.
const config: Config = {
  darkMode: ["class", '[data-theme="ninja-dark"]'],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./modules/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        price: ["var(--font-price)", "ui-monospace", "monospace"],
        sans: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
      },
      colors: {
        // Tokens semánticos (cambian con el tema vía CSS vars).
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        // Paleta de marca (valores fijos). Ver UI-NinjaSof.md §9.
        ninja: {
          flame: "#FF4B22",
          flameSoft: "#FF6A1A",
          flameDeep: "#E63E18",
          gold: "#FFD21F",
          goldSoft: "#FFE45C",
          void: "#09051C",
          voidViolet: "#100A2E",
          deepViolet: "#140D35",
          midViolet: "#2B1A67",
          brightViolet: "#6D4AFF",
          softWhite: "#F7F7FF",
          lavender: "#B8AEDC",
          slate: "#7F75A6",
          black: "#04020D",
        },
      },
      borderRadius: {
        ninjaSm: "10px",
        ninjaMd: "14px",
        ninjaLg: "20px",
        ninjaXl: "28px",
        ninjaFull: "999px",
      },
      boxShadow: {
        ninjaSoft: "var(--shadow-soft, 0 6px 20px rgba(8, 5, 20, 0.16))",
        ninjaGlow: "0 0 24px rgba(255, 106, 26, 0.22)",
        ninjaGoldGlow: "0 0 24px rgba(255, 210, 31, 0.16)",
        ninjaVioletGlow: "0 0 32px rgba(109, 74, 255, 0.18)",
      },
      backgroundImage: {
        "ninja-gradient":
          "linear-gradient(135deg, #FF4B22 0%, #FF8A1F 48%, #FFD21F 100%)",
        "ninja-dark":
          "linear-gradient(135deg, #09051C 0%, #100A2E 50%, #21135A 100%)",
        "ninja-light":
          "linear-gradient(135deg, #F8F7FF 0%, #F1EEFF 52%, #FFFFFF 100%)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "overlay-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "modal-in": {
          from: { opacity: "0", transform: "translate(-50%, -50%) scale(0.95)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "modal-out": {
          from: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
          to: { opacity: "0", transform: "translate(-50%, -50%) scale(0.97)" },
        },
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out",
        "slide-up": "slide-up 240ms cubic-bezier(0.22, 1, 0.36, 1)",
        "overlay-in": "overlay-in 160ms ease-out",
        "overlay-out": "overlay-out 130ms ease-in forwards",
        "modal-in": "modal-in 210ms cubic-bezier(0.22, 1, 0.36, 1)",
        "modal-out": "modal-out 130ms ease-in forwards",
      },
    },
  },
  plugins: [],
};

export default config;
