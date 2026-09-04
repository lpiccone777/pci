/**
 * 2.6 Conocido vs desconocido (CHAT-KNOWN-*)
 *
 * Vía: `POST /conversations/simulate` (patrón simulate + FakeLlm, ver chat-start.e2e-spec.ts).
 *
 * Verificado en `ConversationsService.handleMessage` (apps/api/src/modules/conversations/
 * conversations.service.ts): "conocido" sale de `UsersService.findMembershipByPhone(phone,
 * tenantId)` — busca un `UserTenant` cuyo `user` tenga ese `phone` Y `deletedAt: null`. Desde
 * "no hablamos con desconocidos" (pedido 2026-08-27), sin esa membresía el mensaje se RECHAZA
 * ahí mismo — no crea `User`, no abre `Conversation`, no llega a `executeNode`. La rama
 * `unknown` del nodo `start` sigue existiendo en el motor de flujos, pero es inalcanzable por
 * este camino (ver AGENTS.md, "No hablamos con desconocidos"): CHAT-KNOWN-02/03/04 verifican
 * el rechazo, no la rama.
 *
 * Frontera mockeada: `LlmService` → `FakeLlmService`. El motor de flujos y el broker se
 * ejercitan de verdad.
 *
 * Flujo fixture: mismo patrón que el default de chat-start.e2e-spec.ts (start con ramas
 * known/unknown, cada una a un `message` con texto distinguible). Hazard de `Flow.isDefault`
 * GLOBAL: se desmarca cualquier otro default en `beforeAll` (ver flow-builder.ts).
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { UsersService } from '../src/modules/users/users.service';
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
  FakeLlmService,
  startNode,
  messageNode,
  endNode,
  edge,
} from './support';

describe('2.6 Conocido vs desconocido (CHAT-KNOWN-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;

  let tenant: { id: string };
  let role: { id: string };

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
  }

  async function unsetAllDefaults() {
    await t.prisma.flow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });

    tenant = await createTenant(t.prisma, { slug: uniqueSlug('known') });
    role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol Con Membresía' });

    await unsetAllDefaults();
    await t.prisma.flow.create({
      data: {
        name: 'F-KNOWN',
        nodes: [
          startNode('s'),
          messageNode('k', 'Rama conocido'),
          messageNode('u', 'Rama desconocido'),
          endNode('e'),
        ] as never,
        edges: [edge('s', 'k', 'known'), edge('s', 'u', 'unknown'), edge('k', 'e'), edge('u', 'e')] as never,
        isDefault: true,
        isActive: true,
        context: 'none',
      },
    });
  });

  afterAll(async () => {
    await unsetAllDefaults();
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  it('CHAT-KNOWN-01: número con membresía (UserTenant + Role) en el tenant es conocido y el flujo lo trata como tal', async () => {
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('conocido'),
      phone,
      firstName: 'Conocido',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    // Saludo del `case 'start'` para isKnown:true + la rama known del flujo.
    expect(res.body.reply).toContain('Bienvenido de nuevo');
    expect(res.body.reply).toContain('Rama conocido');
    expect(res.body.reply).not.toContain('Rama desconocido');
  });

  it('CHAT-KNOWN-02: número con fila User pero SIN membresía en el tenant se rechaza (no alcanza con que exista el User)', async () => {
    const phone = uniquePhone();
    // Existe el User (con nombre y todo), pero sin ninguna membership: no hay UserTenant que
    // vincule este teléfono con este tenant.
    await createUser(t.prisma, {
      email: uniqueEmail('sin-membresia'),
      phone,
      firstName: 'Sin Membresía',
    });

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    // No hablamos con desconocidos: se rechaza acá mismo, no llega a la rama `unknown` del
    // nodo `start` — "conocido" depende de la membresía, no de que exista un User.
    expect(res.body.reply).toBe('Este número no está registrado: el bot no atiende mensajes de desconocidos.');
  });

  it('CHAT-KNOWN-03: número de una persona dada de baja se rechaza (la baja rompe la membresía)', async () => {
    const phone = uniquePhone();

    // `findMembershipByPhone` exige `user.deletedAt: null`, así que una persona dada de baja
    // deja de contar como conocida aunque conserve su UserTenant/Role. El teléfono se guarda
    // SUFIJADO a propósito: es lo que hace la baja lógica real (BE-USR-12, "sufija los campos
    // únicos y libera esos valores") para que el número quede libre.
    await createUser(t.prisma, {
      email: uniqueEmail('baja'),
      phone: `${phone}-baja`,
      firstName: 'De Baja',
      deletedAt: new Date(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Este número no está registrado: el bot no atiende mensajes de desconocidos.');

    // No hablamos con desconocidos: tampoco se crea ningún `User` nuevo para este teléfono
    // (antes `findOrCreateByPhone` sí lo hacía; quedó eliminada).
    const newUser = await t.prisma.user.findFirst({ where: { phone } });
    expect(newUser).toBeNull();
  });

  it('CHAT-KNOWN-04: un número sin membresía se rechaza sin crear ningún `User` (no reaparece el placeholder eliminado)', async () => {
    const usersService = t.moduleRef.get(UsersService);
    const spy = jest.spyOn(usersService, 'findMembershipByPhone');

    const phone = uniquePhone(); // número nuevo: sin User ni membership todavía

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Este número no está registrado: el bot no atiende mensajes de desconocidos.');

    // No hablamos con desconocidos (pedido 2026-08-27): `findOrCreateByPhone` (el placeholder)
    // quedó eliminada — el rechazo no crea ningún `User` para este teléfono.
    const created = await t.prisma.user.findFirst({ where: { phone } });
    expect(created).toBeNull();

    // Una sola consulta de membership por mensaje.
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
