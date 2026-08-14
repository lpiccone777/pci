'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface Setting {
  key: string;
  type: 'number' | 'string' | 'boolean' | 'enum';
  group: string;
  label: string;
  description: string;
  defaultValue: string;
  allowedValues?: string[];
  min?: number;
  max?: number;
  multiline?: boolean;
  secret?: boolean;
  provider?: string;
  placeholder?: string;
  value: string;
  isSet?: boolean;
  source: 'db' | 'env' | 'default';
  updatedAt: string | null;
}

interface ProviderStatus {
  active: string;
  encryptionConfigured: boolean;
  providers: Array<{
    provider: string;
    active: boolean;
    ready: boolean;
    missing: string[];
  }>;
}

interface ModelList {
  models: string[];
  source: 'api' | 'fallback';
  message?: string;
  loading?: boolean;
}

/** Las claves de modelo son las únicas que se renderizan como dropdown. */
function isModelKey(s: Setting): boolean {
  return !!s.provider && s.key.endsWith('_MODEL');
}

const CUSTOM_OPTION = '__custom__';

const SOURCE_BADGE: Record<Setting['source'], { text: string; className: string }> = {
  db: { text: 'guardado en BD', className: 'bg-blue-100 text-blue-700' },
  env: { text: 'desde .env', className: 'bg-amber-100 text-amber-700' },
  default: { text: 'valor por defecto', className: 'bg-gray-100 text-gray-600' },
};

