/**
 * Helpers de navegador para los specs del backoffice: inyectar una sesión en `localStorage`
 * (para arrancar ya logueado sin pasar por el formulario) y loguear por la UI real.
 *
 * El JWT y el tenant activo viven en `localStorage` (`token`, `activeTenant`); el resto de las
 * claves que usa `apiFetch` (`systemTenantId`, `fallbackTenantId`, `allTenants`) las repuebla
 * `useAuth` al resolver `/auth/me` en el montaje, así que no hace falta inyectarlas.
 */
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Claves de sesión en `localStorage`, iguales que en `apiFetch`/`clearSession` del frontend. */
export const TOKEN_KEY = 'token';
export const ACTIVE_TENANT_KEY = 'activeTenant';

/**
 * Deja una sesión en `localStorage` para los tests que necesitan arrancar autenticados sin
 * ejercitar el login (la mayoría de los de infra transversal). Llamarla ANTES de navegar a la
 * pantalla objetivo.
 *
 * Escribe UNA sola vez (carga el origen con `/login` y setea con `evaluate`), a propósito no con
 * `addInitScript`: un init script se re-ejecuta en cada navegación y volvería a pisar lo que la
 * app cambie —el `activeTenant` del selector, el token que borra el logout—, rompiendo justo los
 * casos que prueban esos cambios. Como acá se setea el token DESPUÉS de que `/login` ya montó sin
 * token, la pantalla de login no redirige; la sesión recién la lee `useAuth` al navegar al panel.
 *
 * Antes de eso limpia cualquier sesión previa del origen: si al montar `/login` sigue el token de
 * un usuario ANTERIOR (típico al inyectar dos sesiones en un mismo test, p. ej. lector y luego
 * editor), su `useEffect` redirige a `/dashboard` COMO ESE usuario viejo —client-side, sin recargar—
 * y el token nuevo que seteamos después ya no lo relee nadie: el test terminaba viendo al usuario
 * anterior (flaky de FE-TEN-01 / FE-ARE-04 / FE-FLW-02). En la primera inyección todavía no hay
 * origen cargado (`about:blank`): ahí `localStorage` tira `SecurityError`, lo ignoramos.
 */
export async function injectSession(
  page: Page,
  session: { token: string; activeTenant: string },
): Promise<void> {
  await page
    .evaluate(() => {
      try {
        localStorage.clear();
      } catch {
        // about:blank / origen sin cargar: no hay sesión previa que limpiar.
      }
    })
    .catch(() => {
      // `evaluate` puede rechazar si aún no se navegó a ningún origen; es esperable.
    });
  await page.goto('/login');
  await page.evaluate(
    ({ tokenKey, tenantKey, token, tenant }) => {
      localStorage.setItem(tokenKey, token);
      localStorage.setItem(tenantKey, tenant);
    },
    {
      tokenKey: TOKEN_KEY,
      tenantKey: ACTIVE_TENANT_KEY,
      token: session.token,
      tenant: session.activeTenant,
    },
  );
}

/** Lee una clave de `localStorage` de la página actual (o `null` si no está). */
export async function readLocalStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

/**
 * Login por el formulario real (`/login`): completa credenciales y aprieta "Ingresar". No espera
 * el resultado (puede terminar en dashboard, en la vista OTP o en un error) — de eso se ocupa
 * cada test según lo que esté probando.
 */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  const emailInput = page.locator('#login-email');
  await expect(emailInput).toBeVisible();
  await emailInput.fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}
