-- =============================================================================
-- 20261108100100_escuela  (ADR-086 · F15 · H69)
--
-- Escuela NinjaSoft mínima: cursos = secuencias de artículos de ayuda con un
-- checklist y una prueba corta. Progreso por usuario y certificado simple.
--
--  1) Feature `escuela` · BASE (is_basic), grupo extras (CLAUDE.md §6).
--     Qué habilita: cursos por rol, progreso propio, prueba corta y
--     certificado (p. ej. "POS básico" para el cajero).
--     Gating real: school_mark_lesson y school_submit_quiz exigen
--     tenant_has_feature_for(tenant, 'escuela'). Análisis comercial: capacitar
--     al equipo baja tickets de soporte y acelera la primera venta; va en todos
--     los planes (true en los cuatro globales) y un plan a medida la puede
--     apagar con modules.escuela = false.
--  2) school_courses: catálogo de plataforma con las respuestas de las pruebas.
--     Copia de content/help/courses.json (un test compara las dos). Sin
--     policies: nadie lo lee por PostgREST (las respuestas no salen); sólo lo
--     usan las RPC. Cambiar un curso = migración nueva con version + 1.
--  3) school_progress: una fila por usuario, negocio y curso. Lectura: el
--     propio usuario; dueño y encargado ven el progreso de su equipo; staff
--     interno con internal_scope() (ADR-052). Sin escritura directa: todo por
--     RPC, así nadie se marca aprobado a mano.
--  4) RPC school_mark_lesson(curso, lección, hecha) y school_submit_quiz(curso,
--     respuestas): SECURITY DEFINER, search_path fijo, sólo miembros activos
--     del negocio activo. La prueba exige todas las lecciones hechas, puntúa en
--     el servidor y, al aprobar por primera vez, fija passed_at, el código del
--     certificado y audita `school_certified`.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('escuela', 'Escuela NinjaSoft',
   'Cursos cortos por rol con lecciones, checklist, prueba y certificado (por ejemplo, POS básico para el cajero)',
   'extras', true, 90)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('escuela', true),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'escuela');
-- Planes a medida: no se declara (cae al fallback is_basic = true).

