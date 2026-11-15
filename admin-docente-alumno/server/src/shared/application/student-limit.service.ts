import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BusinessRuleError } from '../domain/errors';

/**
 * Límite de estudiantes del plan de la institución (RF-05). La plataforma lo pasa en
 * STUDENT_LIMIT (Básico 100, Estándar 1000, Avanzado 5000); sin él no hay límite.
 *
 * Se cuentan los estudiantes activos de los módulos vigentes (activos o programados), sin
 * repetir correo: la misma persona en dos módulos cuenta una vez.
 */
@Injectable()
export class StudentLimitService {
  constructor(
    private readonly config: ConfigService,
    private readonly database: DataSource,
  ) {}

  limit(): number | null {
    const value = Number(this.config.get<string>('STUDENT_LIMIT'));
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  private async currentEmails(closingTeacherId?: number): Promise<Set<string>> {
    // El módulo activo del docente que activa uno nuevo se cierra: no cuenta.
    const rows: { email: string }[] = await this.database.query(
      `SELECT DISTINCT lower(s.email) AS email
       FROM students s JOIN modules m ON m.id = s.module_id
       WHERE s.active AND m.status IN ('ACTIVE', 'SCHEDULED')
         AND NOT ($1::int IS NOT NULL AND m.teacher_id = $1::int AND m.is_active)`,
      [closingTeacherId ?? null],
    );
    return new Set(rows.map((row) => row.email));
  }

  async count(): Promise<number> {
    return (await this.currentEmails()).size;
  }

  /** Falla si, con estos estudiantes nuevos, la institución supera el límite de su plan. */
  async ensureRoom(newEmails: string[], closingTeacherId?: number): Promise<void> {
    const max = this.limit();
    if (!max) return;
    const emails = await this.currentEmails(closingTeacherId);
    for (const email of newEmails) emails.add(email.trim().toLowerCase());
    if (emails.size > max) {
      throw new BusinessRuleError(
        `El plan de la institución permite hasta ${max} estudiantes y con este cambio serían ${emails.size}. ` +
          'Da de baja estudiantes de módulos que ya no se usan o pide a la plataforma un plan mayor.',
      );
    }
  }
}
