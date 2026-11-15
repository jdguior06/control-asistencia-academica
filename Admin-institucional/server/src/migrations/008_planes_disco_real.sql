-- RF-02: el catálogo muestra los recursos reales. La base de datos de cada tenant vive en
-- el disco del servidor "base" (infra/tenant/terraform/locales.tf): 20, 30 y 40 GB.
UPDATE platform_plans AS p
SET database_gb = v.disco
FROM (VALUES ('basico', 20), ('estandar', 30), ('avanzado', 40)) AS v (plan_id, disco)
WHERE p.id = v.plan_id;
