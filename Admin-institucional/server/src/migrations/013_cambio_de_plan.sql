-- RF-06: cambiar el plan de un tenant. El trabajo vuelve a aplicar el motor con el plan
-- nuevo. Se guarda el disco actual de los servidores: un disco no se puede achicar y con
-- CloudFormation cambiarlo reemplazaría el servidor.
ALTER TABLE platform_jobs DROP CONSTRAINT platform_jobs_action_check;
ALTER TABLE platform_jobs ADD CONSTRAINT platform_jobs_action_check
    CHECK (action IN ('create', 'delete', 'suspend', 'resume', 'backup', 'restore', 'change_plan'));
ALTER TABLE platform_tenants ADD COLUMN disk_gb SMALLINT;

-- Tenants que ya existen: el disco de su plan.
UPDATE platform_tenants t SET disk_gb = i.system_disk_gb
FROM platform_requests r, platform_plan_instances i
WHERE r.id = t.request_id AND i.plan_id = r.plan_id AND i.role = 'database';
