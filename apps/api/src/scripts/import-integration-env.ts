/**
 * Importación de una sola vez de los `.env` del voicebot y del stt a la configuración de pci.
 *
 *   pnpm --filter api run integrations:import-env -- --voicebot <ruta .env> --stt <ruta .env> [--apply]
 *
 * Por default es dry-run: imprime qué claves se darían de alta, cuáles no cambian, cuáles chocan
 * entre los dos `.env` y cuáles se ignoran. Solo nombres, nunca valores. Con `--apply` escribe por
 * `SettingsService` (cifra los secrets con `SETTINGS_ENCRYPTION_KEY`), sube la versión una vez y
 * publica un `config.changed`. Usa la base y el broker de `apps/api/.env`.
 *
 * Levanta un contexto Nest mínimo (sin `AppModule`): así no arranca los consumidores de las colas
 * de WhatsApp ni del motor de conversaciones, que le robarían mensajes a la API que está corriendo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigModule } from '../config/app-config.module';
import { BrokerModule } from '../modules/broker/broker.module';
import { SettingsService } from '../modules/settings/settings.service';
import { IntegrationsConfigService } from '../modules/integrations/integrations-config.service';
import { EnvImportSource, formatEnvImportReport, parseEnvFile } from '../modules/integrations/env-import';
import { runEnvImport } from '../modules/integrations/env-import.runner';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AppConfigModule, BrokerModule],
  providers: [IntegrationsConfigService, SettingsService],
})
class EnvImportModule {}

const USAGE =
  'Uso: integrations:import-env -- --voicebot <ruta .env> --stt <ruta .env> [--apply]\n' +
  'Sin --apply no escribe nada (dry-run). Se puede pasar uno solo de los dos .env.';

function parseArgs(argv: string[]) {
  const args = { voicebot: '', stt: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--voicebot' || a === '--stt') args[a.slice(2) as 'voicebot' | 'stt'] = argv[++i] ?? '';
    else if (a !== '--') throw new Error(`Argumento desconocido: ${a}`);
  }
  if (!args.voicebot && !args.stt) throw new Error('Falta --voicebot o --stt');
  return args;
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  const sources: EnvImportSource[] = [];
  for (const consumer of ['voicebot', 'stt'] as const) {
    if (!args[consumer]) continue;
    // `pnpm run` en Windows puede duplicar las barras invertidas: `resolve` las normaliza.
    const file = path.resolve(args[consumer]);
    if (!fs.existsSync(file)) {
      console.error(`No existe el archivo de --${consumer}: ${file}`);
      return 2;
    }
    sources.push({ consumer, vars: parseEnvFile(fs.readFileSync(file, 'utf8')) });
  }

  // Solo warn/error: el log de `SettingsService` citaría los valores no secretos al guardar.
  const app = await NestFactory.createApplicationContext(EnvImportModule, { logger: ['warn', 'error'] });
  try {
    const result = await runEnvImport(
      {
        prisma: app.get(PrismaService),
        settings: app.get(SettingsService),
        integrations: app.get(IntegrationsConfigService),
      },
      sources,
      { apply: args.apply },
    );

    console.log(args.apply ? '== Importación (--apply) ==' : '== Dry-run: no se escribe nada ==');
    console.log(formatEnvImportReport(result.entries) || '(los .env no traen variables)');
    if (args.apply) {
      console.log(`\nEscritas: ${result.written.length}`);
      if (result.failed.length) console.log(`Fallaron: ${result.failed.join(', ')}`);
      if (result.written.length) console.log('Versión subida una vez y config.changed publicado.');
    } else {
      console.log('\nPara escribir "alta" y "cambia", volvé a correrlo con --apply.');
    }
    return result.failed.length ? 1 : 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Sin el stack completo: podría arrastrar datos de la conexión.
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
