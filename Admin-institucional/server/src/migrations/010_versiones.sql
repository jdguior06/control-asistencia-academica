-- RF-13: versiones de la app, las plantillas y las herramientas usadas en cada trabajo
-- (las anuncia infra/scripts/aprovisionar.sh con la marca ::versiones::).
ALTER TABLE platform_jobs ADD COLUMN versions JSONB NOT NULL DEFAULT '{}'::jsonb;
