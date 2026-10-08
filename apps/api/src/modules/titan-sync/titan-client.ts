/**
 * Cliente HTTP mínimo contra la API de TitanHR, autenticado con el usuario técnico IT de la
 * empresa. No es un provider de Nest: `TitanSyncService` lo arma con la conexión ya
 * descifrada (mismo criterio que los providers de LLM con `ResolvedProviderConfig`).
 *
 * `fetch` directo, igual que `InvgateService`: es una integración de backoffice disparada a
 * mano desde la UI, no I/O de un canal de mensajería.
 *
 * Contrato de Titan relevado en `docs/titanhr-rbac.md`:
 * - `POST /api/auth/login {email, password}` → `{accessToken}`, o `{requiresMfaVerification}`
 *   si la política de la empresa exige MFA (un usuario técnico no debería tenerla).
 * - `GET /api/users` → todos los usuarios con `roles` y `person`, más la empresa de la
 *   asignación vigente. Lo filtra el RLS de aplicación de Titan: el usuario técnico necesita
 *   un grupo de políticas con acceso a todas las empresas que se quieran importar.
 * - `GET /api/person-contacts/by-person/:personId` → contactos (teléfonos, emails).
 * - `POST /api/auth/logout` → revoca la sesión. Importa: Titan limita las sesiones
 *   concurrentes por usuario y revoca la más vieja al pasarse.
 */

const TIMEOUT_MS = 20_000;
const MAX_ERROR_LEN = 300;

export interface TitanCredentials {
  baseUrl: string;
  email: string;
  password: string;
}

export interface TitanRole {
  roleId: number;
  name: string;
}

export interface TitanUser {
  userId: number;
  email: string;
  name?: string | null;
  locked?: boolean;
  personId?: string | null;
  person?: { firstName?: string | null; lastName?: string | null } | null;
  roles?: TitanRole[];
  companyId?: string | null;
  companyName?: string | null;
}

export interface TitanContact {
  value: string;
  isPrimary?: boolean;
  contactType?: { value?: string | null; code?: string | null } | null;
  phoneType?: { value?: string | null; code?: string | null } | null;
}

export class TitanApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class TitanClient {
  private token: string | null = null;

  constructor(private readonly creds: TitanCredentials) {}

  /** Login del usuario técnico. Falla con un mensaje entendible si Titan pide MFA. */
  async login(): Promise<void> {
    const body = (await this.send('POST', '/api/auth/login', {
      email: this.creds.email,
      password: this.creds.password,
    })) as
      { accessToken?: string; requiresMfaVerification?: boolean } | undefined;

    if (body?.requiresMfaVerification) {
      throw new TitanApiError(
        'Titan pide verificación MFA para el usuario técnico. Usá un usuario técnico sin MFA ' +
          '(sin persona/empleado asociado, o en una empresa cuya política no exija MFA).',
      );
    }
    if (!body?.accessToken) {
      throw new TitanApiError('Titan no devolvió un accessToken en el login');
    }
    this.token = body.accessToken;
  }

  /** Cierra la sesión del usuario técnico. Nunca tira: es limpieza best-effort. */
  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.send('POST', '/api/auth/logout');
    } catch {
      // La sesión vence sola; no vale la pena hacer fallar la importación por esto.
    } finally {
      this.token = null;
    }
  }

  async listUsers(): Promise<TitanUser[]> {
    const body = await this.send('GET', '/api/users');
    if (!Array.isArray(body)) {
      throw new TitanApiError(
        'Respuesta inesperada de GET /api/users (no es una lista)',
      );
    }
    return body as TitanUser[];
  }

  async listContacts(personId: string): Promise<TitanContact[]> {
    const body = await this.send(
      'GET',
      `/api/person-contacts/by-person/${encodeURIComponent(personId)}`,
    );
    return Array.isArray(body) ? (body as TitanContact[]) : [];
  }

  private async send(
    method: string,
    path: string,
    json?: unknown,
    attempt = 0,
  ): Promise<unknown> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new TitanApiError(
        `No se pudo contactar TitanHR (${url}): ${(err as Error).message}`,
      );
    }

    // Rate limit de Titan (300 req/min por IP en /api): un reintento con espera alcanza
    // para las ráfagas de contactos de una importación grande.
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 5_000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000)));
      return this.send(method, path, json, attempt + 1);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      const errBody = parsed as
        { message?: string; error?: string } | undefined;
      const detail =
        errBody?.message ||
        errBody?.error ||
        this.sanitize(text).slice(0, MAX_ERROR_LEN);
      throw new TitanApiError(
        `TitanHR respondió ${res.status} en ${method} ${path}: ${detail}`,
        res.status,
      );
    }
    if (parsed === undefined && text) {
      throw new TitanApiError(
        `TitanHR devolvió algo que no es JSON en ${method} ${path}. ¿Es correcta la URL base?`,
      );
    }
    return parsed;
  }

  /** Ni la contraseña ni el token del usuario técnico pueden terminar en un mensaje de error. */
  private sanitize(text: string): string {
    let out = text;
    for (const secret of [this.creds.password, this.token]) {
      if (secret) out = out.split(secret).join('***REDACTED***');
    }
    return out;
  }
}
