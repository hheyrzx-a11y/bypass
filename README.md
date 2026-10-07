# Kayro Patch API

Revisa → (agrega H.264/AVC si falta) → parcha → etiqueta → entrega → borra.

## Subir a Render
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: **New → Blueprint** (usa `render.yaml`) o **New → Web Service → Docker**.
3. Variable `ALLOWED_ORIGINS` = la URL de tu sitio (ej. `https://tusitio.com`).
4. Prueba: `https://TU-API.onrender.com/` (página de demo) y `/health`.

## Endpoints
| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/jobs` | Sube el video (campo `video`). Responde `202` con `jobId` |
| GET | `/api/jobs/:id/events` | Progreso en tiempo real (SSE: `progress`, `done`, `error`) |
| GET | `/api/jobs/:id` | Mismo estado, por consulta |
| GET | `/api/jobs/:id/download` | Descarga el MP4 parchado y lo borra al terminar |
| GET | `/api/limits` | Límites actuales |

## Usarlo desde tu sitio
```html
<script>window.KAYRO_API_BASE = "https://TU-API.onrender.com";</script>
```
y copia `public/index.html`, o llama a la API desde tu propio código:
```js
const form = new FormData(); form.append("video", file);
const { jobId } = await (await fetch(API + "/api/jobs", { method: "POST", body: form })).json();
const es = new EventSource(`${API}/api/jobs/${jobId}/events`);
es.addEventListener("progress", e => console.log(JSON.parse(e.data).percent));
es.addEventListener("done", e => { const r = JSON.parse(e.data); location.href = API + r.result.downloadUrl; es.close(); });
es.addEventListener("error", e => e.data && console.log(JSON.parse(e.data).error.message));
```
(Con `XMLHttpRequest` también puedes mostrar el progreso de la subida con `xhr.upload.onprogress`.)

## Borrado automático
- El original y el MP4 intermedio se borran en cuanto termina el procesamiento (bien o mal).
- El resultado se borra cuando el usuario termina de descargarlo.
- Si nadie lo descarga: se borra a los 15 min (`DONE_TTL_MIN`). Errores: 10 min.
- Al arrancar se vacía la carpeta temporal y cada minuto se limpian archivos huérfanos.
