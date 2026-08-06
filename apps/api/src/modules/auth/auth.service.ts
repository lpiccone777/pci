import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { systemTenantSlug } from '../../common/system-tenant';
import { effectivePermissions } from '../rbac/protected-role';
import { EmailService } from './email.service';
import { DeviceService } from './device.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

interface OtpEntry {
  code: string;
  expiresAt: Date;
  userId: string;
}

@Injectable()
export class AuthService {
  // En producción: Redis / DB. En MVP: Map en memoria.
  private readonly otpStore = new Map<string, OtpEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
    private readonly emailService: EmailService,
    private readonly deviceService: DeviceService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new UnauthorizedException('El email ya está registrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
      },
    });

    // No devolver passwordHash
    const { passwordHash: _, ...result } = user;
    return result;
  }

  async login(dto: LoginDto, userAgent: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // 2FA configurable desde /settings (`OTP_ENABLED`). Si nunca se fijó valor,
    // AppConfigService lo deja desactivado en NODE_ENV=development.
    if (!(await this.config.otpEnabled())) {
      return await this.buildTokens(user);
    }

    // Validar fingerprint
    const hasDevices = await this.prisma.device.count({ where: { userId: user.id } }) > 0;
    const fingerprintValid = await this.deviceService.validateFingerprint(
      user.id,
      user.phone,
      userAgent,
    );

    if (hasDevices && !fingerprintValid) {
      // Dispositivo nuevo de usuario existente → requiere OTP
      await this.sendOtp(user);
      return {
        step: 'otp_required',
        message: 'Se envió un código de verificación a tu email',
      };
    }

    // Primer login o fingerprint válido → registrar device y emitir JWT
    if (!fingerprintValid) {
      await this.deviceService.createFingerprint(user.id, user.phone, userAgent);
    }

    return await this.buildTokens(user);
  }

  async verifyOtp(code: string, userAgent: string) {
    const entry = this.otpStore.get(code);
    if (!entry) {
      throw new UnauthorizedException('Código inválido o expirado');
    }
    if (new Date() > entry.expiresAt) {
      this.otpStore.delete(code);
      throw new UnauthorizedException('Código expirado');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: entry.userId },
    });
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    // Registrar fingerprint del nuevo dispositivo
    await this.deviceService.createFingerprint(user.id, user.phone, userAgent);

    this.otpStore.delete(code);
    return await this.buildTokens(user);
  }

  private async sendOtp(user: { id: string; email: string }) {
    const ttlSeconds = await this.config.otpTtlSeconds();
    const length = await this.config.otpCodeLength();
    // Código numérico de `length` dígitos, sin ceros a la izquierda.
    const min = 10 ** (length - 1);
    const code = Math.floor(min + Math.random() * (min * 9)).toString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    this.otpStore.set(code, {
      code,
      expiresAt,
      userId: user.id,
    });

    await this.emailService.send({
      to: user.email,
      subject: 'Código de verificación - Plataforma Conversacional Inteligente Chatbot',
      text: `Tu código de verificación es: ${code}. Válido por ${ttlSeconds} segundos.`,
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        tenants: {
          include: {
            tenant: true,
            role: {
              include: {
                permissions: true,
              },
            },
          },
        },
      },
    });

    if (!user) throw new UnauthorizedException('Usuario no encontrado');

    const { passwordHash, ...result } = user;

    // De acá salen el menú y los botones del frontend, así que el superusuario tiene que
    // recibir el catálogo completo: si informáramos solo sus filas guardadas, un permiso
    // agregado después del último seed no le aparecería en pantalla aunque el API se lo
    // acepte igual.
    const slug = systemTenantSlug(this.configService);
    return {
      ...result,
      tenants: result.tenants.map((ut) => ({
        ...ut,
        role: {
          ...ut.role,
          permissions: effectivePermissions(
            ut.role.name,
            ut.tenant.slug,
            slug,
            ut.role.permissions,
          ),
        },
      })),
    };
  }

  /**
   * El token identifica a la persona, no a la persona-en-un-tenant. El tenant
   * activo viaja por header `X-Tenant-Id` en cada request y lo valida TenantGuard.
   * Así, cambiar de tenant no exige reemitir el token.
   */
  private async buildTokens(user: { id: string; email: string }) {
    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload, { expiresIn: '15m' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

    return {
      step: 'authenticated',
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email },
    };
  }
}
