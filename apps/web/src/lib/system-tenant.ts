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
