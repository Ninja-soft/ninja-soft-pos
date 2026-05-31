# Control de diseño y estructura

Documento de referencia para revisar que cada pantalla, flujo y módulo mantenga una estructura robusta, consistente y usable antes de mergear o cerrar un hito.

## 1. Principio

NinjaSoft no debe crecer como una suma de pantallas sueltas. Cada feature nueva debe respetar arquitectura visual, jerarquía de información, sistema de componentes, accesibilidad, responsive, estados y navegación. Si una pantalla funciona pero se siente improvisada, no está terminada.

## 2. Gate obligatorio

Aplica a toda PR que toque UI, navegación, formularios, tablas, dashboards, POS, internal, configuración, reportes o pantallas públicas.

- [ ] Usa componentes existentes de `components/ui/`, `components/layout/` o módulo correspondiente.
- [ ] No crea UI ad-hoc si el patrón ya existe.
- [ ] Respeta tokens de color, tipografía, espaciado, radius y sombras.
- [ ] Tiene estructura clara: header, acciones, contenido, estados y navegación.
- [ ] Funciona en mobile 375px, tablet 768px, desktop 1280px y desktop ancho.
- [ ] No hay overflow horizontal inesperado.
- [ ] No hay textos cortados, botones desbordados ni cards deformadas.
- [ ] Tiene loading, empty, error, success y disabled states.
- [ ] Tiene foco visible y navegación por teclado.
- [ ] No depende solo del color para comunicar estado.
- [ ] Tiene copy claro y accionable.
- [ ] Cumple contraste AA.
- [ ] No introduce paletas, gradientes o estilos fuera del sistema.

## 3. Estructura de pantalla

Cada pantalla operativa debe tener:

- [ ] Título claro.
- [ ] Contexto breve si el usuario necesita orientarse.
- [ ] Acción primaria visible y única.
- [ ] Acciones secundarias agrupadas.
- [ ] Filtros y búsqueda persistentes cuando hay listas.
- [ ] Estado vacío con próxima acción.
- [ ] Estado de error con retry o salida clara.
- [ ] Feedback posterior a mutaciones.
- [ ] Confirmación para acciones destructivas.
- [ ] Breadcrumb o forma clara de volver cuando hay profundidad.

Pantallas densas como POS/internal/reportes deben priorizar escaneo: tablas, columnas, KPIs, filtros y acciones compactas. No usar composición de landing ni cards decorativas.

## 4. Layouts permitidos

- [ ] **POS:** layout táctil, rápido, con carrito persistente y acciones de cobro siempre visibles.
- [ ] **Admin tenant:** shell con navegación lateral/superior, contenido por secciones y formularios claros.
- [ ] **Internal:** consola densa, buscador global, tablas, filtros, timeline y acciones auditables.
- [ ] **Reportes:** KPIs arriba, filtros persistentes, tabla/gráfico/export abajo.
- [ ] **Configuración:** grupos lógicos, switches/inputs con ayuda breve, guardar/cancelar claro.
- [ ] **Mobile:** una columna, acciones sticky cuando el flujo lo requiera, targets táctiles de 44px mínimo.

## 5. Componentes y reutilización

Antes de crear un componente:

1. Buscar si existe en `components/ui/`.
2. Buscar patrón similar en `components/shared/`, `components/pos/`, `components/admin/` o `modules/*/components`.
3. Si es genérico, crear o extender primitive.
4. Si es de dominio, ubicarlo dentro del módulo.
5. Documentar variante nueva si afecta al sistema visual.

Prohibido:

- [ ] Hex sueltos en JSX/CSS.
- [ ] Medidas arbitrarias sin justificación.
- [ ] Duplicar botones, inputs, badges, modales o tablas.
- [ ] Cards dentro de cards salvo caso justificado.
- [ ] Usar texto como reemplazo de íconos estándar cuando corresponde un icon button.
- [ ] Ocultar errores o loaders para "simplificar".

## 6. Control responsive