-- -----------------------------------------------------------------------------
-- A) Catálogo de cursos (plataforma)
-- -----------------------------------------------------------------------------
create table if not exists school_courses (
  key          text primary key check (key ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  version      integer not null check (version >= 1),
  title        text not null,
  roles        text[] not null,
  lessons      text[] not null check (cardinality(lessons) >= 1),
  -- [{ "id": "q1", "answer": 1, "explain": "..." }, ...]
  quiz         jsonb not null check (jsonb_typeof(quiz) = 'array' and jsonb_array_length(quiz) between 3 and 5),
  pass_pct     integer not null check (pass_pct between 50 and 100),
  certificate  text,
  is_active    boolean not null default true,
  sort         integer not null default 0,
  updated_at   timestamptz not null default now()
);

alter table school_courses enable row level security;
-- Sin policies: las respuestas no se leen por PostgREST.
revoke all on school_courses from anon, authenticated;

with src as (
  select $courses$
[
 {
  "key": "pos-basico",
  "version": 1,
  "title": "POS básico",
  "roles": [
   "cashier",
   "manager",
   "owner"
  ],
  "lessons": [
   "caja-abrir",
   "pos-cobrar-venta",
   "pos-medios-de-pago",
   "pos-anular-venta",
   "pos-devoluciones",
   "caja-cerrar"
  ],
  "passPct": 80,
  "certificate": "POS básico",
  "quiz": [
   {
    "id": "q1",
    "answer": 1,
    "explain": "La caja se abre desde el punto de venta. En Caja, si no hay turno, el botón \"Ir al punto de venta\" te lleva ahí."
   },
   {
    "id": "q2",
    "answer": 1,
    "explain": "F12 abre el cobro. F2 te lleva al buscador de productos."
   },
   {
    "id": "q3",
    "answer": 1,
    "explain": "Como cajero sólo podés anular ventas del día. Las de días anteriores las anula un encargado o el dueño."
   },
   {
    "id": "q4",
    "answer": 0,
    "explain": "El reintegro en efectivo sale de tu caja: tiene que estar abierta."
   },
   {
    "id": "q5",
    "answer": 2,
    "explain": "Cargás lo que contaste. El sistema lo compara con el efectivo esperado y muestra la diferencia."
   }
  ]
 },
 {
  "key": "caja-y-arqueo",
  "version": 1,
  "title": "Caja, arqueo y cierre Z",
  "roles": [
   "manager",
   "owner"
  ],
  "lessons": [
   "caja-abrir",
   "caja-movimientos",
   "caja-arqueo",
   "caja-cerrar",
   "caja-cierre-z"
  ],
  "passPct": 75,
  "certificate": null,
  "quiz": [
   {
    "id": "q1",
    "answer": 2,
    "explain": "Los movimientos de caja no se editan ni se borran: se compensan con el movimiento contrario."
   },
   {
    "id": "q2",
    "answer": 0,
    "explain": "Negativa es faltante y positiva es sobrante."
   },
   {
    "id": "q3",
    "answer": 1,
    "explain": "El cierre forzado genera el Z con lo que contás y queda en la auditoría con el motivo."
   },
   {
    "id": "q4",
    "answer": 2,
    "explain": "El cierre Z es un registro contable que no se edita ni se borra."
   }
  ]
 },
 {
  "key": "primeros-pasos",
  "version": 1,
  "title": "Primeros pasos del dueño",
  "roles": [
   "owner",
   "manager"
  ],
  "lessons": [
   "productos-alta",
   "productos-importar-excel",
   "pos-medios-de-pago",
   "sucursales",
   "usuarios-permisos"
  ],
  "passPct": 75,
  "certificate": null,
  "quiz": [
   {
    "id": "q1",
    "answer": 1,
    "explain": "Si el SKU (o el código de barras) ya existe se actualiza; si no, se crea uno nuevo."
   },
   {
    "id": "q2",
    "answer": 2,
    "explain": "El cajero vende y cobra con su propia caja, sin tocar catálogo ni precios."
   },
   {
    "id": "q3",
    "answer": 1,
    "explain": "Sumar encargados lo hace sólo el dueño."
   },
   {
    "id": "q4",
    "answer": 0,
    "explain": "En Configuración, Medios de pago, con \"Conectar con Mercado Pago\"."
   }
  ]
 },
 {
  "key": "facturacion-arca",
  "version": 1,
  "title": "Facturación electrónica ARCA",
  "roles": [
   "owner",
   "manager"
  ],
  "lessons": [
   "arca-facturacion",
   "arca-homologacion-produccion",
   "arca-caea"
  ],
  "passPct": 66,
  "certificate": null,
  "quiz": [
   {
    "id": "q1",
    "answer": 1,
    "explain": "Homologación sirve para probar: las facturas no tienen validez fiscal."
   },
   {
    "id": "q2",
    "answer": 0,
    "explain": "Sólo el dueño confirma el paso a producción."
   },
   {
    "id": "q3",
    "answer": 1,
    "explain": "ARCA exige un punto de venta CAEA distinto del que usás con CAE."
   }
  ]
 }
]
$courses$::jsonb as j
)
insert into school_courses (key, version, title, roles, lessons, quiz, pass_pct, certificate, sort)
select
  e ->> 'key',
  (e ->> 'version')::int,
  e ->> 'title',
  array(select jsonb_array_elements_text(e -> 'roles')),
  array(select jsonb_array_elements_text(e -> 'lessons')),
  e -> 'quiz',
  (e ->> 'passPct')::int,
  e ->> 'certificate',
  (ord - 1)::int
from src, jsonb_array_elements(src.j) with ordinality as x(e, ord)
on conflict (key) do update
  set version = excluded.version,
      title = excluded.title,
      roles = excluded.roles,
      lessons = excluded.lessons,
      quiz = excluded.quiz,
      pass_pct = excluded.pass_pct,
      certificate = excluded.certificate,
      sort = excluded.sort,
      updated_at = now()
  where school_courses.version < excluded.version;

-- -----------------------------------------------------------------------------
-- B) Progreso por usuario
-- -----------------------------------------------------------------------------
create table if not exists school_progress (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  course_key       text not null references school_courses(key),
  course_version   integer not null,
  lessons_done     text[] not null default '{}',
  quiz_attempts    integer not null default 0 check (quiz_attempts >= 0),
  best_score_pct   integer check (best_score_pct between 0 and 100),
  last_score_pct   integer check (last_score_pct between 0 and 100),
  passed_at        timestamptz,
  certificate_code text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, user_id, course_key)
);
create index if not exists school_progress_tenant_idx on school_progress (tenant_id, course_key);

drop trigger if exists set_updated_at_school_progress on school_progress;
create trigger set_updated_at_school_progress
  before update on school_progress
  for each row execute function set_updated_at();

-- Rol del usuario del JWT en el negocio activo (membresía activa).
create or replace function school_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from tenant_users
   where tenant_id = current_tenant_id() and user_id = auth.uid() and status = 'active'
   limit 1;
$$;
revoke all on function school_my_role() from public, anon;
grant execute on function school_my_role() to authenticated;

alter table school_progress enable row level security;

drop policy if exists school_progress_select on school_progress;
create policy school_progress_select on school_progress
  for select using (
    (
      tenant_id = (select current_tenant_id())
      and (user_id = (select auth.uid()) or (select school_my_role()) in ('owner', 'manager'))
    )
    or (select internal_scope())
  );
