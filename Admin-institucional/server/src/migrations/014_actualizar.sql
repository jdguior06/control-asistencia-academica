-- RF-15: actualizar un tenant (plantillas de infraestructura y aplicación al último commit,
-- y opcionalmente los parches de seguridad del sistema).
ALTER TABLE platform_jobs DROP CONSTRAINT platform_jobs_action_check;
ALTER TABLE platform_jobs ADD CONSTRAINT platform_jobs_action_check
    CHECK (action IN ('create', 'delete', 'suspend', 'resume', 'backup', 'restore', 'change_plan', 'update'));

-- Última versión disponible en el repositorio y qué cambió para cada tenant desde su último
-- despliegue. La escribe el worker (que tiene la copia del repositorio) cada pocos minutos
-- o cuando el portal la pide (requested_at) al abrir "Actualizar".
CREATE TABLE platform_repo (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    data JSONB NOT NULL DEFAULT '{}',
    checked_at TIMESTAMPTZ,
    requested_at TIMESTAMPTZ
);
INSERT INTO platform_repo (id) VALUES (true);
