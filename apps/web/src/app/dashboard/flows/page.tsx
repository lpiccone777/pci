'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';

interface Flow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdAt: string;
  tenantFlows: Array<{
    tenant: { id: string; name: string; slug: string };
  }>;
}

export default function FlowsPage() {
  const { hasPermission } = useAuth();
  const router = useRouter();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFlows();
  }, []);

  async function loadFlows() {
    try {
      const data = await apiFetch('/flows');
      setFlows(data);
    } catch (err) {
      console.error('Error loading flows:', err);
    } finally {
      setLoading(false);
    }
  }

  async function deleteFlow(id: string) {
    if (!confirm('¿Eliminar este flujo?')) return;
    try {
      await apiFetch(`/flows/${id}`, { method: 'DELETE' });
      setFlows(flows.filter((f) => f.id !== id));
    } catch (err) {
      alert('Error al eliminar');
    }
  }

  async function setDefault(id: string) {
    try {
      await apiFetch(`/flows/${id}/default`, { method: 'POST' });
      loadFlows();
    } catch (err) {
      alert('Error al establecer como default');
    }
  }

  if (loading) return <div className="p-6">Cargando...</div>;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Flujos IVR</h1>
        {hasPermission('flows', 'create') && (
          <button
            onClick={() => router.push('/dashboard/flows/new')}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Nuevo Flujo
          </button>
        )}
      </div>

      <div className="grid gap-4">
        {flows.map((flow) => (
          <div
            key={flow.id}
            className="bg-white p-4 rounded-lg shadow border hover:shadow-md transition"
          >
            <div className="flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-lg">{flow.name}</h3>
                  {flow.isDefault && (
                    <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded">
                      Default
                    </span>
                  )}
                  {!flow.isActive && (
                    <span className="bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded">
                      Inactivo
                    </span>
                  )}
                </div>
                {flow.description && (
                  <p className="text-gray-600 text-sm mt-1">{flow.description}</p>
                )}
                <div className="flex gap-2 mt-2">
                  {flow.tenantFlows.map((tf) => (
                    <span
                      key={tf.tenant.id}
                      className="bg-blue-50 text-blue-700 text-xs px-2 py-1 rounded"
                    >
                      {tf.tenant.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                {hasPermission('flows', 'update') && (
                  <>
                    <button
                      onClick={() => router.push(`/dashboard/flows/${flow.id}`)}
                      className="text-blue-600 hover:text-blue-800 text-sm"
                    >
                      Editar
                    </button>
                    {!flow.isDefault && (
                      <button
                        onClick={() => setDefault(flow.id)}
                        className="text-green-600 hover:text-green-800 text-sm"
                      >
                        Default
                      </button>
                    )}
                  </>
                )}
                {hasPermission('flows', 'delete') && (
                  <button
                    onClick={() => deleteFlow(flow.id)}
                    className="text-red-600 hover:text-red-800 text-sm"
                  >
                    Eliminar
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

        {flows.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            No hay flujos configurados.{' '}
            {hasPermission('flows', 'create') && (
              <button
                onClick={() => router.push('/dashboard/flows/new')}
                className="text-blue-600 hover:underline"
              >
                Crear el primero
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
