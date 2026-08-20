# Commits de ayer — 19 de agosto de 2026

Repositorio `pci-chatbot`, rama `martin-dev`. Autor: `tinchobsas`.

## Resumen

| Métrica | Valor |
|---|---|
| Commits | 1 |
| Archivos tocados | 7 |
| Líneas agregadas | +4.555 |
| Líneas eliminadas | −3.038 |

## `93205ea` — 19:53 — feat(web): build estático (output: export) para el dashboard, servible sin Node vía nginx

### Next.js en modo export
- `next.config.ts`: se agrega `output: "export"` + `trailingSlash: true`. El build deja de necesitar un proceso Node corriendo en el servidor — nginx sirve la carpeta `out/` directamente.
- Todas las páginas del dashboard ya eran `'use client'` (sin Server Components, API routes ni middleware), así que no hicieron falta cambios ahí.
- `trailingSlash: true` emite cada ruta como carpeta/`index.html` (ej. `dashboard/flows/index.html`) para que nginx la resuelva por su índice por defecto, sin reglas de rewrite para sacar el `.html` de la URL.

### Ruta dinámica `/flows/[id]` → query param `/flows/edit?id=`
- `next export` no soporta rutas dinámicas sin `generateStaticParams` (no hay forma de pre-generar una página por cada flow id en build time, ya que los flows se crean en runtime). Fue el único caso del dashboard que chocó con el cambio a export.
- `flows/[id]/page.tsx` (1745 líneas) se renombra a `flows/edit/page.tsx` sin reescritura funcional: mismo editor de flujos (React Flow, catálogo de nodos, guardado/carga), ahora lee el id del flow con `useSearchParams()` en vez de con el param de ruta.
- `useSearchParams()` obliga a envolver el árbol en un `<Suspense>` (exigencia de Next para que la parte que depende de query params pueda renderizarse en el cliente) — se separó `FlowEditorInner` del wrapper `FlowEditorPage` para eso.
- `flows/page.tsx`: los dos links a `/dashboard/flows/new` y `/dashboard/flows/${flow.id}` pasan a `/dashboard/flows/edit?id=new` y `/dashboard/flows/edit?id=${flow.id}`.

### Informe de commits
- Se agrega `informe-commits-tinchobsas.md`: bitácora de los commits de tinchobsas del 3 al 10 de agosto de 2026.

### Grafo
- `/graphify . --update`: re-extrae los 5 archivos nuevos/cambiados (`next.config.ts`, `flows/edit/page.tsx`, `flows/page.tsx`, `next-env.d.ts`, el informe de commits) y poda los 4 archivos borrados. Grafo resultante: 1974 nodos / 4383 edges (antes: 1934/4305) tras deduplicar 4 nodos fantasma del `[id]/page.tsx` viejo.

### Archivos modificados
| Archivo | Cambios |
|---|---|
| `apps/web/next.config.ts` | +10 |
| `apps/web/src/app/dashboard/flows/{[id] → edit}/page.tsx` | +20 / −20 (rename) |
| `apps/web/src/app/dashboard/flows/page.tsx` | +6 / −6 |
| `graphify-out/GRAPH_REPORT.md` | ±654 |
| `graphify-out/graph.html` | ±10 |
| `graphify-out/graph.json` | +6846 |
| `informe-commits-tinchobsas.md` | +47 (nuevo) |

## Notas
- Fecha relevada con `git log --since/--until` en horario de Argentina (UTC−3).
- No hay más commits de ningún autor fechados el 19 de agosto de 2026 en esta rama.
