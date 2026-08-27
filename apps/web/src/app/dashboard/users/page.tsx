'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { ALL_TENANTS, SYSTEM_TENANT_ID_KEY } from '@/lib/system-tenant';
import { ImportUsersModal } from './import-users-modal';

export interface RoleOption {
  id: string;
  name: string;
}

export interface AreaOption {
  id: string;
  name: string;
}

interface TenantOption {
  id: string;
  name: string;
  slug: string;
}

interface UserData {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  internalPhone: string | null;
  invgateUserId: string | null;
  createdAt: string;
  role: RoleOption | null;
  area: AreaOption | null;
  /** Solo en la vista "Todas las empresas": a qué empresa corresponde esta membresía. */
  tenant?: { id: string; name: string; slug: string };
}

export type Feedback = { kind: 'ok' | 'error'; text: string };

/** Cantidad de filas por página de la tabla. Fija: no hay pedido de que sea configurable. */
const PAGE_SIZE = 20;

/** El nombre visible de un usuario: nombre y apellido, o el email si no tiene. */
function userLabel(u: { firstName: string | null; lastName: string | null; email: string }) {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

/** La empresa a pre-seleccionar / a pedir la lista completa: comparte alta y edición. */
function useSystemTenantId() {
  return typeof window !== 'undefined'
    ? localStorage.getItem(SYSTEM_TENANT_ID_KEY)
    : null;
}

/**
 * Roles de una empresa, por su header. Sirve al superadmin (que puede pararse en cualquiera)
 * y al usuario común (en las suyas), sin depender de los endpoints `/by-tenant`, que son solo
 * del tenant de sistema. Devuelve [] ante error (sin permiso, empresa vacía) para no romper.
 */
export async function fetchRolesForTenant(tenantId: string): Promise<RoleOption[]> {
  try {
    const data = await apiFetch('/roles', { headers: { 'X-Tenant-Id': tenantId } });
    return (data || []).map((r: any) => ({ id: r.id, name: r.name }));
  } catch {
    return [];
  }
}

export async function fetchAreasForTenant(tenantId: string): Promise<AreaOption[]> {
  try {
    const data = await apiFetch('/areas', { headers: { 'X-Tenant-Id': tenantId } });
    return (data || []).map((a: any) => ({ id: a.id, name: a.name }));
  } catch {
    return [];
  }
}

/** Los cuatro campos únicos en todo el sistema. */
type GlobalField = 'email' | 'phone' | 'internalPhone' | 'invgateUserId';

/**
 * El usuario que ya ocupa un campo global. `canView` false = no se revela quién es (está en una
 * empresa que quien edita no administra), y ahí `userId` y `name` van en null.
 */
type FieldConflict = { canView: boolean; userId: string | null; name: string | null };

/**
 * Verifica en vivo si un campo global ya está en uso. Devuelve el conflicto (quién lo usa) o
 * null si está libre. Ante cualquier error (red, sin permiso) devuelve null: el chequeo en vivo
 * es solo un aviso temprano; el guardado revalida igual contra el backend.
 */
async function checkFieldAvailability(
  field: GlobalField,
  value: string,
  excludeUserId?: string,
): Promise<FieldConflict | null> {
  const v = value.trim();
  if (!v) return null;
  const params = new URLSearchParams({ field, value: v });
  if (excludeUserId) params.set('excludeUserId', excludeUserId);
  try {
    const res = await apiFetch(`/users/check-availability?${params.toString()}`);
    return res.available ? null : (res.conflict as FieldConflict);
  } catch {
    return null;
  }
}

/** El error inline que va debajo de un campo global en conflicto. */
function FieldConflictError({
  conflict,
  onView,
}: {
  conflict: FieldConflict;
  onView: (userId: string) => void;
}) {
  return (
    <p className="text-xs text-red-600 mt-1">
      Ya está en uso por{' '}
      {conflict.canView && conflict.userId ? (
        <button
          type="button"
          onClick={() => onView(conflict.userId!)}
          className="underline font-medium hover:text-red-800"
        >
          {conflict.name || 'otro usuario'}
        </button>
      ) : (
        'un usuario de otra empresa'
      )}
      .
    </p>
  );
}

export default function UsersPage() {
  const {
    hasPermission,
    hasPermissionInTenant,
    user: currentUser,
    activeTenant,
    isSystemUser,
  } = useAuth();

  // "Todas las empresas": vista consolidada (una fila por membresía, con columna Empresa).
  const isAllTenants = activeTenant === ALL_TENANTS;

  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Filtro por empresa; solo se usa en el modo consolidado. */
  const [tenantFilter, setTenantFilter] = useState<string>('');
  /** Filtros comunes de la tabla. */
  const [nameFilter, setNameFilter] = useState('');
  const [lastNameFilter, setLastNameFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  /** Página actual (1-indexed) de la tabla filtrada. */
  const [page, setPage] = useState(1);

  /** null = cerrado · { user: null } = alta · { user } = edición. */
  const [editing, setEditing] = useState<{ user: UserData | null } | null>(null);
  /** El usuario cuyo detalle se está viendo (clic en la fila). */
  const [viewing, setViewing] = useState<UserData | null>(null);
  /** Modal de carga masiva desde Excel, abierto. */
  const [importing, setImporting] = useState(false);

  const canCreate = hasPermission('users', 'create');

  // Empresas donde el usuario común puede dar de alta: es miembro con permiso de crear
  // usuarios y de ver roles (el rol es obligatorio, así que sin verlos no podría completar).
  // Para el superadmin es `null`: el formulario trae la lista completa desde `/tenants/all`.
  const creatableTenants = useMemo<TenantOption[] | null>(() => {
    if (isSystemUser) return null;
    return (currentUser?.tenants ?? [])
      .filter(
        (m) =>
          m.role?.permissions?.some(
            (p) => p.resource === 'users' && p.action === 'create',
          ) &&
          m.role?.permissions?.some(
            (p) => p.resource === 'roles' && p.action === 'read',
          ),
      )
      .map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug }));
  }, [currentUser, isSystemUser]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isAllTenants) {
        setUsers(await apiFetch(isSystemUser ? '/users/all' : '/users/mine'));
      } else {
        setUsers(await apiFetch('/users'));
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

  // Empresas presentes en el listado, para alimentar el filtro del modo consolidado.
  const tenantsInList = useMemo(() => {
    const byId = new Map<string, string>();
    for (const u of users) if (u.tenant) byId.set(u.tenant.id, u.tenant.name);
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [users]);

  const visibleUsers = useMemo(
    () =>
      isAllTenants && tenantFilter
        ? users.filter((u) => u.tenant?.id === tenantFilter)
        : users,
    [users, isAllTenants, tenantFilter],
  );

  // Roles presentes en el listado, para alimentar el filtro por rol. Igual criterio que
  // `tenantsInList`: sale de los datos ya traídos, sin pedir `/roles` aparte (que en modo
  // consolidado, además, varía por empresa).
  const rolesInList = useMemo(() => {
    const byId = new Map<string, string>();
    for (const u of visibleUsers) if (u.role) byId.set(u.role.id, u.role.name);
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [visibleUsers]);

  const filteredUsers = useMemo(() => {
    const name = nameFilter.trim().toLowerCase();
    const lastName = lastNameFilter.trim().toLowerCase();
    return visibleUsers.filter((u) => {
      if (name && !(u.firstName || '').toLowerCase().includes(name)) return false;
      if (lastName && !(u.lastName || '').toLowerCase().includes(lastName)) return false;
      if (roleFilter && u.role?.id !== roleFilter) return false;
      return true;
    });
  }, [visibleUsers, nameFilter, lastNameFilter, roleFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  // Si un filtro deja la página actual fuera de rango, se recorta en vez de mostrar vacío.
  const safePage = Math.min(page, pageCount);
  const pagedUsers = useMemo(
    () => filteredUsers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredUsers, safePage],
  );

  const hasFilters = Boolean(nameFilter || lastNameFilter || roleFilter);
  function clearFilters() {
    setNameFilter('');
    setLastNameFilter('');
    setRoleFilter('');
  }

  // Cualquier cambio en los filtros (incluido el de empresa, que ya existía) vuelve a la
  // página 1: quedarse en una página que ya no existe para el resultado nuevo confunde.
  useEffect(() => {
    setPage(1);
  }, [tenantFilter, nameFilter, lastNameFilter, roleFilter]);

  /** El header con la empresa de una fila, para operar sobre ella aunque no sea la activa. */
  function tenantHeaders(u: UserData): Record<string, string> | undefined {
    return u.tenant ? { 'X-Tenant-Id': u.tenant.id } : undefined;
  }

  /** ¿Puede editar esta fila? En consolidado, según su permiso en la empresa de la fila. */
  function canUpdateRow(u: UserData) {
    return u.tenant
      ? hasPermissionInTenant(u.tenant.id, 'users', 'update')
      : hasPermission('users', 'update');
  }

  /** ¿Puede dar de baja esta fila? Mismo criterio por empresa que editar. */
  function canDeleteRow(u: UserData) {
    return u.tenant
      ? hasPermissionInTenant(u.tenant.id, 'users', 'delete')
      : hasPermission('users', 'delete');
  }

  function openModal(user: UserData | null) {
    setFeedback(null);
    setDeletingId(null);
    setViewing(null);
    setEditing({ user });
  }

  function openDetail(user: UserData) {
    setFeedback(null);
    setDeletingId(null);
    setViewing(user);
  }

  /** El botón gris de un usuario que no se puede dar de baja: responde y explica por qué. */
  function explainBlockedDelete() {
    setDeletingId(null);
    setFeedback({
      kind: 'error',
      text: 'No podés darte de baja a vos mismo.',
    });
  }

  async function confirmDelete(u: UserData) {
    setBusy(true);
    try {
      const res = await apiFetch(`/users/${u.id}`, {
        method: 'DELETE',
        headers: tenantHeaders(u),
      });
      setFeedback({ kind: 'ok', text: res?.message || 'Usuario dado de baja.' });
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
      <div className="flex items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Usuarios</h1>
        {canCreate && (
          <div className="flex items-center gap-2">
            {!isAllTenants && (
              <button
                onClick={() => setImporting(true)}
                className="border border-blue-600 text-blue-600 px-4 py-2 rounded hover:bg-blue-50 whitespace-nowrap"
              >
                Importar desde Excel
              </button>
            )}
            <button
              onClick={() => openModal(null)}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300 whitespace-nowrap"
            >
              Nuevo usuario
            </button>
          </div>
        )}
      </div>

      {feedback && (
        <p className={`mb-4 ${feedback.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {feedback.text}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Filtro por empresa: solo en la vista consolidada. En una empresa concreta el propio
            selector del sidebar ya cumple esa función, así que ahí sería redundante. */}
        {isAllTenants && tenantsInList.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Empresa:</label>
            <select
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              className="border border-gray-200 px-3 py-1.5 rounded text-sm"
            >
              <option value="">Todas</option>
              {tenantsInList.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <input
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          placeholder="Filtrar por nombre..."
          className="border border-gray-200 px-3 py-1.5 rounded text-sm"
        />
        <input
          value={lastNameFilter}
          onChange={(e) => setLastNameFilter(e.target.value)}
          placeholder="Filtrar por apellido..."
          className="border border-gray-200 px-3 py-1.5 rounded text-sm"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="border border-gray-200 px-3 py-1.5 rounded text-sm text-gray-600"
        >
          <option value="">Todos los roles</option>
          {rolesInList.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              {isAllTenants && (
                <th className="text-left px-4 py-2 font-semibold">Empresa</th>
              )}
              <th className="text-left px-4 py-2 font-semibold">Nombre</th>
              <th className="text-left px-4 py-2 font-semibold">Apellido</th>
              <th className="text-left px-4 py-2 font-semibold">Email</th>
              <th className="text-left px-4 py-2 font-semibold">Rol</th>
              <th className="text-left px-4 py-2 font-semibold">Área</th>
              <th className="text-left px-4 py-2 font-semibold">Teléfono</th>
              <th className="text-left px-4 py-2 font-semibold">Interno</th>
              <th className="text-left px-4 py-2 font-semibold whitespace-nowrap">ID Invgate</th>
              <th className="text-left px-4 py-2 font-semibold">Creado</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 && (
              <tr>
                <td
                  colSpan={isAllTenants ? 11 : 10}
                  className="px-4 py-6 text-center text-gray-400"
                >
                  {visibleUsers.length === 0 ? (
                    <>
                      <p className="mb-3">
                        {isAllTenants
                          ? 'Todavía no hay usuarios en tus empresas.'
                          : 'Todavía no hay usuarios en esta empresa.'}
                      </p>
                      {canCreate && (
                        <button
                          onClick={() => openModal(null)}
                          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                        >
                          Crear el primero
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="mb-3">Ningún usuario coincide con los filtros.</p>
                      <button
                        onClick={clearFilters}
                        className="text-blue-600 hover:text-blue-800 underline"
                      >
                        Limpiar filtros
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )}

            {pagedUsers.map((u) => {
              // La clave incluye la empresa: en consolidado una persona aparece una vez por
              // empresa, y con solo el id se repetiría la key.
              const rowKey = u.tenant ? `${u.id}-${u.tenant.id}` : u.id;

              if (deletingId === rowKey) {
                return (
                  <tr key={rowKey} className="border-t bg-red-50">
                    <td colSpan={isAllTenants ? 11 : 10} className="px-4 py-2">
                      <div className="flex gap-2 items-center flex-wrap">
                        <span className="text-red-700 mr-1">
                          ¿Dar de baja a <b>{userLabel(u)}</b>
                          {u.tenant ? (
                            <>
                              {' '}
                              de <b>{u.tenant.name}</b>?
                            </>
                          ) : (
                            ' de esta empresa?'
                          )}{' '}
                          Se lo quita de esa empresa y su historial se conserva. Si no le
                          queda ninguna otra, la baja es definitiva: no se puede reactivar y
                          para que vuelva hay que darlo de alta de nuevo.
                        </span>
                        <button
                          onClick={() => confirmDelete(u)}
                          disabled={busy}
                          className="bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:bg-gray-300"
                        >
                          {busy ? 'Dando de baja...' : 'Sí, dar de baja'}
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
                );
              }

              const isSelf = u.id === currentUser?.id;

              return (
                <tr
                  key={rowKey}
                  onClick={() => openDetail(u)}
                  className="border-t hover:bg-gray-50 cursor-pointer"
                  title="Ver detalle"
                >
                  {isAllTenants && (
                    <td className="px-4 py-2 text-gray-500">{u.tenant?.name ?? '—'}</td>
                  )}
                  <td className="px-4 py-2 font-medium">{u.firstName || '-'}</td>
                  <td className="px-4 py-2">{u.lastName || '-'}</td>
                  <td className="px-4 py-2 text-gray-600">{u.email}</td>
                  <td className="px-4 py-2">
                    {u.role ? (
                      <span className="inline-block bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs">
                        {u.role.name}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{u.area?.name || '-'}</td>
                  <td className="px-4 py-2 text-gray-600">{u.phone || '-'}</td>
                  <td className="px-4 py-2 text-gray-600">{u.internalPhone || '-'}</td>
                  <td className="px-4 py-2 text-gray-600">{u.invgateUserId || '-'}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 text-right whitespace-nowrap">
                    {/* Fuera de la zona que abre el detalle va SOLO el grupo de botones. El
                        stopPropagation vive en este contenedor, que se lleva el padding vertical
                        (py-2) para ocupar el alto completo de la fila. title="" evita heredar el
                        tooltip del <tr>. */}
                    <span
                      className="inline-block align-middle py-2 pl-0.5 cursor-default"
                      onClick={(e) => e.stopPropagation()}
                      title=""
                    >
                      {canUpdateRow(u) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openModal(u);
                          }}
                          className="text-blue-600 hover:text-blue-800 px-2"
                        >
                          Editar
                        </button>
                      )}
                      {canDeleteRow(u) &&
                        (isSelf ? (
                          // aria-disabled y no disabled: con `disabled` de verdad, quien navega
                          // por teclado ni lo encuentra, y en táctil no hay hover que dé el motivo.
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              explainBlockedDelete();
                            }}
                            aria-disabled="true"
                            title="No podés darte de baja a vos mismo"
                            className="text-gray-400 hover:text-gray-500 cursor-not-allowed px-2"
                          >
                            Eliminar
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFeedback(null);
                              setViewing(null);
                              setDeletingId(rowKey);
                            }}
                            className="text-red-600 hover:text-red-800 px-2"
                          >
                            Eliminar
                          </button>
                        ))}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredUsers.length > 0 && (
        <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
          <span>
            {filteredUsers.length} {filteredUsers.length === 1 ? 'usuario' : 'usuarios'}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Anterior
              </button>
              <span>
                Página {safePage} de {pageCount}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={safePage >= pageCount}
                className="px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Siguiente
              </button>
            </div>
          )}
        </div>
      )}

      {editing &&
        (editing.user ? (
          <UserEditModal
            user={editing.user}
            isSelf={editing.user.id === currentUser?.id}
            creatableTenants={creatableTenants}
            onClose={() => setEditing(null)}
            onSaved={afterSave}
          />
        ) : (
          <UserModal
            availableTenants={creatableTenants}
            presetTenantId={isAllTenants ? null : activeTenant}
            onClose={() => setEditing(null)}
            onSaved={afterSave}
          />
        ))}

      {viewing && (
        <UserDetailModal
          user={viewing}
          canEdit={canUpdateRow(viewing)}
          onEdit={() => openModal(viewing)}
          onClose={() => setViewing(null)}
        />
      )}

      {importing && !isAllTenants && activeTenant && (
        <ImportUsersModal
          tenantId={activeTenant}
          onClose={() => setImporting(false)}
          onImported={afterSave}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alta: un usuario nuevo en una o varias empresas                     */
/* ------------------------------------------------------------------ */

interface Membership {
  tenantId: string;
  roleId: string;
  areaId: string;
}

function UserModal({
  availableTenants,
  presetTenantId,
  onClose,
  onSaved,
}: {
  /** Empresas destino. null = superadmin (se traen todas desde `/tenants/all`). */
  availableTenants: TenantOption[] | null;
  /** Empresa a pre-seleccionar (donde estás parado). null = elegís desde cero. */
  presetTenantId: string | null;
  onClose: () => void;
  onSaved: (message: Feedback) => void;
}) {
  const systemTenantId = useSystemTenantId();

  const [form, setForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    internalPhone: '',
    invgateUserId: '',
    password: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<
    Partial<Record<GlobalField, FieldConflict | null>>
  >({});
  const [conflictUserId, setConflictUserId] = useState<string | null>(null);

  function clearConflict(field: GlobalField) {
    setConflicts((prev) => ({ ...prev, [field]: null }));
  }
  async function checkField(field: GlobalField, value: string) {
    const conflict = await checkFieldAvailability(field, value);
    setConflicts((prev) => ({ ...prev, [field]: conflict }));
  }
  const hasConflict = Object.values(conflicts).some(Boolean);

  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantChoices, setTenantChoices] = useState<TenantOption[]>(availableTenants ?? []);
  const [rolesByTenant, setRolesByTenant] = useState<Record<string, RoleOption[]>>({});
  const [areasByTenant, setAreasByTenant] = useState<Record<string, AreaOption[]>>({});

  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  async function loadRolesForTenant(tenantId: string) {
    if (rolesByTenant[tenantId]) return;
    const roles = await fetchRolesForTenant(tenantId);
    setRolesByTenant((prev) => ({ ...prev, [tenantId]: roles }));
  }
  async function loadAreasForTenant(tenantId: string) {
    if (areasByTenant[tenantId]) return;
    const areas = await fetchAreasForTenant(tenantId);
    setAreasByTenant((prev) => ({ ...prev, [tenantId]: areas }));
  }

  // La lista de empresas para el desplegable. El superadmin la pide con el header de sistema
  // (única empresa desde la que `/tenants/all` responde), esté parado donde esté.
  useEffect(() => {
    if (availableTenants) {
      setTenantChoices(availableTenants);
      return;
    }
    apiFetch(
      '/tenants/all',
      systemTenantId ? { headers: { 'X-Tenant-Id': systemTenantId } } : undefined,
    )
      .then((list: any[]) =>
        setTenantChoices(list.map((t) => ({ id: t.id, name: t.name, slug: t.slug }))),
      )
      .catch((err: any) => setError(err.message));
  }, [availableTenants, systemTenantId]);

  function addTenant(tenantId: string) {
    if (!tenantId) return;
    setMemberships((prev) =>
      prev.some((m) => m.tenantId === tenantId)
        ? prev
        : [...prev, { tenantId, roleId: '', areaId: '' }],
    );
    loadRolesForTenant(tenantId);
    loadAreasForTenant(tenantId);
  }

  // Pre-seleccionar la empresa donde estás parado, si la hay.
  useEffect(() => {
    if (presetTenantId) addTenant(presetTenantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetTenantId]);

  function removeTenant(tenantId: string) {
    setMemberships((prev) => prev.filter((m) => m.tenantId !== tenantId));
  }
  function setMembershipRole(tenantId: string, roleId: string) {
    setMemberships((prev) =>
      prev.map((m) => (m.tenantId === tenantId ? { ...m, roleId } : m)),
    );
  }
  function setMembershipArea(tenantId: string, areaId: string) {
    setMemberships((prev) =>
      prev.map((m) => (m.tenantId === tenantId ? { ...m, areaId } : m)),
    );
  }

  const availableToAdd = tenantChoices.filter(
    (t) => !memberships.some((m) => m.tenantId === t.id),
  );
  const tenantName = (id: string) => tenantChoices.find((t) => t.id === id)?.name ?? id;

  const changed =
    form.firstName.length > 0 ||
    form.lastName.length > 0 ||
    form.email.length > 0 ||
    form.phone.length > 0 ||
    form.internalPhone.length > 0 ||
    form.invgateUserId.length > 0 ||
    form.password.length > 0 ||
    memberships.length > 0;

  const requestClose = useCallback(() => {
    if (saving) return;
    if (changed && !confirm('Tenés cambios sin guardar. ¿Descartarlos?')) return;
    onClose();
  }, [saving, changed, onClose]);

  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // Con la ficha del ocupante abierta encima, Escape la cierra a ella, no al formulario.
      if (conflictUserId) {
        setConflictUserId(null);
        return;
      }
      requestClose();
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [requestClose, conflictUserId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (memberships.length === 0) {
      setError('Elegí al menos una empresa.');
      return;
    }
    if (memberships.some((m) => !m.roleId)) {
      setError('Cada empresa necesita un rol.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch('/users/multi', {
        method: 'POST',
        body: JSON.stringify({
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          password: form.password,
          phone: form.phone || undefined,
          internalPhone: form.internalPhone || undefined,
          invgateUserId: form.invgateUserId || undefined,
          memberships: memberships.map((m) => ({
            tenantId: m.tenantId,
            roleId: m.roleId,
            areaId: m.areaId || undefined,
          })),
        }),
      });
      onSaved({
        kind: 'ok',
        text: `Usuario creado en ${memberships.length} ${
          memberships.length === 1 ? 'empresa' : 'empresas'
        }.`,
      });
    } catch (err: any) {
      const body = err?.body;
      if (body?.field && body?.conflict) {
        // El backend dice qué campo global chocó: lo mostramos debajo de ese campo.
        setConflicts((prev) => ({ ...prev, [body.field]: body.conflict }));
        setError('');
      } else {
        setError(err.message);
      }
      setSaving(false);
    }
  }

  const saveDisabled =
    saving ||
    memberships.length === 0 ||
    memberships.some((m) => !m.roleId) ||
    hasConflict;

  return (
    <>
    <ModalShell
      title="Nuevo usuario"
      subtitle="Elegí en qué empresas se da de alta a la persona: por cada una, un rol y, opcional, un área."
      onRequestClose={requestClose}
      onSubmit={save}
      error={error}
      footer={
        <>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saveDisabled}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
          >
            {saving ? 'Guardando...' : 'Crear'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PersonField label="Nombre *">
          <input
            ref={firstRef}
            placeholder="Juan"
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            className="border border-gray-200 px-3 py-2 rounded w-full"
            required
          />
        </PersonField>
        <PersonField label="Apellido *">
          <input
            placeholder="Pérez"
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            className="border border-gray-200 px-3 py-2 rounded w-full"
            required
          />
        </PersonField>
        <PersonField label="Email *">
          <input
            type="email"
            placeholder="juan.perez@empresa.com"
            value={form.email}
            onChange={(e) => {
              setForm({ ...form, email: e.target.value });
              clearConflict('email');
            }}
            onBlur={(e) => checkField('email', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.email ? 'border-red-400' : 'border-gray-200'
            }`}
            required
          />
          {conflicts.email && (
            <FieldConflictError conflict={conflicts.email} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="Teléfono">
          <input
            placeholder="+54911..."
            value={form.phone}
            onChange={(e) => {
              setForm({ ...form, phone: e.target.value });
              clearConflict('phone');
            }}
            onBlur={(e) => checkField('phone', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.phone ? 'border-red-400' : 'border-gray-200'
            }`}
          />
          {conflicts.phone && (
            <FieldConflictError conflict={conflicts.phone} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="Interno">
          <input
            placeholder="1024"
            value={form.internalPhone}
            onChange={(e) => {
              setForm({ ...form, internalPhone: e.target.value });
              clearConflict('internalPhone');
            }}
            onBlur={(e) => checkField('internalPhone', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.internalPhone ? 'border-red-400' : 'border-gray-200'
            }`}
            maxLength={30}
          />
          {conflicts.internalPhone && (
            <FieldConflictError conflict={conflicts.internalPhone} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="ID de Invgate">
          <input
            value={form.invgateUserId}
            onChange={(e) => {
              setForm({ ...form, invgateUserId: e.target.value });
              clearConflict('invgateUserId');
            }}
            onBlur={(e) => checkField('invgateUserId', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.invgateUserId ? 'border-red-400' : 'border-gray-200'
            }`}
            maxLength={64}
          />
          {conflicts.invgateUserId && (
            <FieldConflictError conflict={conflicts.invgateUserId} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="Contraseña *">
          <input
            type="password"
            placeholder="Mínimo 8 caracteres"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="border border-gray-200 px-3 py-2 rounded w-full"
            minLength={8}
            required
          />
        </PersonField>
      </div>

      <MembershipsEditor
        memberships={memberships.map((m) => ({
          tenantId: m.tenantId,
          tenantName: tenantName(m.tenantId),
          roleId: m.roleId,
          areaId: m.areaId,
          existing: false,
          removed: false,
          roleEditable: true,
          removable: true,
        }))}
        rolesByTenant={rolesByTenant}
        areasByTenant={areasByTenant}
        availableToAdd={availableToAdd}
        onAdd={addTenant}
        onRemove={removeTenant}
        onRestore={() => {}}
        onRole={setMembershipRole}
        onArea={setMembershipArea}
        emptyHint="Todavía no agregaste ninguna empresa."
      />
    </ModalShell>
      {conflictUserId && (
        <ConflictUserModal
          userId={conflictUserId}
          onClose={() => setConflictUserId(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Edición: la persona y todas sus empresas administrables             */
/* ------------------------------------------------------------------ */

interface EditMembership {
  tenantId: string;
  tenantName: string;
  roleId: string;
  areaId: string;
  /** Nombre actual del rol/área, para mostrar las empresas en solo lectura sin cargar sus
   *  listas (cuando no hay permiso para editarlas). */
  roleName: string;
  areaName: string;
  /** Ya existía al abrir el editor (vs. agregada en esta sesión). */
  existing: boolean;
  /** Marcada para dar de baja al guardar (solo existentes). */
  removed: boolean;
}

function UserEditModal({
  user,
  isSelf,
  creatableTenants,
  onClose,
  onSaved,
}: {
  user: UserData;
  /** El usuario se está editando a sí mismo: no puede darse de baja de ninguna empresa. */
  isSelf: boolean;
  /** Empresas donde se puede agregar (usuario común). null = superadmin (todas). */
  creatableTenants: TenantOption[] | null;
  onClose: () => void;
  onSaved: (message: Feedback) => void;
}) {
  const { hasPermissionInTenant } = useAuth();
  const systemTenantId = useSystemTenantId();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<
    Partial<Record<GlobalField, FieldConflict | null>>
  >({});
  const [conflictUserId, setConflictUserId] = useState<string | null>(null);

  function clearConflict(field: GlobalField) {
    setConflicts((prev) => ({ ...prev, [field]: null }));
  }
  async function checkField(field: GlobalField, value: string) {
    const conflict = await checkFieldAvailability(field, value, user.id);
    setConflicts((prev) => ({ ...prev, [field]: conflict }));
  }
  const hasConflict = Object.values(conflicts).some(Boolean);

  const [form, setForm] = useState({
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    phone: user.phone ?? '',
    internalPhone: user.internalPhone ?? '',
    invgateUserId: user.invgateUserId ?? '',
    password: '',
  });
  const [base, setBase] = useState(form);

  const [memberships, setMemberships] = useState<EditMembership[]>([]);
  /** Estado inicial de las membresías, para detectar cambios. */
  const [baseMemberships, setBaseMemberships] = useState<EditMembership[]>([]);
  const [tenantChoices, setTenantChoices] = useState<TenantOption[]>(creatableTenants ?? []);
  const [rolesByTenant, setRolesByTenant] = useState<Record<string, RoleOption[]>>({});
  const [areasByTenant, setAreasByTenant] = useState<Record<string, AreaOption[]>>({});

  const firstRef = useRef<HTMLInputElement>(null);

  async function loadRolesForTenant(tenantId: string) {
    if (rolesByTenant[tenantId]) return;
    const roles = await fetchRolesForTenant(tenantId);
    setRolesByTenant((prev) => ({ ...prev, [tenantId]: roles }));
  }
  async function loadAreasForTenant(tenantId: string) {
    if (areasByTenant[tenantId]) return;
    const areas = await fetchAreasForTenant(tenantId);
    setAreasByTenant((prev) => ({ ...prev, [tenantId]: areas }));
  }

  // Poblar el editor: los datos de la persona y sus membresías visibles.
  useEffect(() => {
    apiFetch(`/users/${user.id}/memberships`)
      .then((data: any) => {
        const person = {
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
          phone: data.phone ?? '',
          internalPhone: data.internalPhone ?? '',
          invgateUserId: data.invgateUserId ?? '',
          password: '',
        };
        setForm(person);
        setBase(person);
        const mapped: EditMembership[] = (data.memberships || []).map((m: any) => ({
          tenantId: m.tenantId,
          tenantName: m.tenant?.name ?? m.tenantId,
          roleId: m.role?.id ?? '',
          areaId: m.area?.id ?? '',
          roleName: m.role?.name ?? '',
          areaName: m.area?.name ?? '',
          existing: true,
          removed: false,
        }));
        setMemberships(mapped);
        setBaseMemberships(mapped);
        // Traer roles/áreas de cada empresa que se puede editar (para los selects).
        for (const m of mapped) {
          if (hasPermissionInTenant(m.tenantId, 'users', 'update')) {
            loadRolesForTenant(m.tenantId);
            loadAreasForTenant(m.tenantId);
          }
        }
      })
      .catch((err: any) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setTimeout(() => firstRef.current?.focus(), 0);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  // Lista de empresas para agregar. El superadmin la pide con el header de sistema.
  useEffect(() => {
    if (creatableTenants) {
      setTenantChoices(creatableTenants);
      return;
    }
    apiFetch(
      '/tenants/all',
      systemTenantId ? { headers: { 'X-Tenant-Id': systemTenantId } } : undefined,
    )
      .then((list: any[]) =>
        setTenantChoices(list.map((t) => ({ id: t.id, name: t.name, slug: t.slug }))),
      )
      .catch(() => {
        // Sin la lista solo no se pueden agregar empresas nuevas; el resto del editor anda.
      });
  }, [creatableTenants, systemTenantId]);

  function addTenant(tenantId: string) {
    if (!tenantId) return;
    setMemberships((prev) => {
      const found = prev.find((m) => m.tenantId === tenantId);
      // Si estaba marcada para baja, agregar la restaura en vez de duplicarla.
      if (found) {
        return prev.map((m) => (m.tenantId === tenantId ? { ...m, removed: false } : m));
      }
      const name = tenantChoices.find((t) => t.id === tenantId)?.name ?? tenantId;
      return [
        ...prev,
        {
          tenantId,
          tenantName: name,
          roleId: '',
          areaId: '',
          roleName: '',
          areaName: '',
          existing: false,
          removed: false,
        },
      ];
    });
    loadRolesForTenant(tenantId);
    loadAreasForTenant(tenantId);
  }

  function removeMembership(tenantId: string) {
    setMemberships((prev) =>
      prev
        // Las nuevas se sacan de la lista; las existentes se marcan para baja.
        .map((m) =>
          m.tenantId === tenantId && m.existing ? { ...m, removed: true } : m,
        )
        .filter((m) => !(m.tenantId === tenantId && !m.existing)),
    );
  }
  function restoreMembership(tenantId: string) {
    setMemberships((prev) =>
      prev.map((m) => (m.tenantId === tenantId ? { ...m, removed: false } : m)),
    );
  }
  function setMembershipRole(tenantId: string, roleId: string) {
    setMemberships((prev) =>
      prev.map((m) => (m.tenantId === tenantId ? { ...m, roleId } : m)),
    );
  }
  function setMembershipArea(tenantId: string, areaId: string) {
    setMemberships((prev) =>
      prev.map((m) => (m.tenantId === tenantId ? { ...m, areaId } : m)),
    );
  }

  const availableToAdd = tenantChoices.filter(
    (t) => !memberships.some((m) => m.tenantId === t.id && !m.removed),
  );

  const membershipsChanged =
    memberships.length !== baseMemberships.length ||
    memberships.some((m) => {
      const b = baseMemberships.find((x) => x.tenantId === m.tenantId);
      return !b || b.roleId !== m.roleId || b.areaId !== m.areaId || m.removed;
    });
  const personChanged =
    form.firstName !== base.firstName ||
    form.lastName !== base.lastName ||
    form.phone !== base.phone ||
    form.internalPhone !== base.internalPhone ||
    form.invgateUserId !== base.invgateUserId ||
    form.password.length > 0;
  const changed = personChanged || membershipsChanged;

  const requestClose = useCallback(() => {
    if (saving) return;
    if (changed && !confirm('Tenés cambios sin guardar. ¿Descartarlos?')) return;
    onClose();
  }, [saving, changed, onClose]);

  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // Con la ficha del ocupante abierta encima, Escape la cierra a ella, no al formulario.
      if (conflictUserId) {
        setConflictUserId(null);
        return;
      }
      requestClose();
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [requestClose, conflictUserId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const kept = memberships.filter((m) => !m.removed);
    if (kept.some((m) => !m.roleId)) {
      setError('Cada empresa necesita un rol.');
      return;
    }

    // Confirmar las bajas (empresas existentes marcadas para quitar): son destructivas.
    const toRemove = memberships.filter((m) => m.existing && m.removed);
    if (toRemove.length > 0) {
      const names = toRemove.map((m) => m.tenantName).join(', ');
      const ok = confirm(
        `Vas a dar de baja a ${userLabel(user)} de: ${names}. ` +
          'Se conserva su historial. Si no le queda ninguna otra empresa, la baja es ' +
          'definitiva: no se puede reactivar y para que vuelva hay que darlo de alta de ' +
          'nuevo. ¿Continuar?',
      );
      if (!ok) return;
    }

    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/users/${user.id}/full`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          internalPhone: form.internalPhone,
          invgateUserId: form.invgateUserId,
          ...(form.password ? { password: form.password } : {}),
          memberships: kept.map((m) => ({
            tenantId: m.tenantId,
            roleId: m.roleId,
            areaId: m.areaId || undefined,
          })),
        }),
      });
      onSaved({ kind: 'ok', text: res?.message || `Usuario ${userLabel(user)} guardado.` });
    } catch (err: any) {
      const body = err?.body;
      if (body?.field && body?.conflict) {
        // El backend dice qué campo global chocó: lo mostramos debajo de ese campo.
        setConflicts((prev) => ({ ...prev, [body.field]: body.conflict }));
        setError('');
      } else {
        setError(err.message);
      }
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <ModalShell title="Editar usuario" onRequestClose={onClose}>
        <p className="text-gray-500 text-sm">Cargando...</p>
      </ModalShell>
    );
  }

  const editableMemberships: EditorRow[] = memberships.map((m) => ({
    tenantId: m.tenantId,
    tenantName: m.tenantName,
    roleId: m.roleId,
    areaId: m.areaId,
    roleName: m.roleName,
    areaName: m.areaName,
    existing: m.existing,
    removed: m.removed,
    // Nuevas: siempre editables. Existentes: solo con permiso en esa empresa.
    roleEditable: !m.existing || hasPermissionInTenant(m.tenantId, 'users', 'update'),
    // Quitar: nuevas siempre; existentes solo con delete y si no es uno mismo.
    removable: !m.existing || (!isSelf && hasPermissionInTenant(m.tenantId, 'users', 'delete')),
  }));

  return (
    <>
    <ModalShell
      title="Editar usuario"
      subtitle="Cambiá los datos de la persona y sus empresas: rol y área por empresa, agregar o quitar empresas."
      onRequestClose={requestClose}
      onSubmit={save}
      error={error}
      footer={
        <>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || !changed || hasConflict}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PersonField label="Nombre *">
          <input
            ref={firstRef}
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            className="border border-gray-200 px-3 py-2 rounded w-full"
            required
          />
        </PersonField>
        <PersonField label="Apellido *">
          <input
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            className="border border-gray-200 px-3 py-2 rounded w-full"
            required
          />
        </PersonField>
        <PersonField label="Email">
          <input
            value={user.email}
            className="border border-gray-200 px-3 py-2 rounded w-full bg-gray-100"
            disabled
            title="El email no se puede cambiar"
          />
        </PersonField>
        <PersonField label="Teléfono">
          <input
            placeholder="+54911..."
            value={form.phone}
            onChange={(e) => {
              setForm({ ...form, phone: e.target.value });
              clearConflict('phone');
            }}
            onBlur={(e) => checkField('phone', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.phone ? 'border-red-400' : 'border-gray-200'
            }`}
          />
          {conflicts.phone && (
            <FieldConflictError conflict={conflicts.phone} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="Interno">
          <input
            placeholder="1024"
            value={form.internalPhone}
            onChange={(e) => {
              setForm({ ...form, internalPhone: e.target.value });
              clearConflict('internalPhone');
            }}
            onBlur={(e) => checkField('internalPhone', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.internalPhone ? 'border-red-400' : 'border-gray-200'
            }`}
            maxLength={30}
          />
          {conflicts.internalPhone && (
            <FieldConflictError conflict={conflicts.internalPhone} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="ID de Invgate">
          <input
            value={form.invgateUserId}
            onChange={(e) => {
              setForm({ ...form, invgateUserId: e.target.value });
              clearConflict('invgateUserId');
            }}
            onBlur={(e) => checkField('invgateUserId', e.target.value)}
            className={`border px-3 py-2 rounded w-full ${
              conflicts.invgateUserId ? 'border-red-400' : 'border-gray-200'
            }`}
            maxLength={64}
          />
          {conflicts.invgateUserId && (
            <FieldConflictError conflict={conflicts.invgateUserId} onView={setConflictUserId} />
          )}
        </PersonField>
        <PersonField label="Nueva contraseña">
          <input
            type="password"
            placeholder="Dejar vacío para no cambiarla"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="border border-gray-200 px-3 py-2 rounded w-full"
            minLength={8}
          />
        </PersonField>
      </div>

      <MembershipsEditor
        memberships={editableMemberships}
        rolesByTenant={rolesByTenant}
        areasByTenant={areasByTenant}
        availableToAdd={availableToAdd}
        onAdd={addTenant}
        onRemove={removeMembership}
        onRestore={restoreMembership}
        onRole={setMembershipRole}
        onArea={setMembershipArea}
        emptyHint="Esta persona no está en ninguna empresa que puedas administrar."
      />
    </ModalShell>
      {conflictUserId && (
        <ConflictUserModal
          userId={conflictUserId}
          onClose={() => setConflictUserId(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Editor de empresas: compartido por alta y edición                   */
/* ------------------------------------------------------------------ */

interface EditorRow {
  tenantId: string;
  tenantName: string;
  roleId: string;
  areaId: string;
  /** Nombre actual del rol/área, para el render en solo lectura. */
  roleName?: string;
  areaName?: string;
  existing: boolean;
  removed: boolean;
  roleEditable: boolean;
  removable: boolean;
}

function MembershipsEditor({
  memberships,
  rolesByTenant,
  areasByTenant,
  availableToAdd,
  onAdd,
  onRemove,
  onRestore,
  onRole,
  onArea,
  emptyHint,
}: {
  memberships: EditorRow[];
  rolesByTenant: Record<string, RoleOption[]>;
  areasByTenant: Record<string, AreaOption[]>;
  availableToAdd: TenantOption[];
  onAdd: (tenantId: string) => void;
  onRemove: (tenantId: string) => void;
  onRestore: (tenantId: string) => void;
  onRole: (tenantId: string, roleId: string) => void;
  onArea: (tenantId: string, areaId: string) => void;
  emptyHint: string;
}) {
  return (
    <div className="mt-4 border-t border-gray-200 pt-4">
      <label className="block text-xs text-gray-500 mb-1">Empresas *</label>
      <p className="text-xs text-gray-400 mb-3">
        Por cada empresa, un rol (obligatorio) y un área (opcional).
      </p>

      {memberships.length === 0 && (
        <p className="text-xs text-gray-400 mb-2">{emptyHint}</p>
      )}

      <div className="space-y-2">
        {memberships.map((m) => {
          const tRoles = rolesByTenant[m.tenantId];
          const tAreas = areasByTenant[m.tenantId];
          // En solo lectura no se cargan las listas de la empresa, así que el nombre viene
          // de la propia fila (lo trajo el backend); si están cargadas, se usan igual.
          const roleName =
            m.roleName || tRoles?.find((r) => r.id === m.roleId)?.name || '—';
          const areaName =
            m.areaName || tAreas?.find((a) => a.id === m.areaId)?.name || 'Sin área';

          if (m.removed) {
            return (
              <div
                key={m.tenantId}
                className="border border-red-200 bg-red-50 rounded p-3 flex items-center justify-between"
              >
                <span className="text-sm text-red-700">
                  <b>{m.tenantName}</b> — se dará de baja al guardar
                </span>
                <button
                  type="button"
                  onClick={() => onRestore(m.tenantId)}
                  className="text-blue-600 hover:text-blue-800 text-xs"
                >
                  Deshacer
                </button>
              </div>
            );
          }

          return (
            <div key={m.tenantId} className="border border-gray-200 rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-sm">{m.tenantName}</span>
                {m.removable && (
                  <button
                    type="button"
                    onClick={() => onRemove(m.tenantId)}
                    className="text-red-600 hover:text-red-800 text-xs"
                  >
                    Quitar
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Rol *</label>
                  {m.roleEditable ? (
                    <>
                      <select
                        value={m.roleId}
                        onChange={(e) => onRole(m.tenantId, e.target.value)}
                        className="border border-gray-200 px-3 py-2 rounded w-full"
                        required
                      >
                        <option value="">{tRoles ? 'Seleccionar rol' : 'Cargando...'}</option>
                        {(tRoles || []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      {tRoles && tRoles.length === 0 && (
                        <p className="text-xs text-amber-700 mt-1">
                          Esta empresa no tiene roles. Creá uno antes de asignarla.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="px-3 py-2 text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded">
                      {roleName}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Área</label>
                  {m.roleEditable ? (
                    <select
                      value={m.areaId}
                      onChange={(e) => onArea(m.tenantId, e.target.value)}
                      className="border border-gray-200 px-3 py-2 rounded w-full"
                    >
                      <option value="">Sin área</option>
                      {(tAreas || []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="px-3 py-2 text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded">
                      {areaName}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {availableToAdd.length > 0 && (
        <select
          value=""
          onChange={(e) => onAdd(e.target.value)}
          className="mt-2 border border-gray-200 px-3 py-2 rounded w-full text-gray-600"
        >
          <option value="">+ Agregar empresa…</option>
          {availableToAdd.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Piezas de presentación compartidas                                  */
/* ------------------------------------------------------------------ */

function PersonField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

export function ModalShell({
  title,
  subtitle,
  onRequestClose,
  onSubmit,
  error,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  onRequestClose: () => void;
  onSubmit?: (e: React.FormEvent) => void;
  error?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const Inner = onSubmit ? 'form' : 'div';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onRequestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-modal-title"
    >
      <Inner
        onSubmit={onSubmit}
        className="bg-white rounded-md shadow-2xl w-full max-w-[720px] max-h-full flex flex-col text-gray-900"
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="user-modal-title" className="text-lg font-semibold text-gray-800">
              {title}
            </h2>
            {subtitle && <p className="mt-1 text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onRequestClose}
            aria-label="Cerrar"
            className="text-xl leading-none text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>

        {error && (
          <p className="px-5 py-2 text-sm text-red-600 bg-red-50 border-t border-red-200">
            {error}
          </p>
        )}

        {footer && (
          <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3 rounded-b-md">
            {footer}
          </div>
        )}
      </Inner>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de detalle: solo lectura, al clickear una fila              */
/* ------------------------------------------------------------------ */

function UserDetailModal({
  user,
  canEdit,
  onEdit,
  onClose,
}: {
  user: UserData;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

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

  const rows: Array<{ label: string; value: string }> = [
    ...(user.tenant ? [{ label: 'Empresa', value: user.tenant.name }] : []),
    { label: 'Nombre', value: [user.firstName, user.lastName].filter(Boolean).join(' ') || '-' },
    { label: 'Email', value: user.email },
    { label: 'Rol', value: user.role?.name || '-' },
    { label: 'Área', value: user.area?.name || 'Sin área' },
    { label: 'Teléfono', value: user.phone || '-' },
    { label: 'Interno', value: user.internalPhone || '-' },
    { label: 'ID de Invgate', value: user.invgateUserId || '-' },
    { label: 'Creado', value: new Date(user.createdAt).toLocaleString() },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-detail-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[480px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="user-detail-title" className="text-lg font-semibold text-gray-800">
              {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
            </h2>
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
          <dl className="divide-y divide-gray-100">
            {rows.map((r) => (
              <div key={r.label} className="flex justify-between gap-4 py-2">
                <dt className="text-xs uppercase tracking-wider text-gray-500">{r.label}</dt>
                <dd className="text-sm text-gray-800 text-right break-all">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3 rounded-b-md">
          {canEdit && (
            <button
              onClick={onEdit}
              className="text-blue-600 px-4 py-2 rounded hover:bg-blue-50 whitespace-nowrap"
            >
              Editar
            </button>
          )}
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

/* ------------------------------------------------------------------ */
/* Ficha del usuario que ya ocupa un campo global (solo lectura)       */
/* ------------------------------------------------------------------ */

interface ConflictUserData {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  internalPhone: string | null;
  invgateUserId: string | null;
  memberships: Array<{
    tenantId: string;
    tenant: { id: string; name: string; slug: string };
    role: { id: string; name: string } | null;
    area: { id: string; name: string } | null;
  }>;
}

/**
 * La ficha del usuario que ya usa un dato global, abierta desde el link del error. Carga sus
 * datos por id (`/users/:id/memberships`, que ya devuelve solo las empresas que quien consulta
 * puede ver). Se muestra por encima del formulario; su Escape lo maneja el modal de abajo.
 */
function ConflictUserModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [data, setData] = useState<ConflictUserData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    apiFetch(`/users/${userId}/memberships`)
      .then((d: ConflictUserData) => setData(d))
      .catch((err: any) => setError(err.message))
      .finally(() => setLoading(false));
  }, [userId]);

  const fullName = data
    ? [data.firstName, data.lastName].filter(Boolean).join(' ') || data.email
    : '';

  const rows = data
    ? [
        {
          label: 'Nombre',
          value: [data.firstName, data.lastName].filter(Boolean).join(' ') || '-',
        },
        { label: 'Email', value: data.email },
        { label: 'Teléfono', value: data.phone || '-' },
        { label: 'Interno', value: data.internalPhone || '-' },
        { label: 'ID de Invgate', value: data.invgateUserId || '-' },
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[480px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-gray-800">
              {loading ? 'Cargando…' : fullName || 'Usuario'}
            </h2>
            <p className="mt-1 text-xs text-gray-500">Ya usa este dato</p>
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loading && !error && <p className="text-sm text-gray-500">Cargando...</p>}
          {data && (
            <>
              <dl className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <div key={r.label} className="flex justify-between gap-4 py-2">
                    <dt className="text-xs uppercase tracking-wider text-gray-500">
                      {r.label}
                    </dt>
                    <dd className="text-sm text-gray-800 text-right break-all">{r.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Empresas</p>
                {data.memberships.length === 0 ? (
                  <p className="text-sm text-gray-400">Sin empresas visibles.</p>
                ) : (
                  <ul className="space-y-1">
                    {data.memberships.map((m) => (
                      <li key={m.tenantId} className="text-sm text-gray-700">
                        <span className="font-medium">{m.tenant?.name ?? m.tenantId}</span>
                        {m.role?.name ? ` · ${m.role.name}` : ''}
                        {m.area?.name ? ` · ${m.area.name}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3 rounded-b-md">
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
