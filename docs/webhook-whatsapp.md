# Webhook de WhatsApp — cómo levantarlo y verificarlo

Guía operativa para desarrollo local. El backend (`apps/api`) expone el webhook en
`/webhooks/whatsapp` (`WhatsAppWebhookController`), pero Meta necesita una URL
pública para poder pegarle — como no hay deploy, se usa un túnel (Cloudflare
Tunnel) que expone el `localhost:3001` de la máquina de desarrollo.

Nada de esto persiste: cada vez que se reinicia el túnel, Meta necesita la URL
nueva. Es la naturaleza de un túnel gratuito sin cuenta (`trycloudflare.com`).

## 1. Prerequisitos

- Backend corriendo en el puerto 3001 (`cd apps/api && node dist/main`, o el
  proceso que ya esté levantado — chequear con el paso 2).
- `cloudflared` instalado (`cloudflared --version`). Si falta:
  `choco install cloudflared` o bajarlo de
  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
- Los tres valores de `.env` (`apps/api/.env`) configurados:
  - `WHATSAPP_API_TOKEN` — token de acceso a la Graph API. **Ojo:** si es un
    token corto generado desde el Explorer de Meta for Developers, vence en
    1-2 horas (ver sección "Problemas comunes" más abajo).
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — el token que Meta va a mandar de vuelta
    en el handshake de verificación.

  Estos tres también se pueden guardar como `Setting` en la base (vía
  `/settings` o `SettingsService.upsert`) — si existen ahí, **pisan** al
  `.env` (cascada BD → env → default, ver `AppConfigService.get`). Si cambiás
  el `.env` y no ves el efecto, revisar primero si hay un valor en la tabla
  `Setting` tapándolo.

## 2. Verificar que el backend esté arriba

```bash
# Windows: ver si algo escucha en el 3001
powershell -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue"

# Pegarle directo al webhook (sin pasar por el túnel) — 403 es la respuesta
# CORRECTA acá: confirma que la ruta está viva, solo falta el verify_token real
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/webhooks/whatsapp
```

Si no hay nada en el 3001, levantar el backend:

```bash
cd apps/api
node --enable-source-maps dist/main
# o, si hace falta reconstruir primero:
pnpm run build && node --enable-source-maps dist/main
```

## 3. Levantar el túnel

```bash
cloudflared tunnel --url http://localhost:3001
```

A los pocos segundos imprime un bloque como:

```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://<algo-random>.trycloudflare.com
```

Esa URL + `/webhooks/whatsapp` es la que va en Meta. Dejar el proceso corriendo
en una terminal aparte (o en background) mientras se prueba.

## 4. Verificar el túnel

```bash
# PowerShell suele ser más confiable que curl.exe en Git Bash acá (curl a
# veces tira exit code 43 con TLS/HTTP2 en Windows sin que sea un problema real)
powershell -Command "try { Invoke-WebRequest -Uri 'https://<tu-url>.trycloudflare.com/webhooks/whatsapp' -Method GET -UseBasicParsing -TimeoutSec 15 } catch { \"HTTP $($_.Exception.Response.StatusCode.value__)\" }"
```

De nuevo, **403 con "verify_token inválido" es la respuesta correcta** — significa
que la petición llegó de punta a punta hasta el controller. Un timeout, un 502
o un "no se pudo resolver el host" sí son problema (túnel caído, o el backend
no está escuchando en el 3001).

## 5. Configurar el webhook en Meta for Developers

1. Meta for Developers → tu app de WhatsApp → **Configuration** (o
   **Webhooks**, según la vista).
2. **Callback URL**: `https://<tu-url>.trycloudflare.com/webhooks/whatsapp`
3. **Verify Token**: el mismo valor que `WHATSAPP_WEBHOOK_VERIFY_TOKEN` en
   `.env` (o en `Setting` si está ahí). Para verlo:
   ```bash
   grep "^WHATSAPP_WEBHOOK_VERIFY_TOKEN=" apps/api/.env
   ```
4. Click en **Verify and Save**. Meta hace el `GET` de handshake en ese
   momento — si el log del backend muestra
   `Webhook de WhatsApp verificado por Meta.` (`WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   coincidió), quedó bien. Si muestra
   `Verificación de webhook de WhatsApp rechazada: verify_token no coincide.`,
   revisar que el token pegado en Meta sea exactamente igual al de `.env`/`Setting`.
5. Suscribirse al campo **messages** (si no está ya tildado).

## 6. Prueba end-to-end con un mensaje real

Mandar un WhatsApp real al número de prueba (tiene que estar en la allow-list
del modo sandbox de Meta — si no, la entrega de la RESPUESTA falla con
`#131030 Recipient phone number not in allowed list`, aunque la recepción
funcione igual).

Ver en el log del backend:

```
[ConversationsService] [<tenantId>] Mensaje de <telefono>: <texto>...
...
[ConversationsService] [<tenantId>] Respuesta enviada a <telefono>
```

Si en vez de eso aparece:

```
[WhatsAppService] WhatsApp API respondió 401 al mandarle a <telefono>: ...OAuthException...code:190...
```

es `WHATSAPP_API_TOKEN` vencido — ver "Problemas comunes" abajo.

## Problemas comunes

- **`401 OAuthException, code 190`**: el token de acceso venció. Los tokens
  generados desde el Explorer de Meta for Developers son de corta duración
  (1-2 horas). Confirmarlo pegándole directo a la Graph API:
  ```bash
  curl -s "https://graph.facebook.com/v21.0/me?access_token=<el-token>"
  ```
  Si dice `Session has expired...`, generar uno nuevo en Meta for Developers y
  actualizarlo — recordar que si hay un valor en `Setting` (tabla `Setting`,
  key `WHATSAPP_API_TOKEN`) pisa al `.env`, así que hay que actualizarlo ahí
  (vía `/settings` en el panel, o `SettingsService.upsert('WHATSAPP_API_TOKEN', token)`
  desde un script), no alcanza con editar el archivo. **No hace falta
  reiniciar el backend**: `AppConfigService.get()` lee la tabla `Setting` en
  cada llamada, sin cachear.
  Para no repetir esto cada 1-2 horas, conviene generar un token de larga
  duración (~60 días) o, mejor, un token de **System User** (no vence) desde
  Business Settings de Meta.
- **La URL del túnel cambió y Meta sigue apuntando a la vieja**: pasa cada vez
  que se reinicia `cloudflared` (túnel gratuito sin cuenta = URL nueva cada
  vez). Repetir el paso 5 con la URL actual.
- **`curl` da `HTTP 000` / exit code 43 contra la URL del túnel**: suele ser un
  problema del `curl.exe` de Windows con esa combinación TLS/HTTP2, no del
  túnel. Confirmar con `Invoke-WebRequest` (PowerShell) antes de asumir que
  está caído.
- **El backend no arranca / `prisma generate` falla con `EPERM`**: el motor de
  Prisma queda bloqueado por un proceso `node` corriendo. Buscar y matar el
  proceso viejo (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`,
  filtrar por el que corre `dist\main`) antes de reintentar.
