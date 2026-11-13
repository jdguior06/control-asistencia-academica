-- La cuenta de AWS está en el plan gratuito: solo admite algunos tipos de instancia
-- (t3.micro, t3.small, c7i-flex.large, m7i-flex.large...). Los planes predefinidos usan
-- esos tipos; todos tienen 2 vCPU y se distinguen por la memoria y el disco.
-- Debe coincidir con infra/tenant/terraform/locales.tf.
UPDATE platform_plan_instances AS i
SET vcpu = v.vcpu,
    ram_gib = v.ram_gib,
    system_disk_gb = v.disco,
    aws_type = v.aws_type
FROM (VALUES
    ('basico', 'frontend', 2, 1, 20, 't3.micro'),
    ('basico', 'backend', 2, 2, 20, 't3.small'),
    ('basico', 'database', 2, 2, 20, 't3.small'),
    ('estandar', 'frontend', 2, 2, 30, 't3.small'),
    ('estandar', 'backend', 2, 4, 30, 'c7i-flex.large'),
    ('estandar', 'database', 2, 4, 30, 'c7i-flex.large'),
    ('avanzado', 'frontend', 2, 2, 40, 't3.small'),
    ('avanzado', 'backend', 2, 8, 40, 'm7i-flex.large'),
    ('avanzado', 'database', 2, 8, 40, 'm7i-flex.large')
) AS v (plan_id, role, vcpu, ram_gib, disco, aws_type)
WHERE i.plan_id = v.plan_id
  AND i.role = v.role;
