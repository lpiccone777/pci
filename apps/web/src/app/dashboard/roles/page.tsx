'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { ALL_TENANTS } from '@/lib/system-tenant';

interface CatalogEntry {
  key: string;
  label: string;
}

interface Catalog {
  resources: CatalogEntry[];
  actions: CatalogEntry[];
  total: number;
}

interface RolePermissionData {
  id: string;
  resource: string;
  action: string;
}

interface RoleRow {
  id: string;
  name: string;
  permissions: RolePermissionData[];
  /** Cuántos usuarios tienen el rol. Bloquea el borrado. */
  userCount: number;
  /** Solo los permisos del catálogo: es lo que muestra la matriz. */
  permissionCount: number;
  /**
   * El superusuario del sistema: tiene todos los permisos de forma permanente y el backend
   * rechaza modificarlo, renombrarlo o eliminarlo. Se muestra en modo consulta.
   */
  isProtected: boolean;
  /** Solo en la vista "Todas las empresas": a qué empresa pertenece el rol. */
  tenant?: { id: string; name: string; slug: string };
}

interface RoleUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

type Feedback = { kind: 'ok' | 'error'; text: string };

const permKey = (resource: string, action: string) => `${resource}:${action}`;

function splitKey(key: string) {
  const [resource, action] = key.split(':');
  return { resource, action };
}

/** "1 usuario tiene este rol." / "6 usuarios tienen este rol." */
function usersPhrase(count: number) {
  if (count === 0) return 'Ningún usuario tiene este rol.';
  return count === 1 ? '1 usuario tiene este rol.' : `${count} usuarios tienen este rol.`;
}

