-- =============================================================================
-- Recuperada del remoto (schema_migrations, version 20260531113406): aplicada
-- vía MCP el 2026-05-31 pero nunca commiteada. Restaurada el 2026-06-04 para
-- que el historial replaye en DBs frescas (detectado por el job rls de CI).
-- =============================================================================
-- Bucket para fotos de perfil de usuarios (staff y dueños). Público (URL directa),
-- escritura solo en la carpeta del propio usuario.
insert into storage.buckets (id, name, public)
values ('user-avatars', 'user-avatars', true)
on conflict (id) do nothing;

create policy "user_avatars_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'user-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "user_avatars_modify" on storage.objects for update to authenticated
  using (bucket_id = 'user-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "user_avatars_remove" on storage.objects for delete to authenticated
  using (bucket_id = 'user-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
