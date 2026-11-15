-- RF-19: respaldar y restaurar la base de cada tenant (pg_dump en S3), manual o programado
-- según el plan. Y alertas recibidas durante un trabajo de la plataforma (sin correo).
ALTER TABLE platform_jobs DROP CONSTRAINT platform_jobs_action_check;
ALTER TABLE platform_jobs ADD CONSTRAINT platform_jobs_action_check
    CHECK (action IN ('create', 'delete', 'suspend', 'resume', 'backup', 'restore'));
ALTER TABLE platform_jobs ADD COLUMN params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE platform_jobs ADD COLUMN requested_by TEXT;

CREATE TABLE platform_backups (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
    job_id UUID REFERENCES platform_jobs(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL UNIQUE,     -- tenants/<slug>/<fecha>.dump
    bucket TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'programado')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ             -- borrado por la retención del plan
);
CREATE INDEX platform_backups_tenant_idx ON platform_backups (tenant_id, created_at DESC);

ALTER TABLE platform_alerts ADD COLUMN during_job BOOLEAN NOT NULL DEFAULT false;
