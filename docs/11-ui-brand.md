# UI & Brand — NinjaSoft POS

Resumen ejecutivo del sistema visual. La especificación completa y autoritativa vive en `UI-NinjaSof.md` en la raíz del repositorio. Este documento sintetiza lo crítico para que cualquier agente o dev construya UI alineada con la marca.

> **Regla maestra.** Cuando este documento y `UI-NinjaSof.md` difieran, manda `UI-NinjaSof.md`.

## 1. Filosofía visual

**"Software seguro para negocios inteligentes."**

- Oscuro por default. La luz se reserva para excepciones (impresos, emails).
- Violeta profundo como base. Naranja/dorado como acentos de acción.
- Profesional pero cercano. Tecnológico sin ser frío.
- La tecnología no se ve: se siente. La UI desaparece cuando funciona.

## 2. Paleta

### 2.1 Primarios

| Token | Hex | Uso |
|---|---|---|
| `void-violet` | `#120A2E` | Fondo base (dark). |
| `mid-violet` | `#3B237A` | Fondo intermedio, cards, surfaces. |
| `flame` | `#FF4B22` | Acento principal, CTAs, focus. |
| `gold` | `#FFD21F` | Highlight, estados positivos puntuales. |

### 2.2 Neutros

| Token | Hex | Uso |
|---|---|---|
| `soft-white` | `#F7F4FF` | Fondo light, texto sobre dark. |
| `lavender-mist` | `#B8AED6` | Texto secundario sobre dark. |
| `slate-mist` | `#8A7FB5` | Texto deshabilitado. |
| `shadow` | `#2A1B5C` | Bordes, dividers sobre dark. |
| `pure-void` | `#0A0420` | Sombras profundas. |

### 2.3 Proporción de uso

`violet 60% · mid 20% · flame 12% · gold 5% · white 3%`

Si una pantalla tiene demasiado naranja, está mal balanceada.

### 2.4 Estados semánticos

| Estado | Color base | Token Tailwind |
|---|---|---|
| Success | Verde esmeralda | `success` |
| Warning | Naranja ámbar (no flame) | `warning` |
| Error | Rojo (no flame) | `error` |
| Info | Azul violeta | `info` |

`flame` **no** es color de error ni de warning. Es el color de acción primaria.

## 3. Tipografía

| Familia | Uso | Pesos |
|---|---|---|
| **Nunito** | Display, headings, logotipo | 300, 400, 600, 700, 900 |
| **Inter** | Body, UI, formularios | 300, 400, 500, 600, 700 |
| **JetBrains Mono** | Código, números técnicos, metadatos | 400, 500 |

### 3.1 Escala (modular 1.250)

| Nivel | Tamaño | Familia | Peso |
|---|---|---|---|
| Display | 72px | Nunito | 900 |
| H1 | 56px | Nunito | 800 |
| H2 | 42px | Nunito | 700 |
| H3 | 28px | Nunito | 700 |
| Subtitle | 20px | Inter | 500 |
| Body L | 16px | Inter | 400 |
| Body | 14px | Inter | 400 |
| Caption | 12px | Inter | 500 |
| Eyebrow | 11px | JetBrains Mono | 500 (UPPERCASE) |

En el POS, el tamaño base sube a 16px (Body L como body) para legibilidad rápida.

## 4. Temas

### 4.1 ninja-dark (default)

Aplicado a todo el producto operativo (POS, admin, internal). Fondo `void-violet`, surfaces `mid-violet`, texto `soft-white`.

### 4.2 ninja-light

Para landing pública, impresos, emails. Fondo `soft-white`, surfaces blanco puro, texto `void-violet`.

### 4.3 Switch
El cliente puede elegir tema en su admin si el flag `dark_mode_only` está `false` (default).

## 5. Componentes — inventario crítico

Lista de primitives obligatorios en `components/ui/`:

