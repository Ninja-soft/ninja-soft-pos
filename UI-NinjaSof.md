# NinjaSoft — UI Guide, Brand System & Tailwind Theme

Este documento define la estética visual, el sistema de diseño y las reglas de implementación para el proyecto NinjaSoft.

Debe ser usado como referencia principal por cualquier agente, desarrollador o diseñador que trabaje sobre la interfaz del producto, landing, dashboard, POS, documentos comerciales o cualquier pieza digital relacionada.

No asumir que existe un brandbook externo. Todo lo necesario para interpretar la estética de NinjaSoft está documentado acá.

---

## 1. Identidad general

NinjaSoft es una marca de software enfocada en soluciones seguras, precisas y ágiles para negocios inteligentes.

La identidad visual combina tecnología, seguridad, velocidad operativa y criterio profesional. La estética debe sentirse premium, moderna, confiable y corporativa, sin parecer una plantilla genérica ni una startup improvisada.

La frase conceptual principal es:

> Software seguro para negocios inteligentes.

La interfaz debe transmitir que el sistema fue construido para operar en contextos reales de negocio: ventas, stock, integración con APIs, sincronización de datos, gestión administrativa, automatización y control operativo.

NinjaSoft no debe verse infantil, informal ni excesivamente decorativo. Debe verse técnico, sólido, elegante y claro.

---

## 2. Sensación visual buscada

La estética de NinjaSoft debe sentirse como:

- Un sistema serio de software.
- Una herramienta premium para empresas.
- Una interfaz segura y confiable.
- Un producto digital moderno, oscuro y preciso.
- Un panel de control tecnológico, pero legible.
- Una experiencia visual con personalidad, sin sacrificar claridad.

Palabras clave:

- Seguridad.
- Precisión.
- Agilidad.
- Foco.
- Control.
- Tecnología.
- Cercanía profesional.
- Orden.
- Silencio visual.
- Alto contraste controlado.

---

## 3. Personalidad de la marca

La marca debe comportarse visual y verbalmente como un equipo técnico confiable.

### Directa

Comunica sin vueltas. Los textos deben ser claros, concretos y accionables.

Ejemplo:

```txt
Detectamos el problema.
Diseñamos la solución.
Sincronización completada.
Revisá los datos antes de continuar.
```

### Clara

La interfaz no debe obligar al usuario a interpretar demasiado. Cada sección debe explicar qué está pasando.

### Segura

Debe transmitir protección, estabilidad y confianza. El usuario tiene que sentir que sus datos, ventas y operaciones están bajo control.

### Cercana

Aunque la estética sea tecnológica, no debe sentirse fría o distante. El tono puede ser humano y amable, pero nunca informal de más.

### Profesional

No usar lenguaje exagerado, promesas vacías ni textos estilo marketing genérico.

---

## 4. Principio rector de diseño

La interfaz ideal de NinjaSoft no grita.

Ordena, protege y acelera.

Cada decisión visual debe ayudar a que el usuario:

- Entienda más rápido.
- Trabaje con menos fricción.
- Detecte errores.
- Confirme acciones importantes.
- Confíe en el estado del sistema.
- Use el producto durante muchas horas sin fatiga visual.

---

## 5. Estilo visual principal

El estilo base de NinjaSoft es:

- Dark UI premium.
- SaaS moderno.
- Dashboard tecnológico.
- Glassmorphism sutil.
- Fondos violetas profundos.
- Acentos naranja fuego y amarillo dorado.
- Bordes redondeados.
- Glow moderado.
- Gradientes cálidos.
- Contraste alto pero elegante.
- Texturas técnicas de baja opacidad.
- Componentes limpios y bien espaciados.

No usar:

- Bootstrap genérico.
- Sombras negras exageradas.
- Colores primarios básicos sin identidad.
- Interfaces saturadas.
- Exceso de líneas divisorias.
- Glow excesivo.
- Fondos blancos como base principal del tema dark.
- Estilo gamer agresivo.
- Estilo cripto exagerado.
- Neon excesivo.
- Emojis como parte estructural de la UI.

---

## 6. Temas visuales del sistema

El producto debe contemplar dos temas principales:

1. `ninja-dark`
2. `ninja-light`

Además, cuando se construyan pantallas operativas complejas, se debe mantener una estética Tailwind limpia, moderna y sobria.

---

## 7. Tema principal: ninja-dark

Este es el tema principal de la marca.

Debe usarse para:

- Landing principal.
- Dashboard.
- POS.
- Panel administrativo.
- Login.
- Modales importantes.
- Sistema interno.
- Presentaciones digitales.
- Screenshots comerciales.
- Interfaces premium.

### Sensación

El tema dark debe sentirse:

- Profundo.
- Seguro.
- Tecnológico.
- Premium.
- Silencioso.
- Preciso.
- Diferente a una plantilla común.

### Fondo base

El fondo no debe ser negro puro. Debe ser un violeta oscuro profundo, con variaciones sutiles.

