'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { ALL_TENANTS, SYSTEM_TENANT_SLUG } from '@/lib/system-tenant';

interface RoleOption {
  id: string;
  name: string;
}

interface AreaOption {
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
  invgateUserId: string | null;
  createdAt: string;
  role: RoleOption | null;
  area: AreaOption | null;
  /** Solo en la vista "Todas las empresas": a qué empresa corresponde esta membresía. */
  tenant?: { id: string; name: string; slug: string };
}

type Feedback = { kind: 'ok' | 'error'; text: string };

/** El nombre visible de un usuario: nombre y apellido, o el email si no tiene. */
function userLabel(u: UserData) {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

export default function UsersPage() {
  const { hasPermission, user: currentUser, activeTenant } = useAuth();
  // "Todas las empresas": vista consolidada de solo lectura (una fila por membresía).
  const isAllTenants = activeTenant === ALL_TENANTS;
  // Parado en la empresa de sistema, el superadmin da de alta multiempresa (los endpoints
  // cross-tenant que necesita el formulario solo responden desde ahí).
  const activeSlug = currentUser?.tenants?.find((t) => t.tenantId === activeTenant)?.tenant
    ?.slug;
  const isSystemTenant = activeSlug === SYSTEM_TENANT_SLUG;
  // El alta multiempresa (formulario con su propio selector de empresas) se puede usar tanto
  // parado en la empresa de sistema como en "Todas las empresas": en ambos casos el header
  // resuelve a la empresa de sistema, que es lo que exige SystemTenantGuard.
  const canMultiCreate = isSystemTenant || isAllTenants;
  const [users, setUsers] = useState<UserData[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** null = cerrado · { user: null } = alta · { user } = edición. */
  const [editing, setEditing] = useState<{ user: UserData | null } | null>(null);
  /** El usuario cuyo detalle se está viendo (clic en la fila). */
  const [viewing, setViewing] = useState<UserData | null>(null);

  // En "Todas las empresas" editar y borrar se apagan (son por empresa), pero el alta sigue
  // disponible: el formulario multiempresa elige las empresas destino por su cuenta. No
  // alcanza con los permisos para apagar el resto, porque el superadmin tiene rol de sistema
  // con todos los permisos.
  const canCreate = hasPermission('users', 'create');
  const canUpdate = hasPermission('users', 'update') && !isAllTenants;
  const canDelete = hasPermission('users', 'delete') && !isAllTenants;
  const canReadRoles = hasPermission('roles', 'read');
  const canReadAreas = hasPermission('areas', 'read');

  const load = useCallback(async () => {
    try {
      // En la vista consolidada solo hace falta el listado cross-tenant; roles y áreas del
      // tenant activo solo alimentan el formulario de alta/edición, que ahí no se abre.
      if (isAllTenants) {
        setUsers(await apiFetch('/users/all'));
        return;
      }
      // El área es opcional, así que sin permiso para verlas la pantalla sigue andando:
      // simplemente no aparece el selector.
      const [userData, roleData, areaData] = await Promise.all([
        apiFetch('/users'),
        canReadRoles ? apiFetch('/roles') : Promise.resolve([]),
        canReadAreas ? apiFetch('/areas') : Promise.resolve([]),
      ]);
      setUsers(userData);
      setRoles(roleData.map((r: any) => ({ id: r.id, name: r.name })));
      setAreas(areaData.map((a: any) => ({ id: a.id, name: a.name })));
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAllTenants]);

  useEffect(() => {
    load();
  }, [load]);

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
      const res = await apiFetch(`/users/${u.id}`, { method: 'DELETE' });
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

  const noRoles = roles.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Usuarios</h1>
        {canCreate && (
          <button
            onClick={() => openModal(null)}
            // El alta multiempresa trae sus roles por empresa, así que no depende de que el
            // tenant activo tenga roles.
            disabled={noRoles && !canMultiCreate}
            title={
              noRoles && !canMultiCreate
                ? 'Primero tiene que haber al menos un rol'
                : undefined
            }
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300 whitespace-nowrap"
          >
            Nuevo usuario
          </button>
        )}
      </div>

      {feedback && (
        <p className={`mb-4 ${feedback.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {feedback.text}
        </p>
      )}

      {/* La lista de roles queda vacía por dos motivos distintos —la empresa no tiene
          ninguno, o esta persona no puede verlos— y cada uno se resuelve de otra forma.
          Con un solo mensaje, a quien le falta el permiso se le decía que no hay roles
          (falso) y se lo mandaba a una pantalla a la que tampoco puede entrar. */}
      {noRoles && canCreate && !canMultiCreate && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4 text-sm">
          {canReadRoles ? (
            <>
              No hay roles en este tenant. El rol es obligatorio, así que creá uno en{' '}
              <strong>Roles</strong> antes de dar de alta usuarios.
            </>
          ) : (
            <>
              No tenés permiso para ver los roles, y el rol es obligatorio para dar de alta
              un usuario. Pedile a un administrador que te habilite <strong>ver roles</strong>.
            </>
          )}
        </p>
      )}

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
              <th className="text-left px-4 py-2 font-semibold whitespace-nowrap">ID Invgate</th>
              <th className="text-left px-4 py-2 font-semibold">Creado</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td
                  colSpan={isAllTenants ? 10 : 9}
                  className="px-4 py-6 text-center text-gray-400"
                >
                  <p className="mb-3">Todavía no hay usuarios en esta empresa.</p>
                  {canCreate && (!noRoles || canMultiCreate) && (
                    <button
                      onClick={() => openModal(null)}
                      className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                    >
                      Crear el primero
                    </button>
                  )}
                </td>
              </tr>
            )}

            {users.map((u) => {
              if (deletingId === u.id) {
                return (
                  <tr key={u.id} className="border-t bg-red-50">
                    <td colSpan={isAllTenants ? 10 : 9} className="px-4 py-2">
                      <div className="flex gap-2 items-center flex-wrap">
                        <span className="text-red-700 mr-1">
                          ¿Dar de baja a <b>{userLabel(u)}</b> de esta empresa? Se lo quita
                          de este tenant; su historial se conserva.
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
                  key={isAllTenants ? `${u.id}-${u.tenant?.id}` : u.id}
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
                      {canUpdate && (
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
                      {canDelete &&
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
                              setDeletingId(u.id);
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

      {editing && (
        <UserModal
          user={editing.user}
          roles={roles}
          areas={areas}
          canReadAreas={canReadAreas}
          // Alta multiempresa: parado en la empresa de sistema o en la vista "Todas las empresas".
          multiTenant={canMultiCreate && !editing.user}
          onClose={() => setEditing(null)}
          onSaved={afterSave}
        />
      )}

      {viewing && (
        <UserDetailModal
          user={viewing}
          canEdit={canUpdate}
          onEdit={() => openModal(viewing)}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de usuario: un solo formulario para crear y para editar     */
/* ------------------------------------------------------------------ */

interface Membership {
  tenantId: string;
  roleId: string;
  areaId: string;
}

function UserModal({
  user,
  roles,
  areas,
  canReadAreas,
  multiTenant,
  onClose,
  onSaved,
}: {
  user: UserData | null;
  roles: RoleOption[];
  areas: AreaOption[];
  canReadAreas: boolean;
  multiTenant: boolean;
  onClose: () => void;
  onSaved: (message: Feedback) => void;
}) {
  const base = {
    email: user?.email ?? '',
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    phone: user?.phone ?? '',
    invgateUserId: user?.invgateUserId ?? '',
    roleId: user?.role?.id ?? '',
    areaId: user?.area?.id ?? '',
  };

  const [form, setForm] = useState({ ...base, password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Alta multiempresa: solo al crear (no al editar). El rol y el área van por empresa.
  const isMulti = multiTenant && !user;
  const [allTenants, setAllTenants] = useState<TenantOption[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [rolesByTenant, setRolesByTenant] = useState<Record<string, RoleOption[]>>({});
  const [areasByTenant, setAreasByTenant] = useState<Record<string, AreaOption[]>>({});

  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  // La lista de empresas del selector: solo responde parado en la empresa de sistema, que es
  // justo donde se habilita este formulario.
  useEffect(() => {
    if (!isMulti) return;
    apiFetch('/tenants/all')
      .then((list: any[]) =>
        setAllTenants(list.map((t) => ({ id: t.id, name: t.name, slug: t.slug }))),
      )
      .catch((err: any) => setError(err.message));
  }, [isMulti]);

  // Roles y áreas se piden por empresa, con caché para no repetir el request (patrón del
  // editor de flujos). El catch deja la lista vacía en vez de romper el formulario.
  async function loadRolesForTenant(tenantId: string) {
    if (rolesByTenant[tenantId]) return;
    try {
      const data = await apiFetch(`/roles/by-tenant/${tenantId}`);
      setRolesByTenant((prev) => ({
        ...prev,
        [tenantId]: (data || []).map((r: any) => ({ id: r.id, name: r.name })),
      }));
    } catch {
      setRolesByTenant((prev) => ({ ...prev, [tenantId]: prev[tenantId] || [] }));
    }
  }

  async function loadAreasForTenant(tenantId: string) {
    if (areasByTenant[tenantId]) return;
    try {
      const data = await apiFetch(`/areas/by-tenant/${tenantId}`);
      setAreasByTenant((prev) => ({
        ...prev,
        [tenantId]: (data || []).map((a: any) => ({ id: a.id, name: a.name })),
      }));
    } catch {
      setAreasByTenant((prev) => ({ ...prev, [tenantId]: prev[tenantId] || [] }));
    }
  }

  function addTenant(tenantId: string) {
    if (!tenantId || memberships.some((m) => m.tenantId === tenantId)) return;
    setMemberships((prev) => [...prev, { tenantId, roleId: '', areaId: '' }]);
    loadRolesForTenant(tenantId);
    loadAreasForTenant(tenantId);
  }
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

  const availableTenants = allTenants.filter(
    (t) => !memberships.some((m) => m.tenantId === t.id),
  );
  const tenantName = (id: string) => allTenants.find((t) => t.id === id)?.name ?? id;

  const noRoles = roles.length === 0;

  const changed = isMulti
    ? form.firstName.length > 0 ||
      form.lastName.length > 0 ||
      form.email.length > 0 ||
      form.phone.length > 0 ||
      form.invgateUserId.length > 0 ||
      form.password.length > 0 ||
      memberships.length > 0
    : form.firstName !== base.firstName ||
      form.lastName !== base.lastName ||
      form.phone !== base.phone ||
      form.invgateUserId !== base.invgateUserId ||
      form.roleId !== base.roleId ||
      (canReadAreas && form.areaId !== base.areaId) ||
      form.password.length > 0 ||
      (!user && form.email !== base.email);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (changed && !confirm('Tenés cambios sin guardar. ¿Descartarlos?')) return;
    onClose();
  }, [saving, changed, onClose]);

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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (user) {
        const payload: Record<string, string> = {
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          invgateUserId: form.invgateUserId,
          roleId: form.roleId,
        };
        // La contraseña solo viaja si se completó: vacío significa "no la cambies".
        if (form.password) payload.password = form.password;
        // Sin permiso para ver áreas no hay selector, y mandar el campo vacío le borraría
        // el área al usuario sin que nadie lo haya pedido.
        if (canReadAreas) payload.areaId = form.areaId;

        await apiFetch(`/users/${user.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        onSaved({ kind: 'ok', text: `Usuario ${userLabel({ ...user, ...form } as UserData)} guardado.` });
      } else if (isMulti) {
        if (memberships.length === 0) {
          setError('Elegí al menos una empresa.');
          setSaving(false);
          return;
        }
        if (memberships.some((m) => !m.roleId)) {
          setError('Cada empresa necesita un rol.');
          setSaving(false);
          return;
        }
        await apiFetch('/users/multi', {
          method: 'POST',
          body: JSON.stringify({
            email: form.email,
            firstName: form.firstName,
            lastName: form.lastName,
            password: form.password,
            phone: form.phone || undefined,
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
      } else {
        await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify(form),
        });
        onSaved({ kind: 'ok', text: 'Usuario creado.' });
      }
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  const saveDisabled = isMulti
    ? saving || memberships.length === 0 || memberships.some((m) => !m.roleId)
    : saving || (user === null && noRoles) || (user !== null && !changed);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-modal-title"
    >
      <form
        onSubmit={save}
        className="bg-white rounded-md shadow-2xl w-full max-w-[720px] max-h-full flex flex-col text-gray-900"
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="user-modal-title" className="text-lg font-semibold text-gray-800">
              {user ? 'Editar usuario' : 'Nuevo usuario'}
            </h2>
            {isMulti && (
              <p className="mt-1 text-xs text-gray-500">
                Alta en varias empresas: elegí el rol y el área de cada una.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Cerrar"
            className="text-xl leading-none text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
              <input
                ref={firstRef}
                placeholder="Juan"
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                className="border border-gray-200 px-3 py-2 rounded w-full"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Apellido *</label>
              <input
                placeholder="Pérez"
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                className="border border-gray-200 px-3 py-2 rounded w-full"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email *</label>
              <input
                type="email"
                placeholder="juan.perez@empresa.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="border border-gray-200 px-3 py-2 rounded w-full disabled:bg-gray-100"
                disabled={!!user}
                title={user ? 'El email no se puede cambiar' : undefined}
                required
              />
            </div>

            {!isMulti && (
              <>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Rol *</label>
                  <select
                    value={form.roleId}
                    onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                    className="border border-gray-200 px-3 py-2 rounded w-full"
                    required
                  >
                    <option value="">Seleccionar rol</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                {canReadAreas && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Área</label>
                    <select
                      value={form.areaId}
                      onChange={(e) => setForm({ ...form, areaId: e.target.value })}
                      className="border border-gray-200 px-3 py-2 rounded w-full"
                    >
                      <option value="">Sin área</option>
                      {areas.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    {areas.length === 0 && (
                      <p className="text-xs text-gray-400 mt-1">
                        Todavía no hay áreas en esta empresa.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Teléfono</label>
              <input
                placeholder="+54911..."
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="border border-gray-200 px-3 py-2 rounded w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ID de Invgate</label>
              <input
                value={form.invgateUserId}
                onChange={(e) => setForm({ ...form, invgateUserId: e.target.value })}
                className="border border-gray-200 px-3 py-2 rounded w-full"
                maxLength={64}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                {user ? 'Nueva contraseña' : 'Contraseña *'}
              </label>
              <input
                type="password"
                placeholder={user ? 'Dejar vacío para no cambiarla' : 'Mínimo 8 caracteres'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="border border-gray-200 px-3 py-2 rounded w-full"
                minLength={8}
                required={!user}
              />
            </div>
          </div>

          {isMulti && (
            <div className="mt-4 border-t border-gray-200 pt-4">
              <label className="block text-xs text-gray-500 mb-1">Empresas *</label>
              <p className="text-xs text-gray-400 mb-3">
                Elegí en qué empresas se da de alta a la persona. Por cada una, un rol
                (obligatorio) y un área (opcional).
              </p>

              {memberships.length === 0 && (
                <p className="text-xs text-gray-400 mb-2">
                  Todavía no agregaste ninguna empresa.
                </p>
              )}

              <div className="space-y-2">
                {memberships.map((m) => {
                  const tRoles = rolesByTenant[m.tenantId];
                  const tAreas = areasByTenant[m.tenantId];
                  return (
                    <div key={m.tenantId} className="border border-gray-200 rounded p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-sm">{tenantName(m.tenantId)}</span>
                        <button
                          type="button"
                          onClick={() => removeTenant(m.tenantId)}
                          className="text-red-600 hover:text-red-800 text-xs"
                        >
                          Quitar
                        </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Rol *</label>
                          <select
                            value={m.roleId}
                            onChange={(e) => setMembershipRole(m.tenantId, e.target.value)}
                            className="border border-gray-200 px-3 py-2 rounded w-full"
                            required
                          >
                            <option value="">
                              {tRoles ? 'Seleccionar rol' : 'Cargando...'}
                            </option>
                            {(tRoles || []).map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                          {tRoles && tRoles.length === 0 && (
                            <p className="text-xs text-amber-700 mt-1">
                              Esta empresa no tiene roles. Creá uno antes de darla de alta.
                            </p>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Área</label>
                          <select
                            value={m.areaId}
                            onChange={(e) => setMembershipArea(m.tenantId, e.target.value)}
                            className="border border-gray-200 px-3 py-2 rounded w-full"
                          >
                            <option value="">Sin área</option>
                            {(tAreas || []).map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {availableTenants.length > 0 && (
                <select
                  value=""
                  onChange={(e) => addTenant(e.target.value)}
                  className="mt-2 border border-gray-200 px-3 py-2 rounded w-full text-gray-600"
                >
                  <option value="">+ Agregar empresa…</option>
                  {availableTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="px-5 py-2 text-sm text-red-600 bg-red-50 border-t border-red-200">
            {error}
          </p>
        )}

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3 rounded-b-md">
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
            {saving ? 'Guardando...' : user ? 'Guardar' : 'Crear'}
          </button>
        </div>
      </form>
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