| Componente | Variantes | Notas |
|---|---|---|
| Button | primary, secondary, outline, ghost, danger | + sizes sm/md/lg |
| IconButton | mismas que Button | square, focusable |
| Input | default, error, disabled | con label, helper, error |
| Textarea | igual | auto-resize opcional |
| Select | nativo y custom (Radix) | searchable opcional |
| Checkbox / Switch | | accesible |
| RadioGroup | | accesible |
| Card | default, elevated, interactive | radius 12px |
| Badge | default, success, warning, error, info | con dot opcional |
| Tag | filled, outline | dismissible opcional |
| Avatar | initials, image | sizes sm/md/lg |
| Tooltip | | Radix, delay 300ms |
| Dialog / Modal | | Radix, focus trap |
| Sheet / Drawer | side: left/right/bottom | Radix |
| Popover | | Radix |
| DropdownMenu | | Radix |
| Toast | default, success, warning, error | sonner-like |
| Tabs | | Radix |
| Accordion | | Radix |
| Progress | linear, circular | con label opcional |
| Skeleton | | con shimmer |
| Table | sortable, paginated | base para DataTable |
| DataTable | | con filtros, paginación, selección |
| EmptyState | | ícono + título + descripción + CTA |
| ErrorState | | con retry |
| PageHeader | | título + breadcrumb + acciones |
| Sidebar | collapsible | sticky |
| Topbar | | con search + perfil |

### 5.1 Radio de badges, pastillas y chips

**Badges, pastillas de estado, chips/etiquetas (incluidos los chips de filtro o selección rápida) y contadores usan radio chico: `rounded-md` (~6 px).** Nunca `rounded-full` ni radios grandes tipo pill (`rounded-xl`/`2xl`). El primitive `Badge` ya lo aplica; las pastillas inline siguen la misma regla.

Siguen redondos (`rounded-full`) a propósito: avatares, puntos de estado (dots), botones circulares de sólo ícono, switches, spinners, radios/checks circulares, círculos numerados de pasos, barras de progreso y elementos decorativos circulares. Las pastillas dentro de comprobantes impresos (`components/invoices`, `components/tickets`) dependen de la opción de bordes de la factura.

## 6. Iconografía

- **Stroke:** 1.5px constante. Sin rellenos sólidos.
- **Grid:** 24×24px.
- **Radius:** 2px en esquinas.
- **Librería sugerida:** Lucide React (icons consistentes con el sistema).

Iconos personalizados de NinjaSoft: solo cuando ningún ícono de Lucide encaja. Se guardan en `components/icons/`.

## 7. Espaciado y radius

| Token | Valor | Uso |
|---|---|---|
| `space-1` | 4px | Espacios mínimos |
| `space-2` | 8px | Entre íconos y texto |
| `space-3` | 12px | Padding small |
| `space-4` | 16px | Padding default |
| `space-6` | 24px | Entre cards |
| `space-8` | 32px | Entre secciones |
| `space-12` | 48px | Page padding |
| `space-16` | 64px | Hero sections |

| Radius | Valor |
|---|---|
| `radius-sm` | 6px |
| `radius-md` | 10px |
| `radius-lg` | 12px (default cards) |
| `radius-xl` | 16px |
| `radius-full` | 9999px |

## 8. Sombras y elevación

**Nunca bordes de color al costado** (`border-l-*` de color en tarjetas, filas o avisos): quedan poco profesionales. Si hace falta marcar estado o color, usar una franja arriba (`border-t-2` con el color) y las esquinas de arriba rectas (`rounded-t-none`), o un punto de color.

Sin sombras paralelas, glow ni degradados decorativos (dirección 2026-10). La elevación se resuelve con:
- Borde de 1px del tema (`border-border`).
- Cambio de relleno (`bg-card` sobre `bg-background`, `bg-muted` para zonas internas).
- Acento sólido (`--pos-solid`, texto blanco) para el CTA y los indicadores activos (switch, check, progreso). Nunca `bg-ninja-gradient`, `shadow-ninjaGlow` ni texto en degradado.

`--shadow-soft`, `--choice-shadow` y `--seg-thumb-shadow` quedan en "sin sombra" (en claro el pulgar del segmentado lleva un borde de 1px). Radios: `rounded-md`/`rounded-lg` en cards, campos y botones; `rounded-xl` sólo en hojas y diálogos; nada de `rounded-2xl`/`3xl`. Excepciones: el patrón de fondo y el resalte de precios que elige el usuario en Apariencia, la protección de texto sobre fotos (Tiendita) y la animación de bienvenida de Tiendita.

