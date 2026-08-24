/**
 * Puertos del stack AISLADO que levanta Playwright para los tests e2e. A propósito distintos
 * de los de desarrollo (web 3000 / api 3001), para poder correr los tests con la app de dev
 * levantada en paralelo sin que se pisen.
 *
 * Los comparten `playwright.config.ts` (baseURL del web), `global-setup.ts` (al arrancar los
 * procesos) y los specs (para pegarle a la API directo). Única fuente de verdad de los puertos.
 */
export const WEB_PORT = 3100;
export const API_PORT = 3101;

export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
