import Sidebar from '@/components/sidebar';
import { AuthGuard } from '@/components/auth-guard';

// /settings vive fuera de /dashboard pero comparte el chrome del panel,
// para no perder la navegación ni el selector de tenant.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-6 bg-gray-50">{children}</main>
      </div>
    </AuthGuard>
  );
}
