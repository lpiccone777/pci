/**
 * 2.6 Conocido vs desconocido (CHAT-KNOWN-*)
 *
 * Vía: `POST /conversations/simulate` (patrón simulate + FakeLlm, ver chat-start.e2e-spec.ts).
 *
 * Verificado en `ConversationsService.handleMessage` (apps/api/src/modules/conversations/
 * conversations.service.ts): "conocido" sale de `UsersService.findMembershipByPhone(phone,
 * tenantId)` — busca un `UserTenant` cuyo `user` tenga ese `phone` Y `deletedAt: null`. Esto se
 * resuelve UNA vez, antes de `findOrCreateByPhone` (el placeholder), y el resultado (`identity`)
 * se enhebra por parámetro hasta `executeNode`'s `case 'start'`, que NO vuelve a consultar nada
 * — ver ese comentario en el código, es exactamente el bug histórico que este bloque cubre.
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
    return http(t).post('/conversations/simulate').send({ from, body, tenantId });
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

  it('CHAT-KNOWN-02: número con fila User pero SIN membresía en el tenant es desconocido (no alcanza con que exista el User)', async () => {
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
    // Nada de "Bienvenido de nuevo": el saludo de conocido depende de identity.isKnown, no de
    // que exista un User (ver el comentario del código citado arriba del describe).
    expect(res.body.reply).not.toContain('Bienvenido de nuevo');
    expect(res.body.reply).toContain('Rama desconocido');
  });

  it('CHAT-KNOWN-03: número de una persona dada de baja es desconocido (la baja rompe la membresía)', async () => {
    const phone = uniquePhone();

    // `findMembershipByPhone` exige `user.deletedAt: null`, así que una persona dada de baja
    // deja de contar como conocida aunque conserve su UserTenant/Role. El teléfono se guarda
    // SUFIJADO a propósito: es lo que hace la baja lógica real (BE-USR-12, "sufija los campos
    // únicos y libera esos valores") para que el número quede libre. Sin este sufijo, el
    // `findOrCreateByPhone` de más abajo (que también filtra `deletedAt: null`, así que tampoco
    // ve a esta persona) intentaría crear un User nuevo con el MISMO `phone` ya ocupado por la
    // fila dada de baja y violaría el `@unique` de `User.phone` — no es una elección de test,
    // es lo que exige la constraint real.
    const deletedUser = await createUser(t.prisma, {
      email: uniqueEmail('baja'),
      phone: `${phone}-baja`,
      firstName: 'De Baja',
      deletedAt: new Date(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).not.toContain('Bienvenido de nuevo');
    expect(res.body.reply).toContain('Rama desconocido');

    // Entra como persona nueva, sin heredar nada de la dada de baja (mismo criterio que
    // BE-USR-15: "permitido, entra como persona nueva sin historial").
    const newUser = await t.prisma.user.findFirst({ where: { phone } });
    expect(newUser).toBeTruthy();
    expect(newUser!.id).not.toBe(deletedUser.id);
  });

  it('CHAT-KNOWN-04: "conocido" se resuelve una sola vez, antes de crear el placeholder (no reaparece el bug de "siempre conocido")', async () => {
    const usersService = t.moduleRef.get(UsersService);
    const spy = jest.spyOn(usersService, 'findMembershipByPhone');

    const phone = uniquePhone(); // número nuevo: sin User ni membership todavía

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    // El bug histórico: si `case 'start'` volviera a resolver "conocido" consultando por la
    // existencia de un User, para ese momento `handleMessage` ya creó el placeholder un paso
    // antes (`findOrCreateByPhone`) y el número dejaría de detectarse como desconocido. Acá
    // sigue dando la rama desconocido porque `identity` se resolvió ANTES de crear ese User y
    // se enhebra por parámetro, sin volver a consultar nada dentro del nodo.
    expect(res.body.reply).toContain('Rama desconocido');

    // Prueba directa de "se resuelve una sola vez": una sola consulta de membership por
    // mensaje, no una en handleMessage y otra dentro de executeNode/case 'start'.
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
