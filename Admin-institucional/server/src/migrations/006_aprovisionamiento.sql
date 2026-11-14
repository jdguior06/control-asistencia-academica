-- Aprovisionamiento desde el portal: cada institución tiene su red (10.N.0.0/16) y
-- cada creación o eliminación de su infraestructura es un trabajo que ejecuta el
-- worker (src/worker.js) con infra/scripts/aprovisionar.sh.

-- Número de red del tenant: 10.<network_number>.0.0/16 (la plataforma usa el 0).
ALTER TABLE platform_tenants
    ADD COLUMN network_number SMALLINT UNIQUE CHECK (network_number BETWEEN 1 AND 250);

CREATE TABLE platform_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    -- Pasos que anuncia el script: [{ "number": 1, "title": "...", "status": "running|ok|warning|error", "summary": "..." }]
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    log TEXT NOT NULL DEFAULT '',
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

-- Un solo trabajo activo por institución.
CREATE UNIQUE INDEX platform_jobs_one_active_idx ON platform_jobs (tenant_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX platform_jobs_queue_idx ON platform_jobs (created_at) WHERE status = 'queued';
CREATE INDEX platform_jobs_tenant_idx ON platform_jobs (tenant_id, created_at DESC);
