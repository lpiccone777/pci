'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface TenantData {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  /** Contadores de uso, para el detalle y para dimensionar la empresa de un vistazo. */
  userCount: number;
  roleCount: number;
  areaCount: number;
  /** La empresa de sistema: slug congelado y sin baja. Se muestra en modo protegido. */
  isSystem: boolean;
}

type Feedback = { kind: 'ok' | 'error'; text: string };

export default function TenantsPage() {
  const { hasPermission } = useAuth();
  const [tenants, setTenants] = useState<TenantData[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** null = cerrado · { tenant: null } = alta · { tenant } = edición. */
  const [editing, setEditing] = useState<{ tenant: TenantData | null } | null>(null);
  /** La empresa cuyo detalle se está viendo (clic en la fila). */
  const [viewing, setViewing] = useState<TenantData | null>(null);

  const canCreate = hasPermission('tenants', 'create');
  const canUpdate = hasPermission('tenants', 'update');
  const canDelete = hasPermission('tenants', 'delete');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/tenants/all');
      setTenants(data);
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openModal(tenant: TenantData | null) {
    setFeedback(null);
    setDeletingId(null);
    setViewing(null);
    setEditing({ tenant });
  }

  function openDetail(tenant: TenantData) {
    setFeedback(null);
    setDeletingId(null);
    setViewing(tenant);
  }

  async function confirmDelete(tenant: TenantData) {
    setBusy(true);
    try {
      const res = await apiFetch(`/tenants/${tenant.id}`, { method: 'DELETE' });
      setFeedback({ kind: 'ok', text: res?.message || `Empresa ${tenant.name} dada de baja.` });
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
        <h1 className="text-2xl font-bold text-gray-800">Tenants</h1>
        {canCreate && (
          <button
            onClick={() => openModal(null)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 whitespace-nowrap"
          >
            Nuevo Tenant
          </button>
        )}
      </div>

      {feedback && (
        <p className={`mb-4 ${feedback.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {feedback.text}
        </p>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Nombre</th>
              <th className="text-left px-4 py-2 font-semibold">Slug</th>
              <th className="text-right px-4 py-2 font-semibold whitespace-nowrap">Usuarios</th>
              <th className="text-left px-4 py-2 font-semibold">Creado</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  <p className="mb-3">Todavía no hay empresas cargadas.</p>
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

            {tenants.map((t) =>
              deletingId === t.id ? (
                <tr key={t.id} className="border-t bg-red-50">
                  <td colSpan={5} className="px-4 py-2">
                    <div className="flex gap-2 items-center flex-wrap">
                      <span className="text-red-700 mr-1">
                        ¿Dar de baja la empresa <b>{t.name}</b>? Deja de aparecer en el
                        listado; sus datos se conservan.
                      </span>
                      <button
                        onClick={() => confirmDelete(t)}
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
              ) : (
                <tr
                  key={t.id}
                  onClick={() => openDetail(t)}
                  className="border-t hover:bg-gray-50 cursor-pointer"
                  title="Ver detalle"
                >
                  <td className="px-4 py-2">
                    <span className="font-medium">{t.name}</span>
                    {t.isSystem && (
                      <span
                        title="Empresa de sistema: no se puede dar de baja ni cambiarle el slug"
                        className="ml-2 align-middle text-[11px] uppercase tracking-wider text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5"
                      >
                        Sistema
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-500">{t.slug}</td>
                  <td className="px-4 py-2 text-right text-gray-600 tabular-nums">
                    {t.userCount}
                  </td>
                  <td className="px-4 py-2">{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {/* stopPropagation: los botones no deben abrir además el detalle de la fila. */}
                    {canUpdate && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openModal(t);
                        }}
                        className="text-blue-600 hover:text-blue-800 px-2"
                      >
                        Editar
                      </button>
                    )}
                    {canDelete &&
                      (t.isSystem ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setFeedback({
                              kind: 'error',
                              text: `${t.name} es la empresa de sistema: no se puede dar de baja.`,
                            });
                          }}
                          aria-disabled="true"
                          title="No se puede dar de baja: es la empresa de sistema"
                          className="text-gray-400 hover:text-gray-500 cursor-not-allowed px-2"
                        >
                          Dar de baja
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setFeedback(null);
                            setViewing(null);
                            setDeletingId(t.id);
                          }}
                          className="text-red-600 hover:text-red-800 px-2"
                        >
                          Dar de baja
                        </button>
                      ))}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <TenantModal
          tenant={editing.tenant}
          canCreate={canCreate}
          canUpdate={canUpdate}
          otherSlugs={tenants
            .filter((t) => t.id !== editing.tenant?.id)
            .map((t) => t.slug.toLowerCase())}
          onClose={() => setEditing(null)}
          onSaved={afterSave}
        />
      )}

      {viewing && (
        <TenantDetailModal
          tenant={viewing}
          canEdit={canUpdate}
          onEdit={() => openModal(viewing)}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana de empresa: un solo formulario para crear y para editar     */
/* ------------------------------------------------------------------ */

function TenantModal({
  tenant,
  canCreate,
  canUpdate,
  otherSlugs,
  onClose,
  onSaved,
}: {
  tenant: TenantData | null;
  canCreate: boolean;
  canUpdate: boolean;
  otherSlugs: string[];
  onClose: () => void;
  onSaved: (message: Feedback) => void;
}) {
  const baseName = tenant?.name ?? '';
  const baseSlug = tenant?.slug ?? '';

  const [name, setName] = useState(baseName);
  const [slug, setSlug] = useState(baseSlug);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const nameRef = useRef<HTMLInputElement>(null);

  // El slug de la empresa de sistema no se puede cambiar (de él dependen los cortes de
  // superusuario). El backend lo rechaza igual; deshabilitarlo evita prometer algo que
  // va a fallar al guardar.
  const slugLocked = !!tenant?.isSystem;

  const canEdit = tenant ? canUpdate : canCreate;

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const changed = name.trim() !== baseName || slug.trim() !== baseSlug;

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
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName) {
      setError('La empresa necesita un nombre.');
      nameRef.current?.focus();
      return;
    }
    if (!trimmedSlug) {
      setError('La empresa necesita un slug.');
      return;
    }
    if (otherSlugs.includes(trimmedSlug.toLowerCase())) {
      setError(`Ya existe una empresa con el slug ${trimmedSlug}.`);
      return;
    }

    setSaving(true);
    setError('');

    try {
      if (!tenant) {
        await apiFetch('/tenants', {
          method: 'POST',
          body: JSON.stringify({ name: trimmedName, slug: trimmedSlug }),
        });
        onSaved({ kind: 'ok', text: `Empresa ${trimmedName} creada.` });
      } else {
        await apiFetch(`/tenants/${tenant.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: trimmedName, slug: trimmedSlug }),
        });
        onSaved({ kind: 'ok', text: `Empresa ${trimmedName} guardada.` });
      }
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  const saveDisabled = saving || !canEdit || (tenant !== null && !changed);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tenant-modal-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[480px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="tenant-modal-title" className="text-lg font-semibold text-gray-800">
              {tenant ? 'Editar empresa' : 'Nueva empresa'}
            </h2>
          </div>
          <button
            onClick={requestClose}
            aria-label="Cerrar"
            className="text-xl leading-none text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-1"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          <div>
            <label htmlFor="tenant-name" className="block text-xs text-gray-500 mb-1">
              Nombre *
            </label>
            <input
              id="tenant-name"
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
              placeholder="Ej: Empresa S.A."
              className="w-full border border-gray-200 px-3 py-2 rounded disabled:bg-gray-100"
            />
          </div>

          <div>
            <label htmlFor="tenant-slug" className="block text-xs text-gray-500 mb-1">
              Slug (identificador único) *
            </label>
            <input
              id="tenant-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save();
                }
              }}
              disabled={!canEdit || slugLocked || saving}
              autoComplete="off"
              placeholder="Ej: empresa-sa"
              className="w-full border border-gray-200 px-3 py-2 rounded disabled:bg-gray-100"
            />
            <p className="mt-1 text-xs text-gray-500">
              {slugLocked
                ? 'El slug de la empresa de sistema no se puede cambiar.'
                : 'Identificador corto y único. No se puede repetir, ni siquiera con una empresa dada de baja.'}
            </p>
          </div>
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

function TenantDetailModal({
  tenant,
  canEdit,
  onEdit,
  onClose,
}: {
  tenant: TenantData;
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
    { label: 'Nombre', value: tenant.name },
    { label: 'Slug', value: tenant.slug },
    { label: 'Usuarios', value: String(tenant.userCount) },
    { label: 'Roles', value: String(tenant.roleCount) },
    { label: 'Áreas', value: String(tenant.areaCount) },
    { label: 'Creada', value: new Date(tenant.createdAt).toLocaleString() },
    { label: 'Última modificación', value: new Date(tenant.updatedAt).toLocaleString() },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-gray-900/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tenant-detail-title"
    >
      <div className="bg-white rounded-md shadow-2xl w-full max-w-[480px] max-h-full flex flex-col text-gray-900">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="tenant-detail-title" className="text-lg font-semibold text-gray-800">
              {tenant.name}
            </h2>
            {tenant.isSystem && (
              <span className="mt-1 inline-block text-[11px] uppercase tracking-wider text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
                Empresa de sistema
              </span>
            )}
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
