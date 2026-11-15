import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { StudentLimitService } from './shared/application/student-limit.service';
import { Roles } from './shared/infrastructure/security/decorators';

/**
 * "Estado del servicio" del administrador de la institución: lo que comprueba la propia
 * API (ella misma y su base de datos) y lo que sabe la plataforma (estado de los
 * servidores, métricas, alertas activas y eventos recientes). La plataforma solo responde
 * por esta institución: se identifica con su clave de vinculación por la red privada.
 */
@Controller('admin/service-status')
@Roles('ADMIN')
export class ServiceStatusController {
  constructor(
    private readonly database: DataSource,
    private readonly config: ConfigService,
    private readonly studentLimit: StudentLimitService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async status() {
    const started = Date.now();
    let database: 'ok' | 'error' = 'ok';
    try {
      await this.database.query('SELECT 1');
    } catch {
      database = 'error';
    }
    const databaseMs = Date.now() - started;
    // RF-05: estudiantes de la institución frente al límite de su plan.
    const students = database === 'ok'
      ? { count: await this.studentLimit.count().catch(() => null), limit: this.studentLimit.limit() }
      : { count: null, limit: this.studentLimit.limit() };
    const local = { api: 'ok' as const, database, databaseMs, students };

    const url = this.config.get<string>('PLATFORM_STATUS_URL');
    const slug = this.config.get<string>('PLATFORM_TENANT_SLUG');
    const key = this.config.get<string>('PLATFORM_BOOTSTRAP_KEY');
    if (!url || !slug || !key) {
      return { checkedAt: new Date().toISOString(), local, platform: null, platformError: 'not-configured' };
    }
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) {
        return { checkedAt: new Date().toISOString(), local, platform: null, platformError: `http-${response.status}` };
      }
      return { checkedAt: new Date().toISOString(), local, platform: await response.json() };
    } catch {
      // Sin detalles de red ni de la clave en la respuesta.
      return { checkedAt: new Date().toISOString(), local, platform: null, platformError: 'unreachable' };
    }
  }
}
