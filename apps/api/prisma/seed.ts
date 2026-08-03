import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const DEFAULT_ADMIN_EMAIL = 'admin@pci.local';
const DEFAULT_ADMIN_PASSWORD = 'changeme123';

async function main() {
  // 1. Tenant por defecto
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'system' },
    update: {},
    create: {
      name: 'Sistema PCI',
      slug: 'system',
    },
  });

  // 2. Rol SuperAdmin
  const role = await prisma.role.upsert({
    where: {
      name_tenantId: { name: 'SuperAdmin', tenantId: tenant.id },
    },
    update: {},
    create: {
      name: 'SuperAdmin',
      tenantId: tenant.id,
    },
  });

  // 3. Permisos completos (CRUD sobre todos los recursos del sistema)
  const resources = [
    'users',
    'tenants',
    'roles',
    'permissions',
    'devices',
    'conversations',
    'tickets',
    'metrics',
    'settings',
    'channels',
    'llm',
    'flows',
  ];
  const actions = ['create', 'read', 'update', 'delete'];

  for (const resource of resources) {
    for (const action of actions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_resource_action: {
            roleId: role.id,
            resource,
            action,
          },
        },
        update: {},
        create: { roleId: role.id, resource, action },
      });
    }
  }

  // 4. Usuario admin por defecto
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: DEFAULT_ADMIN_EMAIL },
    update: {},
    create: {
      email: DEFAULT_ADMIN_EMAIL,
      name: 'Administrador',
      passwordHash,
    },
  });

  // 5. Asignar admin al tenant con rol SuperAdmin
  await prisma.userTenant.upsert({
    where: {
      userId_tenantId: { userId: user.id, tenantId: tenant.id },
    },
    update: {},
    create: {
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    },
  });

  // 6. Settings por defecto (configurables desde backoffice)
  const defaultSettings = [
    { key: 'OTP_TTL_SECONDS', value: '300' },
    { key: 'DEVICE_FINGERPRINT_TTL_DAYS', value: '90' },
  ];

  for (const s of defaultSettings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }

  console.log('✅ Seed completado:');
  console.log(`   Tenant: ${tenant.name} (${tenant.slug})`);
  console.log(`   Rol: ${role.name}`);
  console.log(`   Usuario: ${user.email} / ${DEFAULT_ADMIN_PASSWORD}`);
  console.log(`   Permisos: ${resources.length * actions.length} asignados`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