Viewports mínimos a revisar:

- [ ] 375x667 mobile.
- [ ] 768x1024 tablet.
- [ ] 1024x768 tablet horizontal/POS.
- [ ] 1280x720 desktop.
- [ ] 1440x900 desktop.

Checklist:

- [ ] Sidebar/header no tapa contenido.
- [ ] Modales caben o scrollean internamente.
- [ ] Tablas tienen estrategia responsive: columnas prioritarias, scroll controlado o cards.
- [ ] Botones largos hacen wrap o usan label corto.
- [ ] Formularios no quedan en columnas imposibles.
- [ ] Elementos sticky no tapan acciones finales.

## 7. Accesibilidad

- [ ] Labels asociados a inputs.
- [ ] `aria-label` en icon buttons.
- [ ] Orden de tabulación lógico.
- [ ] Escape cierra modal/drawer.
- [ ] Focus trap en modal.
- [ ] Mensajes de error asociados al campo.
- [ ] Contraste AA.
- [ ] Estados no dependen solo de color.
- [ ] Texto escalable hasta 200%.
- [ ] Respeta `prefers-reduced-motion`.

## 8. Control de estructura frontend

- [ ] La ruta vive en el grupo correcto: `(auth)`, `(app)`, `(public)`, `internal`.
- [ ] La lógica de dominio vive en `modules/<dominio>`.
- [ ] Schemas Zod compartidos entre UI y mutación.
- [ ] Mutaciones sensibles pasan por Edge Function/RPC auditada.
- [ ] Hooks no mezclan demasiadas responsabilidades.
- [ ] Componentes grandes se separan antes de superar 300 líneas.
- [ ] Estados de servidor usan TanStack Query.
- [ ] Estado local complejo usa hook o store dedicado.
- [ ] No se accede a `service_role` ni secretos desde frontend.

## 9. Control visual por tipo de pantalla

### POS

- [ ] Acción "Cobrar" siempre clara.
- [ ] Total siempre visible.
- [ ] Carrito no salta de tamaño al cambiar cantidades.
- [ ] Teclado/scanner no pierde foco.
- [ ] Touch targets grandes.
- [ ] Error de venta no borra carrito.

### Internal

- [ ] Tablas densas pero legibles.
- [ ] Motivo visible en acciones sensibles.
- [ ] Audit trail cerca de cambios críticos.
- [ ] Estados comerciales claros: trial, active, past_due, suspended, cancelled.
- [ ] Acciones peligrosas separadas de acciones frecuentes.

### Configuración

- [ ] Agrupación por dominio.
- [ ] Switches para booleanos.
- [ ] Inputs numéricos con unidad visible.
- [ ] Preview cuando afecta ticket, impresión, email o branding.
- [ ] Guardado explícito o autosave claramente indicado.

### Reportes

- [ ] Filtros visibles.
- [ ] Rango de fechas claro.
- [ ] KPIs con definición obvia.
- [ ] Export disponible si el reporte se usa para gestión.
- [ ] Empty state distingue "sin datos" de "filtro sin resultados".

## 10. Evidencia requerida

Para cerrar una PR con UI:

- [ ] Captura desktop.
- [ ] Captura mobile si la pantalla se usa en mobile.
- [ ] Nota de estados revisados: loading/empty/error.
- [ ] Confirmación de navegación por teclado para formularios/modales.
- [ ] Si toca POS/internal, breve demo o descripción del flujo crítico.

## 11. Criterios de rechazo

Una PR vuelve al autor si:

- [ ] Rompe responsive.
- [ ] Introduce componentes duplicados.
- [ ] Usa estilos fuera del sistema sin justificación.
- [ ] No tiene estados de carga/error/vacío.
- [ ] Tiene acciones destructivas sin confirmación.
- [ ] Mezcla lógica de dominio dentro de componentes visuales grandes.
- [ ] Hace una mutación crítica directo desde frontend.
- [ ] No actualiza docs/ADR cuando agrega patrón estructural nuevo.
