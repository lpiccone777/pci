/**
 * Catálogo de permisos asignables a un rol.
 *
 * `RolePermission.resource` y `.action` son texto libre en la base, así que sin una
 * lista cerrada un typo como `usuario` en lugar de `usuarios` se guarda sin error, se
 * muestra en la pantalla como si funcionara y no habilita nada: nadie se entera hasta
 * que alguien reporta que no puede entrar a algo. Este catálogo es la única fuente de
 * verdad de qué pares son válidos — `PermissionService` rechaza cualquier otro y la
 * matriz del backoffice se dibuja a partir de acá.
 *
 * Mismo criterio que `settings.catalog.ts` para la tabla `Setting`.
 *
 * Los `key` de recurso y acción tienen que coincidir **exactamente** con los strings de
 * los `@RequirePermission(...)` de los controladores: `RolesGuard` compara por igualdad
 * literal, sin normalizar nada.
 *
 * Los permisos que ya estén en la base y no figuren acá quedan intactos: no se muestran
 * en la matriz, no se cuentan y el reemplazo masivo no los toca (ver `replaceForRole`).
 */

export interface PermissionResource {
  key: string;
  /** Etiqueta legible para la matriz del backoffice. */
  label: string;
}

export interface PermissionAction {
  key: string;
  label: string;
}

/**
 * Los 14 recursos del sistema.
 *
 * Hoy solo `users`, `tenants`, `roles`, `permissions`, `areas`, `settings`, `flows`
 * y `context-sources` protegen alguna operación con `@RequirePermission`. El resto se
 * declara igual: son los módulos que todavía no se protegieron, y tener el permiso
 * disponible antes evita tener que repartirlo a mano el día que se protejan.
 *
 * El orden es el que se ve en la matriz.
 */
export const PERMISSION_RESOURCES: readonly PermissionResource[] = [
  { key: 'users', label: 'Usuarios' },
  { key: 'tenants', label: 'Empresas' },
  { key: 'areas', label: 'Áreas' },
  { key: 'roles', label: 'Roles' },
  { key: 'permissions', label: 'Permisos' },
  { key: 'devices', label: 'Dispositivos' },
  { key: 'conversations', label: 'Conversaciones' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'metrics', label: 'Métricas' },
  { key: 'settings', label: 'Configuración' },
  { key: 'channels', label: 'Canales' },
  { key: 'llm', label: 'Modelos de lenguaje' },
  { key: 'flows', label: 'Flujos IVR' },
  { key: 'context-sources', label: 'Fuentes de verdad' },
] as const;

/** Las 4 acciones CRUD. `read` va primera porque es la que habilita a las demás. */
export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  { key: 'read', label: 'Ver' },
  { key: 'create', label: 'Crear' },
  { key: 'update', label: 'Modificar' },
  { key: 'delete', label: 'Eliminar' },
] as const;

/** Cantidad de permisos asignables: 14 recursos × 4 acciones = 56. */
export const PERMISSION_TOTAL = PERMISSION_RESOURCES.length * PERMISSION_ACTIONS.length;

/** Un par recurso-acción, que es todo lo que hace falta para decidir si algo se permite. */
export interface CatalogPermission {
  resource: string;
  action: string;
}

/**
 * El catálogo entero como lista de pares.
 *
 * Es lo que se informa como permisos del rol de superusuario: los tiene todos siempre, sin
 * depender de que existan las filas correspondientes en la base. Ver `effectivePermissions`
 * en `protected-role.ts`.
 */
export const CATALOG_PERMISSIONS: readonly CatalogPermission[] =
  PERMISSION_RESOURCES.flatMap((r) =>
    PERMISSION_ACTIONS.map((a) => ({ resource: r.key, action: a.key })),
  );

const RESOURCE_KEYS = new Set(PERMISSION_RESOURCES.map((r) => r.key));
const ACTION_KEYS = new Set(PERMISSION_ACTIONS.map((a) => a.key));

/** Todos los recursos del catálogo. Para el `IN (...)` del reemplazo masivo. */
export const PERMISSION_RESOURCE_KEYS: string[] = PERMISSION_RESOURCES.map((r) => r.key);

/** Todas las acciones del catálogo. Para el `IN (...)` del reemplazo masivo. */
export const PERMISSION_ACTION_KEYS: string[] = PERMISSION_ACTIONS.map((a) => a.key);

/** `true` si el par existe en el catálogo. */
export function isValidPermission(resource: string, action: string): boolean {
  return RESOURCE_KEYS.has(resource) && ACTION_KEYS.has(action);
}

/**
 * `true` si el par pertenece al universo del catálogo (recurso *y* acción conocidos).
 *
 * Hoy equivale a `isValidPermission` porque el catálogo es el producto cartesiano
 * completo. Existe aparte porque expresa otra pregunta: `isValidPermission` decide si
 * algo se puede asignar, esta decide si un permiso ya guardado está bajo el control de
 * la pantalla o es de los que hay que dejar quietos. Si algún día el catálogo deja de
 * ser el producto completo, el reemplazo masivo tiene que seguir esta, no aquella.
 */
export function isCatalogedPermission(resource: string, action: string): boolean {
  return RESOURCE_KEYS.has(resource) && ACTION_KEYS.has(action);
}

/**
 * El catálogo tal como lo consume la matriz del backoffice.
 * Evita duplicar la lista de recursos y etiquetas en el frontend.
 */
export function getPermissionCatalog() {
  return {
    resources: PERMISSION_RESOURCES,
    actions: PERMISSION_ACTIONS,
    total: PERMISSION_TOTAL,
  };
}
