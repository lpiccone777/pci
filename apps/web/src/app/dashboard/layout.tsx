import Sidebar from '@/components/sidebar';
import { AuthGuard } from '@/components/auth-guard';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-6 bg-gray-50">{children}</main>
      </div>
    </AuthGuard>
  );
}
