'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Internos que atiende el voicebot (*Mensajería → Voicebot → Internos*, contrato de integración
 * §3.5). No son claves del catálogo sino una entidad propia (`/voicebot/extensions`), así que
 * tienen su panel. El número es el que se marca (en desarrollo, desde MicroSIP) y no puede
 * coincidir con el interno de una persona: el backend lo valida en los dos sentidos.
 */
interface Extension {
  id: string;
  number: string;
  name: string;
  tenantId: string;
  flowId: string | null;
  enabled: boolean;
  tenant: { id: string; name: string; slug: string; deletedAt: string | null };
}

interface TenantOption {
  id: string;
  name: string;
}

type Draft = { number: string; name: string; tenantId: string; enabled: boolean };
const EMPTY_DRAFT: Draft = { number: '', name: '', tenantId: '', enabled: true };

const CHANGE_NOTICE = 'El voicebot toma el cambio al recibir el aviso de configuración.';

export function VoicebotExtensions({ canUpdate, canDelete }: { canUpdate: boolean; canDelete: boolean }) {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** null = sin formulario · { id: null } = alta · { id } = edición. */
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);

  async function load() {
    try {
      const [exts, ts]: [Extension[], TenantOption[]] = await Promise.all([
        apiFetch('/voicebot/extensions'),
        apiFetch('/tenants/all'),
      ]);
      setExtensions(exts);
      setTenants(ts.map((t) => ({ id: t.id, name: t.name })));
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setNotice('');
    try {
      await action();
      setError('');
      setNotice(`${ok} ${CHANGE_NOTICE}`);
      setEditing(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!editing) return;
    const { id, draft } = editing;
    const body = JSON.stringify({ ...draft, number: draft.number.trim(), name: draft.name.trim() });
    run(
      () =>
        id
          ? apiFetch(`/voicebot/extensions/${id}`, { method: 'PATCH', body })
          : apiFetch('/voicebot/extensions', { method: 'POST', body }),
      id ? `Interno ${draft.number.trim()} actualizado.` : `Interno ${draft.number.trim()} creado.`,
    );
  }

  function toggle(ext: Extension) {
    run(
      () =>
        apiFetch(`/voicebot/extensions/${ext.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !ext.enabled }),
        }),
      `Interno ${ext.number} ${ext.enabled ? 'deshabilitado' : 'habilitado'}.`,
    );
  }

  function remove(ext: Extension) {
    if (!window.confirm(`¿Eliminar el interno ${ext.number} (${ext.name})?`)) return;
    run(() => apiFetch(`/voicebot/extensions/${ext.id}`, { method: 'DELETE' }), `Interno ${ext.number} eliminado.`);
  }

  if (loading) return <p className="text-gray-500 text-sm">Cargando internos...</p>;

  const draft = editing?.draft;
  const setDraft = (patch: Partial<Draft>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Números que atiende el voicebot y la empresa que atiende cada uno. Solo se atienden las llamadas
        a internos habilitados: el resto se rechaza. El número no puede ser el interno de una persona.
      </p>
      {error && (
        <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-2">Número</th>
              <th className="px-4 py-2">Nombre</th>
              <th className="px-4 py-2">Empresa</th>
              <th className="px-4 py-2">Estado</th>
              <th className="px-4 py-2 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {extensions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  Todavía no hay internos.
                </td>
              </tr>
            )}
            {extensions.map((ext) => (
              <tr key={ext.id} className="border-t">
                <td className="px-4 py-2 font-mono">{ext.number}</td>
                <td className="px-4 py-2">{ext.name}</td>
                <td className="px-4 py-2">
                  {ext.tenant.name}
                  {ext.tenant.deletedAt && <span className="ml-1 text-xs text-red-600">(dada de baja)</span>}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      ext.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {ext.enabled ? 'habilitado' : 'deshabilitado'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap space-x-3">
                  {canUpdate && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(ext)}
                        className="text-blue-600 hover:underline disabled:text-gray-400"
                      >
                        {ext.enabled ? 'Deshabilitar' : 'Habilitar'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setEditing({
                            id: ext.id,
                            draft: { number: ext.number, name: ext.name, tenantId: ext.tenantId, enabled: ext.enabled },
                          })
                        }
                        className="text-blue-600 hover:underline disabled:text-gray-400"
                      >
                        Editar
                      </button>
                    </>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(ext)}
                      className="text-red-600 hover:underline disabled:text-gray-400"
                    >
                      Eliminar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canUpdate && !editing && (
        <button
          type="button"
          onClick={() => setEditing({ id: null, draft: EMPTY_DRAFT })}
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"
        >
          Nuevo interno
        </button>
      )}

      {editing && draft && (
        <form
          aria-label={editing.id ? 'Editar interno' : 'Nuevo interno'}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="bg-white p-4 rounded shadow grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          <label className="text-sm">
            <span className="block font-medium text-gray-800 mb-1">Número</span>
            <input
              id="extension-number"
              value={draft.number}
              onChange={(e) => setDraft({ number: e.target.value })}
              placeholder="201"
              required
              maxLength={32}
              className="border px-3 py-2 rounded w-full font-mono"
            />
            <span className="block text-xs text-gray-500 mt-1">Tal como lo marca el teléfono que llama.</span>
          </label>
          <label className="text-sm">
            <span className="block font-medium text-gray-800 mb-1">Nombre</span>
            <input
              id="extension-name"
              value={draft.name}
              onChange={(e) => setDraft({ name: e.target.value })}
              placeholder="Mesa de ayuda"
              required
              maxLength={100}
              className="border px-3 py-2 rounded w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block font-medium text-gray-800 mb-1">Empresa que atiende</span>
            <select
              id="extension-tenant"
              value={draft.tenantId}
              onChange={(e) => setDraft({ tenantId: e.target.value })}
              required
              className="border px-3 py-2 rounded w-full"
            >
              <option value="" disabled>
                Elegí una empresa
              </option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block font-medium text-gray-800 mb-1">Flujo de voz</span>
            <select id="extension-flow" disabled className="border px-3 py-2 rounded w-full disabled:bg-gray-100">
              <option>Se habilita con los flujos de voz</option>
            </select>
          </label>
          <label className="text-sm flex items-center gap-2 md:col-span-2">
            <input
              id="extension-enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ enabled: e.target.checked })}
            />
            Habilitado
          </label>
          <div className="md:col-span-2 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 disabled:bg-gray-300"
            >
              {busy ? 'Guardando...' : 'Guardar'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="px-4 py-2 rounded text-sm border hover:bg-gray-50"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
