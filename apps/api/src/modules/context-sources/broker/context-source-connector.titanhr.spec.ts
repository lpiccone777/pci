/**
 * Integración contra el servidor MCP REAL de TitanHR (Titan_dev/mcp) con permisos por persona:
 * el connector firma la identidad (`identityMode: 'titan'`) y el servidor aplica los permisos
 * de esa persona. Se saltea si no hay servidor configurado:
 *
 *   TITANHR_MCP_URL=http://127.0.0.1:3333/mcp TITANHR_MCP_TOKEN=<token de cliente> \
 *   TITANHR_MCP_IDENTITY_SECRET=<secreto> TITANHR_MCP_SELF_USER=<userId> \
 *   TITANHR_MCP_MANAGER_USER=<userId> npx jest context-source-connector.titanhr
 */
import { createHmac } from 'node:crypto';
import { ContextSourceConnectorService } from './context-source-connector.service';
import { MCP_IDENTITY_HEADER, McpIdentity, mcpIdentityHeaders, signMcpIdentity } from './mcp-client';

const url = process.env.TITANHR_MCP_URL;
const describeIfServer = url ? describe : describe.skip;

const identityOf = (titanUserId: number): McpIdentity => ({
  titanUserId,
  titanEmail: '',
  pciUserId: 'pci-test',
  tenantId: 'tenant-test',
});

describe('signMcpIdentity', () => {
  it('firma un JWT HS256 de 5 minutos verificable con el secreto compartido', () => {
    const jwt = signMcpIdentity({ titanUserId: 447, titanEmail: 'a@b.c', pciUserId: 'u1', tenantId: 't1' }, 's3cr3t', 1000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({
      sub: '447',
      email: 'a@b.c',
      aud: 'titanhr-mcp',
      iss: 'pci',
      iat: 1000,
      exp: 1300,
    });
    expect(s).toBe(createHmac('sha256', 's3cr3t').update(`${h}.${p}`).digest('base64url'));
  });

  it('exige secreto e identidad solo si la conexión envía identidad', () => {
    expect(mcpIdentityHeaders({ identityMode: 'none' }, null)).toEqual({});
    expect(() => mcpIdentityHeaders({ identityMode: 'titan' }, identityOf(1))).toThrow(/Secreto de identidad/);
    expect(() => mcpIdentityHeaders({ identityMode: 'titan', identitySecret: 'x' }, null)).toThrow(/identidad de la persona/);
    expect(Object.keys(mcpIdentityHeaders({ identityMode: 'titan', identitySecret: 'x' }, identityOf(1)))).toEqual([MCP_IDENTITY_HEADER]);
  });
});

describeIfServer('ContextSourceConnectorService — MCP de TitanHR con permisos por persona', () => {
  const connector: any = new ContextSourceConnectorService({} as never);
  const config = {
    serverUrl: url,
    transport: 'http',
    authType: 'bearer',
    apiKey: process.env.TITANHR_MCP_TOKEN,
    queryMode: 'agent',
    identityMode: 'titan',
    identitySecret: process.env.TITANHR_MCP_IDENTITY_SECRET,
  };
  const selfUser = Number(process.env.TITANHR_MCP_SELF_USER);
  const managerUser = Number(process.env.TITANHR_MCP_MANAGER_USER);

  it('sin identidad la conexión no se puede usar', async () => {
    const res = await connector.listMcpTools(config, null);
    expect(res.ok).toBe(false);
  });

  it('cada persona ve solo las tools de su perfil', async () => {
    const self = await connector.listMcpTools(config, identityOf(selfUser));
    const manager = await connector.listMcpTools(config, identityOf(managerUser));
    expect(self.ok).toBe(true);
    expect(manager.ok).toBe(true);
    const selfTools = self.tools.map((t: { name: string }) => t.name);
    const managerTools = manager.tools.map((t: { name: string }) => t.name);
    expect(selfTools).toContain('get_vacation_balance');
    expect(selfTools).not.toContain('search_employees');
    expect(managerTools).toContain('list_direct_reports');
  });

  it('invoca una tool en nombre de la persona (sin parámetro employee = ella misma)', async () => {
    const who = await connector.callMcpTool(config, identityOf(selfUser), 'whoami', {});
    expect(who.ok).toBe(true);
    expect(JSON.parse(who.text)).toMatchObject({ userId: selfUser, profile: 'self' });

    const me = await connector.callMcpTool(config, identityOf(selfUser), 'get_employee', {});
    expect(me.ok).toBe(true);
    expect(JSON.parse(me.text).employeeCode).toBeTruthy();
  });

  it('un empleado común no puede ver a otro: la tool responde el rechazo como texto', async () => {
    const team = await connector.callMcpTool(config, identityOf(managerUser), 'list_direct_reports', {});
    const someone = JSON.parse(team.text).reports?.[0]?.employeeCode;
    expect(someone).toBeTruthy();

    const res = await connector.callMcpTool(config, identityOf(selfUser), 'get_employee', { employee: someone });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('respondió con error');
    expect(res.text).toMatch(/no tenés permiso|No se encontró/);
  });

  it('probar conexión en modo agente informa las tools disponibles para la persona', async () => {
    const res = await connector.testConnection('mcp', config, identityOf(managerUser));
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Modo agente');
  });
});
