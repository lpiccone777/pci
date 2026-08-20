'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { token, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !token) {
      // Barra final: ver el comentario equivalente en `lib/api.ts` (clearSession).
      router.replace('/login/');
    }
  }, [isLoading, token, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Cargando...</div>
      </div>
    );
  }

  if (!token) {
    return null; // Redirigiendo
  }

  return <>{children}</>;
}