Colores recomendados:

```txt
Void              #09051C
Void Violet       #100A2E
Deep Violet       #140D35
Mid Violet        #21135A
Panel Violet      #1B123F
Soft Panel        #241654
```

### Fondo recomendado en CSS

```css
background:
  radial-gradient(circle at 18% 18%, rgba(255, 75, 34, 0.16), transparent 30%),
  radial-gradient(circle at 82% 12%, rgba(95, 58, 214, 0.24), transparent 34%),
  radial-gradient(circle at 70% 82%, rgba(255, 210, 31, 0.08), transparent 28%),
  linear-gradient(135deg, #09051C 0%, #100A2E 48%, #21135A 100%);
```

### Tailwind background sugerido

```tsx
<div className="min-h-screen bg-[radial-gradient(circle_at_18%_18%,rgba(255,75,34,0.16),transparent_30%),radial-gradient(circle_at_82%_12%,rgba(95,58,214,0.24),transparent_34%),linear-gradient(135deg,#09051C_0%,#100A2E_48%,#21135A_100%)] text-[#F7F7FF]">
  ...
</div>
```

---

## 8. Tema secundario: ninja-light

El tema light debe mantener la identidad NinjaSoft sin perder legibilidad.

No debe ser blanco plano sin personalidad. Debe sentirse limpio, premium y corporativo.

Debe usarse para:

- Documentos comerciales.
- Pantallas administrativas extensas.
- Formularios largos.
- Reportes.
- Tablas complejas.
- Facturas.
- Presupuestos.
- Paneles donde se requiera máxima lectura.
- Versiones claras del dashboard.

### Sensación

El tema light debe sentirse:

- Limpio.
- Profesional.
- Luminoso.
- Sofisticado.
- Seguro.
- Menos visualmente intenso que el dark.
- Con acentos NinjaSoft bien controlados.

### Fondo base

```txt
White Core        #F8F7FF
Soft Lavender     #F1EEFF
Warm Surface      #FFFFFF
Light Panel       #F6F3FF
Border Light      #E3DDF5
Text Dark         #161026
Text Muted        #6E6688
```

### Acentos de marca en light

```txt
Ninja Flame       #FF4B22
Flame Soft        #FF6A1A
Strike Gold       #FFD21F
Mid Violet        #4A2DA3
Void Violet       #100A2E
```

### Fondo recomendado en CSS

```css
background:
  radial-gradient(circle at 15% 10%, rgba(255, 106, 26, 0.10), transparent 28%),
  radial-gradient(circle at 85% 0%, rgba(74, 45, 163, 0.12), transparent 32%),
  linear-gradient(135deg, #F8F7FF 0%, #F1EEFF 52%, #FFFFFF 100%);
```

### Tailwind background sugerido

```tsx
<div className="min-h-screen bg-[radial-gradient(circle_at_15%_10%,rgba(255,106,26,0.10),transparent_28%),radial-gradient(circle_at_85%_0%,rgba(74,45,163,0.12),transparent_32%),linear-gradient(135deg,#F8F7FF_0%,#F1EEFF_52%,#FFFFFF_100%)] text-[#161026]">
  ...
</div>
```

---

## 9. Paleta principal

### Colores de marca

```txt
Ninja Flame       #FF4B22
Flame Soft        #FF6A1A
Flame Deep        #E63E18
Strike Gold       #FFD21F
Gold Soft         #FFE45C
Void              #09051C
Void Violet       #100A2E
Deep Violet       #140D35
Mid Violet        #2B1A67
Bright Violet     #6D4AFF
Soft White        #F7F7FF
Lavender Mist     #B8AEDC
Slate Mist        #7F75A6
Pure Black        #04020D
```

### Uso correcto

#### Ninja Flame

Usar para:

- CTA principal.
- Estados activos.
- Links importantes.
- Bordes de foco.
- Iconos de acción.
- Indicadores de operación.
- Highlights.

No usar para:

- Grandes fondos constantes.
- Textos largos.
- Errores, salvo que se combine con rojo semántico.

#### Strike Gold

Usar para:

- Métricas clave.
- Detalles de valor.
- Gradientes.
- Estados destacados.
- Badges importantes.
- Elementos premium.

No usar como color principal de texto largo.

#### Void Violet

Usar para:

- Fondos principales dark.
- Sidebars.
- Headers.
- Modales.
- Layout general.

#### Lavender Mist

Usar para:

- Texto secundario.
- Descripciones.
- Ayudas.
- Labels no activos.

---

## 10. Gradientes de marca

Los gradientes son parte fuerte de la identidad, pero deben usarse con criterio.

### Gradiente principal

```css
linear-gradient(135deg, #FF4B22 0%, #FF8A1F 48%, #FFD21F 100%)
```

Uso:

- Botón principal.
- Logo lockup.
- Iconos destacados.
- Elementos activos.
- Detalles de marca.

