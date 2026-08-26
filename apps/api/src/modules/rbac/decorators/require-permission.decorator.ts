import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'permission';
export interface PermissionMetadata {
  resource: string;
  action: string;
}

export const RequirePermission = (resource: string, action: string) =>
  SetMetadata(PERMISSION_KEY, { resource, action });

/**
 * Autoriza si el rol tiene AL MENOS UNO de los permisos dados (semántica "o"). Para
 * endpoints que son dependencia de más de un flujo: p. ej. `GET /roles` lo necesita quien
 * administra roles (`roles:read`) y también quien da de alta usuarios (`users:create`), que
 * no puede asignar un rol sin poder listarlo (FE-USR-16). `RolesGuard` acepta tanto el
 * objeto único de `RequirePermission` como este arreglo.
 */
export const RequireAnyPermission = (...permissions: PermissionMetadata[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
