'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import {
  ModalShell,
  fetchRolesForTenant,
  fetchAreasForTenant,
  type RoleOption,
  type AreaOption,
  type Feedback,
} from './page';

/* ------------------------------------------------------------------ */
/* Contrato con /titan-sync (módulo titan-sync del backend)            */
/* ------------------------------------------------------------------ */

interface TitanConnection {
  baseUrl: string;
  itEmail: string;
  itPassword: string;
  itPasswordIsSet: boolean;
  configured: boolean;
  lastImportAt: string | null;
}

export interface TitanStatus {
  enabled: boolean;
  connection: TitanConnection | null;
}

type TitanUserStatus = 'new' | 'linked' | 'member' | 'other-tenant';

interface TitanPreviewUser {
  titanUserId: number;
  email: string;
  firstName: string;
  lastName: string;
  locked: boolean;
  roles: string[];
  companyName: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
  status: TitanUserStatus;
  pciUserId: string | null;
}

type ImportOutcome = 'created' | 'linked' | 'updated' | 'skipped';

interface ImportResult {
  summary: { requested: number; created: number; linked: number; updated: number; skipped: number };
  results: {
    titanUserId: number;
    email: string | null;
    outcome: ImportOutcome;
    reason?: string;
    phone?: string | null;
    warnings: string[];
  }[];
}

const STATUS_LABEL: Record<TitanUserStatus, { text: string; className: string }> = {
  new: { text: 'Nuevo', className: 'bg-blue-50 text-blue-700' },
  linked: { text: 'Vinculado', className: 'bg-green-50 text-green-700' },
  member: { text: 'Ya está en PCI', className: 'bg-gray-100 text-gray-700' },
  'other-tenant': { text: 'En otra empresa', className: 'bg-amber-50 text-amber-700' },
};

const OUTCOME_LABEL: Record<ImportOutcome, string> = {
  created: 'Creado',
  linked: 'Vinculado',
  updated: 'Actualizado',
  skipped: 'No importado',
};

/** Un usuario se puede tildar si Titan lo da por válido y no vive en otra empresa de PCI. */
function selectable(u: TitanPreviewUser) {
  return u.eligible && u.status !== 'other-tenant';
}

/** Lo que pide el endpoint: siempre activo en el backend salvo que el módulo esté apagado. */
export async function fetchTitanStatus(): Promise<TitanStatus | null> {
  try {
    return await apiFetch('/titan-sync/status');
  } catch {
    return null;
  }
}

