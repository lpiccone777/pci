'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { apiFetch } from '@/lib/api';

interface DashboardMetrics {
  users: number;
  tenants: number;
  conversations: number;
  tickets: number;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  useEffect(() => {
    apiFetch('/metrics/dashboard')
      .then(setMetrics)
      .catch(() => setMetrics(null));
  }, []);

  const value = (n: number | undefined) => (n === undefined ? '—' : String(n));

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card title="Usuarios" value={value(metrics?.users)} color="blue" />
        <Card title="Tenants" value={value(metrics?.tenants)} color="green" />
        <Card title="Conversaciones" value={value(metrics?.conversations)} color="purple" />
        <Card title="Tickets" value={value(metrics?.tickets)} color="orange" />
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-4">Actividad reciente</h2>
          <p className="text-gray-500 text-sm">Próximamente: métricas de conversaciones y tickets.</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-4">Tu rol y permisos</h2>
          {user?.tenants?.map((ut) => (
            <div key={ut.tenantId} className="mb-3">
              <p className="text-sm font-medium text-gray-700">
                {ut.tenant.name}: <span className="text-blue-600">{ut.role.name}</span>
              </p>
              <p className="text-xs text-gray-500">
                {ut.role.permissions.length} permisos
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({ title, value, color }: { title: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-800',
    green: 'bg-green-100 text-green-800',
    purple: 'bg-purple-100 text-purple-800',
    orange: 'bg-orange-100 text-orange-800',
  };
  return (
    <div className={`rounded-lg p-4 ${colors[color] || 'bg-gray-100'}`}>
      <p className="text-sm font-medium opacity-75">{title}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
