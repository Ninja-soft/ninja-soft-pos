-- =============================================================================
-- Dominio propio pos.soft.ninja en los emails (antes ninja-soft-pos.vercel.app).
-- Logos de los emails en PNG desde Cloudinary (WebP no se ve en varios clientes
-- de correo, p. ej. Outlook): Ninja_POS_Light = texto blanco (fondo oscuro),
-- Ninja_POS_Dark = texto negro (fondo claro).
-- =============================================================================

-- Plantillas del sistema (defaults sembrados y overrides de staff).
update system_email_templates
set html = replace(replace(replace(html,
  'https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp', 'https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm'),
  'https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-light-mode.webp', 'https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0'),
  'https://ninja-soft-pos.vercel.app', 'https://pos.soft.ninja')
where html like '%ninja-soft-pos.vercel.app%';

-- Plantillas por negocio.
update email_templates
set html = replace(replace(replace(html,
  'https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp', 'https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm'),
  'https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-light-mode.webp', 'https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0'),
  'https://ninja-soft-pos.vercel.app', 'https://pos.soft.ninja')
where html like '%ninja-soft-pos.vercel.app%';

-- Helper del dunning con el logo nuevo.
create or replace function _dunning_email_html(p_tenant text, p_title text, p_body text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $h$
  select
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;background:#111827;border-radius:14px;overflow:hidden">'
    || '<div style="padding:28px 24px 20px;text-align:center">'
    || '<img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPos" style="max-height:24px;display:inline-block" />'
    || '<div style="color:#ffffff;font-size:17px;font-weight:bold;margin-top:12px">'
    || replace(replace(replace(coalesce(p_title,''),'&','&amp;'),'<','&lt;'),'>','&gt;')
    || '</div>'
    || '<div style="height:3px;width:48px;background:#f97316;border-radius:99px;margin:16px auto 0"></div>'
    || '</div>'
    || '<div style="padding:8px 28px 28px;color:#e5e7eb;line-height:1.6">'
    || '<p style="margin:0 0 14px;font-size:15px">'
    || replace(replace(replace(coalesce(p_body,''),'&','&amp;'),'<','&lt;'),'>','&gt;')
    || '</p></div>'
    || '<div style="background:#09051C;padding:18px 12px;text-align:center">'
    || '<img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPos" style="max-height:20px;display:inline-block" />'
    || '<div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div>'
    || '</div></div>';
$h$;
