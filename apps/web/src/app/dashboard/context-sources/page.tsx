'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { ALL_TENANTS } from '@/lib/system-tenant';

/** Empresa de una fila en la vista consolidada "Todas las empresas". */
interface TenantRef {
  id: string;
  name: string;
  slug: string;
}

interface FieldOption {
  value: string;
  label: string;
}

interface FieldDef {
  key: string;
  type: 'string' | 'number' | 'select' | 'boolean';
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: FieldOption[];
  defaultValue?: string;
  secret?: boolean;
  helpText?: string;
}

interface TypeDef {
  type: string;
  label: string;
  description: string;
  fields: FieldDef[];
}

interface ContextSourceData {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  createdAt: string;
  /** Campos no-secretos con su valor real; los `secret` vienen enmascarados + `<key>IsSet`. */
  config: Record<string, any>;
  /** Presente solo en la vista consolidada "Todas las empresas" (endpoints /all y /mine). */
  tenant?: TenantRef;
}

interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  statusCode?: number;
}

interface SkillData {
  id: string;
  name: string;
  promptText: string;
  isActive: boolean;
  createdAt: string;
  /** Presente solo en la vista consolidada "Todas las empresas". */
  tenant?: TenantRef;
}

export default function ContextSourcesPage() {
  const { hasPermission, activeTenant, isSuperAdmin } = useAuth();
  // "Todas las empresas": vista consolidada de solo lectura (columna Empresa, sin alta), igual
  // que Áreas/Roles. El alta a ciegas en una empresa de respaldo era el hallazgo FE-CS-11/12.
  const isAllTenants = activeTenant === ALL_TENANTS;
  const [tab, setTab] = useState<'connections' | 'skills'>('connections');
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [sources, setSources] = useState<ContextSourceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [fieldsToClear, setFieldsToClear] = useState<Set<string>>(new Set());

  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const canCreate = hasPermission('context-sources', 'create');
  const canUpdate = hasPermission('context-sources', 'update');
  const canDelete = hasPermission('context-sources', 'delete');

  const typeDef = types.find((t) => t.type === type);

  // --- Skills ---
  const [skills, setSkills] = useState<SkillData[]>([]);
  const [skillEditingId, setSkillEditingId] = useState<string | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillPromptText, setSkillPromptText] = useState('');
  const [skillIsActive, setSkillIsActive] = useState(true);
  const [skillBusy, setSkillBusy] = useState(false);

  const canCreateSkill = hasPermission('skills', 'create');
  const canUpdateSkill = hasPermission('skills', 'update');
  const canDeleteSkill = hasPermission('skills', 'delete');

  async function load() {
    try {
      // En "Todas las empresas" se consolida (superadmin → /all; usuario común → /mine),
      // igual que Áreas/Roles. En una empresa concreta, el listado scopeado de siempre.
      const sourcesEndpoint = !isAllTenants
        ? '/context-sources'
        : isSuperAdmin
          ? '/context-sources/all'
          : '/context-sources/mine';
      const skillsEndpoint = !isAllTenants
        ? '/skills'
        : isSuperAdmin
          ? '/skills/all'
          : '/skills/mine';
      const [typesData, sourcesData, skillsData] = await Promise.all([
        apiFetch('/context-sources/types'),
        apiFetch(sourcesEndpoint),
        apiFetch(skillsEndpoint).catch(() => []), // sin permiso `skills:read`: pestaña vacía, no rompe la principal
      ]);
      setTypes(typesData);
      setSources(sourcesData);
      setSkills(skillsData);
      setType((current) => current || typesData[0]?.type || '');
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

  function resetSkillForm() {
    setSkillEditingId(null);
    setSkillName('');
    setSkillPromptText('');
    setSkillIsActive(true);
  }

  function startEditSkill(s: SkillData) {
    setNotice('');
    setSkillEditingId(s.id);
    setSkillName(s.name);
    setSkillPromptText(s.promptText);
    setSkillIsActive(s.isActive);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submitSkill(e: React.FormEvent) {
    e.preventDefault();
    setSkillBusy(true);
    setError('');
    try {
      if (skillEditingId) {
        await apiFetch(`/skills/${skillEditingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: skillName, promptText: skillPromptText, isActive: skillIsActive }),
        });
        setNotice('Skill actualizado.');
      } else {
        await apiFetch('/skills', {
          method: 'POST',
          body: JSON.stringify({ name: skillName, promptText: skillPromptText, isActive: skillIsActive }),
        });
        setNotice('Skill creado.');
      }
      resetSkillForm();
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSkillBusy(false);
    }
  }

  async function removeSkill(s: SkillData) {
    if (!confirm(`¿Eliminar el skill "${s.name}"?`)) return;
    setSkillBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiFetch(`/skills/${s.id}`, { method: 'DELETE' });
      setNotice(res.message || 'Skill eliminado.');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSkillBusy(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setName('');
    setType(types[0]?.type ?? '');
    setIsActive(true);
    setFormConfig({});
    setFieldsToClear(new Set());
  }

  function startEdit(s: ContextSourceData) {
    setNotice('');
    setEditingId(s.id);
    setName(s.name);
    setType(s.type);
    setIsActive(s.isActive);
    const initial: Record<string, string> = {};
    const def = types.find((t) => t.type === s.type);
    for (const f of def?.fields ?? []) {
      if (f.secret) continue; // los secrets nunca se prellenan: se dejan vacíos a propósito
      initial[f.key] = s.config?.[f.key] ?? '';
    }
    setFormConfig(initial);
    setFieldsToClear(new Set());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    resetForm();
  }

  function setField(key: string, value: string) {
    setFormConfig((prev) => ({ ...prev, [key]: value }));
    setFieldsToClear((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function clearSecretField(key: string) {
    setFormConfig((prev) => ({ ...prev, [key]: '' }));
    setFieldsToClear((prev) => new Set(prev).add(key));
  }

  function buildConfigPayload(def: TypeDef): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.secret) {
        if (fieldsToClear.has(f.key)) {
          config[f.key] = null;
          continue;
        }
        const val = formConfig[f.key];
        if (val) config[f.key] = val;
        continue; // vacío y no marcado para borrar: no tocar el valor ya guardado
      }
      const val = formConfig[f.key] ?? '';
      config[f.key] = f.type === 'number' && val !== '' ? Number(val) : val;
    }
    return config;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!typeDef) return;
    setBusy(true);
    setError('');
    try {
      const config = buildConfigPayload(typeDef);

      if (editingId) {
        await apiFetch(`/context-sources/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, isActive, config }),
        });
        setNotice('Fuente de verdad actualizada.');
      } else {
        await apiFetch('/context-sources', {
          method: 'POST',
          body: JSON.stringify({ name, type, isActive, config }),
        });
        setNotice('Fuente de verdad creada.');
      }
      cancelEdit();
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: ContextSourceData) {
    if (!confirm(`¿Eliminar la fuente de verdad "${s.name}"?`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiFetch(`/context-sources/${s.id}`, { method: 'DELETE' });
      setNotice(res.message || 'Fuente de verdad eliminada.');
      await load();
    } catch (err: any) {
      // El backend explica cuántos flujos la usan si no se puede borrar todavía.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(s: ContextSourceData) {
    setTesting(s.id);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[s.id];
      return next;
    });
    try {
      const result = await apiFetch(`/context-sources/${s.id}/test-connection`, { method: 'POST' });
      setTestResults((prev) => ({ ...prev, [s.id]: result }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [s.id]: { ok: false, message: err.message, latencyMs: 0 },
      }));
    } finally {
      setTesting(null);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  const showForm = editingId ? canUpdate : canCreate;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-gray-800">Fuentes de Verdad</h1>
      <p className="text-sm text-gray-500 mb-4">
        {tab === 'connections'
          ? 'Conexiones a fuentes de contexto externas (MCP, RAG, n8n, broker) que los flujos pueden ' +
            'consultar. No se instala nada acá: son parámetros de conexión a un servicio que ya ' +
            'corre en otro lado.'
          : 'Skills: texto de contexto libre que se concatena al system prompt base de un flujo ' +
            '(ver el selector "Skill" en el editor de flujos). A diferencia de las conexiones, no ' +
            'consultan nada en tiempo real — es texto fijo.'}
      </p>

      <div className="flex gap-1 mb-6 border-b">
        <button
          onClick={() => setTab('connections')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'connections'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Conexiones
        </button>
        <button
          onClick={() => setTab('skills')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'skills'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Skills
        </button>
      </div>

      {error && <p className="text-red-500 mb-4">{error}</p>}
      {notice && <p className="text-green-600 mb-4">{notice}</p>}

      {isAllTenants && (
        <div className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Estás viendo <strong>todas las empresas</strong> (solo lectura). Para crear o editar,
          elegí una empresa puntual en el selector del panel lateral.
        </div>
      )}

      {tab === 'connections' && showForm && !isAllTenants && (
        <form onSubmit={submit} className="bg-white p-4 rounded shadow mb-6 space-y-3">
          <h2 className="font-semibold text-gray-700">
            {editingId ? 'Editar fuente de verdad' : 'Nueva fuente de verdad'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
              <input
                placeholder="RAG de tickets resueltos"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="border px-3 py-2 rounded w-full"
                maxLength={80}
                required
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Tipo *</label>
              {editingId ? (
                <input
                  disabled
                  value={typeDef?.label ?? type}
                  className="border px-3 py-2 rounded w-full bg-gray-100 text-gray-500"
                  title="El tipo no se puede cambiar después de creada. Eliminala y creá una nueva si necesitás otro tipo."
                />
              ) : (
                <select
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value);
                    setFormConfig({});
                    setFieldsToClear(new Set());
                  }}
                  className="border px-3 py-2 rounded w-full"
                  required
                >
                  {types.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-600 pb-2">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                Activa
              </label>
            </div>
          </div>

          {typeDef && (
            <>
              <p className="text-xs text-gray-500">{typeDef.description}</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {typeDef.fields.map((f) => {
                  const isSet = editingId
                    ? !!sources.find((s) => s.id === editingId)?.config?.[`${f.key}IsSet`]
                    : false;
                  const maskedValue = editingId
                    ? sources.find((s) => s.id === editingId)?.config?.[f.key]
                    : '';

                  return (
                    <div key={f.key}>
                      <label className="block text-xs text-gray-500 mb-1">
                        {f.label}
                        {f.required && ' *'}
                      </label>

                      {f.type === 'select' ? (
                        <select
                          value={formConfig[f.key] ?? f.defaultValue ?? ''}
                          onChange={(e) => setField(f.key, e.target.value)}
                          className="border px-3 py-2 rounded w-full"
                        >
                          {(f.options ?? []).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : f.secret ? (
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={formConfig[f.key] ?? ''}
                            onChange={(e) => setField(f.key, e.target.value)}
                            placeholder={
                              isSet
                                ? `${maskedValue} (cargado — dejar vacío para no cambiar)`
                                : f.placeholder
                            }
                            className="border px-3 py-2 rounded w-full"
                            autoComplete="off"
                          />
                          {isSet && (
                            <button
                              type="button"
                              onClick={() => clearSecretField(f.key)}
                              title="Quitar el valor guardado"
                              className={`text-xs px-2 rounded border whitespace-nowrap ${
                                fieldsToClear.has(f.key)
                                  ? 'bg-red-50 border-red-300 text-red-600'
                                  : 'text-gray-500 border-gray-300 hover:bg-gray-50'
                              }`}
                            >
                              {fieldsToClear.has(f.key) ? 'Se va a borrar' : 'Quitar'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <input
                          type={f.type === 'number' ? 'number' : 'text'}
                          value={formConfig[f.key] ?? f.defaultValue ?? ''}
                          onChange={(e) => setField(f.key, e.target.value)}
                          placeholder={f.placeholder}
                          className="border px-3 py-2 rounded w-full"
                        />
                      )}

                      {f.helpText && <p className="text-[11px] text-gray-400 mt-1">{f.helpText}</p>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !typeDef}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
            >
              {busy ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={cancelEdit}
                className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
      )}

      {tab === 'connections' && !editingId && !canCreate && !isAllTenants && sources.length === 0 && (
        <p className="text-gray-400 text-sm mb-4">No tenés permiso para crear fuentes de verdad.</p>
      )}

      {tab === 'connections' && (
      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Nombre</th>
              {isAllTenants && <th className="text-left px-4 py-2">Empresa</th>}
              <th className="text-left px-4 py-2">Tipo</th>
              <th className="text-left px-4 py-2">Estado</th>
              {!isAllTenants && <th className="text-left px-4 py-2">Conexión</th>}
              {!isAllTenants && (canUpdate || canDelete) && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {sources.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  {isAllTenants
                    ? 'No hay fuentes de verdad configuradas en ninguna empresa.'
                    : 'No hay fuentes de verdad configuradas en esta empresa.'}
                </td>
              </tr>
            )}
            {sources.map((s) => {
              const result = testResults[s.id];
              return (
                <tr key={s.id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-2">{s.name}</td>
                  {isAllTenants && (
                    <td className="px-4 py-2 text-gray-500">{s.tenant?.name ?? '—'}</td>
                  )}
                  <td className="px-4 py-2 text-gray-500">
                    {types.find((t) => t.type === s.type)?.label ?? s.type}
                  </td>
                  <td className="px-4 py-2">
                    {s.isActive ? (
                      <span className="text-green-600">Activa</span>
                    ) : (
                      <span className="text-gray-400">Inactiva</span>
                    )}
                  </td>
                  {!isAllTenants && (
                    <td className="px-4 py-2">
                      <button
                        onClick={() => testConnection(s)}
                        disabled={testing === s.id}
                        className="text-blue-600 hover:text-blue-800 text-xs px-2 py-1 border border-blue-200 rounded disabled:opacity-50"
                      >
                        {testing === s.id ? 'Probando...' : 'Probar conexión'}
                      </button>
                      {result && (
                        <p className={`text-xs mt-1 ${result.ok ? 'text-green-600' : 'text-red-500'}`}>
                          {result.ok ? '✓' : '✗'} {result.message}
                        </p>
                      )}
                    </td>
                  )}
                  {!isAllTenants && (canUpdate || canDelete) && (
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {canUpdate && (
                        <button
                          onClick={() => startEdit(s)}
                          disabled={busy}
                          className="text-blue-600 hover:text-blue-800 text-sm px-2"
                        >
                          Editar
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => remove(s)}
                          disabled={busy}
                          className="text-red-600 hover:text-red-800 text-sm px-2"
                        >
                          Eliminar
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {tab === 'skills' && (
        <>
          {(skillEditingId ? canUpdateSkill : canCreateSkill) && !isAllTenants && (
            <form onSubmit={submitSkill} className="bg-white p-4 rounded shadow mb-6 space-y-3">
              <h2 className="font-semibold text-gray-700">
                {skillEditingId ? 'Editar skill' : 'Nuevo skill'}
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
                  <input
                    placeholder="Soporte nivel 1"
                    value={skillName}
                    onChange={(e) => setSkillName(e.target.value)}
                    className="border px-3 py-2 rounded w-full"
                    maxLength={80}
                    required
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-gray-600 pb-2">
                    <input
                      type="checkbox"
                      checked={skillIsActive}
                      onChange={(e) => setSkillIsActive(e.target.checked)}
                    />
                    Activo
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Texto (se concatena al system prompt base) *
                </label>
                <textarea
                  value={skillPromptText}
                  onChange={(e) => setSkillPromptText(e.target.value)}
                  className="border px-3 py-2 rounded w-full"
                  rows={5}
                  maxLength={8000}
                  required
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={skillBusy}
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
                >
                  {skillBusy ? 'Guardando...' : skillEditingId ? 'Guardar cambios' : 'Crear'}
                </button>
                {skillEditingId && (
                  <button
                    type="button"
                    onClick={resetSkillForm}
                    className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </form>
          )}

          {!skillEditingId && !canCreateSkill && !isAllTenants && skills.length === 0 && (
            <p className="text-gray-400 text-sm mb-4">No tenés permiso para crear skills.</p>
          )}

          <div className="bg-white rounded shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 text-gray-700">
                <tr>
                  <th className="text-left px-4 py-2">Nombre</th>
                  {isAllTenants && <th className="text-left px-4 py-2">Empresa</th>}
                  <th className="text-left px-4 py-2">Texto</th>
                  <th className="text-left px-4 py-2">Estado</th>
                  {!isAllTenants && (canUpdateSkill || canDeleteSkill) && <th className="px-4 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {skills.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                      {isAllTenants
                        ? 'No hay skills configurados en ninguna empresa.'
                        : 'No hay skills configurados en esta empresa.'}
                    </td>
                  </tr>
                )}
                {skills.map((s) => (
                  <tr key={s.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-2">{s.name}</td>
                    {isAllTenants && (
                      <td className="px-4 py-2 text-gray-500">{s.tenant?.name ?? '—'}</td>
                    )}
                    <td className="px-4 py-2 text-gray-500 max-w-xs truncate" title={s.promptText}>
                      {s.promptText}
                    </td>
                    <td className="px-4 py-2">
                      {s.isActive ? (
                        <span className="text-green-600">Activo</span>
                      ) : (
                        <span className="text-gray-400">Inactivo</span>
                      )}
                    </td>
                    {!isAllTenants && (canUpdateSkill || canDeleteSkill) && (
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {canUpdateSkill && (
                          <button
                            onClick={() => startEditSkill(s)}
                            disabled={skillBusy}
                            className="text-blue-600 hover:text-blue-800 text-sm px-2"
                          >
                            Editar
                          </button>
                        )}
                        {canDeleteSkill && (
                          <button
                            onClick={() => removeSkill(s)}
                            disabled={skillBusy}
                            className="text-red-600 hover:text-red-800 text-sm px-2"
                          >
                            Eliminar
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

    </div>
  );
}
