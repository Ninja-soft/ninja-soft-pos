-- =============================================================================
-- 20261011140000_sin_guion_largo
-- El dueño prohíbe el guion largo (U+2014) en todo texto visible del producto.
-- Esta migración limpia los textos sembrados en la base:
--   1. Asuntos de emails del sistema y de los negocios (system_email_templates,
--      email_templates): primero los asuntos conocidos fila por fila, después un
--      reemplazo genérico de lo que quede (overrides guardados a mano).
--   2. Funciones que arman texto visible con el guion largo:
--      - create_sale: nombre de ítem con variante ("Remera <sep> Rojo / M"),
--        que se imprime en tickets y se ve en ventas. Pasa a usar " · ".
--      - funciones de dunning: asunto "Hubo un problema con tu cobro ..."
--      Se recrean desde su definición viva (pg_get_functiondef) con el literal
--      reemplazado, así no se copia a mano una función de cientos de líneas.
-- No toca datos históricos (ventas ya cobradas, emails ya enviados).
-- =============================================================================

-- 1) Asuntos conocidos (fila por fila).
update system_email_templates
   set subject = 'Recibimos tu pago. ¡Gracias!'
 where subject = 'Recibimos tu pago ' || chr(8212) || ' gracias';

update email_templates
   set subject = 'Recibimos tu pago. ¡Gracias!'
 where subject = 'Recibimos tu pago ' || chr(8212) || ' gracias';

update system_email_templates
   set subject = 'Hubo un problema con tu cobro: tenés 3 días'
 where subject = 'Hubo un problema con tu cobro ' || chr(8212) || ' tenés 3 días';

-- 1b) Resto (overrides editados a mano): " X " pasa a ", " y cualquier guion
--     largo suelto (o su entidad HTML) se quita.
update system_email_templates
   set subject = replace(replace(subject, ' ' || chr(8212) || ' ', ', '), chr(8212), ''),
       html    = replace(replace(replace(html, ' ' || chr(8212) || ' ', ', '), chr(8212), ''), '&mdash;', '')
 where subject like '%' || chr(8212) || '%'
    or html like '%' || chr(8212) || '%'
    or html like '%&mdash;%';

update email_templates
   set subject = replace(replace(subject, ' ' || chr(8212) || ' ', ', '), chr(8212), ''),
       html    = replace(replace(replace(html, ' ' || chr(8212) || ' ', ', '), chr(8212), ''), '&mdash;', '')
 where subject like '%' || chr(8212) || '%'
    or html like '%' || chr(8212) || '%'
    or html like '%&mdash;%';

-- 2) Funciones de public que arman texto visible con el guion largo.
do $$
declare
  r      record;
  v_def  text;
  v_new  text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and (p.prosrc like '%'' ' || chr(8212) || ' ''%'
            or p.prosrc like '%problema con tu cobro ' || chr(8212) || '%')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, ''' ' || chr(8212) || ' ''', ''' · ''');
    v_new := replace(v_new,
      'Hubo un problema con tu cobro ' || chr(8212) || ' tenés 3 días',
      'Hubo un problema con tu cobro: tenés 3 días');
    if v_new <> v_def then
      execute v_new;
    end if;
  end loop;
end
$$;
