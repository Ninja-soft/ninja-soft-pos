-- =============================================================================
-- 20261105200200_kds_sla_estacion  (F13 · H46 follow-up: SLA configurable por
--                                    estación en el KDS)
-- -----------------------------------------------------------------------------
-- El KDS alertaba con umbrales fijos (ámbar a 5 min, rojo a 10 min) para todas
-- las estaciones. Una barra que sirve un café no tiene el mismo tiempo que una
-- parrilla. `pos_settings.kds_sla` guarda los minutos por estación:
--
--   { "default": {"warn": 5, "late": 10},
--     "parrilla": {"warn": 15, "late": 25},
--     "barra":    {"warn": 3,  "late": 6} }
--
-- Claves: 'default' o una estación (texto corto). Cada valor: warn y late enteros
-- entre 1 y 240, warn < late. Lo valida un CHECK (server-side; la UI no es la
-- única barrera). Vacío = umbrales históricos 5/10. La escritura sigue la policy
-- de pos_settings (sólo el dueño). Flag operativo, no feature de plan.
-- =============================================================================

create or replace function _kds_sla_valid(p jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  k text;
  v jsonb;
  w numeric;
  l numeric;
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k, v in select * from jsonb_each(p) loop
    if char_length(k) = 0 or char_length(k) > 40 then
      return false;
    end if;
    if jsonb_typeof(v) <> 'object'
       or jsonb_typeof(v -> 'warn') <> 'number'
       or jsonb_typeof(v -> 'late') <> 'number' then
      return false;
    end if;
    w := (v ->> 'warn')::numeric;
    l := (v ->> 'late')::numeric;
    if w <> trunc(w) or l <> trunc(l) or w < 1 or l > 240 or w >= l then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

alter table pos_settings
  add column if not exists kds_sla jsonb not null default '{}'::jsonb;

alter table pos_settings drop constraint if exists pos_settings_kds_sla_check;
alter table pos_settings add constraint pos_settings_kds_sla_check
  check (_kds_sla_valid(kds_sla));

comment on column pos_settings.kds_sla is
  'Minutos de alerta del KDS por estación: {"default"|estacion: {"warn": n, "late": n}}.';
