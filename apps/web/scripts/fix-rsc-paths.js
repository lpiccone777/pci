/**
 * Workaround del bug de Next.js 16 con `output: "export"` (vercel/next.js#85374):
 * el build escribe los payloads RSC del prefetch en carpetas anidadas
 * (`dashboard/users/__next.dashboard/users/__PAGE__.txt`) pero el router del
 * cliente los pide con el nombre aplanado separado por puntos
 * (`dashboard/users/__next.dashboard.users.__PAGE__.txt`) — cada hover sobre un
 * <Link> tira un 404 en producción y el prefetch queda deshabilitado de hecho.
 *
 * Este script corre después de `next build` (ver "build" en package.json) y COPIA
 * cada archivo bajo un directorio `__next.*` a su alias plano al lado del
 * directorio padre. Copia, no renombra: si una versión futura de Next vuelve a
 * pedir la forma anidada, ambas siguen existiendo (son .txt chicos, el costo es
 * nulo). Cuando Next publique el fix oficial, este script pasa a no encontrar
 * nada que copiar y se puede borrar sin más.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'out');

function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

if (!fs.existsSync(OUT_DIR)) {
  console.log('[fix-rsc-paths] out/ no existe — nada que hacer (¿build sin output: export?).');
  process.exit(0);
}

let copied = 0;
walk(OUT_DIR, (filePath) => {
  const parts = filePath.split(path.sep);
  const idx = parts.findIndex((p) => p.startsWith('__next.'));
  // Solo interesa cuando `__next.*` es un DIRECTORIO intermedio (hay más
  // componentes después): esos son los que el cliente pide aplanados.
  if (idx === -1 || idx === parts.length - 1) return;

  const flatName = parts.slice(idx).join('.');
  const target = path.join(parts.slice(0, idx).join(path.sep), flatName);
  if (fs.existsSync(target)) return;
  fs.copyFileSync(filePath, target);
  copied++;
});

console.log(`[fix-rsc-paths] ${copied} payload(s) RSC copiados a su alias plano.`);