### Gradiente dark premium

```css
linear-gradient(135deg, #09051C 0%, #100A2E 50%, #21135A 100%)
```

Uso:

- Fondo principal.
- Layout de producto.
- Hero section.

### Gradiente card dark

```css
linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.025))
```

Uso:

- Cards.
- Panels.
- Modales.

### Gradiente light

```css
linear-gradient(135deg, #F8F7FF 0%, #F1EEFF 52%, #FFFFFF 100%)
```

Uso:

- Tema light.
- Reportes.
- Formularios.
- Fondos administrativos.

---

## 11. Tipografía

El sistema debe usar tres familias tipográficas.

### Display: Nunito

Uso:

- Logo textual cuando corresponda.
- Títulos principales.
- Hero.
- Encabezados importantes.
- Mensajes de marca.

Sensación:

- Humana.
- Redondeada.
- Cálida.
- Cercana.
- Moderna.

Pesos:

```txt
300 Light
400 Regular
600 SemiBold
700 Bold
900 Black
```

### UI: Inter

Uso:

- Texto general.
- Formularios.
- Tablas.
- Cards.
- Menús.
- Dashboard.
- POS.
- Listados.
- Botones.
- Modales.

Sensación:

- Clara.
- Técnica.
- Neutral.
- Muy legible en pantalla.

Pesos:

```txt
400 Regular
500 Medium
600 SemiBold
700 Bold
```

### Code: JetBrains Mono

Uso:

- Código.
- Logs.
- IDs.
- Tokens.
- Estados técnicos.
- Badges técnicos.
- Texto estilo `<Development Team />`.

No usar JetBrains Mono para textos largos comunes.

---

## 12. Escala tipográfica recomendada

```ts
const typography = {
  hero: "text-5xl md:text-7xl font-black tracking-[-0.06em]",
  h1: "text-4xl md:text-5xl font-extrabold tracking-[-0.05em]",
  h2: "text-3xl md:text-4xl font-bold tracking-[-0.04em]",
  h3: "text-2xl md:text-3xl font-bold tracking-[-0.03em]",
  title: "text-xl font-semibold",
  body: "text-sm md:text-base",
  small: "text-sm",
  caption: "text-xs",
  code: "font-mono text-xs tracking-tight"
}
```

### Reglas

- Los títulos deben tener aire.
- No comprimir encabezados.
- Evitar textos muy chicos en operaciones críticas.
- En POS, priorizar legibilidad sobre estética.
- En dashboards, las métricas deben tener jerarquía fuerte.

---

## 13. Tailwind config recomendado

Usar este esquema como base en `tailwind.config.ts`.

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["Nunito", "sans-serif"],
        sans: ["Inter", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"]
      },
      colors: {
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
          black: "#04020D"
        }
      },
      borderRadius: {
        ninjaSm: "10px",
        ninjaMd: "14px",
        ninjaLg: "20px",
        ninjaXl: "28px",
        ninjaFull: "999px"
      },
      boxShadow: {
        ninjaSoft: "0 20px 60px rgba(0, 0, 0, 0.28)",
        ninjaGlow: "0 0 32px rgba(255, 106, 26, 0.32)",
        ninjaGoldGlow: "0 0 32px rgba(255, 210, 31, 0.22)",
        ninjaVioletGlow: "0 0 42px rgba(109, 74, 255, 0.24)"
      },
      backgroundImage: {
        "ninja-gradient": "linear-gradient(135deg, #FF4B22 0%, #FF8A1F 48%, #FFD21F 100%)",
        "ninja-dark": "linear-gradient(135deg, #09051C 0%, #100A2E 50%, #21135A 100%)",
        "ninja-light": "linear-gradient(135deg, #F8F7FF 0%, #F1EEFF 52%, #FFFFFF 100%)"
      }
    }
  },
  plugins: []
};

export default config;
```

---

## 14. Variables CSS recomendadas

Usar variables CSS para soportar tema dark y light.

```css
:root {
  --background: #F8F7FF;
  --foreground: #161026;

  --card: #FFFFFF;
  --card-foreground: #161026;

  --popover: #FFFFFF;
  --popover-foreground: #161026;

  --primary: #FF4B22;
  --primary-foreground: #100A2E;

  --secondary: #F1EEFF;
  --secondary-foreground: #21135A;

  --muted: #F6F3FF;
  --muted-foreground: #6E6688;

  --accent: #FFD21F;
  --accent-foreground: #100A2E;

  --destructive: #EF4444;
  --destructive-foreground: #FFFFFF;

  --border: #E3DDF5;
  --input: #E3DDF5;
  --ring: #FF6A1A;

  --radius: 1rem;
}

