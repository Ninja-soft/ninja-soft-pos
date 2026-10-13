-- =============================================================================
-- 20261108300400_tours_sugerencias_semilla  (ADR-089 · F15 · H70, H74)
--
-- Contenido inicial, publicado (versión 1). Desde acá lo edita el staff en
-- /internal/onboarding sin deploy (cada publicación es una versión nueva).
-- tests/unit/onboardingTours.test.ts valida estos pasos con el esquema de
-- lib/onboarding/schema.ts y busca cada ancla en el TSX.
--
-- Tours:
--   * primer-cobro: todo rubro, dueño y encargado, mientras el negocio no
--     tenga su primera venta. Productos, medios de pago, caja, cobrar.
--   * heladeria-favoritos-sabores: rubro heladería, en la primera semana
--     (criterio H70): productos por tamaño como favoritos, sabores como
--     modificador, medios de pago y primer cobro.
-- Sugerencias: sin productos, caja cerrada, sin primera venta, trial por
-- vencer, venta fallida y bienvenida.
-- Anclas data-tour usadas: productos-nuevo, config-medios-pago, pos-caja,
-- pos-buscar, pos-favoritos, pos-cobrar (las valida un test contra el TSX).
-- =============================================================================

with src as (
  select *
    from (values
      ('primer-cobro',
       'Primer cobro',
       'Productos, medios de pago, caja y cobro: todo lo que hace falta para la primera venta.',
       'sin_primera_venta',
       50,
       '{"roles": ["owner", "manager"]}'::jsonb,
       $steps$[
  {"id": "bienvenida", "title": "Tu primer cobro", "body": "Te mostramos en cuatro pasos cómo dejar todo listo y cobrar tu primera venta. Podés salir con Esc y retomarlo desde Ayuda.", "placement": "modal"},
  {"id": "productos", "title": "Cargá un producto", "body": "Tocá Nuevo producto, poné nombre y precio y guardá. Si ya tenés productos, seguí con el próximo paso.", "placement": "spotlight", "anchor": "productos-nuevo", "route": "/productos", "advance": "click", "action": {"label": "Ir a Productos", "href": "/productos"}},
  {"id": "medios", "title": "Elegí cómo cobrás", "body": "Prendé los medios que usás: efectivo, transferencia, tarjeta en posnet o Mercado Pago.", "placement": "tooltip", "anchor": "config-medios-pago", "route": "/configuracion", "action": {"label": "Ir a Medios de pago", "href": "/configuracion?seccion=pagos"}},
  {"id": "caja", "title": "Abrí la caja", "body": "Tocá el estado de la caja y cargá el efectivo con el que arrancás. Sin caja abierta no se puede cobrar.", "placement": "spotlight", "anchor": "pos-caja", "route": "/pos", "advance": "click", "action": {"label": "Ir a Vender", "href": "/pos"}},
  {"id": "buscar", "title": "Agregá productos", "body": "Buscá por nombre o código, escaneá, o tocá un botón de la grilla.", "placement": "tooltip", "anchor": "pos-buscar", "route": "/pos"},
  {"id": "cobrar", "title": "Cobrá", "body": "Tocá Cobrar (o F12), elegí el medio y confirmá.", "placement": "spotlight", "anchor": "pos-cobrar", "route": "/pos", "advance": "click"},
  {"id": "listo", "title": "Listo", "body": "Ya sabés cobrar. En Ayuda y en la Escuela tenés guías para anular, devolver y cerrar la caja.", "placement": "modal"}
]$steps$::jsonb),
      ('heladeria-favoritos-sabores',
       'Heladería: favoritos y sabores',
       'Tamaños como botones favoritos, sabores como modificador, medios de pago y primer cobro.',
       'registro',
       60,
       '{"industries": ["heladeria"], "roles": ["owner", "manager"]}'::jsonb,
       $steps$[
  {"id": "bienvenida", "title": "Armemos tu heladería", "body": "Vamos por favoritos, sabores, medios de pago y el primer cobro. Son cinco minutos y podés salir con Esc.", "placement": "modal"},
  {"id": "favoritos", "title": "Tamaños como favoritos", "body": "Creá un producto por tamaño (cuarto, medio, kilo, cucurucho) y prendé Favorito: queda como botón grande en el POS.", "placement": "spotlight", "anchor": "productos-nuevo", "route": "/productos", "advance": "click", "action": {"label": "Ir a Productos", "href": "/productos"}},
  {"id": "sabores", "title": "Sabores sin un producto por sabor", "body": "Al editar cada tamaño, abrí Modificadores y usá el modelo Sabores: el cajero elige hasta 3 sabores al cobrar.", "placement": "modal", "route": "/productos"},
  {"id": "medios", "title": "Elegí cómo cobrás", "body": "Prendé efectivo, transferencia, posnet o Mercado Pago. En temporada alta el QR acelera la fila.", "placement": "tooltip", "anchor": "config-medios-pago", "route": "/configuracion", "action": {"label": "Ir a Medios de pago", "href": "/configuracion?seccion=pagos"}},
  {"id": "botones", "title": "Tus favoritos en el POS", "body": "Los tamaños marcados como favoritos aparecen arriba: un toque y van al carrito con sus sabores.", "placement": "tooltip", "anchor": "pos-favoritos", "route": "/pos", "action": {"label": "Ir a Vender", "href": "/pos"}},
  {"id": "caja", "title": "Abrí la caja", "body": "Tocá el estado de la caja y cargá el efectivo inicial.", "placement": "spotlight", "anchor": "pos-caja", "route": "/pos", "advance": "click"},
  {"id": "cobrar", "title": "Primer cobro", "body": "Tocá un tamaño, elegí los sabores y después Cobrar (o F12).", "placement": "spotlight", "anchor": "pos-cobrar", "route": "/pos", "advance": "click"},
  {"id": "listo", "title": "Tu heladería está lista", "body": "Ya podés vender. Cuando quieras repasar, lo encontrás en Ayuda.", "placement": "modal"}
]$steps$::jsonb)
    ) as v(key, title, description, trigger_event, priority, audience, steps)
),
ins as (
  insert into onboarding_tours (key, title, description, status, trigger_event, audience, priority, steps,
                                published_version, published_at, draft_updated_at)
  select key, title, description, 'published', trigger_event, audience, priority, steps,
         1, now(), now() - interval '1 second'
    from src
  on conflict (key) do nothing
  returning id, title, description, trigger_event, audience, priority, steps
)
insert into onboarding_tour_versions (tour_id, version, title, description, trigger_event, audience, priority, steps)
select id, 1, title, description, trigger_event, audience, priority, steps from ins;