export default function SettingsPage() {
  const { hasPermission } = useAuth();
  const [settings, setSettings] = useState<Setting[]>([]);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ModelList>>({});
  const [customModel, setCustomModel] = useState<Record<string, boolean>>({});
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const canUpdate = hasPermission('settings', 'update');
  const canDelete = hasPermission('settings', 'delete');

  async function load() {
    try {
      const [data, st]: [Setting[], ProviderStatus] = await Promise.all([
        apiFetch('/settings'),
        apiFetch('/settings/providers/status'),
      ]);
      setSettings(data);
      setStatus(st);
      // Los secrets arrancan vacíos: el backend solo devuelve un enmascarado,
      // así que el input es de escritura y "vacío" significa "no lo cambies".
      setDrafts(Object.fromEntries(data.map((s) => [s.key, s.secret ? '' : s.value])));
      setError('');
      return st;
    } catch (err: any) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  /** Consulta al backend los modelos de un proveedor. */
  async function loadModels(provider: string, refresh = false) {
    setModels((m) => ({ ...m, [provider]: { ...(m[provider] ?? { models: [], source: 'fallback' }), loading: true } }));
    try {
      const res: ModelList = await apiFetch(
        `/settings/providers/${provider}/models${refresh ? '?refresh=true' : ''}`,
      );
      setModels((m) => ({ ...m, [provider]: { ...res, loading: false } }));
    } catch (err: any) {
      setModels((m) => ({
        ...m,
        [provider]: { models: [], source: 'fallback', message: err.message, loading: false },
      }));
    }
  }

  useEffect(() => {
    // Al entrar, precargamos solo los del proveedor activo: consultar los cinco
    // sería una ráfaga de llamadas externas para configurar uno solo.
    load().then((st) => {
      if (st?.active) loadModels(st.active);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Al entrar a una pestaña de proveedor, consultamos sus modelos en el momento
    // en vez de esperar a que el usuario toque "Buscar modelos" a mano. Antes solo
    // pasaba esto con el proveedor activo (precargado arriba): el resto mostraba
    // un campo de texto plano hasta el click manual, y de un vistazo parecía que
    // el dropdown "solo funcionaba" en el proveedor activo.
    if (!activeGroup) return;
    const provider = settings.find((s) => s.group === activeGroup && s.provider)?.provider;
    if (provider && !models[provider]) {
      loadModels(provider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup]);

  async function save(s: Setting) {
    setBusyKey(s.key);
    setNotice('');
    try {
      await apiFetch(`/settings/${s.key}`, {
        method: 'PATCH',
        body: JSON.stringify({ value: drafts[s.key] }),
      });
      setNotice(`${s.key} actualizado.`);
      setError('');
      const st = await load();

      // Al cargar la key o el host recién se puede consultar el catálogo:
      // refrescamos para que el dropdown deje de mostrar la lista de fallback.
      if (s.provider && (s.secret || s.key.endsWith('_URL'))) {
        await loadModels(s.provider, true);
      }
      // Si cambió el proveedor activo, traemos sus modelos.
      if (s.key === 'LLM_PROVIDER' && st?.active) {
        await loadModels(drafts[s.key] || st.active);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function restoreDefault(key: string) {
    setBusyKey(key);
    setNotice('');
    try {
      await apiFetch(`/settings/${key}`, { method: 'DELETE' });
      setNotice(`${key} volvió al valor de .env o al default.`);
      setError('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  // El API devuelve las claves en orden de catálogo, ya agrupadas.
  const groups = useMemo(() => {
    const gs: string[] = [];
    for (const s of settings) if (!gs.includes(s.group)) gs.push(s.group);
    return gs;
  }, [settings]);

  // Pestaña por defecto: la primera del catálogo, y si la que estaba activa
  // desaparece (ej. filtro/permiso distinto tras un reload) cae a la primera.
  useEffect(() => {
    if (groups.length && (!activeGroup || !groups.includes(activeGroup))) {
      setActiveGroup(groups[0]);
    }
  }, [groups, activeGroup]);

  /**
   * Navegación por teclado del tablist (WAI-ARIA APG, "automatic activation"):
   * flechas mueven el foco Y activan el panel al toque, Home/End van a los
   * extremos. El resto de las teclas (Tab, Enter/Space en el botón) las maneja
   * el browser solo.
   */
  function handleTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (index + 1) % groups.length;
    else if (e.key === 'ArrowLeft') nextIndex = (index - 1 + groups.length) % groups.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = groups.length - 1;
    else return;

    e.preventDefault();
    const nextGroup = groups[nextIndex];
    setActiveGroup(nextGroup);
    tabRefs.current[nextGroup]?.focus();
  }

  if (loading) return <p className="text-gray-500">Cargando configuración...</p>;

  if (error && settings.length === 0) {
    // 404 = el backend no conoce la ruta (proceso desactualizado o API caído).
    // Es un problema distinto de 403 y confundirlos manda a depurar permisos al pedo.
    const routeMissing = /cannot get|not found|404|failed to fetch|networkerror/i.test(error);

    return (
      <div>
        <h1 className="text-2xl font-bold mb-4 text-gray-800">Configuración</h1>
        <div className="bg-white p-6 rounded shadow max-w-2xl">
          <p className="text-red-600 font-medium mb-2">No se pudo cargar la configuración</p>
          <p className="text-sm text-gray-600 mb-3 font-mono">{error}</p>

          {routeMissing ? (
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                El backend no reconoce la ruta <code className="bg-gray-100 px-1 rounded">/settings</code>.
                Esto <strong>no</strong> es un problema de permisos.
              </p>
              <p>
                Casi siempre significa que el API está corriendo una versión anterior al módulo de
                settings. Reiniciá el backend:
              </p>
              <pre className="bg-gray-900 text-gray-100 px-3 py-2 rounded text-xs overflow-x-auto">
                pnpm dev:api
              </pre>
              <p className="text-gray-500">
                Si sigue fallando, verificá que{' '}
                <code className="bg-gray-100 px-1 rounded">NEXT_PUBLIC_API_URL</code> apunte al puerto
                del backend.
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              La configuración del sistema solo es accesible desde el tenant de sistema y con
              permisos <code className="bg-gray-100 px-1 rounded">settings:read</code>.
            </p>
          )}
        </div>
      </div>
    );
  }

  const activeProvider = status?.providers.find((p) => p.active);

  const activeGroupSettings = activeGroup ? settings.filter((s) => s.group === activeGroup) : [];
  const activeGroupProvider = activeGroupSettings.find((s) => s.provider)?.provider;
  const activePanelStatus = status?.providers.find((p) => p.provider === activeGroupProvider);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1 text-gray-800">Configuración del sistema</h1>
      <p className="text-sm text-gray-500 mb-6">
        Estos parámetros aplican sin reiniciar el backend. El valor efectivo se resuelve en
        cascada: <strong>base de datos → variable de entorno → valor por defecto</strong>.
      </p>

      {error && <p className="text-red-500 mb-4">{error}</p>}
      {notice && <p className="text-green-600 mb-4">{notice}</p>}

      {status && !status.encryptionConfigured && (
        <div className="bg-red-50 border border-red-200 rounded p-4 mb-4 text-sm">
          <p className="font-medium text-red-800 mb-1">
            Falta <code className="bg-white px-1 rounded">SETTINGS_ENCRYPTION_KEY</code> en el backend
          </p>
          <p className="text-red-700 mb-2">
            Sin esa variable no se pueden guardar API keys: se rechaza la escritura antes que
            dejar un secret en texto plano en la base.
          </p>
          <pre className="bg-gray-900 text-gray-100 px-3 py-2 rounded text-xs overflow-x-auto">
            node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;
          </pre>
          <p className="text-red-700 mt-2">
            Pegá el resultado en <code className="bg-white px-1 rounded">apps/api/.env</code> y
            reiniciá el backend.
          </p>
        </div>
      )}

      {activeProvider && !activeProvider.ready && (
        <div className="bg-amber-50 border border-amber-200 rounded px-4 py-3 mb-4 text-sm text-amber-800">
          El proveedor activo es <strong>{activeProvider.provider}</strong> pero le falta
          configuración: <code className="bg-white px-1 rounded">{activeProvider.missing.join(', ')}</code>.
          Los mensajes van a fallar hasta que lo completes.
        </div>
      )}
      {!canUpdate && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4 text-sm">
          Tenés acceso de solo lectura: falta el permiso{' '}
          <code className="bg-white px-1 rounded">settings:update</code>.
        </p>
      )}

      {/* Tabs: una por grupo del catálogo. Patrón WAI-ARIA APG (tablist con
          activación automática por flecha) — ver handleTabKeyDown más arriba. */}
      <div
        role="tablist"
        aria-label="Secciones de configuración"
        className="flex flex-wrap gap-1 border-b border-gray-200 mb-6"
      >
        {groups.map((group, index) => {
          const groupProvider = settings.find((s) => s.group === group && s.provider)?.provider;
          const pStatus = status?.providers.find((p) => p.provider === groupProvider);
          const selected = group === activeGroup;

          return (
            <button
              key={group}
              ref={(el) => {
                tabRefs.current[group] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${group}`}
              aria-selected={selected}
              aria-controls={`panel-${group}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveGroup(group)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              className={`flex items-center gap-1.5 px-3 py-2 -mb-px text-sm font-medium rounded-t border-b-2 whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                selected
                  ? 'border-blue-600 text-blue-700 bg-blue-50'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50'
              }`}
            >
              {group}
              {pStatus?.active && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"
                  title="Proveedor activo"
                  aria-hidden="true"
                />
              )}
              {pStatus && !pStatus.ready && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                  title="Configuración incompleta"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {activeGroup && (
        <section
          key={activeGroup}
          role="tabpanel"
          id={`panel-${activeGroup}`}
          aria-labelledby={`tab-${activeGroup}`}
          tabIndex={0}
        >
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-lg font-semibold text-gray-700">{activeGroup}</h2>
            {activePanelStatus?.active && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">activo</span>
            )}
            {activePanelStatus && (
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  activePanelStatus.ready ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {activePanelStatus.ready ? 'configurado' : 'incompleto'}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {activeGroupSettings
              .map((s) => {
                const draft = drafts[s.key] ?? '';
                // En secrets el input arranca vacío y "vacío" = no cambiar nada.
                const dirty = s.secret ? draft.length > 0 : draft !== s.value;
                const badge = SOURCE_BADGE[s.source];
                const busy = busyKey === s.key;
                const modelList = s.provider ? models[s.provider] : undefined;

                return (
                  <div key={s.key} className="bg-white p-4 rounded shadow">
                    <div className="flex items-start justify-between gap-4 mb-1">
                      <label htmlFor={s.key} className="font-medium text-gray-800">
                        {s.label}
                        {s.secret && <span className="ml-2 text-xs text-gray-400">🔒 secret</span>}
                      </label>
                      <div className="flex gap-1 shrink-0">
                        {s.secret && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              s.isSet
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {s.isSet ? `cargada: ${s.value}` : 'sin configurar'}
                          </span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded ${badge.className}`}>
                          {badge.text}
                        </span>
                      </div>
                    </div>

                    <p className="text-xs text-gray-500 mb-1">{s.description}</p>
                    <p className="text-xs text-gray-400 mb-3 font-mono">
                      {s.key}
                      {!s.secret && ` · default: ${s.defaultValue || '(vacío)'}`}
                    </p>

                    <div className="flex flex-wrap gap-2 items-center">
                      {s.type === 'boolean' ? (
                        <select
                          id={s.key}
                          value={draft}
                          disabled={!canUpdate || busy}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                          className="border px-3 py-2 rounded disabled:bg-gray-100"
                        >
                          <option value="true">Activado</option>
                          <option value="false">Desactivado</option>
                        </select>
                      ) : s.type === 'enum' ? (
                        <select
                          id={s.key}
                          value={draft}
                          disabled={!canUpdate || busy}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                          className="border px-3 py-2 rounded disabled:bg-gray-100"
                        >
                          {s.allowedValues?.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : s.multiline ? (
                        <textarea
                          id={s.key}
                          value={draft}
                          rows={3}
                          disabled={!canUpdate || busy}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                          className="border px-3 py-2 rounded w-full disabled:bg-gray-100"
                        />
                      ) : isModelKey(s) && modelList?.models.length && !customModel[s.key] ? (
                        <select
                          id={s.key}
                          value={draft}
                          disabled={!canUpdate || busy || modelList.loading}
                          onChange={(e) => {
                            if (e.target.value === CUSTOM_OPTION) {
                              setCustomModel({ ...customModel, [s.key]: true });
                              return;
                            }
                            setDrafts({ ...drafts, [s.key]: e.target.value });
                          }}
                          className="border px-3 py-2 rounded w-96 max-w-full disabled:bg-gray-100"
                        >
                          {/* El valor actual puede no estar en la lista (modelo viejo
                              o escrito a mano): lo agregamos para no perderlo. */}
                          {draft && !modelList.models.includes(draft) && (
                            <option value={draft}>{draft} (actual)</option>
                          )}
                          {modelList.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          <option value={CUSTOM_OPTION}>Otro — escribir a mano…</option>
                        </select>
                      ) : (
                        <input
                          id={s.key}
                          type={s.secret ? 'password' : s.type === 'number' ? 'number' : 'text'}
                          value={draft}
                          min={s.min}
                          max={s.max}
                          step={s.key === 'LLM_TEMPERATURE' ? '0.1' : undefined}
                          autoComplete={s.secret ? 'new-password' : undefined}
                          placeholder={
                            s.secret
                              ? s.isSet
                                ? 'Escribí una nueva para reemplazarla'
                                : s.placeholder || 'Pegá la API key'
                              : s.placeholder
                          }
                          disabled={!canUpdate || busy}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                          className={`border px-3 py-2 rounded disabled:bg-gray-100 ${
                            s.secret || s.key.includes('URL') ? 'w-96 max-w-full' : 'w-48'
                          }`}
                        />
                      )}

                      <button
                        onClick={() => save(s)}
                        disabled={!canUpdate || !dirty || busy}
                        className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                      >
                        {busy ? 'Guardando...' : 'Guardar'}
                      </button>

                      {dirty && (
                        <button
                          onClick={() =>
                            setDrafts({ ...drafts, [s.key]: s.secret ? '' : s.value })
                          }
                          disabled={busy}
                          className="text-sm text-gray-500 hover:text-gray-700 px-2"
                        >
                          Cancelar
                        </button>
                      )}

                      {isModelKey(s) && s.provider && (
                        <button
                          type="button"
                          onClick={() => {
                            setCustomModel({ ...customModel, [s.key]: false });
                            loadModels(s.provider!, !!modelList);
                          }}
                          disabled={modelList?.loading}
                          className="text-sm text-blue-600 hover:text-blue-800 px-2"
                        >
                          {modelList?.loading
                            ? 'Consultando...'
                            : modelList
                              ? 'Actualizar lista'
                              : 'Buscar modelos'}
                        </button>
                      )}

                      {s.source === 'db' && canDelete && (
                        <button
                          onClick={() => restoreDefault(s.key)}
                          disabled={busy}
                          className="text-sm text-red-500 hover:text-red-700 px-2 ml-auto"
                          title={
                            s.secret
                              ? 'Borra la API key guardada. La clave vuelve a leerse de .env si existe'
                              : 'Borra el valor de BD: la clave vuelve a resolverse por .env o por su default'
                          }
                        >
                          {s.secret ? 'Borrar key' : 'Restaurar'}
                        </button>
                      )}
                    </div>

                    {isModelKey(s) && modelList && !modelList.loading && (
                      <p className="text-xs mt-2">
                        {modelList.source === 'api' ? (
                          <span className="text-green-600">
                            {modelList.models.length} modelos consultados al proveedor
                          </span>
                        ) : (
                          <span className="text-amber-600">
                            Lista conocida (no se pudo consultar al proveedor)
                            {modelList.message ? ` — ${modelList.message}` : ''}
                          </span>
                        )}
                      </p>
                    )}

                    {s.min !== undefined && s.max !== undefined && (
                      <p className="text-xs text-gray-400 mt-2">
                        Rango permitido: {s.min} – {s.max}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      )}
    </div>
  );
}
