-- =============================================================================
-- 20260608360000_pos_settings_doc_plu
-- Settings nuevos del POS:
--   * require_customer_doc: exige tipo + número de documento al crear/editar un
--     cliente desde el formulario compartido. Default TRUE (siempre se pide el
--     documento de forma predeterminada).
--   * plu_enabled / plu_mode: habilita el PLU (código corto de 6 dígitos para
--     tipear rápido en el POS) y su modo de generación. La generación del PLU en
--     productos la implementa otro agente; acá solo se exponen las columnas.
-- Conservador para require_customer_doc (default true = pedir documento) y para
-- PLU (default off). No regresiona otros settings.
-- =============================================================================
alter table pos_settings
  add column if not exists require_customer_doc boolean not null default true,
  add column if not exists plu_enabled boolean not null default false,
  add column if not exists plu_mode text not null default 'random'
    check (plu_mode in ('random','incremental'));
