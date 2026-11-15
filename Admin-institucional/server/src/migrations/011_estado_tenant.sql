-- Estado de los servicios para el administrador del tenant: su app consulta al portal con
-- la clave de vinculación de la instalación. Se guarda solo su hash (sha256).
ALTER TABLE platform_tenants ADD COLUMN status_key_hash TEXT;
