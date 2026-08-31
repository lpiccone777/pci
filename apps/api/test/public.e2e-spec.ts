/**
 * 1.16 Endpoints públicos — `AppController` (BE-APP-*)
 *
 * Vía: endpoints REST reales con supertest, sin ningún guard (rutas sin prefijo). Nada que
 * mockear: `AppController` no tiene dependencias externas.
 */
import { createTestApp, TestApp, http } from './support';

describe('1.16 Endpoints públicos (BE-APP-*)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('BE-APP-01: GET / devuelve 200 con el saludo de AppService.getHello()', async () => {
    const res = await http(t).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toBe('Hello World!');
  });

  it('BE-APP-02: GET /privacy-policy devuelve 200 con Content-Type text/html y la política de privacidad', async () => {
    const res = await http(t).get('/privacy-policy');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  it('BE-APP-03: GET /company devuelve 200 con Content-Type text/html y el sitio de empresa', async () => {
    const res = await http(t).get('/company');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<!DOCTYPE html>');
  });
});
