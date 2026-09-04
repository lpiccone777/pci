/**
 * Aislamiento del broker POR SPEC (no solo por corrida).
 *
 * `global-setup.ts` crea UN vhost de RabbitMQ para toda la corrida. Pero todos los specs
 * comparten ese vhost, y el `ConversationsService` de CADA app de test se suscribe a las MISMAS
 * colas (`whatsapp.incoming`, `whatsapp.simulate.incoming`, `whatsapp.outgoing`, `sms.incoming`,
 * `sms.outgoing`). Con eso, un mensaje que un spec dejó sin ackear (o publicó y no llegó a
 * drenar) puede terminar consumido por el consumidor real de OTRO spec (round-robin), o cruzar
 * datos entre specs — el origen del flake "Channel ended / respuesta vacía" que aparece solo al
 * correr la suite completa.
 *
 * Solución: cada `createTestApp` crea su PROPIO vhost efímero (mismo servidor y credenciales que
 * el de la corrida), apunta ahí la conexión del broker de esa app, y lo borra al cerrar. Así
 * ninguna app comparte colas con otra. Best-effort: si no hay plugin de management, devuelve
 * `null` y la app cae al vhost compartido (comportamiento previo), sin romperse.
 *
 * Nota: `Date.now()`/`Math.random()` están permitidos en tests (a diferencia de los scripts de
 * workflow), así que se usan para nombrar el vhost de forma única.
 */

interface Mgmt {
  baseUrl: string;
  user: string;
  pass: string;
}

/** Deriva las credenciales del management API desde la `RABBITMQ_URL` de la corrida. */
function resolveMgmt(): { mgmt: Mgmt; amqpUrl: URL } | null {
  const base = process.env.RABBITMQ_URL;
  if (!base) return null;
  let amqpUrl: URL;
  try {
    amqpUrl = new URL(base);
  } catch {
    return null;
  }
  const user = amqpUrl.username ? decodeURIComponent(amqpUrl.username) : 'guest';
  const pass = amqpUrl.password ? decodeURIComponent(amqpUrl.password) : 'guest';
  const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL || `http://${amqpUrl.hostname}:15672`;
  return { mgmt: { baseUrl, user, pass }, amqpUrl };
}

async function mgmtRequest(mgmt: Mgmt, method: string, path: string, body?: unknown): Promise<void> {
  const auth = Buffer.from(`${mgmt.user}:${mgmt.pass}`).toString('base64');
  const res = await fetch(`${mgmt.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
}

export interface EphemeralVhost {
  vhost: string;
  /** `RABBITMQ_URL` apuntando al vhost efímero. */
  url: string;
}

/**
 * Crea un vhost efímero y devuelve la URL del broker apuntándole. `null` si no se pudo
 * (sin management API): la app cae al vhost compartido de la corrida.
 */
export async function createEphemeralVhost(): Promise<EphemeralVhost | null> {
  const resolved = resolveMgmt();
  if (!resolved) return null;
  const { mgmt, amqpUrl } = resolved;
  const vhost = `pci_spec_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  try {
    await mgmtRequest(mgmt, 'PUT', `/api/vhosts/${encodeURIComponent(vhost)}`);
    await mgmtRequest(
      mgmt,
      'PUT',
      `/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(mgmt.user)}`,
      { configure: '.*', write: '.*', read: '.*' },
    );
  } catch {
    // Best-effort: sin management API, back al vhost compartido.
    return null;
  }
  const url = new URL(amqpUrl.toString());
  url.pathname = `/${vhost}`;
  return { vhost, url: url.toString() };
}

/** Borra el vhost efímero (best-effort: un fallo de limpieza no debe romper el teardown). */
export async function deleteEphemeralVhost(vhost: string): Promise<void> {
  const resolved = resolveMgmt();
  if (!resolved) return;
  try {
    await mgmtRequest(resolved.mgmt, 'DELETE', `/api/vhosts/${encodeURIComponent(vhost)}`);
  } catch {
    /* la limpieza es best-effort */
  }
}
