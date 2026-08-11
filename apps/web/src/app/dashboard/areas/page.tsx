'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { ALL_TENANTS } from '@/lib/system-tenant';

interface AreaData {
  id: string;
  name: string;
  createdAt: string;
  /** Cuántos usuarios del tenant activo están asignados a esta área. */
  userCount: number;
  /** Solo en la vista "Todas las empresas": a qué empresa pertenece el área. */
  tenant?: { id: string; name: string; slug: string };
}

interface AreaUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

type Feedback = { kind: 'ok' | 'error'; text: string };

export default function AreasPage() {
  const { hasPermission, hasPermissionInTenant, activeTenant, isSystemUser } = useAuth();
  // Vista consolidada "Todas las empresas": el superadmin ve las de todo el sistema
  // (`/areas/all`); el usuario común con varias empresas, solo las suyas (`/areas/mine`).
  // Antes era exclusiva del superadmin y de solo lectura; ahora ambos pueden modificar y
  // eliminar por fila (cada acción va contra la empresa de esa fila), pero el alta sigue
  // apagada: para crear hay que pararse en una empresa puntual.
  const isAllTenants = activeTenant === ALL_TENANTS;
  const [areas, setAreas] = useState<AreaData[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** null = cerrado · { area: null } = alta · { area } = edición. */
  const [editing, setEditing] = useState<{ area: AreaData | null } | null>(null);
  /** El área cuyo detalle se está viendo (clic en la fila). */
  const [viewing, setViewing] = useState<AreaData | null>(null);
  /** El área cuya lista de usuarios se está viendo (clic en el número). */
  const [viewingUsers, setViewingUsers] = useState<AreaData | null>(null);

  // El alta se apaga en la vista consolidada: no hay una empresa activa donde crear. Modificar
  // y eliminar, en cambio, se deciden por fila (cada una es de una empresa distinta): ver
  // `rowCanUpdate` / `rowCanDelete`.
  const canCreate = hasPermission('areas', 'create') && !isAllTenants;
  const canUpdate = hasPermission('areas', 'update') && !isAllTenants;
  const canDelete = hasPermission('areas', 'delete') && !isAllTenants;

  // En la vista consolidada el permiso se evalúa contra la empresa de la fila (el superadmin
  // que opera sobre una empresa ajena cae a su rol de sistema). En una empresa puntual manda
  // el permiso del tenant activo, ya resuelto en `canUpdate` / `canDelete`.
  const rowCanUpdate = (a: AreaData) =>
    isAllTenants ? hasPermissionInTenant(a.tenant?.id ?? '', 'areas', 'update') : canUpdate;
  const rowCanDelete = (a: AreaData) =>
    isAllTenants ? hasPermissionInTenant(a.tenant?.id ?? '', 'areas', 'delete') : canDelete;

  const load = useCallback(async () => {
    try {
      // Consolidada: el superadmin trae todo el sistema; el usuario común, solo sus empresas.
      const endpoint = !isAllTenants
        ? '/areas'
        : isSystemUser
          ? '/areas/all'
          : '/areas/mine';
      setAreas(await apiFetch(endpoint));
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [isAllTenants, isSystemUser]);

  useEffect(() => {
    load();
  }, [load]);

  function openModal(area: AreaData | null) {
    setFeedback(null);
    setDeletingId(null);
    setViewing(null);
    setEditing({ area });
  }

  function openDetail(area: AreaData) {
    setFeedback(null);
    setDeletingId(null);
    setViewing(area);
  }

  function openUsers(area: AreaData) {
    setFeedback(null);
    setDeletingId(null);
    setViewingUsers(area);
  }

  /** El botón gris de un área que no se puede borrar: responde al clic y explica por qué. */
  function explainBlockedDelete(area: AreaData) {
    setDeletingId(null);
    setFeedback({
      kind: 'error',
      text:
        `No se puede eliminar ${area.name}: ${area.userCount} ` +
        (area.userCount === 1
          ? 'usuario está asignado a esta área.'
          : 'usuarios están asignados a esta área.') +
        ' Reasignalos desde Usuarios y volvé a intentar.',
    });
  }

  async function confirmDelete(area: AreaData) {
    setBusy(true);
    try {
      const res = await apiFetch(`/areas/${area.id}`, {
        method: 'DELETE',
        // En la vista consolidada la baja va contra la empresa de la fila, no contra el header
        // del selector (que apunta al sistema / a la empresa de respaldo).
        ...(isAllTenants && area.tenant
          ? { headers: { 'X-Tenant-Id': area.tenant.id } }
          : {}),
      });
      setFeedback({ kind: 'ok', text: res?.message || `Área ${area.name} eliminada.` });
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
      <div className="flex items-center justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold text-gray-800">Áreas</h1>
        {canCreate && (
          <button
            onClick={() => openModal(null)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 whitespace-nowrap"
          >
            Nueva área
          </button>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-6">
        {isAllTenants
          ? `Áreas de ${
              isSystemUser ? 'todas las empresas' : 'todas tus empresas'
            }. Podés modificar o eliminar cada una en su empresa; para crear una nueva, elegí una empresa en el selector lateral.`
          : 'Agrupan a los usuarios de esta empresa para auditoría y métricas. No intervienen en los flujos IVR, que se resuelven por rol.'}
      </p>

      {feedback && (
        <p className={`mb-4 ${feedback.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {feedback.text}
        </p>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              {isAllTenants && (
                <th className="text-left px-4 py-2 font-semibold">Empresa</th>
              )}
              <th className="text-left px-4 py-2 font-semibold">Nombre</th>
              <th className="text-right px-4 py-2 font-semibold whitespace-nowrap">Usuarios</th>
              <th className="text-left px-4 py-2 font-semibold">Creada</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {areas.length === 0 && (
              <tr>
                <td colSpan={isAllTenants ? 5 : 4} className="px-4 py-6 text-center text-gray-400">
                  <p className="mb-3">
                    {isAllTenants
                      ? 'No hay áreas para mostrar.'
                      : 'Todavía no hay áreas en esta empresa.'}
                  </p>
                  {canCreate && (
                    <button
                      onClick={() => openModal(null)}
                      className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                    >
                      Crear la primera
                    </button>
                  )}
                </td>
              </tr>
            )}

            {areas.map((a) =>
              deletingId === a.id ? (
                <tr key={a.id} className="border-t bg-red-50">
                  <td colSpan={isAllTenants ? 5 : 4} className="px-4 py-2">
                    <div className="flex gap-2 items-center flex-wrap">
                      <span className="text-red-700 mr-1">
                        ¿Eliminar el área <b>{a.name}</b>
                        {isAllTenants && a.tenant ? (
                          <>
                            {' '}
                            de <b>{a.tenant.name}</b>
                          </>
                        ) : null}
                        ? Esta acción no se puede deshacer.
                      </span>
                      <button
                        onClick={() => confirmDelete(a)}
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
                  key={a.id}
                  onClick={() => openDetail(a)}
                  className="border-t hover:bg-gray-50 cursor-pointer"
                  title="Ver detalle"
                >
                  {isAllTenants && (
                    <td className="px-4 py-2 text-gray-500">{a.tenant?.name ?? '—'}</td>
                  )}
                  <td className="px-4 py-2 font-medium">{a.name}</td>
                  <td className="px-4 py-2 text-right">
                    {/* El número ES el acceso a la lista, igual que en Roles: el dato y la
                        forma de abrirlo son la misma cosa, así que no lleva un botón aparte.
                        stopPropagation para que abrir la lista no dispare también el detalle.
                        En "Todas las empresas" el drill-down pega contra un endpoint scopeado
                        a la empresa activa, así que ahí el número va como texto plano. */}
                    {isAllTenants ? (
                      <span className="tabular-nums">{a.userCount}</span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openUsers(a);
                        }}
                        title={`Ver los usuarios del área ${a.name}`}
                        className="text-blue-600 hover:text-blue-800 hover:underline tabular-nums"
                      >
                        {a.userCount}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2">{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 text-right whitespace-nowrap">
                    {/* Fuera de la zona que abre el detalle va SOLO el grupo de botones. El
                        stopPropagation vive en este contenedor, que se lleva el padding vertical
                        (py-2) para ocupar el alto completo de la fila: así un clic apenas arriba
                        o abajo del botón tampoco abre el detalle. title="" evita heredar el
                        tooltip del <tr>. */}
                    <span
                      className="inline-block align-middle py-2 pl-0.5 cursor-default"
                      onClick={(e) => e.stopPropagation()}
                      title=""
                    >
                      {rowCanUpdate(a) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openModal(a);
                          }}
                          className="text-blue-600 hover:text-blue-800 px-2"
                        >
                          Editar
                        </button>
                      )}
                      {rowCanDelete(a) &&
                        (a.userCount === 0 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFeedback(null);
                              setViewing(null);
                              setDeletingId(a.id);
                            }}
                            className="text-red-600 hover:text-red-800 px-2"
                          >
                            Eliminar
                          </button>
                        ) : (
                          // aria-disabled y no disabled: con `disabled` de verdad, quien navega
                          // por teclado ni lo encuentra, y en táctil no hay hover que dé el motivo.
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              explainBlockedDelete(a);
                            }}
                            aria-disabled="true"
                            title={`No se puede eliminar: tiene ${a.userCount} ${
                              a.userCount === 1 ? 'usuario asignado' : 'usuarios asignados'
                            }`}
                            className="text-gray-400 hover:text-gray-500 cursor-not-allowed px-2"
                          >
                            Eliminar
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

      {editing && (
        <AreaModal
          area={editing.area}
          canCreate={canCreate}
          canUpdate={editing.area ? rowCanUpdate(editing.area) : canUpdate}
          // En la vista consolidada, la ventana muestra la empresa del área y dirige el guardado
          // a ella; en una empresa puntual, ambas quedan indefinidas y se opera sobre la activa.
          tenantName={isAllTenants ? editing.area?.tenant?.name : undefined}
          tenantHeader={isAllTenants ? editing.area?.tenant?.id : undefined}
          otherNames={areas
            .filter((a) => a.id !== editing.area?.id)
            // El nombre es único por empresa: en la vista consolidada solo chocan las de la
            // misma empresa que se está editando.
            .filter((a) => !isAllTenants || a.tenant?.id === editing.area?.tenant?.id)
            .map((a) => a.name.toLowerCase())}
          onClose={() => setEditing(null)}
          onSaved={afterSave}
        />
      )}

      {viewing && (
        <AreaDetailModal
          area={viewing}
          canEdit={rowCanUpdate(viewing)}
          isAllTenants={isAllTenants}
          onEdit={() => openModal(viewing)}
          onViewUsers={() => {
            const a = viewing;
            setViewing(null);
            openUsers(a);
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {viewingUsers && (
        <UsersModal area={viewingUsers} onClose={() => setViewingUsers(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de área: un solo formulario para crear y para editar        */
/* ------------------------------------------------------------------ */

function AreaModal({
  area,
  canCreate,
  canUpdate,
  tenantName,
  tenantHeader,
  otherNames,
  onClose,
  onSaved,
}: {
  area: AreaData | null;
  canCreate: boolean;
  canUpdate: boolean;
  /** Nombre de la empresa del área, solo en la vista consolidada. Se muestra en el encabezado. */
  tenantName?: string;
  /** Empresa a la que dirigir el guardado (header `X-Tenant-Id`), solo en la vista consolidada. */
  tenantHeader?: string;
  otherNames: string[];
  onClose: () => void;
  onSaved: (message: Feedback) => void;
}) {
  const baseName = area?.name ?? '';

  const [name, setName] = useState(baseName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const nameRef = useRef<HTMLInputElement>(null);

  const canEdit = area ? canUpdate : canCreate;

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const changed = name.trim() !== baseName;

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

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('El área necesita un nombre.');
      nameRef.current?.focus();
      return;
    }
    if (otherNames.includes(trimmed.toLowerCase())) {
      setError(`Ya existe un área llamada ${trimmed} en esta empresa.`);
      nameRef.current?.focus();
      return;
    }

    setSaving(true);
    setError('');

    try {
      if (!area) {
        await apiFetch('/areas', {
          method: 'POST',
          body: JSON.stringify({ name: trimmed }),
        });
        onSaved({ kind: 'ok', text: `Área ${trimmed} creada.` });
      } else {
        await apiFetch(`/areas/${area.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: trimmed }),
          // En la vista consolidada el guardado va contra la empresa del área, no contra el
          // header del selector.
          ...(tenantHeader ? { headers: { 'X-Tenant-Id': tenantHeader } } : {}),
        });
        onSaved({ kind: 'ok', text: `Área ${trimmed} guardada.` });
      }
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  const saveDisabled = saving || !canEdit || (area !== null && !changed);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="area-modal-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[480px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="area-modal-title" className="text-lg font-semibold text-gray-800">
              {area ? 'Editar área' : 'Nueva área'}
            </h2>
            {tenantName && (
              <p className="mt-1 text-xs text-gray-500">
                Empresa: <span className="text-gray-700">{tenantName}</span>
              </p>
            )}
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
          <label htmlFor="area-name" className="block text-xs text-gray-500 mb-1">
            Nombre *
          </label>
          <input
            id="area-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
            disabled={!canEdit || saving}
            autoComplete="off"
            placeholder="Ej: Soporte"
            maxLength={80}
            className="w-full border border-gray-200 px-3 py-2 rounded disabled:bg-gray-100"
          />
        </div>

        {error && (
          <p className="px-5 py-2 text-sm text-red-600 bg-red-50 border-t border-red-200">
            {error}
          </p>
        )}

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3 rounded-b-md">
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
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de detalle: solo lectura, al clickear una fila              */
/* ------------------------------------------------------------------ */

function AreaDetailModal({
  area,
  canEdit,
  isAllTenants,
  onEdit,
  onViewUsers,
  onClose,
}: {
  area: AreaData;
  canEdit: boolean;
  isAllTenants: boolean;
  onEdit: () => void;
  onViewUsers: () => void;
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="area-detail-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[480px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="area-detail-title" className="text-lg font-semibold text-gray-800">
              {area.name}
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
            {isAllTenants && area.tenant && (
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-xs uppercase tracking-wider text-gray-500">Empresa</dt>
                <dd className="text-sm text-gray-800 text-right break-all">
                  {area.tenant.name}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Nombre</dt>
              <dd className="text-sm text-gray-800 text-right break-all">{area.name}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Usuarios</dt>
              <dd className="text-sm text-gray-800 text-right tabular-nums">
                {/* El número abre la lista, igual que en la tabla. En "Todas las empresas"
                    el drill-down pega contra un endpoint scopeado, así que va como texto. */}
                {isAllTenants ? (
                  <span className="tabular-nums">{area.userCount}</span>
                ) : (
                  <button
                    onClick={onViewUsers}
                    className="text-blue-600 hover:text-blue-800 hover:underline tabular-nums"
                  >
                    {area.userCount}
                  </button>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-xs uppercase tracking-wider text-gray-500">Creada</dt>
              <dd className="text-sm text-gray-800 text-right">
                {new Date(area.createdAt).toLocaleString()}
              </dd>
            </div>
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
/* Ventana de usuarios del área                                        */
/* ------------------------------------------------------------------ */

function UsersModal({ area, onClose }: { area: AreaData; onClose: () => void }) {
  const router = useRouter();
  const [people, setPeople] = useState<AreaUser[] | null>(null);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    apiFetch(`/areas/${area.id}/users`)
      .then(setPeople)
      .catch((err: any) => setError(err.message));
  }, [area.id]);

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
      role="dialog"
      aria-modal="true"
      aria-labelledby="area-users-modal-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[520px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2
              id="area-users-modal-title"
              className="text-lg font-semibold text-gray-800"
            >
              Usuarios del área {area.name}
            </h2>
            <p className="mt-2 text-xs text-gray-500">
              {area.userCount === 0
                ? 'Ningún usuario está asignado a esta área.'
                : area.userCount === 1
                  ? '1 usuario'
                  : `${area.userCount} usuarios`}
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

          {!error && people === null && (
            <p className="text-gray-500 text-sm">Cargando...</p>
          )}

          {!error && people !== null && people.length === 0 && (
            <p className="py-6 text-center text-sm text-gray-400">
              Nadie está en esta área todavía.
              <br />
              Por eso se puede eliminar sin dejar a nadie sin área.
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
            {people && people.length > 0 ? 'El área se cambia desde cada usuario.' : ''}
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
