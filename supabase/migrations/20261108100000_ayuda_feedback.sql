-- =============================================================================
-- 20261108100000_ayuda_feedback  (ADR-086 · F15 · H72)
--
-- Ayuda contextual: los artículos viven versionados en el repo
-- (content/help/*.json); la base sólo guarda el voto "me sirvió / no me sirvió"
-- de cada usuario por artículo.
--
--  * help_article_feedback: un voto por usuario, negocio y artículo (se puede
--    cambiar). Guarda la versión del artículo, la pantalla y el rol del momento.
--  * El rol lo completa el servidor desde la membresía (no lo elige el cliente).
--  * RLS: cada usuario ve y escribe sólo sus votos en el negocio activo; el
--    staff interno lee con internal_scope() (ADR-052) para medir qué artículos
--    no sirven. Sin DELETE.
--  * Plan: la ayuda es parte del producto (sin key en features, sin gating):
--    es la documentación de uso, como un manual.
-- =============================================================================

create table if not exists help_article_feedback (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  user_id         uuid not null default auth.uid() references public.users(id) on delete cascade,
  article_id      text not null check (article_id ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  article_version integer not null default 1 check (article_version between 1 and 1000),
  helpful         boolean not null,
  comment         text check (comment is null or char_length(comment) <= 500),
  route           text check (route is null or char_length(route) <= 200),
  role            text check (role is null or role in ('owner', 'manager', 'cashier', 'viewer')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, user_id, article_id)
);

create index if not exists help_article_feedback_article_idx
  on help_article_feedback (article_id, helpful);

-- Rol desde la membresía activa; updated_at al cambiar el voto. Sin cambiar de
-- dueño ni de artículo en un update.
create or replace function trg_help_article_feedback_fill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id
       or new.user_id is distinct from old.user_id
       or new.article_id is distinct from old.article_id then
      raise exception 'feedback_immutable_keys' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  new.updated_at := now();
  select tu.role into new.role
    from tenant_users tu
   where tu.tenant_id = new.tenant_id and tu.user_id = new.user_id and tu.status = 'active'
   limit 1;
  return new;
end;
$$;

drop trigger if exists help_article_feedback_fill on help_article_feedback;
create trigger help_article_feedback_fill
  before insert or update on help_article_feedback
  for each row execute function trg_help_article_feedback_fill();

alter table help_article_feedback enable row level security;

drop policy if exists help_article_feedback_select on help_article_feedback;
create policy help_article_feedback_select on help_article_feedback
  for select using (
    (tenant_id = (select current_tenant_id()) and user_id = (select auth.uid()))
    or (select internal_scope())
  );

drop policy if exists help_article_feedback_insert on help_article_feedback;
create policy help_article_feedback_insert on help_article_feedback
  for insert with check (
    tenant_id = (select current_tenant_id()) and user_id = (select auth.uid())
  );

drop policy if exists help_article_feedback_update on help_article_feedback;
create policy help_article_feedback_update on help_article_feedback
  for update using (
    tenant_id = (select current_tenant_id()) and user_id = (select auth.uid())
  )
  with check (
    tenant_id = (select current_tenant_id()) and user_id = (select auth.uid())
  );
-- Sin DELETE: el voto se cambia, no se borra.

grant select, insert, update on help_article_feedback to authenticated;
