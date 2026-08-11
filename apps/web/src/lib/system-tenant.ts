/**
 * Slug de la empresa de sistema. Tiene que coincidir con `SYSTEM_TENANT_SLUG` del backend
 * (ver `protected-role.ts` y `SystemTenantGuard`).
 *
 * Vive acá y no en cada componente para que el frontend lo diga en un solo lugar: de
 * pertenecer a esta empresa dependen tres cosas —el ítem Configuración del menú, el
 * selector de empresas y la resolución de permisos fuera de la empresa propia—, y con el
 * literal repetido alcanzaba con cambiar una para que las otras dejaran de coincidir.
 */
export const SYSTEM_TENANT_SLUG =
  process.env.NEXT_PUBLIC_SYSTEM_TENANT_SLUG || 'system';

/**
 * Dónde se guarda el listado de empresas del selector del superusuario.
 *
 * `GET /tenants/all` solo se puede pedir parado en la empresa de sistema, así que la lista
 * se guarda al traerla: sin eso, apenas salta a otra empresa el selector se quedaría sin
 * opciones y no habría forma de volver. Se limpia al cerrar sesión.
 */
export const ALL_TENANTS_CACHE_KEY = 'allTenants';

/**
 * Valor centinela del selector para "Todas las empresas" (vista consolidada de solo
 * lectura del superusuario). No es el id de ninguna empresa: viaja como tenant activo, y
 * `apiFetch` lo traduce al id de la empresa de sistema en el header `X-Tenant-Id` (que es
 * lo que exige `SystemTenantGuard` en el backend para los endpoints cross-tenant `/all`).
 */
export const ALL_TENANTS = '__all__';

/**
 * Dónde se guarda el id de la empresa de sistema. Lo escribe `use-auth` al resolver el
 * usuario y lo lee `apiFetch` para traducir el centinela `ALL_TENANTS`. Se limpia al cerrar
 * sesión.
 */
export const SYSTEM_TENANT_ID_KEY = 'systemTenantId';
