import { Controller, Post, Get, Body, Headers, UseGuards, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Headers('user-agent') userAgent: string,
  ) {
    if (!userAgent) {
      throw new UnauthorizedException('User-Agent requerido');
    }
    return this.authService.login(dto, userAgent);
  }

  @Post('verify-otp')
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Headers('user-agent') userAgent: string,
  ) {
    if (!userAgent) {
      throw new UnauthorizedException('User-Agent requerido');
    }
    return this.authService.verifyOtp(dto.code, userAgent);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: any) {
    return this.authService.me(req.user.userId);
  }
}
