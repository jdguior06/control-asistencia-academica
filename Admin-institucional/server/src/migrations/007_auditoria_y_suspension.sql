-- Etapa 6: suspender y reanudar instituciones (apagar y encender sus servidores) y
-- registro de auditoría con datos reales.

ALTER TABLE platform_jobs DROP CONSTRAINT platform_jobs_action_check;
ALTER TABLE platform_jobs ADD CONSTRAINT platform_jobs_action_check
    CHECK (action IN ('create', 'delete', 'suspend', 'resume'));

-- Quién hizo qué, sobre qué y con qué resultado. Solo se agregan filas.
CREATE TABLE platform_audit (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    action TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('started', 'completed', 'pending', 'failed')),
    actor TEXT NOT NULL,          -- nombre o correo de quien lo hizo
    actor_role TEXT NOT NULL,     -- Operador, Sistema, Sitio público...
    resource TEXT NOT NULL,       -- institución o recurso
    reference TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX platform_audit_created_idx ON platform_audit (created_at DESC);
