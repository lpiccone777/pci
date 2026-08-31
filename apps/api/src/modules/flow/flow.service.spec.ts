import { FlowService } from './flow.service';

describe('FlowService.findActiveFlowForTenant — variantes de feriado/guardia', () => {
  const tenantFlowFindFirst = jest.fn();
  const flowFindFirst = jest.fn();
  const flowAlternativeFindUnique = jest.fn();
  const resolveStatus = jest.fn();

  const prisma = {
    tenantFlow: { findFirst: tenantFlowFindFirst },
    flow: { findFirst: flowFindFirst },
    flowAlternative: { findUnique: flowAlternativeFindUnique },
  } as any;
  const scheduleCalendarService = { resolveStatus } as any;
  const config = { get: jest.fn() } as any;

  const service = new FlowService(prisma, scheduleCalendarService, config);

  const TENANT = 'tenant-1';
  const ROLE = 'role-1';
  const NOW = new Date('2026-01-01T12:00:00.000Z');
  const PRINCIPAL = { id: 'flow-principal', isActive: true };
  const VARIANT = { id: 'flow-variant', isActive: true };

  beforeEach(() => {
    jest.clearAllMocks();
    // Camino feliz de resolvePrincipalFlow: hay flujo de inicio para (tenant, rol).
    tenantFlowFindFirst.mockResolvedValue({ flow: PRINCIPAL });
  });

  it('sin feriado/guardia (resolveStatus null) devuelve el Principal, sin consultar FlowAlternative', async () => {
    resolveStatus.mockResolvedValue(null);

    const result = await service.findActiveFlowForTenant(TENANT, ROLE, NOW);

    expect(result).toBe(PRINCIPAL);
    expect(flowAlternativeFindUnique).not.toHaveBeenCalled();
  });

  it('feriado resuelto pero sin FlowAlternative configurado → fallback al Principal', async () => {
    resolveStatus.mockResolvedValue('feriado');
    flowAlternativeFindUnique.mockResolvedValue(null);

    const result = await service.findActiveFlowForTenant(TENANT, ROLE, NOW);

    expect(result).toBe(PRINCIPAL);
    expect(flowAlternativeFindUnique).toHaveBeenCalledWith({
      where: { baseFlowId_type: { baseFlowId: PRINCIPAL.id, type: 'feriado' } },
      include: { variantFlow: true },
    });
  });

  it('feriado con variante inactiva → fallback al Principal', async () => {
    resolveStatus.mockResolvedValue('feriado');
    flowAlternativeFindUnique.mockResolvedValue({ variantFlow: { ...VARIANT, isActive: false } });

    const result = await service.findActiveFlowForTenant(TENANT, ROLE, NOW);

    expect(result).toBe(PRINCIPAL);
  });

  it('guardia con variante activa → devuelve la variante, no el Principal', async () => {
    resolveStatus.mockResolvedValue('guardia');
    flowAlternativeFindUnique.mockResolvedValue({ variantFlow: VARIANT });

    const result = await service.findActiveFlowForTenant(TENANT, ROLE, NOW);

    expect(result).toBe(VARIANT);
  });
});
