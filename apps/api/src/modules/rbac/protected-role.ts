/**
 * El rol de superusuario del sistema: cómo se identifica y por qué es intocable.
 *
 * Hay exactamente un rol protegido en todo el sistema: el llamado `SuperAdmin` dentro del
 * tenant de sistema. Tiene siempre el catálogo completo de permisos, y ni sus permisos, ni
 * su nombre, ni su existencia se pueden cambiar desde la API.
 *
 * **No lleva marca en la base a propósito.** El proyecto ya decide qué es "del sistema"
 * comparando el slug del tenant contra `SYSTEM_TENANT_SLUG` (ver `SystemTenantGuard`), y
 * este es el mismo criterio: una columna nueva en `Role` para un rol único no justifica una
 * migración. El costo asumido es que la protección depende de dos textos: si alguien cambia
 * `SYSTEM_TENANT_SLUG` a un slug que no existe, este rol deja de estar protegido. En la
 * práctica eso ya rompería antes el acceso a `/settings` y a `GET /tenants/all`, que cortan
 * por el mismo slug, así que no pasa desapercibido.
 *
 * El nombre es constante y no variable de entorno por la misma razón: cada variable es otra
 * forma de apagar la protección sin querer. Como renombrar el rol está bloqueado, el nombre
 * no se puede desviar.
 *
 * TypeScript puro, sin nada de Nest: `prisma/seed.ts` lo importa y corre con ts-node.
 */

import { CATALOG_PERMISSIONS, CatalogPermission } from './permissions.catalog';

/** El único rol protegido del sistema. Ver el comentario de arriba antes de cambiarlo. */
export const SUPERADMIN_ROLE_NAME = 'SuperAdmin';

/**
 * Default del slug del tenant de sistema, para cuando `SYSTEM_TENANT_SLUG` no está definida.
 *
 * Duplicado conocido: `SystemTenantGuard` tiene el mismo literal, y el frontend otro más en
 * `NEXT_PUBLIC_SYSTEM_TENANT_SLUG`. Los tres tienen que decir lo mismo.
 */
export const DEFAULT_SYSTEM_TENANT_SLUG = 'system';

/**
 * `true` si el rol es el superusuario del sistema.
 *
 * Función pura y sin consultas: quien la llama ya tiene el rol y el slug de su tenant a mano
 * —`RoleService` los trae juntos en la misma consulta—, así que identificar el rol protegido
 * no cuesta ni un viaje más a la base.
 */
export function isProtectedRole(
  roleName: string,
  tenantSlug: string,
  systemSlug: string,
): boolean {
  return roleName === SUPERADMIN_ROLE_NAME && tenantSlug === systemSlug;
}

/**
 * Los permisos que hay que informar para un rol.
 *
 * Para el superusuario del sistema devuelve **el catálogo completo**, sin mirar qué filas
 * tiene guardadas: tiene todos los permisos siempre, incluidos los que se agreguen mañana.
 * Antes eso dependía de correr el seed en cada entorno, y hasta que alguien se acordaba el
 * superusuario quedaba sin el permiso nuevo — y como el rol está bloqueado en la pantalla,
 * el arreglo solo se podía hacer por consola.
 *
 * Para cualquier otro rol devuelve sus filas tal cual: ahí la base sí es la verdad.
 *
 * **Toda lectura de los permisos de un rol tiene que pasar por acá** — el guard de
 * permisos, `/auth/me`, la respuesta del listado de roles y la lectura de permisos por
 * rol. Un lugar que se olvide muestra las filas guardadas: queda desactualizado, no roto,
 * porque el seed las sigue cargando.
 */
export function effectivePermissions<T extends CatalogPermission>(
  roleName: string,
  tenantSlug: string,
  systemSlug: string,
  stored: T[],
): (T | CatalogPermission)[] {
  if (!isProtectedRole(roleName, tenantSlug, systemSlug)) return stored;
  return [...CATALOG_PERMISSIONS];
}
