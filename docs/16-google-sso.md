# 16 — Google SSO (guía de activación)

> Para Lucas. El botón "Registrate con Google" ya está en `/signup`. Hasta que
> cargues las credenciales, si alguien lo toca verá un aviso amable
> ("Google está casi listo — falta habilitarlo"). Seguí estos pasos una sola
> vez y el botón queda operativo.

Tiempo estimado: 10–15 minutos. Necesitás una cuenta de Google y acceso al
dashboard de Supabase del proyecto.

---

## Resumen del flujo

```
Google Cloud Console  →  crea credenciales OAuth (Client ID + Secret)
        │
        ▼
Supabase Dashboard → Authentication → Providers → Google  →  pegás ID + Secret
        │
        ▼
/signup → botón Google funciona (redirige a Google y vuelve al paso "Tu negocio")
```

El dato clave es el **redirect URI** de Supabase, que ya conocemos:

```
https://hrkditzrsavehnhngakb.supabase.co/auth/v1/callback
```

---

## 1. Google Cloud Console — crear proyecto

1. Entrá a https://console.cloud.google.com/
2. Arriba a la izquierda, selector de proyecto → **Nuevo proyecto**.
   - Nombre: `NinjaSoft POS` (o el que prefieras).
   - Crear y esperar a que quede seleccionado.

## 2. Configurar la pantalla de consentimiento (OAuth consent screen)

1. Menú lateral → **APIs y servicios → Pantalla de consentimiento de OAuth**.
2. Tipo de usuario: **External** (Externo) → Crear.
3. Completá lo mínimo:
   - **Nombre de la app**: `NinjaSoft POS`.
   - **Correo de asistencia al usuario**: tu email.
   - **Datos de contacto del desarrollador**: tu email.
4. Guardar y continuar por las pantallas siguientes (Scopes / Usuarios de prueba)
   sin agregar nada → **Guardar y continuar** hasta el final.
5. Mientras la app esté en modo "Testing", solo los emails que agregues como
   **usuarios de prueba** pueden entrar. Para abrirla a cualquiera, usá
   **Publicar app** (no requiere verificación de Google si solo pedís el perfil
   básico y el email, que es nuestro caso).

## 3. Crear las credenciales OAuth (Client ID Web)

1. Menú lateral → **APIs y servicios → Credenciales**.
2. **Crear credenciales → ID de cliente de OAuth**.
3. Tipo de aplicación: **Aplicación web**.
4. Nombre: `NinjaSoft Web`.
5. En **URIs de redireccionamiento autorizados**, agregá EXACTAMENTE:

   ```
   https://hrkditzrsavehnhngakb.supabase.co/auth/v1/callback
   ```

   (Sin barra final, sin espacios. Es la URL que Supabase usa para recibir la
   respuesta de Google.)
6. (Opcional pero recomendado) En **Orígenes autorizados de JavaScript** agregá
   las URLs desde donde se abre el login, p. ej.:

   ```
   http://localhost:3000
   https://app.ninjasoft.com.ar
   ```

7. **Crear**. Google te muestra el **Client ID** y el **Client Secret**.
   Copiálos (el secret también se puede ver/descargar después).

## 4. Cargar las credenciales en Supabase

1. Entrá al dashboard del proyecto:
   https://supabase.com/dashboard/project/hrkditzrsavehnhngakb
2. Menú lateral → **Authentication → Providers** (Sign In / Providers).
3. Buscá **Google** en la lista y abrilo.
4. Activá el toggle **Enable Sign in with Google**.
5. Pegá:
   - **Client ID** → el de Google.
   - **Client Secret** → el de Google.
6. Dejá el **Callback URL (for OAuth)** tal como viene (es el mismo
   `.../auth/v1/callback` que pusiste en Google).
7. **Save**.

## 5. Probar

1. Abrí `/signup` (en local o producción).
2. Tocá **Registrate con Google**.
3. Elegí tu cuenta de Google y aceptá los permisos.
4. Volvés a `/signup?step=2` ya autenticado: el wizard muestra el paso
   **"Contanos de tu negocio"** (nombre del negocio + tipo de negocio +
   datos fiscales/código opcionales).
5. Completás y **Crear cuenta** → quedás en el dashboard.

---

## Notas y problemas comunes

- **El botón muestra "Google está casi listo — falta habilitarlo".** Significa
  que el provider todavía está deshabilitado en Supabase (paso 4 no hecho o el
  toggle apagado). El código detecta el error del provider y muestra ese aviso
  en vez de romper el registro.
- **`redirect_uri_mismatch` al volver de Google.** El URI del paso 3.5 no
  coincide exacto con el de Supabase. Verificá que sea
  `https://hrkditzrsavehnhngakb.supabase.co/auth/v1/callback`, sin barra final.
- **"Access blocked: app not verified".** La app está en modo Testing y tu email
  no está en la lista de usuarios de prueba, o publicala (paso 2.5).
- **Cambié las URLs de producción.** Agregá el dominio nuevo en "Orígenes
  autorizados de JavaScript" (paso 3.6); el callback de Supabase no cambia.
- **Seguridad.** El Client Secret es sensible: vive solo en el dashboard de
  Supabase, nunca en el repo ni en variables `NEXT_PUBLIC_*`.
