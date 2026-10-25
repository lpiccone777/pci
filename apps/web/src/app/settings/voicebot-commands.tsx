'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Botones de la subpestaña Voicebot (H5, contrato §6): "Probar conexión" (`health.check`) en el
 * grupo general y "Re-provisionar SIP" (`sip.provision`) en los de SIP. Los dos van por el broker
 * (`/integrations/voicebot/*`); sin respuesta del voicebot muestran el motivo, no un error crudo.
 */
type Result = { ok: boolean; error?: string; [key: string]: unknown };

const HEALTH_LABELS: Record<string, string> = { livekit: 'LiveKit', rabbitmq: 'RabbitMQ', minimax: 'MiniMax' };

export function VoicebotCommands({ kind, canUpdate }: { kind: 'health' | 'sip'; canUpdate: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const path = kind === 'health' ? '/integrations/voicebot/health' : '/integrations/voicebot/sip-provision';
      setResult(await apiFetch(path, { method: 'POST' }));
    } catch (err) {
      setResult({ ok: false, error: (err instanceof Error && err.message) || 'No se pudo consultar al voicebot' });
    } finally {
      setBusy(false);
    }
  }

  if (kind === 'sip' && !canUpdate) return null;
  const label = kind === 'health' ? 'Probar conexión' : 'Re-provisionar SIP';
  const help =
    kind === 'health'
      ? 'Le pregunta al voicebot cómo están LiveKit, RabbitMQ y MiniMax, y si tiene la última configuración.'
      : 'Vuelve a crear trunks y reglas SIP. Normalmente no hace falta: los cambios de SIP se aplican solos.';

  return (
    <div className="bg-white p-4 rounded shadow mb-4">
      <div className="flex items-center gap-3">
        <button onClick={run} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50">
          {busy ? 'Consultando…' : label}
        </button>
        <span className="text-sm text-gray-600">{help}</span>
      </div>
      {result && (
        <div className={`mt-3 text-sm rounded px-3 py-2 ${result.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
          {result.error ? (
            <p>{result.error}</p>
          ) : kind === 'health' ? (
            <ul className="space-y-0.5">
              <li>{result.ok ? 'El voicebot responde.' : 'El voicebot responde con problemas.'} ({String(result.latencyMs)} ms)</li>
              {Object.entries(HEALTH_LABELS).map(([key, name]) =>
                result[key] !== undefined ? (
                  <li key={key}>
                    {name}: {typeof result[key] === 'object' ? JSON.stringify(result[key]) : String(result[key])}
                  </li>
                ) : null,
              )}
              {result.activeCalls !== undefined && <li>Llamadas activas: {String(result.activeCalls)}</li>}
              <li>
                Configuración: versión {String(result.configVersion ?? '?')} en el voicebot, {String(result.pciConfigVersion)} en pci
                {result.configUpToDate ? ' (al día)' : ' — el voicebot no tomó el último cambio'}
              </li>
            </ul>
          ) : (
            <pre className="whitespace-pre-wrap text-xs">{JSON.stringify({ trunks: result.trunks, rules: result.rules }, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