.dark,
[data-theme="ninja-dark"] {
  --background: #09051C;
  --foreground: #F7F7FF;

  --card: rgba(20, 13, 53, 0.78);
  --card-foreground: #F7F7FF;

  --popover: #140D35;
  --popover-foreground: #F7F7FF;

  --primary: #FF4B22;
  --primary-foreground: #100A2E;

  --secondary: rgba(255, 255, 255, 0.06);
  --secondary-foreground: #F7F7FF;

  --muted: rgba(255, 255, 255, 0.06);
  --muted-foreground: #B8AEDC;

  --accent: #FFD21F;
  --accent-foreground: #100A2E;

  --destructive: #FF4B4B;
  --destructive-foreground: #FFFFFF;

  --border: rgba(255, 255, 255, 0.10);
  --input: rgba(255, 255, 255, 0.12);
  --ring: #FF6A1A;
}

[data-theme="ninja-light"] {
  --background: #F8F7FF;
  --foreground: #161026;

  --card: rgba(255, 255, 255, 0.86);
  --card-foreground: #161026;

  --popover: #FFFFFF;
  --popover-foreground: #161026;

  --primary: #FF4B22;
  --primary-foreground: #100A2E;

  --secondary: #F1EEFF;
  --secondary-foreground: #21135A;

  --muted: #F6F3FF;
  --muted-foreground: #6E6688;

  --accent: #FFD21F;
  --accent-foreground: #100A2E;

  --destructive: #DC2626;
  --destructive-foreground: #FFFFFF;

  --border: #E3DDF5;
  --input: #DDD6F0;
  --ring: #FF6A1A;
}
```

---

## 15. Base CSS recomendada

```css
* {
  border-color: var(--border);
}

html {
  scroll-behavior: smooth;
}

body {
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
  font-family: "Inter", sans-serif;
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: rgba(255, 106, 26, 0.32);
  color: #F7F7FF;
}

.font-display {
  font-family: "Nunito", sans-serif;
}

.font-code {
  font-family: "JetBrains Mono", monospace;
}
```

---

## 16. Layout general de producto

La estructura recomendada para dashboards y sistemas internos:

```txt
App Shell
├── Sidebar
├── Header
├── Main Content
│   ├── Page Header
│   ├── Metrics / Quick actions
│   ├── Primary content
│   └── Secondary panels
└── Toast / Command Menu / Modals
```

### Sidebar

Debe ser oscura en tema dark.

Características:

- Fondo profundo.
- Logo arriba.
- Navegación clara.
- Estado activo con acento naranja o gradiente.
- Íconos lineales.
- Bordes suaves.
- Separadores sutiles.

Clase sugerida:

```tsx
<aside className="border-r border-white/10 bg-[#09051C]/80 backdrop-blur-xl">
  ...
</aside>
```

### Header

Debe ser simple y funcional.

Debe mostrar:

- Título de pantalla.
- Breadcrumb opcional.
- Estado de sincronización.
- Usuario.
- Acciones principales.

Clase sugerida dark:

```tsx
<header className="sticky top-0 z-40 border-b border-white/10 bg-[#09051C]/70 backdrop-blur-xl">
  ...
</header>
```

Clase sugerida light:

```tsx
<header className="sticky top-0 z-40 border-b border-[#E3DDF5] bg-white/72 backdrop-blur-xl">
  ...
</header>
```

---

## 17. Estética Tailwind limpia y dark

Cuando se trabaje con Tailwind, evitar clases visualmente caóticas.

Priorizar:

- `bg-white/5`
- `border-white/10`
- `text-white`
- `text-white/70`
- `rounded-2xl`
- `shadow-xl`
- `backdrop-blur-xl`
- `transition`
- `hover:bg-white/10`
- `focus-visible:ring-2`
- `ring-orange-500/40`

Evitar:

- Demasiados colores en una sola pantalla.
- `shadow-2xl` en todos lados.
- Gradientes en cada card.
- Bordes de colores constantes.
- Fondos `black` puros.
- Texto gris de bajo contraste.
- Clases duplicadas sin criterio.

Ejemplo de card limpia dark:

```tsx
<div className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 shadow-xl shadow-black/20 backdrop-blur-xl">
  <p className="text-sm text-white/60">Ventas hoy</p>
  <h3 className="mt-2 text-3xl font-bold tracking-tight text-white">$842.300</h3>
  <p className="mt-2 text-sm text-emerald-300">+12.4% vs ayer</p>
</div>
```

Ejemplo de card limpia light:

```tsx
<div className="rounded-2xl border border-[#E3DDF5] bg-white/85 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl">
  <p className="text-sm text-[#6E6688]">Ventas hoy</p>
  <h3 className="mt-2 text-3xl font-bold tracking-tight text-[#161026]">$842.300</h3>
  <p className="mt-2 text-sm text-emerald-600">+12.4% vs ayer</p>
