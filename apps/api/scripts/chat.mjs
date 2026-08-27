#!/usr/bin/env node
/**
 * Chat interactivo contra el bot, por consola.
 *
 * Manda cada línea que escribís a POST /conversations/simulate y muestra la respuesta.
 * Sirve para probar flujos IVR y el LLM sin WhatsApp, sin RabbitMQ y sin frontend.
 *
 *   pnpm --filter api chat                       (auto: usa la empresa más antigua)
 *   pnpm --filter api chat -- --tenant <id>      (fija una empresa puntual)
 *   pnpm --filter api chat -- --route            (rutea por la membresía del teléfono:
 *                                                 una → directo; varias → selector; ninguna → sistema)
 *
 * Comandos dentro del chat:
 *   /reset   cierra la conversación y arranca de cero (vuelve al inicio del flujo)
 *   /estado  muestra en qué flujo y nodo quedó parada la conversación
 *   /salir   termina
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const API = arg('api', process.env.API_URL || 'http://localhost:3001');
const FROM = arg('from', '+5491100000001');
// Con --route no se manda tenant: el mensaje pasa por el ruteo por membresía del teléfono,
// igual que un canal real (incluido el selector de empresa para números multitenant). La flag
// tiene prioridad sobre TENANT_ID del entorno: si no, esa variable dejaría --route en no-op.
const routeByMembership = args.includes('--route');
let tenantId = routeByMembership ? '' : arg('tenant', process.env.TENANT_ID || '');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bot: (s) => `\x1b[36m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
};

/** Sin --tenant, resolvemos el primero que exista para no pedirle el id al usuario. */
async function resolveTenant() {
  if (routeByMembership) {
    console.log(c.dim('ruteo: la empresa se resuelve por la membresía del teléfono (no se fija tenant)'));
    return;
  }
  if (tenantId) return;
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const t = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    await prisma.$disconnect();
    if (!t) throw new Error('no hay tenants en la base');
    tenantId = t.id;
    console.log(c.dim(`tenant: ${t.name} (${t.slug}) ${t.id}`));
  } catch (err) {
    console.error(c.err(`No pude resolver el tenant: ${err.message}`));
    console.error(c.dim('Pasalo a mano:  pnpm --filter api chat -- --tenant <id>'));
    process.exit(1);
  }
}

async function send(body) {
  const res = await fetch(`${API}/conversations/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tenantId ? { from: FROM, body, tenantId } : { from: FROM, body }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {}
    throw new Error(`HTTP ${res.status} — ${detail}`);
  }
  return JSON.parse(text).reply ?? '(sin respuesta)';
}

async function showState() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const conv = await prisma.conversation.findFirst({
    where: { user: { phone: FROM }, status: 'active', ...(tenantId ? { tenantId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  await prisma.$disconnect();

  if (!conv) return console.log(c.dim('  (todavía no hay conversación)'));
  console.log(c.dim(`  flujo : ${conv.currentFlowId ?? '(ninguno → responde el LLM)'}`));
  console.log(c.dim(`  nodo  : ${conv.currentNodeId ?? '(ninguno)'}`));
  console.log(c.dim(`  vars  : ${JSON.stringify(conv.flowState ?? {})}`));
}

async function reset() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const { count } = await prisma.conversation.updateMany({
    where: { user: { phone: FROM }, status: 'active', ...(tenantId ? { tenantId } : {}) },
    data: { status: 'closed', currentFlowId: null, currentNodeId: null },
  });
  await prisma.$disconnect();
  console.log(c.ok(`  ${count} conversación(es) cerradas. La próxima arranca de cero.`));
}

await resolveTenant();

console.log(c.dim(`\nChat de prueba · ${API} · como ${FROM}`));
console.log(c.dim('Comandos: /reset  /estado  /salir\n'));

const rl = createInterface({ input: stdin, output: stdout });

for (;;) {
  let line;
  try {
    line = (await rl.question('\x1b[33mvos>\x1b[0m ')).trim();
  } catch {
    // stdin cerrado (Ctrl+D, o entrada por pipe que llegó al final): salimos limpio.
    break;
  }
  if (!line) continue;

  if (line === '/salir' || line === '/exit') break;
  if (line === '/estado') {
    await showState();
    continue;
  }
  if (line === '/reset') {
    await reset();
    continue;
  }

  const t0 = Date.now();
  try {
    const reply = await send(line);
    console.log(c.bot(`bot> ${reply}`));
    console.log(c.dim(`     (${Date.now() - t0}ms)\n`));
  } catch (err) {
    console.log(c.err(`bot> ${err.message}\n`));
  }
}

rl.close();
