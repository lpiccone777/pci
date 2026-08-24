'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const { login, verifyOtp, token, isLoading } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('admin@pci.local');
  const [password, setPassword] = useState('changeme123');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'credentials' | 'otp'>('credentials');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Si ya está logueado, redirigir al dashboard
  useEffect(() => {
    if (!isLoading && token) {
      router.replace('/dashboard');
    }
  }, [isLoading, token, router]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await login(email, password);
      if (res.step === 'otp_required') {
        setStep('otp');
      }
      // Si es authenticated, el useEffect de arriba maneja la redirección cuando token cambie
    } catch (err: any) {
      setError(err.message || 'Error de login');
    } finally {
      setLoading(false);
    }
  }

  async function handleOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyOtp(code);
      // El useEffect de arriba maneja la redirección cuando token cambie
    } catch (err: any) {
      setError(err.message || 'Código inválido');
    } finally {
      setLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-500">Cargando...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center text-gray-800">PCI Chatbot Admin</h1>

        {error && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 rounded text-sm">{error}</div>
        )}

        {step === 'credentials' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">Contraseña</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleOtp} className="space-y-4">
            <div className="mb-4 p-3 bg-blue-50 text-blue-700 rounded text-sm">
              Se envió un código de verificación a tu email. Ingresalo abajo.
            </div>
            <div>
              <label htmlFor="login-otp" className="block text-sm font-medium text-gray-700 mb-1">Código OTP</label>
              <input
                id="login-otp"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                // La longitud es configurable desde /settings (OTP_CODE_LENGTH, 4-8).
                maxLength={8}
                className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-center text-lg tracking-widest"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Verificando...' : 'Verificar'}
            </button>
            <button
              type="button"
              onClick={() => setStep('credentials')}
              className="w-full text-sm text-gray-500 hover:text-gray-700 mt-2"
            >
              Volver a credenciales
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