</div>
```

---

## 18. Componentes principales

### Button primary

Debe ser el botón más importante de una pantalla.

```tsx
<button className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-[#FF4B22] via-[#FF8A1F] to-[#FFD21F] px-5 py-3 text-sm font-bold text-[#100A2E] shadow-[0_0_32px_rgba(255,106,26,0.32)] transition hover:scale-[1.01] active:scale-[0.99]">
  Guardar cambios
</button>
```

Usar para:

- Guardar.
- Confirmar.
- Empezar.
- Sincronizar.
- Crear.
- Acceder.

No usar más de un botón primary fuerte por sección.

### Button secondary dark

```tsx
<button className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.10]">
  Cancelar
</button>
```

### Button secondary light

```tsx
<button className="inline-flex items-center justify-center rounded-2xl border border-[#E3DDF5] bg-white px-5 py-3 text-sm font-semibold text-[#21135A] shadow-sm transition hover:bg-[#F6F3FF]">
  Cancelar
</button>
```

---

## 19. Inputs

### Input dark

```tsx
<input
  className="h-11 w-full rounded-2xl border border-white/10 bg-[#09051C]/60 px-4 text-sm text-white placeholder:text-white/35 outline-none transition focus:border-[#FF6A1A] focus:ring-4 focus:ring-[#FF6A1A]/15"
/>
```

### Input light

```tsx
<input
  className="h-11 w-full rounded-2xl border border-[#DDD6F0] bg-white px-4 text-sm text-[#161026] placeholder:text-[#6E6688]/65 outline-none transition focus:border-[#FF6A1A] focus:ring-4 focus:ring-[#FF6A1A]/15"
/>
```

### Label dark

```tsx
<label className="mb-2 block text-sm font-medium text-white/70">
  Nombre del cliente
</label>
```

### Label light

```tsx
<label className="mb-2 block text-sm font-medium text-[#6E6688]">
  Nombre del cliente
</label>
```

---

## 20. Cards

### Card dark premium

```tsx
<div className="rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.025))] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl">
  ...
</div>
```

### Card light premium

```tsx
<div className="rounded-[28px] border border-[#E3DDF5] bg-white/85 p-6 shadow-[0_20px_60px_rgba(35,22,80,0.08)] backdrop-blur-xl">
  ...
</div>
```

### Regla

Las cards deben agrupar información relacionada. No usar cards para cada línea sin necesidad.

---

## 21. Badges

### Badge active dark

```tsx
<span className="inline-flex items-center rounded-full border border-[#FF6A1A]/25 bg-[#FF6A1A]/12 px-3 py-1 text-xs font-semibold text-[#FFD21F]">
  Activo
</span>
```

### Badge neutral dark

```tsx
<span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs font-medium text-white/70">
  Pendiente
</span>
```

### Badge light

```tsx
<span className="inline-flex items-center rounded-full border border-[#FF6A1A]/20 bg-[#FF6A1A]/10 px-3 py-1 text-xs font-semibold text-[#E63E18]">
  Activo
</span>
```

---

## 22. Tablas

Las tablas deben ser muy claras. En un sistema operativo real, la tabla debe priorizar lectura y velocidad.

### Tabla dark

```tsx
<div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
  <table className="w-full text-sm">
    <thead className="bg-white/[0.06] text-left text-xs uppercase tracking-[0.16em] text-white/45">
      ...
    </thead>
    <tbody className="divide-y divide-white/10 text-white/75">
      ...
    </tbody>
  </table>
</div>
```

### Tabla light

```tsx
<div className="overflow-hidden rounded-2xl border border-[#E3DDF5] bg-white">
  <table className="w-full text-sm">
    <thead className="bg-[#F6F3FF] text-left text-xs uppercase tracking-[0.16em] text-[#6E6688]">
      ...
    </thead>
    <tbody className="divide-y divide-[#E3DDF5] text-[#161026]">
      ...
    </tbody>
  </table>
</div>
```

### Reglas

- Usar zebra opcional con baja opacidad.
- Hover suave.
- Cabecera sticky si la tabla es larga.
- Acciones alineadas a la derecha.
- No abusar de colores por columna.

---

## 23. Modales

Los modales deben sentirse sólidos, no flotantes débiles.

### Modal dark

```tsx
<div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
  <div className="w-full max-w-xl rounded-[28px] border border-white/10 bg-[#140D35]/95 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
    ...
  </div>
</div>
```

### Modal light

```tsx
<div className="fixed inset-0 z-50 grid place-items-center bg-[#100A2E]/30 p-4 backdrop-blur-sm">
  <div className="w-full max-w-xl rounded-[28px] border border-[#E3DDF5] bg-white p-6 shadow-[0_30px_90px_rgba(35,22,80,0.18)]">
    ...
  </div>
