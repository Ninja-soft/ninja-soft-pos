import type { Config } from "tailwindcss";

// Color temado que soporta el modificador de opacidad de Tailwind (ADR-040).
// Los tokens semánticos son `var(--x)` con valores hex o rgba por tema, y
// Tailwind no puede inyectar alpha en un var(): `bg-muted/50` no generaba
// NADA. Con una función de color:
// - sin modificador (Tailwind pasa `opacityVariable`, o nada en fill/stroke)
//   devolvemos `var(--x)` tal cual, igual que antes;
// - con modificador (`/50`, `/[.35]`) mezclamos con transparente vía
//   color-mix, que respeta el alpha propio del token (rgba).
type ColorFnArgs = { opacityValue?: string; opacityVariable?: string };
// Tailwind 3 acepta funciones de color en runtime, pero sus tipos sólo
// declaran strings: de ahí el cast.
const themed = (name: string): string => {
  const fn = ({ opacityValue, opacityVariable }: ColorFnArgs = {}) =>
    opacityVariable !== undefined || opacityValue === undefined
      ? `var(--${name})`
      : `color-mix(in srgb, var(--${name}) calc(${opacityValue} * 100%), transparent)`;
  return fn as unknown as string;
};

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
        background: themed("background"),
        foreground: themed("foreground"),
        card: {
          DEFAULT: themed("card"),
          foreground: themed("card-foreground"),
        },
        popover: {
          DEFAULT: themed("popover"),
          foreground: themed("popover-foreground"),
        },
        primary: {
          DEFAULT: themed("primary"),
          foreground: themed("primary-foreground"),
        },
        secondary: {
          DEFAULT: themed("secondary"),
          foreground: themed("secondary-foreground"),
        },
        muted: {
          DEFAULT: themed("muted"),
          foreground: themed("muted-foreground"),
        },
        accent: {
          DEFAULT: themed("accent"),
          foreground: themed("accent-foreground"),
        },
        destructive: {
          DEFAULT: themed("destructive"),
          foreground: themed("destructive-foreground"),
        },
        border: themed("border"),
        input: themed("input"),
        ring: themed("ring"),
        // Estado temado (texto legible sobre el fondo del tema; pastel en
        // oscuro, tinta en claro). Tripletas RGB en globals.css.
        success: "rgb(var(--status-success) / <alpha-value>)",
        danger: "rgb(var(--status-danger) / <alpha-value>)",
        warning: "rgb(var(--status-warning) / <alpha-value>)",
        info: "rgb(var(--status-info) / <alpha-value>)",
        // Paleta de marca. Ver UI-NinjaSof.md §9. Los tonos pensados para
        // LEERSE sobre el fondo (flameSoft/softWhite/lavender/slate) son
        // adaptativos por tema vía CSS vars (tripletas RGB en globals.css):
        // en oscuro conservan el hex histórico, en claro se hunden para no
        // quedar lavados/ilegibles. El resto es fijo de marca.
        ninja: {
          flame: "#FF4B22",
          flameSoft: "rgb(var(--ninja-flame-soft) / <alpha-value>)",
          flameDeep: "#E63E18",
          gold: "#FFD21F",
          goldSoft: "#FFE45C",
          void: "#09051C",
          voidViolet: "#100A2E",
          deepViolet: "#140D35",
          midViolet: "#2B1A67",
          brightViolet: "#6D4AFF",
          softWhite: "rgb(var(--ninja-soft-white) / <alpha-value>)",
          lavender: "rgb(var(--ninja-lavender) / <alpha-value>)",
          slate: "rgb(var(--ninja-slate) / <alpha-value>)",
          black: "#04020D",
        },
      },
      // Sin esto, un `ring-*` sin color caía al azul por defecto de Tailwind
      // (rgb(59 130 246 / 0.5)). Ahora es el token --ring del tema (al 50%,
      // la opacidad por defecto de ring en Tailwind 3).
      ringColor: {
        DEFAULT: themed("ring"),
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
        "sheet-in": {
          from: { opacity: "0.6", transform: "translateY(100%)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "sheet-out": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(40%)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.4)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out",
        "slide-up": "slide-up 240ms cubic-bezier(0.22, 1, 0.36, 1)",
        "overlay-in": "overlay-in 160ms ease-out",
        "overlay-out": "overlay-out 130ms ease-in forwards",
        "modal-in": "modal-in 210ms cubic-bezier(0.22, 1, 0.36, 1)",
        "modal-out": "modal-out 130ms ease-in forwards",
        "sheet-in": "sheet-in 280ms cubic-bezier(0.22, 1, 0.36, 1)",
        "sheet-out": "sheet-out 160ms ease-in forwards",
        "scale-in": "scale-in 320ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
