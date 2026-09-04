/**
 * globalSetup de Playwright: levanta el stack aislado (base + vhost efímeros + API + web propios)
 * ANTES de correr los tests y devuelve la función que lo destruye al terminar.
 *
 * Playwright ejecuta la función devuelta como teardown en el MISMO proceso, así que conserva en
 * el closure los handles de los procesos y los datos de la base/vhost — sin archivos de handoff
 * ni matar procesos por PID desde un proceso nuevo.
 *
 * Salvedad: si la corrida se corta de golpe (Ctrl+C), el teardown podría no ejecutarse y quedar
 * una base/vhost/procesos huérfanos. En ese caso, la próxima corrida usa nombres nuevos (con
 * timestamp) y no se pisa; la limpieza del residuo es manual.
 */
import { prepareStack, teardownStack } from './support/ephemeral-stack';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await prepareStack();
  return async () => {
    await teardownStack(stack);
  };
}