export function TitanImportModal({
  tenantId,
  onClose,
  onImported,
}: {
  /** Empresa donde se importan los usuarios (la empresa activa). */
  tenantId: string;
  onClose: () => void;
  onImported: (message: Feedback) => void;
}) {
  const { hasPermission } = useAuth();
  const canConfigure = hasPermission('titan-sync', 'update');
  const canImport = hasPermission('titan-sync', 'create');

  const [step, setStep] = useState<'loading' | 'connection' | 'select' | 'result'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // --- Conexión ---
  const [connection, setConnection] = useState<TitanConnection | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [itEmail, setItEmail] = useState('');
  const [itPassword, setItPassword] = useState('');
  const [testMessage, setTestMessage] = useState<Feedback | null>(null);

  // --- Selección ---
  const [users, setUsers] = useState<TitanPreviewUser[]>([]);
  const [titanRoles, setTitanRoles] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [titanRoleFilter, setTitanRoleFilter] = useState('');
  const [hideLinked, setHideLinked] = useState(false);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [roleId, setRoleId] = useState('');
  const [areaId, setAreaId] = useState('');

  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    fetchRolesForTenant(tenantId).then(setRoles);
    fetchAreasForTenant(tenantId).then(setAreas);
    (async () => {
      const status = await fetchTitanStatus();
      const conn = status?.connection ?? null;
      setConnection(conn);
      setBaseUrl(conn?.baseUrl ?? '');
      setItEmail(conn?.itEmail ?? '');
      if (conn?.configured) {
        await loadUsers();
      } else {
        setStep('connection');
      }
    })();
  }, [tenantId]);

  async function loadUsers() {
    setError('');
    setStep('loading');
    try {
      const data = await apiFetch('/titan-sync/users');
      setUsers(data.users);
      setTitanRoles(data.roles);
      setSelected(new Set());
      setStep('select');
    } catch (err: any) {
      setError(err.message);
      setStep('connection');
    }
  }

  async function saveAndTest(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setTestMessage(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { baseUrl: baseUrl.trim(), itEmail: itEmail.trim() };
      // Secret de solo escritura: vacío = conservar la guardada.
      if (itPassword) body.itPassword = itPassword;
      const saved: TitanConnection = await apiFetch('/titan-sync/connection', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setConnection(saved);
      setItPassword('');
      if (!saved.configured) {
        setTestMessage({ kind: 'error', text: 'Falta la contraseña del usuario técnico.' });
        return;
      }
      const test = await apiFetch('/titan-sync/connection/test', { method: 'POST' });
      setTestMessage(
        test.ok
          ? {
              kind: 'ok',
              text: `Conexión correcta: ${test.totalUsers} usuarios en Titan, ${test.eligibleUsers} importables.`,
            }
          : { kind: 'error', text: test.error },
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        (!q || `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(q)) &&
        (!titanRoleFilter || u.roles.includes(titanRoleFilter)) &&
        (!hideLinked || u.status !== 'linked'),
    );
  }, [users, search, titanRoleFilter, hideLinked]);

  const visibleSelectable = visible.filter(selectable);
  const allVisibleSelected =
    visibleSelectable.length > 0 && visibleSelectable.every((u) => selected.has(u.titanUserId));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const u of visibleSelectable) {
        if (allVisibleSelected) next.delete(u.titanUserId);
        else next.add(u.titanUserId);
      }
      return next;
    });
  }

  async function doImport() {
    setError('');
    setBusy(true);
    try {
      const res: ImportResult = await apiFetch('/titan-sync/import', {
        method: 'POST',
        body: JSON.stringify({ titanUserIds: [...selected], roleId, ...(areaId ? { areaId } : {}) }),
      });
      setResult(res);
      setStep('result');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (result) {
      const { created, linked, updated } = result.summary;
      onImported({
        kind: 'ok',
        text: `Importación desde Titan: ${created} creados, ${linked} vinculados, ${updated} actualizados.`,
      });
    }
    onClose();
  }

  function requestClose() {
    if (busy) return;
    if (step === 'result') finish();
    else onClose();
  }

  const subtitle =
    step === 'connection'
      ? 'Conexión con TitanHR mediante un usuario técnico de rol IT'
      : step === 'select'
        ? 'Elegí qué usuarios de Titan traer a esta empresa'
        : undefined;

  return (
    <ModalShell
      title="Importar usuarios desde Titan"
      subtitle={subtitle}
      onRequestClose={requestClose}
      error={error}
      footer={
        step === 'connection' ? (
          <>
            <button type="button" onClick={onClose} className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100">
              Cancelar
            </button>
            {connection?.configured && (
              <button
                type="button"
                onClick={loadUsers}
                disabled={busy}
                className="border border-blue-600 text-blue-600 px-4 py-2 rounded hover:bg-blue-50 disabled:opacity-50"
              >
                Ver usuarios de Titan
              </button>
            )}
            {canConfigure && (
              <button
                type="button"
                onClick={() => saveAndTest()}
                disabled={busy || !baseUrl.trim() || !itEmail.trim()}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
              >
                {busy ? 'Probando...' : 'Guardar y probar'}
              </button>
            )}
          </>
        ) : step === 'select' ? (
          <>
            <button
              type="button"
              onClick={() => setStep('connection')}
              disabled={busy}
              className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100 mr-auto"
            >
              Conexión
            </button>
            <button type="button" onClick={onClose} disabled={busy} className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100">
              Cancelar
            </button>
            {canImport && (
              <button
                type="button"
                onClick={doImport}
                disabled={busy || selected.size === 0 || !roleId}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
              >
                {busy ? 'Importando...' : `Importar ${selected.size} usuario${selected.size === 1 ? '' : 's'}`}
              </button>
            )}
          </>
        ) : step === 'result' ? (
          <button type="button" onClick={finish} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
            Listo
          </button>
        ) : null
      }
    >
      {step === 'loading' && <p className="text-sm text-gray-500">Consultando TitanHR...</p>}

      {step === 'connection' && (
        <form onSubmit={saveAndTest} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">URL de TitanHR *</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={!canConfigure}
              placeholder="https://titan.empresa.com"
              className="border border-gray-200 px-3 py-2 rounded w-full"
            />
            <p className="text-xs text-gray-400 mt-1">La del backend de Titan, sin el /api final.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Usuario técnico (email) *</label>
              <input
                type="email"
                value={itEmail}
                onChange={(e) => setItEmail(e.target.value)}
                disabled={!canConfigure}
                placeholder="chatbot.it@empresa.com"
                className="border border-gray-200 px-3 py-2 rounded w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Contraseña {connection?.itPasswordIsSet ? '' : '*'}
              </label>
              <input
                type="password"
                autoComplete="new-password"
                value={itPassword}
                onChange={(e) => setItPassword(e.target.value)}
                disabled={!canConfigure}
                placeholder={connection?.itPasswordIsSet ? 'cargada — dejar vacío para conservarla' : ''}
                className="border border-gray-200 px-3 py-2 rounded w-full"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500">
            Tiene que ser un usuario de Titan con rol <strong>IT</strong>, dedicado a esta integración (no el de
            una persona: cada importación abre y cierra una sesión), sin MFA, y con acceso a los datos de todas
            las empresas que quieras importar. La contraseña se guarda cifrada y no se vuelve a mostrar.
          </p>
          {!canConfigure && (
            <p className="text-xs text-amber-700">No tenés permiso para modificar la conexión (titan-sync: Modificar).</p>
          )}
          {testMessage && (
            <p className={`text-sm ${testMessage.kind === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{testMessage.text}</p>
          )}
          {/* Enter en un input envía el formulario. */}
          <button type="submit" className="hidden" disabled={!canConfigure} />
        </form>
      )}

      {step === 'select' && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o email"
              className="border border-gray-200 px-3 py-1.5 rounded text-sm flex-1 min-w-[180px]"
            />
            <select
              value={titanRoleFilter}
              onChange={(e) => setTitanRoleFilter(e.target.value)}
              className="border border-gray-200 px-2 py-1.5 rounded text-sm"
            >
              <option value="">Todos los roles de Titan</option>
              {titanRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <label className="text-xs text-gray-600 flex items-center gap-1">
              <input type="checkbox" checked={hideLinked} onChange={(e) => setHideLinked(e.target.checked)} />
              Ocultar vinculados
            </label>
          </div>

          <div className="max-h-[45vh] overflow-y-auto border border-gray-200 rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-left text-gray-600">
                  <th className="px-2 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={visibleSelectable.length === 0}
                      aria-label="Seleccionar todos los visibles"
                    />
                  </th>
                  <th className="px-2 py-2">Persona</th>
                  <th className="px-2 py-2">Roles de Titan</th>
                  <th className="px-2 py-2">Empresa</th>
                  <th className="px-2 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((u) => {
                  const can = selectable(u);
                  return (
                    <tr
                      key={u.titanUserId}
                      className={`border-t border-gray-100 ${can ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-60'}`}
                      onClick={() => can && toggle(u.titanUserId)}
                    >
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={selected.has(u.titanUserId)}
                          disabled={!can}
                          onChange={() => toggle(u.titanUserId)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-gray-800">
                          {`${u.lastName}, ${u.firstName}`.replace(/^, |, $/, '') || '—'}
                        </div>
                        <div className="text-gray-500">{u.email}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <span key={r} className="bg-gray-100 text-gray-700 rounded px-1.5 py-0.5">
                              {r}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-gray-600">{u.companyName ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        {u.eligible ? (
                          <span className={`rounded px-1.5 py-0.5 whitespace-nowrap ${STATUS_LABEL[u.status].className}`}>
                            {STATUS_LABEL[u.status].text}
                          </span>
                        ) : (
                          <span className="text-red-600">{u.ineligibleReason}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-6 text-center text-gray-400">
                      No hay usuarios que coincidan con el filtro.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {selected.size} seleccionado{selected.size === 1 ? '' : 's'} de {users.length} usuarios de Titan.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Rol de PCI * <span className="text-gray-400">(permisos del backoffice, para los nuevos)</span>
              </label>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className="border border-gray-200 px-3 py-2 rounded w-full"
              >
                <option value="">Elegí un rol...</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Área (opcional)</label>
              <select
                value={areaId}
                onChange={(e) => setAreaId(e.target.value)}
                className="border border-gray-200 px-3 py-2 rounded w-full"
              >
                <option value="">Sin área</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Los roles de Titan de cada persona se guardan completos para usarlos en los flujos. Re-importar a alguien
            ya vinculado actualiza sus roles de Titan sin cambiar su rol de PCI. El teléfono se toma del celular
            cargado en Titan.
          </p>
          {!canImport && (
            <p className="text-xs text-amber-700 mt-2">No tenés permiso para importar (titan-sync: Crear).</p>
          )}
        </div>
      )}

      {step === 'result' && result && (
        <div>
          <p className="text-sm text-gray-700 mb-3">
            <span className="font-medium text-green-700">{result.summary.created} creados</span> ·{' '}
            {result.summary.linked} vinculados · {result.summary.updated} actualizados
            {result.summary.skipped > 0 && (
              <>
                {' '}
                · <span className="font-medium text-red-600">{result.summary.skipped} no importados</span>
              </>
            )}{' '}
            de {result.summary.requested}.
          </p>
          <div className="max-h-[50vh] overflow-y-auto border border-gray-200 rounded text-xs">
            <table className="min-w-full">
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.titanUserId} className="border-b border-gray-100 last:border-0 align-top">
                    <td className="px-2 py-1.5">{r.email ?? `Titan #${r.titanUserId}`}</td>
                    <td className={`px-2 py-1.5 whitespace-nowrap ${r.outcome === 'skipped' ? 'text-red-600' : 'text-green-700'}`}>
                      {OUTCOME_LABEL[r.outcome]}
                    </td>
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap">{r.phone ?? ''}</td>
                    <td className="px-2 py-1.5 text-gray-600">
                      {[r.reason, ...r.warnings].filter(Boolean).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