insert into onboarding_nudges (key, title, body, event, audience, priority, cooldown_hours, max_impressions,
                               cta_label, cta_href, support_fallback, status, published_at)
values
  ('sin-productos', 'Todavía no cargaste productos',
   'Cargá tu primer producto o importá tu lista desde Excel para empezar a vender.',
   'sin_productos', '{"roles": ["owner", "manager"]}', 70, 24, 3,
   'Cargar productos', '/productos', false, 'published', now()),
  ('sin-primera-venta', 'Hagamos tu primera venta',
   'Un recorrido corto te lleva de punta a punta: productos, medios de pago, caja y cobro.',
   'sin_primera_venta', '{"roles": ["owner", "manager"], "max_days": 30}', 60, 48, 3,
   'Ver el recorrido', 'tour:primer-cobro', false, 'published', now()),
  ('caja-cerrada', 'La caja está cerrada',
   'Para cobrar, abrí la caja desde Vender: tocá el estado de la caja y cargá el efectivo inicial.',
   'sin_caja_abierta', '{"roles": ["owner", "manager", "cashier"]}', 40, 12, 5,
   'Ir a Vender', '/pos', false, 'published', now()),
  ('trial-por-vencer', 'Tu prueba está por terminar',
   'Elegí tu plan para seguir vendiendo sin cortes.',
   'trial_por_vencer', '{"roles": ["owner"], "statuses": ["trial"]}', 80, 24, 4,
   'Ver planes', '/dashboard-team', true, 'published', now()),
  ('venta-fallida', '¿No salió el cobro?',
   'Revisá que la caja esté abierta y el medio de pago habilitado. Si sigue fallando, buscá "cobro" en Ayuda.',
   'venta_fallida', '{}', 90, 6, 10,
   null, null, true, 'published', now()),
  ('bienvenida', 'Bienvenido a NinjaSoft',
   'En la Escuela tenés cursos cortos para vos y tu equipo, con certificado de POS básico.',
   'registro', '{"roles": ["owner"]}', 30, 72, 2,
   'Ir a la Escuela', '/escuela', false, 'published', now())
on conflict (key) do nothing;
