'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { ALL_TENANTS } from '@/lib/system-tenant';

/**
 * Llamadas salientes desde pci (H5, contrato C63). Se lanzan en la empresa activa, con un flujo de
 * voz de esa empresa, a uno o varios números (rotación: un número por intento). pci reintenta los
 * no atendidos hasta agotar las vueltas. Solo se puede llamar a números de la lista de prefijos
 * permitidos (configuración → Voicebot → Llamadas salientes): vacía, no se puede llamar a nada.
 */
interface Attempt {
  id: string;
  to: string | null;
  round: number | null;
  outcome: string | null;
  answered: boolean;
  createdAt: string;
  resultAt: string | null;
}

interface Outbound {
  id: string;
  mode: 'flow' | 'audio';
  to: string[];
  status: 'pending' | 'calling' | 'done' | 'failed' | 'cancelled';
  outcome: string | null;
  maxRounds: number;
  attemptsCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  flow: { id: string; name: string } | null;
  createdBy: { firstName: string | null; lastName: string | null; email: string } | null;
  attempts: Attempt[];
}

interface FlowOption {
  id: string;
  name: string;
}

const STATUS: Record<Outbound['status'], { label: string; className: string }> = {
  pending: { label: 'pendiente', className: 'bg-gray-100 text-gray-600' },
  calling: { label: 'llamando', className: 'bg-blue-100 text-blue-700' },
  done: { label: 'atendida', className: 'bg-green-100 text-green-700' },
  failed: { label: 'sin éxito', className: 'bg-red-100 text-red-700' },
  cancelled: { label: 'cancelada', className: 'bg-gray-100 text-gray-500' },
};

const OUTCOME: Record<string, string> = {
  answered: 'atendió',
  digit: 'marcó',
  'no-answer': 'no atendió',
  'no-digit': 'no marcó',
  hangup: 'cortó',
  busy: 'voicebot ocupado',
  exhausted: 'sin más vueltas',
  error: 'error',
};

const formatDate = (iso: string) => new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

export default function VoiceCallsPage() {
  const { hasPermission, activeTenant } = useAuth();
  const isAllTenants = activeTenant === ALL_TENANTS;
  const canCreate = hasPermission('voice_outbound', 'create') && !isAllTenants;
  const canCancel = hasPermission('voice_outbound', 'update') && !isAllTenants;

  const [items, setItems] = useState<Outbound[]>([]);
  const [flows, setFlows] = useState<FlowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [numbers, setNumbers] = useState('');
  const [flowId, setFlowId] = useState('');
  const [maxRounds, setMaxRounds] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, options]: [Outbound[], FlowOption[]] = await Promise.all([
        apiFetch('/voice/outbound-calls'),
        apiFetch('/voice/outbound-calls/flow-options'),
      ]);
      setItems(list);
      setFlows(options);
      setError('');
    } catch (err) {
      setError((err instanceof Error && err.message) || 'No se pudieron cargar las llamadas salientes');
    } finally {
      setLoading(false);
    }
  }, []);

  // Con "todas las empresas" no hay nada que cargar: la pantalla pide elegir una.
  useEffect(() => {
    if (!isAllTenants) load();
  }, [load, isAllTenants, activeTenant]);

  // Mientras haya salientes en curso, la lista se refresca sola.
  const inProgress = items.some((o) => o.status === 'pending' || o.status === 'calling');
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [inProgress, load]);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    const to = numbers
      .split(/[,;\n]/)
      .map((n) => n.trim())
      .filter(Boolean);
    if (!to.length || !flowId) {
      setError('Cargá al menos un número y elegí un flujo de voz.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await apiFetch('/voice/outbound-calls', {
        method: 'POST',
        body: JSON.stringify({ to, flowId, ...(maxRounds ? { maxRounds: Number(maxRounds) } : {}) }),
      });
      setNumbers('');
      setNotice('Llamada lanzada.');
      await load();
    } catch (err) {
      setError((err instanceof Error && err.message) || 'No se pudo lanzar la llamada');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (!confirm('¿Cancelar esta llamada? Si está sonando o en curso, se corta.')) return;
    setBusy(true);
    try {
      await apiFetch(`/voice/outbound-calls/${id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setError((err instanceof Error && err.message) || 'No se pudo cancelar');
    } finally {
      setBusy(false);
    }
  }

  if (isAllTenants) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Llamadas salientes</h1>
        <p className="text-gray-600">Elegí una empresa en el selector: las llamadas salen siempre de una empresa.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Llamadas salientes</h1>
        <p className="text-sm text-gray-600 mt-1">
          El bot llama y corre un flujo de voz de esta empresa. Con varios números, cada intento usa el siguiente;
          los no atendidos se reintentan hasta agotar las vueltas. Solo se puede llamar a números permitidos en la
          configuración del voicebot.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
          {error}
        </p>
      )}
      {notice && <p className="text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm">{notice}</p>}

      {canCreate && (
        <form onSubmit={launch} className="bg-white p-4 rounded shadow grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <label className="md:col-span-2 text-sm">
            <span className="block text-gray-700 mb-1">Números (separados por coma)</span>
            <input
              value={numbers}
              onChange={(e) => setNumbers(e.target.value)}
              placeholder="201, +5491155550000"
              className="w-full border rounded px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Flujo de voz</span>
            <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className="w-full border rounded px-3 py-2">
              <option value="">Elegí un flujo…</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Vueltas (opcional)</span>
            <input
              type="number"
              min={1}
              max={20}
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              placeholder="la del voicebot"
              className="w-full border rounded px-3 py-2"
            />
          </label>
          <div className="md:col-span-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
            >
              {busy ? 'Lanzando…' : 'Llamar'}
            </button>
            {!flows.length && !loading && (
              <span className="text-sm text-amber-700">Esta empresa no tiene flujos de voz activos asignados.</span>
            )}
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-2">Creada</th>
              <th className="px-4 py-2">Números</th>
              <th className="px-4 py-2">Flujo</th>
              <th className="px-4 py-2">Estado</th>
              <th className="px-4 py-2">Intentos</th>
              <th className="px-4 py-2">Lanzada por</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && !items.length && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                  Todavía no hay llamadas salientes en esta empresa.
                </td>
              </tr>
            )}
            {items.map((o) => {
              const status = STATUS[o.status];
              const last = o.attempts[0];
              return (
                <tr key={o.id} className="border-t align-top">
                  <td className="px-4 py-2 whitespace-nowrap">{formatDate(o.createdAt)}</td>
                  <td className="px-4 py-2">{o.to.join(', ')}</td>
                  <td className="px-4 py-2">{o.mode === 'flow' ? (o.flow?.name ?? '(flujo borrado)') : 'audio + dígito'}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${status.className}`}>{status.label}</span>
                    {o.outcome && <div className="text-xs text-gray-500 mt-1">{OUTCOME[o.outcome] ?? o.outcome}</div>}
                    {o.status === 'calling' && o.nextAttemptAt && (
                      <div className="text-xs text-gray-500">próximo intento {formatDate(o.nextAttemptAt)}</div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {o.attemptsCount}
                    {last?.to && <div className="text-xs text-gray-500">último: {last.to}</div>}
                  </td>
                  <td className="px-4 py-2">
                    {o.createdBy ? [o.createdBy.firstName, o.createdBy.lastName].filter(Boolean).join(' ') || o.createdBy.email : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canCancel && (o.status === 'pending' || o.status === 'calling') && (
                      <button onClick={() => cancel(o.id)} disabled={busy} className="text-red-600 hover:underline disabled:opacity-50">
                        Cancelar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
