import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
/** Sal fija: la clave maestra ya es secreta y de alta entropía; esto solo deriva 32 bytes. */
const SALT = 'pci-chatbot-settings-v1';

/**
 * Cifra los valores sensibles (API keys) que se guardan en la tabla `Setting`.
 *
 * La spec §5 pide que los secrets vivan en env vars o vault. Guardarlos en BD para
 * poder configurarlos desde el backoffice es una concesión deliberada, así que al
 * menos no quedan en texto plano: se cifran con AES-256-GCM usando una clave maestra
 * que sí vive solo en el entorno (`SETTINGS_ENCRYPTION_KEY`).
 *
 * Sin esa variable no se pueden guardar secrets — preferimos fallar antes que
 * escribir una API key legible en la base.
 */
@Injectable()
export class SecretsCipher {
  private readonly logger = new Logger(SecretsCipher.name);

  constructor(private readonly config: ConfigService) {}

  /** true si hay clave maestra configurada y por lo tanto se pueden guardar secrets. */
  get isConfigured(): boolean {
    return !!this.config.get<string>('SETTINGS_ENCRYPTION_KEY');
  }

  private key(): Buffer {
    const master = this.config.get<string>('SETTINGS_ENCRYPTION_KEY');
    if (!master) {
      throw new InternalServerErrorException(
        'SETTINGS_ENCRYPTION_KEY no está configurada: no se pueden cifrar ni descifrar secrets',
      );
    }
    return scryptSync(master, SALT, 32);
  }

  isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return (
      PREFIX +
      [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
    );
  }

  /**
   * Descifra un valor. Si no tiene el prefijo, se devuelve tal cual: permite convivir
   * con valores viejos en texto plano y con env vars sin cifrar.
   */
  decrypt(stored: string): string {
    if (!this.isEncrypted(stored)) return stored;

    const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      this.logger.error('Valor cifrado con formato inválido');
      throw new InternalServerErrorException('Valor cifrado corrupto en la configuración');
    }

    try {
      const decipher = createDecipheriv(ALGO, this.key(), Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Suele pasar si cambió SETTINGS_ENCRYPTION_KEY: el tag GCM no valida.
      this.logger.error(
        'No se pudo descifrar un secret. ¿Cambió SETTINGS_ENCRYPTION_KEY? ' +
          'Hay que volver a cargar los secrets desde /settings.',
      );
      throw new InternalServerErrorException(
        'No se pudo descifrar la configuración. Verificá SETTINGS_ENCRYPTION_KEY.',
      );
    }
  }

  /** Enmascara para mostrar en UI: nunca devolvemos el valor real por la API. */
  mask(plain: string): string {
    if (!plain) return '';
    if (plain.length <= 8) return '••••••••';
    return `${plain.slice(0, 3)}••••••••${plain.slice(-4)}`;
  }
}
