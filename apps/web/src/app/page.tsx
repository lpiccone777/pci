'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    // Barra final: ver el comentario equivalente en `lib/api.ts` (clearSession).
    router.replace('/login/');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <p className="text-gray-500">Redirigiendo...</p>
    </div>
  );
}