## 9. Estados interactivos

| Estado | Cambio visual |
|---|---|
| Hover | Cambio de luminosidad 10-15% del color base. |
| Focus visible | Ring 2px `flame` con offset 2px. |
| Active | Cambio de luminosidad 20% + leve scale (0.98). |
| Disabled | Opacity 50% + cursor `not-allowed`. |
| Loading | Spinner o skeleton, mantener layout. |

## 10. Mobile first

- Breakpoints estándar Tailwind (sm 640, md 768, lg 1024, xl 1280).
- POS optimizado para tablet horizontal (1024px+) pero usable en móvil.
- Admin diseñado mobile-first.
- Targets táctiles mínimo 44×44px.

## 11. Animación

- **Duración:** corta (150-250ms). Operativa, no decorativa.
- **Easing:** `ease-out` para entradas, `ease-in` para salidas.
- **No animar:** color de texto, ancho, alto (excepto en colapsables).
- **Sí animar:** opacidad, transform, background-color.
- **Respetar** `prefers-reduced-motion`.
- **Arrastrar y soltar:** el lugar donde cae lo arrastrado se marca con `.nav-drop-placeholder` (borde punteado animado en `--muted-foreground` sobre `--muted`, sin degradados ni sombras); lo arrastrado sigue al puntero con `scale(1.03)` y los vecinos se corren con `transform` (ADR-134).

## 12. Tono de voz en UI

| Característica | Cómo |
|---|---|
| Directo | "Eliminar producto" en lugar de "¿Estás seguro que deseas eliminar este producto?" |
| Claro | "Sin conexión a internet" en lugar de "Network request failed". |
| Seguro | "Guardado." en lugar de "¡Guardado exitosamente!". |
| Cercano | "Falta un poco" en lugar de "Quedan 2 ítems requeridos". |

### 12.1 Microcopy básico

| Acción | Bien | Mal |
|---|---|---|
| CTA primaria | "Cobrar", "Guardar", "Agregar" | "Click aquí", "OK" |
| Confirmación destructiva | "Eliminar definitivamente" | "Confirmar" |
| Empty state | "Acá vas a ver tus ventas." | "No hay datos." |
| Error de red | "No pudimos conectarnos." | "Error 500." |
| Cargando | "Procesando venta..." | "Loading..." |

## 13. Accesibilidad

- Contraste mínimo AA. Verificar con herramientas (no de memoria).
- Foco visible siempre.
- Sin información transmitida solo por color.
- Texto escalable hasta 200% sin romper layout.
- Navegación completa por teclado.
- Atajos documentados y visibles.

## 14. Recursos

- Logos: `public/brand/` (PNG, SVG, en variantes dark/light).
- Mockups de referencia: ver `NinjaSoft_BrandBook.pdf`.
- Sistema completo: `UI-NinjaSof.md`.
- Figma: enlace en `CLAUDE.md` cuando esté disponible.

## 15. Para agentes que generan UI

Antes de escribir un componente:

1. Verificar si existe en `components/ui/`. Si existe, reusar.
2. Si no existe, primero consultar el inventario en este doc.
3. Si tampoco está en el inventario, proponer la adición en un PR separado con el agente `ui-designer`.
4. **No crear componentes UI ad-hoc** dentro de features. Promover al sistema.

## 16. Control de diseño y estructura

Toda pantalla nueva o modificada debe pasar el gate de [`26-design-structure-control.md`](./26-design-structure-control.md).

Mínimo obligatorio:

- [ ] Jerarquía visual clara.
- [ ] Componentes del sistema reutilizados.
- [ ] Estados loading/empty/error/success.
- [ ] Responsive validado.
- [ ] Accesibilidad básica validada.
- [ ] Sin estilos fuera de tokens.
- [ ] Sin duplicación de patrones existentes.

Si el cambio afecta POS, internal, reportes o configuración, el control es bloqueante para cerrar el hito.

## 17. Primitivos de orden visual (2026-10)