</div>
```

---

## 24. Estados visuales

### Éxito

```txt
Color       #42D392
Background  rgba(66, 211, 146, 0.12)
Border      rgba(66, 211, 146, 0.22)
```

### Advertencia

```txt
Color       #FFD21F
Background  rgba(255, 210, 31, 0.12)
Border      rgba(255, 210, 31, 0.24)
```

### Error

```txt
Color       #FF4B4B
Background  rgba(255, 75, 75, 0.12)
Border      rgba(255, 75, 75, 0.24)
```

### Info

```txt
Color       #B8AEDC
Background  rgba(184, 174, 220, 0.10)
Border      rgba(184, 174, 220, 0.18)
```

### Reglas

- El rojo solo debe usarse para errores reales.
- El amarillo/naranja puede indicar atención, proceso o valor.
- El verde solo debe indicar éxito, validación o sincronización correcta.
- No usar demasiados estados en una sola vista.

---

## 25. Iconografía

Usar iconografía lineal, moderna y técnica.

Librerías recomendadas:

- Lucide React.
- Heroicons.
- Phosphor Icons.

Estilo:

- Stroke 1.75 a 2.
- Bordes redondeados.
- Sin relleno pesado.
- Simple.
- Legible.
- No infantil.

Uso de color:

- Naranja para acción.
- Amarillo para destacado.
- Violeta claro para neutro.
- Verde para éxito.
- Rojo para error.

Ejemplo:

```tsx
import { ShieldCheck, Zap, Database, Code2 } from "lucide-react";
```

---

## 26. Atmósfera visual

El fondo puede tener recursos decorativos sutiles.

Permitido:

- Puntos tipo grid técnico.
- Gradientes radiales.
- Brillos desenfocados.
- Líneas diagonales de baja opacidad.
- Noise muy leve.
- Efectos glass.
- Halo naranja/violeta controlado.

No permitido:

- Fondos con ruido excesivo.
- Grid demasiado marcado.
- Decoración que compita con los datos.
- Animaciones constantes en el fondo.
- Efectos 3D sobre toda la interfaz.

Ejemplo de grid técnico:

```tsx
<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:32px_32px] opacity-25" />
```

---

## 27. Animaciones

Las animaciones deben ser sobrias y funcionales.

Permitido:

- Fade in.
- Slide up suave.
- Scale mínimo en botones.
- Glow al enfocar.
- Skeleton loading.
- Transición de hover.
- Indicador de sincronización.

Duraciones:

```txt
Rápida       120ms
Normal       180ms
Media        240ms
Larga        320ms
```

Easing:

```css
ease-out
ease-in-out
cubic-bezier(0.22, 1, 0.36, 1)
```

No usar:

- Rebotes exagerados.
- Efectos tipo cartoon.
- Animaciones infinitas innecesarias.
- Transiciones lentas en acciones operativas.

Ejemplo:

```tsx
<div className="transition duration-200 ease-out hover:-translate-y-0.5 hover:border-[#FF6A1A]/30">
  ...
</div>
```

---

## 28. Landing page

La landing debe vender confianza, no humo.

### Estructura recomendada

```txt
Hero
├── Logo
├── Badge corto
├── Headline
├── Bajada
├── CTA principal
├── CTA secundaria
└── Preview de dashboard

Servicios
├── Desarrollo a medida
├── Integraciones
├── Seguridad
├── Automatización
├── Dashboards
└── Sistemas internos

Proceso
├── Detectamos
├── Diseñamos
├── Implementamos
└── Protegemos

Casos de uso
├── POS
├── Stock
├── Ventas
├── APIs
├── Reportes
└── Operación

Cierre
├── Mensaje fuerte
└── Contacto
```

### Headline sugerido

```txt
Software seguro para negocios inteligentes.
```

### Bajada sugerida

```txt
Diseñamos sistemas a medida para automatizar procesos, proteger operaciones y conectar datos reales de negocio.
```

### CTAs

```txt
Empezar proyecto
Ver soluciones
Hablar con el equipo
```

---

## 29. Dashboard

El dashboard debe sentirse como un centro de control.

Debe incluir:

- Métricas principales.
- Estado operativo.
- Alertas.
- Accesos rápidos.
- Últimas sincronizaciones.
- Actividad reciente.
- Gráficos simples.
- Información clara.

### Card métrica

```tsx
<div className="rounded-[28px] border border-white/10 bg-white/[0.055] p-6 shadow-xl shadow-black/20 backdrop-blur-xl">
  <div className="flex items-center justify-between">
    <p className="text-sm font-medium text-white/55">Ventas hoy</p>
    <span className="rounded-full bg-[#FF6A1A]/10 px-2.5 py-1 text-xs font-semibold text-[#FFD21F]">
      Live
    </span>
  </div>

  <h3 className="mt-4 text-4xl font-black tracking-tight text-white">
    $842.300
  </h3>

  <p className="mt-3 text-sm text-emerald-300">
    +12.4% vs ayer
  </p>