-- Sin insert, update ni delete por PostgREST: sólo las RPC de abajo.
revoke insert, update, delete on school_progress from anon, authenticated;
grant select on school_progress to authenticated;

-- -----------------------------------------------------------------------------
-- C) RPC
-- -----------------------------------------------------------------------------

-- Contexto común: negocio activo, miembro activo, feature y curso.
create or replace function _school_context(p_course text)
returns school_courses
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_course school_courses;
begin
  if auth.uid() is null or v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if school_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'escuela') then
    raise exception 'feature_not_in_plan: escuela' using errcode = '42501';
  end if;
  select * into v_course from school_courses where key = p_course and is_active;
  if not found then
    raise exception 'invalid_course' using errcode = '22023';
  end if;
  return v_course;
end;
$$;
revoke all on function _school_context(text) from public, anon, authenticated;

create or replace function school_mark_lesson(p_course text, p_lesson text, p_done boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_course school_courses := _school_context(p_course);
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
  v_row    school_progress;
begin
  if p_lesson is null or not (p_lesson = any (v_course.lessons)) then
    raise exception 'invalid_lesson' using errcode = '22023';
  end if;

  insert into school_progress (tenant_id, user_id, course_key, course_version, lessons_done)
  values (v_tenant, v_uid, v_course.key, v_course.version,
          case when coalesce(p_done, true) then array[p_lesson] else '{}'::text[] end)
  on conflict (tenant_id, user_id, course_key) do update
    set lessons_done = (
          -- Sólo lecciones que siguen en el curso, sin repetir, en el orden del curso.
          select coalesce(array_agg(l order by o), '{}'::text[])
            from unnest(v_course.lessons) with ordinality as c(l, o)
           where (l = any (school_progress.lessons_done) and l <> p_lesson)
              or (l = p_lesson and coalesce(p_done, true))
        ),
        course_version = v_course.version
  returning * into v_row;

  return to_jsonb(v_row) - 'id' - 'tenant_id' - 'user_id';
end;
$$;
revoke all on function school_mark_lesson(text, text, boolean) from public, anon;
grant execute on function school_mark_lesson(text, text, boolean) to authenticated;

create or replace function school_submit_quiz(p_course text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_course   school_courses := _school_context(p_course);
  v_tenant   uuid := current_tenant_id();
  v_uid      uuid := auth.uid();
  v_row      school_progress;
  v_total    int := jsonb_array_length(v_course.quiz);
  v_score    int := 0;
  v_pct      int;
  v_passed   boolean;
  v_results  jsonb := '[]'::jsonb;
  v_q        jsonb;
  v_given    jsonb;
  v_ok       boolean;
  v_first    boolean := false;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'invalid_answers' using errcode = '22023';
  end if;

  select * into v_row from school_progress
   where tenant_id = v_tenant and user_id = v_uid and course_key = v_course.key
   for update;
  if not found or exists (
    select 1 from unnest(v_course.lessons) l where not (l = any (v_row.lessons_done))
  ) then
    raise exception 'lessons_pending' using errcode = '22023';
  end if;

  for v_q in select * from jsonb_array_elements(v_course.quiz) loop
    v_given := p_answers -> (v_q ->> 'id');
    v_ok := v_given is not null
        and jsonb_typeof(v_given) = 'number'
        and v_given = (v_q -> 'answer');
    if v_ok then v_score := v_score + 1; end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_q ->> 'id', 'correct', v_ok, 'explain', v_q ->> 'explain'));
  end loop;

  v_pct := round(v_score * 100.0 / v_total);
  v_passed := v_pct >= v_course.pass_pct;
  v_first := v_passed and v_row.passed_at is null;

  update school_progress
     set quiz_attempts = quiz_attempts + 1,
         last_score_pct = v_pct,
         best_score_pct = greatest(coalesce(best_score_pct, 0), v_pct),
         course_version = v_course.version,
         passed_at = case when v_first then now() else passed_at end,
         certificate_code = case
           when v_first then upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
           else certificate_code end
   where id = v_row.id
  returning * into v_row;

  if v_first then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, v_uid, 'school_progress', v_row.id, 'school_certified',
            jsonb_build_object('course', v_course.key, 'version', v_course.version,
                               'score_pct', v_pct, 'certificate_code', v_row.certificate_code));
  end if;

  return jsonb_build_object(
    'score', v_score,
    'total', v_total,
    'pct', v_pct,
    'passed', v_passed,
    'pass_pct', v_course.pass_pct,
    'results', v_results,
    'passed_at', v_row.passed_at,
    'certificate_code', v_row.certificate_code
  );
end;
$$;
revoke all on function school_submit_quiz(text, jsonb) from public, anon;
grant execute on function school_submit_quiz(text, jsonb) to authenticated;