| Necesito… | Uso |
|---|---|
| Encabezado de pantalla | `PageHeader` (eyebrow, título, ícono del menú, ayuda, bajada, acciones) dentro de `PageContainer`. |
| Título de bloque | `SectionHeader`. |
| Lista o tabla vacía | `EmptyState` (ícono + título + bajada + CTA; `compact` en cards/modales/tablas). |
| Cargando | `Spinner` / `SpinnerBlock` / `TableStateRow loading`. Nunca texto "Cargando…". |
| Aviso | `Callout` (relleno tonal). |
| Estado | `Badge` (relleno tonal). |
| Opciones excluyentes | `Segmented` (cortas) o `ChoiceCard` / `choiceClass` + `ChoiceDot` (con bajada). |
| Tabla | `TableWrap` (scroll horizontal dentro de la card) + `TableStateRow`. |
| App de terceros | `IntegrationLogo` con el logo oficial (`public/images/integrations/<app>.webp`). |
| Modal | `Modal` con `footer` para las acciones (hoja inferior en mobile). |

Reglas: lo seleccionado se marca con **relleno neutro elevado** (`choiceClass` o las clases `choice-on` + `choice-check`: relleno tonal del tema, texto de primer plano e insignia de check con el fuego Ninja en la esquina; `choice-on` solo para pastillas compactas o cuando ya hay `ChoiceDot`), nunca con borde o ring de color ni tinte marrón de flame; sin `—` en la UI (`<NoData />`); sin `alert`/`confirm` del navegador (`ConfirmDialog` o confirmación inline).

Hoja de cobro (ADR-042): tiles y botones `rounded-lg`, la hoja `rounded-xl`; el CTA es el mismo `POS_CTA` sólido de §18 (`--pos-solid`, texto blanco), montos en `text-foreground` (nada de `price-hl` ni texto en degradado); logos de medios con su fondo transparente vía `TenderLogo` → `ThemedLogo` y de tarjetas vía `CardBrandLogo` (fuente única `lib/payments/logos.ts`, variante `-on-dark` en temas oscuros, sin placa blanca); las marcas con varios canales, también en "Billeteras y links", van en una fila con canales segmentados. Miniaturas de diseño: wireframes en tonos del tema (`bg-foreground/[x]`) con un solo acento mínimo para el botón de cobro.

## 18. Pantallas del POS (2026-10)

Tokens en `components/pos/ui/posStyles.ts`; mismo lenguaje que el resto de la app.

| Pieza | Regla |
|---|---|
| Radios | `rounded-md` chips, pastillas y steppers; `rounded-lg` botones, campos, tiles y líneas; `rounded-xl` paneles y hojas. Nada de `rounded-2xl`/`3xl`. |
| Superficies | `POS_PANEL` (paneles) y `POS_TILE` (tiles): `bg-card` + borde sutil del tema. Sin degradados decorativos ni sombras pesadas. |
| CTA | `POS_CTA` sólo para Cobrar: relleno sólido del acento con texto blanco AA (`--pos-solid` / `--pos-on`). Acciones secundarias con `POS_QUIET`. |
| Selección | Rubros y áreas en riel segmentado (`POS_SEG_*`, como `Segmented`); filas y mesas con `choice-on`. Nunca relleno invertido ni tinte de flame. |
| Productos | Precios `font-price` + `tabular-nums`, peso `semibold`. Boutique: foto 4:5 `object-cover`, diferida y con tamaño; sin foto, iniciales sobre relleno neutro. Stock bajo / sin stock como pastilla tonal. |
| Teclas rápidas | Tile neutro; el color elegido es una barrita de acento (`QUICK_KEY_DOT`). |
| Mesas | Tile neutro, estado como punto + texto. |
| Logos | Fuente única `lib/payments/logos.ts`: isotipos y logos de tarjeta de fondo transparente, sin placa blanca, con variante `-on-dark` en temas oscuros (`BrandIcon` / `TenderLogo` → `ThemedLogo`, `CardBrandLogo`). |
| Táctil | Controles de 44px en la barra superior; steppers y acciones de línea crecen a 44px con `pointer: coarse`. Foco visible de 2px en todo el POS. |


## Logos oficiales

Los logos de Ninja POS, Ninja Soft, Ninja Food y Ninja Suite están en `public/brand/oficial/` (ver su README). `*-light` va sobre fondos oscuros y `*-dark` sobre claros. Son la única fuente válida: no usar wordmarks viejos de `public/brand/` para piezas nuevas.
