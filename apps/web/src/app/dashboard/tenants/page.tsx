'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

interface TenantData {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export default function TenantsPage() {
  const { hasPermission } = useAuth();
  const [tenants, setTenants] = useState<TenantData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', slug: '' });

  async function load() {
    try {
      const data = await apiFetch('/tenants');
      setTenants(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/tenants', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ name: '', slug: '' });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Tenants</h1>
      {error && <p className="text-red-500 mb-4">{error}</p>}

      {hasPermission('tenants', 'create') && (
        <form onSubmit={create} className="bg-white p-4 rounded shadow mb-6 space-y-3">
          <h2 className="font-semibold text-gray-700">Nuevo tenant</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              placeholder="Nombre"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            />
            <input
              placeholder="Slug (único)"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              className="border px-3 py-2 rounded"
              required
            />
            <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
              Crear
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Nombre</th>
              <th className="text-left px-4 py-2">Slug</th>
              <th className="text-left px-4 py-2">Creado</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-4 py-2">{t.name}</td>
                <td className="px-4 py-2 text-gray-500">{t.slug}</td>
                <td className="px-4 py-2">{new Date(t.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