</div>
```

---

## 30. POS

Si NinjaSoft se aplica a un POS, la estética no puede entorpecer la operación.

### Prioridades

1. Velocidad.
2. Claridad.
3. Total siempre visible.
4. Producto y cantidad fáciles de editar.
5. Medios de pago claros.
6. Estado de caja visible.
7. Confirmaciones seguras.
8. Errores imposibles de ignorar.
9. Diseño cómodo para muchas horas de uso.

### Layout recomendado

```txt
POS Screen
├── Header
│   ├── Caja
│   ├── Usuario
│   ├── Sucursal
│   └── Estado sync
├── Product Search
├── Product Grid / Scanner Input
├── Cart
├── Totals
└── Payment Actions
```

### Reglas

- El total debe ser el elemento de mayor jerarquía.
- Los botones de pago deben ser grandes.
- El carrito debe ser escaneable.
- Las acciones destructivas deben estar separadas.
- No usar decoración innecesaria.
- El color debe ayudar a operar, no distraer.

---

## 31. Formularios

Los formularios deben ser claros, compactos y seguros.

### Reglas

- Agrupar por secciones.
- Mostrar ayuda cuando sea necesario.
- Indicar campos obligatorios sin exagerar.
- Validar visualmente.
- No ocultar errores.
- Botón principal al final.
- Evitar formularios eternos sin pasos.

### Error de campo dark

```tsx
<p className="mt-2 text-sm text-red-300">
  Este campo es obligatorio.
</p>
```

### Error de campo light

```tsx
<p className="mt-2 text-sm text-red-600">
  Este campo es obligatorio.
</p>
```

---

## 32. Empty states

Los estados vacíos deben ser útiles.

Ejemplo:

```txt
Todavía no hay ventas registradas.
Cuando sincronices tu primera operación, la vas a ver acá.
```

No usar:

```txt
Oops! Nada por aquí.
```

Debe mantenerse el tono profesional.

---

## 33. Loading states

Usar skeletons y estados claros.

### Skeleton dark

```tsx
<div className="animate-pulse rounded-2xl bg-white/[0.06]" />
```

### Spinner de marca

Cuando se use spinner, puede tener acento naranja/amarillo.

```tsx
<div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-[#FF6A1A]" />
```

Texto recomendado:

```txt
Sincronizando datos...
Preparando información...
Cargando operación...
```

---

## 34. Toasts

Los toasts deben ser discretos pero claros.

### Toast success dark

```tsx
<div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200 shadow-xl backdrop-blur-xl">
  Sincronización completada.
</div>
```

### Toast error dark

```tsx
<div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200 shadow-xl backdrop-blur-xl">
  No pudimos completar la operación.
</div>
```

---

## 35. Copywriting

El tono debe ser:

- Directo.
- Claro.
- Seguro.
- Cercano.
- Sin exageración.
- Sin humo.
- Sin promesas vacías.

### Ejemplos correctos

```txt
Detectamos el problema.
Diseñamos la solución.
Protegemos el camino con tecnología confiable.
Listo para sincronizar.
Revisá los datos antes de continuar.
Tu operación está protegida.
La venta fue registrada correctamente.
No se pudo conectar con el servidor.
```

### Ejemplos incorrectos

```txt
¡La mejor plataforma del mundo!
Revolucionamos tu negocio con IA disruptiva.
Solución mágica para todo.
Oopsie, algo salió mal.
Confía en nosotros porque somos increíbles.
```

---

## 36. Accesibilidad

La estética no debe romper la accesibilidad.

Reglas:

- Contraste alto entre texto y fondo.
- No depender solo del color para estados.
- Focus visible en inputs y botones.
- Botones con área táctil cómoda.
- Textos mínimos de 13px en desktop y 14px en mobile.
- Labels siempre claros.
- Iconos acompañados por texto cuando la acción no sea obvia.

Focus recomendado:

```tsx
className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A1A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09051C]"
```

---

## 37. Mobile first

El diseño debe funcionar perfecto en mobile.

Reglas:

- Cards apiladas.
- Botones grandes.
- Espaciado generoso.
- Evitar tablas horizontales.
- Usar drawers o bottom sheets.
- Menús compactos.
- Total visible en POS.
- Acciones primarias al alcance del pulgar.
- No esconder estados críticos.

---

## 38. Dark mode limpio para Tailwind

Cuando se implemente una pantalla sin necesidad de mucha marca, usar una estética dark limpia:

```tsx
<div className="min-h-screen bg-zinc-950 text-zinc-50">
  <div className="mx-auto max-w-7xl px-4 py-8">
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-xl shadow-black/20">
      ...
    </div>
  </div>
</div>
```

Pero siempre agregar algún acento NinjaSoft:

```tsx
<span className="text-[#FF6A1A]">Seguro</span>
```

o

```tsx
<div className="h-1 w-16 rounded-full bg-gradient-to-r from-[#FF4B22] to-[#FFD21F]" />
```

---

## 39. Light mode limpio para Tailwind

Cuando se implemente una pantalla clara:

```tsx
<div className="min-h-screen bg-[#F8F7FF] text-[#161026]">
  <div className="mx-auto max-w-7xl px-4 py-8">
    <div className="rounded-2xl border border-[#E3DDF5] bg-white p-6 shadow-xl shadow-violet-950/5">
      ...
    </div>
  </div>
