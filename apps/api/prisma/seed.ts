import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  PERMISSION_ACTIONS,
  PERMISSION_RESOURCES,
} from '../src/modules/rbac/permissions.catalog';
import {
  DEFAULT_SYSTEM_TENANT_SLUG,
  SUPERADMIN_ROLE_NAME,
} from '../src/modules/rbac/protected-role';

const prisma = new PrismaClient();

const DEFAULT_ADMIN_EMAIL = 'admin@pci.local';
const DEFAULT_ADMIN_PASSWORD = 'changeme123';

/** El mismo slug que resuelve el backend, para no sembrar un tenant que después no encuentre. */
const SYSTEM_TENANT_SLUG =
  process.env.SYSTEM_TENANT_SLUG || DEFAULT_SYSTEM_TENANT_SLUG;

async function main() {
  // 1. Tenant por defecto
  const tenant = await prisma.tenant.upsert({
    where: { slug: SYSTEM_TENANT_SLUG },
    update: {},
    create: {
      name: 'Sistema Plataforma Conversacional Inteligente',
      slug: SYSTEM_TENANT_SLUG,
    },
  });

  // 2. Rol SuperAdmin
  const role = await prisma.role.upsert({
    where: {
      name_tenantId: { name: SUPERADMIN_ROLE_NAME, tenantId: tenant.id },
    },
    update: {},
    create: {
      name: SUPERADMIN_ROLE_NAME,
      tenantId: tenant.id,
    },
  });

  // 3. Permisos completos, salidos del catálogo.
  //
  // **El SuperAdmin no depende de estas filas.** El backend le informa el catálogo entero
  // (`effectivePermissions` en `protected-role.ts`) y lo deja pasar sin mirar la lista
  // (`RolesGuard`), así que un recurso nuevo en `permissions.catalog.ts` le llega desde el
  // primer request, sin volver a correr el seed en ningún entorno.
  //
  // Se siguen cargando igual, como piso: si algún día aparece un lugar de lectura nuevo que
  // se olvide de pasar por `effectivePermissions`, con estas filas muestra algo desactualizado
  // en vez de un rol vacío. La lista sale del catálogo y no de una copia a mano para que ese
  // piso no se desfase solo.
  const resources = PERMISSION_RESOURCES.map((r) => r.key);
  const actions = PERMISSION_ACTIONS.map((a) => a.key);

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
      firstName: 'Administrador',
      lastName: 'Plataforma Conversacional Inteligente',
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