export default function RolesPage() {
  const { hasPermission, hasPermissionInTenant, user, activeTenant, isSystemUser } = useAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * null = cerrado. `mode` distingue abrir para ver (clic en la fila, arranca en solo
   * lectura) de abrir para editar (botón Editar / alta). `role: null` = alta.
   */
  const [editing, setEditing] = useState<{
    role: RoleRow | null;
    mode: 'view' | 'edit';
  } | null>(null);
  const [viewingUsers, setViewingUsers] = useState<RoleRow | null>(null);

  // Vista consolidada "Todas las empresas": el superadmin ve los roles de todo el sistema
  // (`/roles/all`); el usuario común con varias empresas, solo los de las suyas (`/roles/mine`).
  // Antes era exclusiva del superadmin y de solo lectura; ahora ambos pueden modificar y
  // eliminar por fila (cada acción va contra la empresa de esa fila), pero el alta sigue
  // apagada: para crear hay que pararse en una empresa puntual.
  const isAllTenants = activeTenant === ALL_TENANTS;

  const canCreate = hasPermission('roles', 'create') && !isAllTenants;
  const canUpdateRole = hasPermission('roles', 'update') && !isAllTenants;
  const canDelete = hasPermission('roles', 'delete') && !isAllTenants;
  const canUpdatePerms = hasPermission('permissions', 'update') && !isAllTenants;

  // En la vista consolidada, cada fila es de una empresa distinta: el permiso se evalúa contra
  // esa empresa (el superadmin que opera sobre una empresa ajena cae a su rol de sistema). En
  // una empresa puntual manda el permiso del tenant activo, ya resuelto arriba.
  const rowCanUpdateRole = (r: RoleRow) =>
    isAllTenants ? hasPermissionInTenant(r.tenant?.id ?? '', 'roles', 'update') : canUpdateRole;
  const rowCanUpdatePerms = (r: RoleRow) =>
    isAllTenants
      ? hasPermissionInTenant(r.tenant?.id ?? '', 'permissions', 'update')
      : canUpdatePerms;
  const rowCanDelete = (r: RoleRow) =>
    isAllTenants ? hasPermissionInTenant(r.tenant?.id ?? '', 'roles', 'delete') : canDelete;
  const rowCanEditSomething = (r: RoleRow) => rowCanUpdateRole(r) || rowCanUpdatePerms(r);

  /**
   * El rol del usuario en el tenant activo. Sirve para avisarle cuando está por editar
   * su propio rol: quitarse `roles:update` tiene efecto inmediato y lo deja afuera de
   * esta pantalla.
   */
  const ownRoleId = useMemo(() => {
    if (!user || !activeTenant) return null;
    return user.tenants?.find((t) => t.tenantId === activeTenant)?.role?.id ?? null;
  }, [user, activeTenant]);

  const load = useCallback(async () => {
    try {
      if (!isAllTenants) {
        const [catalogData, roleData] = await Promise.all([
          apiFetch('/roles/catalog'),
          apiFetch('/roles'),
        ]);
        setCatalog(catalogData);
        setRoles(roleData);
        return;
      }
      // Consolidada: el superadmin trae todo el sistema; el usuario común, solo sus empresas.
      const roleData = await apiFetch(isSystemUser ? '/roles/all' : '/roles/mine');
      setRoles(roleData);
      // El catálogo de permisos alimenta la matriz del modal de edición. `/roles/catalog` pide
      // `roles:read` en el tenant del header: para el superadmin la empresa de sistema alcanza,
      // pero la empresa de respaldo del usuario común puede no tenerlo, así que se pide contra
      // una empresa donde sí (la de cualquier rol visible). Sin roles visibles no hace falta.
      if (roleData.length > 0) {
        const headers =
          !isSystemUser && roleData[0]?.tenant?.id
            ? { headers: { 'X-Tenant-Id': roleData[0].tenant.id } }
            : undefined;
        setCatalog(await apiFetch('/roles/catalog', headers));
      }
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [isAllTenants, isSystemUser]);

  useEffect(() => {
    load();
  }, [load]);

  function openModal(role: RoleRow | null, mode: 'view' | 'edit') {
    setFeedback(null);
    setDeletingId(null);
    setEditing({ role, mode });
  }

  function openUsers(role: RoleRow) {
    setFeedback(null);
    setDeletingId(null);
    setViewingUsers(role);
  }

  /** El botón gris de un rol que no se puede borrar: responde al clic y explica por qué. */
  function explainBlockedDelete(role: RoleRow) {
    setDeletingId(null);
    setFeedback({
      kind: 'error',
      text: role.isProtected
        ? `${role.name} es el rol de superusuario del sistema: no se puede eliminar.`
        : `No se puede eliminar ${role.name}: ${role.userCount} ` +
          (role.userCount === 1
            ? 'usuario lo tiene asignado.'
            : 'usuarios lo tienen asignado.') +
          ' Reasignalos a otro rol desde Usuarios y volvé a intentar.',
    });
  }

  async function confirmDelete(role: RoleRow) {
    setBusy(true);
    try {
      const res = await apiFetch(`/roles/${role.id}`, {
        method: 'DELETE',
        // En la vista consolidada la baja va contra la empresa de la fila, no contra el header
        // del selector (que apunta al sistema / a la empresa de respaldo).
        ...(isAllTenants && role.tenant
          ? { headers: { 'X-Tenant-Id': role.tenant.id } }
          : {}),
      });
      setFeedback({ kind: 'ok', text: res?.message || `Rol ${role.name} eliminado.` });
      setDeletingId(null);
      await load();
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function afterSave(message: Feedback) {
    setEditing(null);
    setFeedback(message);
    await load();
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  return (
    <div>
      <div
        className={`flex items-center justify-between gap-4 ${
          isAllTenants ? 'mb-2' : 'mb-6'
        }`}
      >
        <h1 className="text-2xl font-bold text-gray-800">Roles</h1>
        {canCreate && (
          <button
            onClick={() => openModal(null, 'edit')}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 whitespace-nowrap"
          >
            Nuevo rol
          </button>
        )}
      </div>

      {isAllTenants && (
        <p className="text-sm text-gray-500 mb-6">
          Roles de {isSystemUser ? 'todas las empresas' : 'todas tus empresas'}. Podés modificar
          o eliminar cada uno en su empresa; para crear uno nuevo, elegí una empresa en el
          selector lateral.
        </p>
      )}

      {feedback && (
        <p
          className={`mb-4 ${feedback.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}
        >
          {feedback.text}
        </p>
      )}

      {roles.length === 0 && canCreate && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4 text-sm">
          Todavía no hay roles en esta empresa. Creá el primero para poder dar de alta
          usuarios.
        </p>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              {isAllTenants && (
                <th className="text-left px-4 py-2 font-semibold">Empresa</th>
              )}
              <th className="text-left px-4 py-2 font-semibold">Rol</th>
              <th className="text-right px-4 py-2 font-semibold whitespace-nowrap">
                Usuarios
              </th>
              <th className="text-right px-4 py-2 font-semibold whitespace-nowrap">
                Permisos
              </th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 && (
              <tr>
                <td colSpan={isAllTenants ? 5 : 4} className="px-4 py-6 text-center text-gray-400">
                  <p className="mb-3">
                    {isAllTenants
                      ? 'No hay roles para mostrar.'
                      : 'Todavía no hay roles en esta empresa.'}
                  </p>
                  {canCreate && (
                    <button
                      onClick={() => openModal(null, 'edit')}
                      className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                    >
                      Crear el primero
                    </button>
                  )}
                </td>
              </tr>
            )}

            {roles.map((role) =>
              deletingId === role.id ? (
                <tr key={role.id} className="border-t bg-red-50">
                  <td colSpan={isAllTenants ? 5 : 4} className="px-4 py-2">
                    <div className="flex gap-2 items-center flex-wrap">
                      <span className="text-red-700 mr-1">
                        ¿Eliminar el rol <b>{role.name}</b>
                        {isAllTenants && role.tenant ? (
                          <>
                            {' '}
                            de <b>{role.tenant.name}</b>
                          </>
                        ) : null}
                        ? Esta acción no se puede deshacer.
                      </span>
                      <button
                        onClick={() => confirmDelete(role)}
                        disabled={busy}
                        className="bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:bg-gray-300"
                      >
                        {busy ? 'Eliminando...' : 'Sí, eliminar'}
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        disabled={busy}
                        className="text-gray-600 px-3 py-1.5 rounded hover:bg-gray-100"
                      >
                        Cancelar
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr
                  key={role.id}
                  onClick={() => openModal(role, 'view')}
                  className="border-t hover:bg-gray-50 cursor-pointer"
                  title="Ver detalle"
                >
                  {isAllTenants && (
                    <td className="px-4 py-2 text-gray-500">{role.tenant?.name ?? '—'}</td>
                  )}
                  <td className="px-4 py-2">
                    <span className="font-medium">{role.name}</span>
                    {role.isProtected && (
                      <span
                        title="Superusuario del sistema: tiene todos los permisos de forma permanente y no se puede modificar"
                        className="ml-2 align-middle text-[11px] uppercase tracking-wider text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5"
                      >
                        Rol del sistema
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {/* El número ES el acceso a la lista: el dato y la forma de abrirlo
                        son la misma cosa, así que no lleva un botón aparte. stopPropagation
                        para que abrir la lista no dispare también el detalle de la fila. En
                        "Todas las empresas" el drill-down pega contra un endpoint scopeado a
                        la empresa activa, así que ahí el número va como texto plano. */}
                    {isAllTenants ? (
                      <span className="tabular-nums">{role.userCount}</span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openUsers(role);
                        }}
                        title={`Ver los usuarios con el rol ${role.name}`}
                        className="text-blue-600 hover:text-blue-800 hover:underline tabular-nums"
                      >
                        {role.userCount}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {role.permissionCount === 0 ? (
                      <span
                        className="text-amber-700"
                        title="Este rol no habilita nada todavía"
                      >
                        sin permisos
                      </span>
                    ) : (
                      <span className="text-gray-600 tabular-nums">
                        {role.permissionCount}
                      </span>
                    )}
                  </td>
                  <td className="px-4 text-right whitespace-nowrap">
                    {/* Fuera de la zona que abre el detalle va SOLO el grupo de botones. El
                        stopPropagation vive en este contenedor, que se lleva el padding vertical
                        (py-2) para ocupar el alto completo de la fila. El botón "Editar" solo
                        aparece para quien puede editar y no es el rol de sistema; los demás ven
                        el rol clickeando la fila. title="" evita heredar el tooltip del <tr>. */}
                    <span
                      className="inline-block align-middle py-2 pl-0.5 cursor-default"
                      onClick={(e) => e.stopPropagation()}
                      title=""
                    >
                      {rowCanEditSomething(role) && !role.isProtected && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openModal(role, 'edit');
                          }}
                          className="text-blue-600 hover:text-blue-800 px-2"
                        >
                          Editar
                        </button>
                      )}
                      {rowCanDelete(role) &&
                        (role.userCount === 0 && !role.isProtected ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFeedback(null);
                              setDeletingId(role.id);
                            }}
                            className="text-red-600 hover:text-red-800 px-2"
                          >
                            Borrar
                          </button>
                        ) : (
                          // aria-disabled y no disabled: con `disabled` de verdad, quien
                          // navega por teclado ni siquiera lo encuentra, y en pantalla
                          // táctil no hay hover que muestre el motivo.
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              explainBlockedDelete(role);
                            }}
                            aria-disabled="true"
                            title={
                              role.isProtected
                                ? 'No se puede eliminar: es el rol de superusuario del sistema'
                                : `No se puede eliminar: tiene ${role.userCount} ${
                                    role.userCount === 1
                                      ? 'usuario asignado'
                                      : 'usuarios asignados'
                                  }`
                            }
                            className="text-gray-400 hover:text-gray-500 cursor-not-allowed px-2"
                          >
                            Borrar
                          </button>
                        ))}
                    </span>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {editing && catalog && (
        <RoleModal
          role={editing.role}
          catalog={catalog}
          initialEdit={editing.mode === 'edit'}
          isAllTenants={isAllTenants}
          // En la vista consolidada, el guardado (nombre y permisos) va contra la empresa del rol.
          tenantHeader={isAllTenants ? editing.role?.tenant?.id : undefined}
          // El rol del sistema anula cualquier permiso de edición: el backend lo rechaza
          // igual, y dejar la matriz activa sería prometer algo que va a fallar al guardar.
          // En la vista consolidada los permisos se evalúan contra la empresa del rol.
          canEditName={
            !editing.role?.isProtected &&
            (editing.role ? rowCanUpdateRole(editing.role) : canCreate)
          }
          canEditPerms={
            !editing.role?.isProtected &&
            (editing.role ? rowCanUpdatePerms(editing.role) : canUpdatePerms)
          }
          isProtected={!!editing.role?.isProtected}
          isOwnRole={!!editing.role && editing.role.id === ownRoleId}
          otherNames={roles
            .filter((r) => r.id !== editing.role?.id)
            // El nombre es único por empresa: en la vista consolidada solo chocan los de la
            // misma empresa que se está editando.
            .filter((r) => !isAllTenants || r.tenant?.id === editing.role?.tenant?.id)
            .map((r) => r.name)}
          onClose={() => setEditing(null)}
          onSaved={afterSave}
        />
      )}

      {viewingUsers && (
        <UsersModal role={viewingUsers} onClose={() => setViewingUsers(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de rol: un solo formulario para crear y para editar         */
/* ------------------------------------------------------------------ */

function RoleModal({
  role,
  catalog,
  initialEdit,
  isAllTenants,
  tenantHeader,
  canEditName,
  canEditPerms,
  isProtected,
  isOwnRole,
  otherNames,
  onClose,
  onSaved,
}: {
  role: RoleRow | null;
  catalog: Catalog;
  initialEdit: boolean;
  isAllTenants: boolean;
  /** Empresa a la que dirigir el guardado (header `X-Tenant-Id`), solo en la vista consolidada. */
  tenantHeader?: string;
  canEditName: boolean;
  canEditPerms: boolean;
  isProtected: boolean;
  isOwnRole: boolean;
  otherNames: string[];
  onClose: () => void;
  onSaved: (message: Feedback) => void;
}) {
  const allKeys = useMemo(
    () =>
      catalog.resources.flatMap((r) =>
        catalog.actions.map((a) => permKey(r.key, a.key)),
      ),
    [catalog],
  );

  /** Solo los permisos del catálogo. Los cargados a mano fuera de catálogo no se
      muestran ni se tocan: el PUT del backend los deja donde están. */
  const basePerms = useMemo(() => {
    const known = new Set(allKeys);
    return new Set(
      (role?.permissions ?? [])
        .map((p) => permKey(p.resource, p.action))
        .filter((k) => known.has(k)),
    );
  }, [role, allKeys]);

  const baseName = role?.name ?? '';

  const [name, setName] = useState(baseName);
  const [perms, setPerms] = useState<Set<string>>(() => new Set(basePerms));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState(initialEdit);

  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const permsChanged = allKeys.some((k) => perms.has(k) !== basePerms.has(k));
  const changeCount =
    allKeys.filter((k) => perms.has(k) !== basePerms.has(k)).length +
    (name.trim() !== baseName ? 1 : 0);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (changeCount > 0 && !confirm('Tenés cambios sin guardar. ¿Descartarlos?')) return;
    onClose();
  }, [saving, changeCount, onClose]);

  // Escape se escucha en document y no en el div: si el foco quedó fuera del modal
  // —por un clic en el fondo, por ejemplo— el evento nunca burbujearía hasta acá.
  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      }
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [requestClose]);

  /** Ver es condición para las demás acciones del mismo recurso. */
  function normalize(next: Set<string>, resource: string) {
    const needsRead = catalog.actions.some(
      (a) => a.key !== 'read' && next.has(permKey(resource, a.key)),
    );
    if (needsRead) next.add(permKey(resource, 'read'));
  }

  function toggle(resource: string, action: string, on: boolean) {
    const next = new Set(perms);
    const key = permKey(resource, action);
    if (on) next.add(key);
    else next.delete(key);
    normalize(next, resource);
    setPerms(next);
  }

  function toggleRow(resource: string) {
    const next = new Set(perms);
    const full = catalog.actions.every((a) => next.has(permKey(resource, a.key)));
    catalog.actions.forEach((a) => {
      if (full) next.delete(permKey(resource, a.key));
      else next.add(permKey(resource, a.key));
    });
    setPerms(next);
  }

  function toggleCol(action: string) {
    const next = new Set(perms);
    const full = catalog.resources.every((r) => next.has(permKey(r.key, action)));
    catalog.resources.forEach((r) => {
      if (full) next.delete(permKey(r.key, action));
      else next.add(permKey(r.key, action));
      normalize(next, r.key);
    });
    setPerms(next);
  }

  function toggleAll() {
    setPerms(perms.size === allKeys.length ? new Set() : new Set(allKeys));
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('El rol necesita un nombre.');
      nameRef.current?.focus();
      return;
    }
    if (otherNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      setError(`Ya existe un rol llamado ${trimmed} en esta empresa.`);
      nameRef.current?.focus();
      return;
    }

    setSaving(true);
    setError('');

    // Nombre y permisos son dos llamadas porque exigen permisos distintos: roles:* para
    // el rol, permissions:update para la matriz. Van en orden y solo las necesarias.
    try {
      let roleId = role?.id;
      let justCreated = false;

      if (!role) {
        const created = await apiFetch('/roles', {
          method: 'POST',
          body: JSON.stringify({ name: trimmed }),
        });
        roleId = created.id;
        justCreated = true;
      } else if (trimmed !== baseName) {
        await apiFetch(`/roles/${role.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: trimmed }),
          // En la vista consolidada el guardado va contra la empresa del rol, no contra el
          // header del selector.
          ...(tenantHeader ? { headers: { 'X-Tenant-Id': tenantHeader } } : {}),
        });
      }

      if (permsChanged && canEditPerms) {
        const payload = [...perms].map(splitKey);
        try {
          await apiFetch(`/roles/${roleId}/permissions`, {
            method: 'PUT',
            body: JSON.stringify({ permissions: payload }),
            ...(tenantHeader ? { headers: { 'X-Tenant-Id': tenantHeader } } : {}),
          });
        } catch (permErr: any) {
          if (justCreated) {
            // El rol ya existe: cerrar informando el estado real, en vez de dejar la
            // ventana abierta sugiriendo que no se guardó nada.
            onSaved({
              kind: 'error',
              text: `El rol ${trimmed} se creó, pero sus permisos no se guardaron: ${permErr.message} Editalo para reintentar.`,
            });
            return;
          }
          throw permErr;
        }
      }

      const total = perms.size;
      if (justCreated) {
        onSaved({
          kind: 'ok',
          text:
            total === 0
              ? `Rol ${trimmed} creado, todavía sin permisos.`
              : `Rol ${trimmed} creado con ${total} permisos.`,
        });
      } else {
        const renamed = trimmed !== baseName;
        onSaved({
          kind: 'ok',
          text:
            `Rol ${trimmed} guardado` +
            (renamed ? ' — nombre actualizado, ' : ' — ') +
            `${total} permisos activos.`,
        });
      }
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  /** Mantiene el foco adentro del modal mientras esté abierto. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled)',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * `editMode` distingue ver de editar. La ventana se abre en modo consulta al clickear la
   * fila (`initialEdit=false`) y directo en edición desde el botón Editar o el alta
   * (`initialEdit=true`). El botón "Editar" del pie pasa de una a otra.
   *
   * Los permisos reales siguen mandando: un rol de sistema o quien solo puede leer nunca
   * habilita los campos —de hecho a esos el botón "Editar" ni les aparece—. `nameEditable`
   * y `permsEditable` combinan permiso y modo; `canEditAnything` resume si hay algo editable.
   */
  const canEditAnything = canEditName || canEditPerms;
  const nameEditable = canEditName && editMode;
  const permsEditable = canEditPerms && editMode;

  const saveDisabled = saving || (role !== null && changeCount === 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-modal-title"
    >
      <div
        ref={dialogRef}
        className="bg-white rounded-md shadow-2xl w-full max-w-[720px] max-h-full flex flex-col text-gray-900"
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="role-modal-title" className="text-lg font-semibold text-gray-800 mb-3">
              {role === null
                ? 'Nuevo rol'
                : editMode
                  ? 'Editar rol'
                  : isProtected
                    ? 'Rol del sistema'
                    : role.name}
            </h2>
            {isAllTenants && role?.tenant && (
              <p className="-mt-2 mb-3 text-xs text-gray-500">
                Empresa: <span className="text-gray-700">{role.tenant.name}</span>
              </p>
            )}
            <label htmlFor="role-name" className="block text-xs text-gray-500 mb-1">
              Nombre del rol *
            </label>
            <input
              id="role-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save();
                }
              }}
              disabled={!nameEditable || saving}
              autoComplete="off"
              placeholder="Ej: Supervisor"
              className="w-full max-w-[340px] border border-gray-200 px-3 py-2 rounded disabled:bg-gray-100"
            />
            <p className="mt-2 text-xs text-gray-500">
              {role
                ? usersPhrase(role.userCount)
                : 'Marcá abajo qué va a poder hacer quien tenga este rol.'}
            </p>
          </div>
          <button
            onClick={requestClose}
            aria-label="Cerrar"
            className="text-xl leading-none text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {isProtected && (
            <p className="text-gray-700 bg-gray-50 border border-gray-200 rounded px-3 py-2 mb-3 text-sm">
              Rol de superusuario del sistema. Tiene todos los permisos de forma permanente:
              no se puede modificar, renombrar ni eliminar. Los permisos que se agreguen al
              sistema más adelante también los va a tener, sin que haya que hacer nada.
            </p>
          )}
          {/* En modo consulta el aviso no aplica: no hay forma de quitarse nada. */}
          {isOwnRole && editMode && (
            <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3 text-sm">
              Este es tu rol. Si te quitás el permiso de modificar roles vas a perder el
              acceso a esta pantalla.
            </p>
          )}
          {editMode && !canEditPerms && !isProtected && (
            <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3 text-sm">
              No tenés permiso para modificar permisos. La matriz se muestra como consulta.
            </p>
          )}

          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Permisos</h3>
            <span className="text-xs text-gray-500 tabular-nums">
              {perms.size} de {catalog.total} permisos activos
              {perms.size === catalog.total ? ' · acceso total' : ''}
            </span>
          </div>

          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="text-left px-2 py-1.5 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-200">
                  Recurso
                </th>
                {catalog.actions.map((a) => (
                  <th
                    key={a.key}
                    className="px-2 py-1.5 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-200"
                  >
                    <button
                      onClick={() => toggleCol(a.key)}
                      disabled={!permsEditable}
                      className="underline decoration-dotted decoration-gray-300 underline-offset-[3px] hover:bg-blue-50 hover:decoration-blue-600 rounded px-1 disabled:no-underline disabled:cursor-not-allowed"
                    >
                      {a.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th className="text-left px-2 py-1.5 font-semibold text-gray-800 border-b border-gray-300 whitespace-nowrap">
                  <button
                    onClick={toggleAll}
                    disabled={!permsEditable}
                    className="underline decoration-dotted decoration-gray-300 underline-offset-[3px] hover:bg-blue-50 hover:decoration-blue-600 rounded px-1 disabled:no-underline disabled:cursor-not-allowed"
                  >
                    Todos los recursos
                  </button>
                </th>
                {catalog.actions.map((a) => {
                  const full = catalog.resources.every((r) =>
                    perms.has(permKey(r.key, a.key)),
                  );
                  return (
                    <td
                      key={a.key}
                      className="text-center px-2 py-1.5 border-b border-gray-300"
                    >
                      <input
                        type="checkbox"
                        checked={full}
                        onChange={() => toggleCol(a.key)}
                        disabled={!permsEditable}
                        aria-label={`Toda la columna ${a.label}`}
                        className="w-4 h-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
                      />
                    </td>
                  );
                })}
              </tr>

              {catalog.resources.map((r) => (
                <tr key={r.key} className="hover:bg-gray-50">
                  <th className="text-left px-2 py-1.5 font-normal text-gray-700 border-b border-gray-100 whitespace-nowrap">
                    <button
                      onClick={() => toggleRow(r.key)}
                      disabled={!permsEditable}
                      className="underline decoration-dotted decoration-gray-300 underline-offset-[3px] hover:bg-blue-50 hover:decoration-blue-600 rounded px-1 disabled:no-underline disabled:cursor-not-allowed"
                    >
                      {r.label}
                    </button>
                  </th>
                  {catalog.actions.map((a) => {
                    const key = permKey(r.key, a.key);
                    const on = perms.has(key);
                    const changed = on !== basePerms.has(key);
                    // `read` queda bloqueada mientras la fila tenga otra acción activa:
                    // sin poder ver la pantalla, modificar no sirve de nada.
                    const forced =
                      a.key === 'read' &&
                      catalog.actions.some(
                        (x) => x.key !== 'read' && perms.has(permKey(r.key, x.key)),
                      );
                    return (
                      <td
                        key={a.key}
                        className={`text-center px-2 py-1.5 border-b border-gray-100 ${
                          changed ? 'bg-blue-50' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => toggle(r.key, a.key, e.target.checked)}
                          disabled={forced || !permsEditable}
                          aria-label={`${a.label} ${r.label}`}
                          title={
                            forced
                              ? 'Necesario para las demás acciones de esta fila'
                              : undefined
                          }
                          className="w-4 h-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && (
          <p className="px-5 py-2 text-sm text-red-600 bg-red-50 border-t border-red-200">
            {error}
          </p>
        )}

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center gap-3 rounded-b-md">
          <span
            className={`flex-1 text-[13px] ${
              !editMode
                ? 'text-gray-500'
                : changeCount > 0
                  ? 'text-blue-700 font-medium'
                  : perms.size === 0
                    ? 'text-amber-700'
                    : 'text-gray-500'
            }`}
          >
            {!editMode
              ? ''
              : changeCount > 0
                ? changeCount === 1
                  ? '1 cambio sin guardar'
                  : `${changeCount} cambios sin guardar`
                : perms.size === 0
                  ? 'Sin permisos: quien tenga este rol no va a poder hacer nada.'
                  : 'Sin cambios.'}
          </span>
          {editMode ? (
            <>
              {/* En edición el botón secundario cancela; el primario guarda. */}
              <button
                onClick={requestClose}
                disabled={saving}
                className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={saveDisabled}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
              >
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </>
          ) : (
            <>
              {/* En consulta, "Editar" pasa a modo edición —solo si hay algo para editar—;
                  el rol de sistema y quien solo puede leer se quedan sin él. */}
              {canEditAnything && (
                <button
                  onClick={() => setEditMode(true)}
                  className="text-blue-600 px-4 py-2 rounded hover:bg-blue-50 whitespace-nowrap"
                >
                  Editar
                </button>
              )}
              <button
                onClick={requestClose}
                disabled={saving}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de usuarios del rol                                         */
/* ------------------------------------------------------------------ */

function UsersModal({ role, onClose }: { role: RoleRow; onClose: () => void }) {
  const router = useRouter();
  const [people, setPeople] = useState<RoleUser[] | null>(null);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    apiFetch(`/roles/${role.id}/users`)
      .then(setPeople)
      .catch((err: any) => setError(err.message));
  }, [role.id]);

  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="users-modal-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[520px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="users-modal-title" className="text-lg font-semibold text-gray-800">
              Usuarios con el rol {role.name}
            </h2>
            <p className="mt-2 text-xs text-gray-500">
              {role.userCount === 0
                ? 'Ningún usuario tiene este rol.'
                : role.userCount === 1
                  ? '1 usuario'
                  : `${role.userCount} usuarios`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="text-xl leading-none text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {error && <p className="text-red-500 text-sm">{error}</p>}

          {!error && people === null && <p className="text-gray-500 text-sm">Cargando...</p>}

          {!error && people !== null && people.length === 0 && (
            <p className="py-6 text-center text-sm text-gray-400">
              Nadie tiene este rol todavía.
              <br />
              Por eso se puede eliminar sin dejar a nadie sin acceso.
            </p>
          )}

          {!error && people !== null && people.length > 0 && (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-200">
                    Nombre
                  </th>
                  <th className="text-left px-2 py-1.5 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-200">
                    Email
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 border-b border-gray-100">
                      {[p.firstName, p.lastName].filter(Boolean).join(' ') || '-'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-gray-100 text-gray-500">
                      {p.email}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center gap-3 rounded-b-md">
          <span className="flex-1 text-[13px] text-gray-500">
            {people && people.length > 0 ? 'El rol se cambia desde cada usuario.' : ''}
          </span>
          <button
            onClick={() => router.push('/dashboard/users')}
            className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100 whitespace-nowrap"
          >
            Ir a Usuarios
          </button>
          <button
            ref={closeRef}
            onClick={onClose}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