</div>
```

Mantener acentos de marca con moderación.

---

## 40. Ejemplo de App Shell con tema

```tsx
type ThemeName = "ninja-dark" | "ninja-light";

export function AppShell({
  theme = "ninja-dark",
  children
}: {
  theme?: ThemeName;
  children: React.ReactNode;
}) {
  const isDark = theme === "ninja-dark";

  return (
    <div
      data-theme={theme}
      className={
        isDark
          ? "min-h-screen bg-[radial-gradient(circle_at_18%_18%,rgba(255,75,34,0.16),transparent_30%),radial-gradient(circle_at_82%_12%,rgba(95,58,214,0.24),transparent_34%),linear-gradient(135deg,#09051C_0%,#100A2E_48%,#21135A_100%)] text-[#F7F7FF]"
          : "min-h-screen bg-[radial-gradient(circle_at_15%_10%,rgba(255,106,26,0.10),transparent_28%),radial-gradient(circle_at_85%_0%,rgba(74,45,163,0.12),transparent_32%),linear-gradient(135deg,#F8F7FF_0%,#F1EEFF_52%,#FFFFFF_100%)] text-[#161026]"
      }
    >
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:32px_32px] opacity-20" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
```

---

## 41. Ejemplo de componente ThemeToggle

```tsx
import { Moon, Sun } from "lucide-react";

type ThemeName = "ninja-dark" | "ninja-light";

export function ThemeToggle({
  theme,
  setTheme
}: {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
}) {
  const isDark = theme === "ninja-dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "ninja-light" : "ninja-dark")}
      className={
        isDark
          ? "inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/[0.10]"
          : "inline-flex items-center gap-2 rounded-2xl border border-[#E3DDF5] bg-white px-4 py-2 text-sm font-semibold text-[#21135A] shadow-sm transition hover:bg-[#F6F3FF]"
      }
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
      {isDark ? "Light" : "Dark"}
    </button>
  );
}
```

---

## 42. Reglas para Claude / agentes

Cuando un agente genere código para NinjaSoft, debe cumplir estas reglas:

1. Usar Tailwind CSS.
2. Priorizar componentes responsive.
3. Usar tema `ninja-dark` por defecto.
4. Soportar `ninja-light` cuando la pantalla lo requiera.
5. Usar fondos violetas profundos en dark.
6. Usar acentos naranja/amarillo con moderación.
7. Usar cards con bordes redondeados y glass sutil.
8. Usar Inter para UI, Nunito para títulos y JetBrains Mono para textos técnicos.
9. No usar estilos genéricos sin identidad.
10. No usar colores aleatorios fuera de la paleta.
11. No saturar con glow.
12. No crear componentes visualmente ruidosos.
13. Priorizar claridad operativa.
14. Generar código completo, no fragmentos sueltos, salvo que se pida lo contrario.
15. Mantener una estética premium, segura y tecnológica.

---

## 43. Prompt interno para generar pantallas

Usar este prompt como referencia al pedir nuevas pantallas:

```txt
Diseñá una interfaz para NinjaSoft usando Tailwind CSS, con estética dark premium, fondo violeta profundo, cards glassmorphism sutiles, acentos naranja fuego y amarillo dorado. La interfaz debe sentirse segura, moderna, precisa y corporativa. Usar Nunito para títulos, Inter para UI y JetBrains Mono para elementos técnicos. Priorizar claridad operativa, responsive design, espaciado generoso, bordes redondeados y microinteracciones suaves. Evitar saturación visual, sombras pesadas, colores genéricos y decoración innecesaria. El tema principal es ninja-dark, pero la estructura debe poder adaptarse a ninja-light.
```

---

## 44. Checklist visual antes de aprobar una pantalla

Antes de considerar una pantalla terminada, verificar:

- ¿Se siente NinjaSoft?
- ¿Tiene fondo o estructura coherente con la marca?
- ¿Usa acentos naranja/amarillo con criterio?
- ¿La jerarquía visual es clara?
- ¿Se lee bien en dark?
- ¿Existe una adaptación viable a light?
- ¿Los botones principales destacan correctamente?
- ¿Los errores son visibles?
- ¿Las cards tienen buena separación?
- ¿La pantalla funciona en mobile?
- ¿No parece una plantilla genérica?
- ¿No está sobrecargada de glow?
- ¿La interfaz transmite seguridad?
- ¿La operación principal se entiende en menos de 5 segundos?

---

## 45. Dirección final

NinjaSoft debe verse como una marca capaz de construir software serio, seguro y a medida.

La estética debe hacer sentir que detrás del sistema hay criterio técnico, precisión y cuidado por el detalle.

El producto debe ser visualmente atractivo, pero nunca a costa de la claridad.

La interfaz ideal de NinjaSoft:

- Ordena.
- Protege.
- Acelera.
- Informa.
- Genera confianza.
- Se siente premium.
- Funciona en operación real.

Fin del documento.