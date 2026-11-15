-- RF-29: alertas de Grafana recibidas por el portal, con su tenant y hora de detección.
CREATE TABLE platform_alerts (
    id BIGSERIAL PRIMARY KEY,
    fingerprint TEXT NOT NULL,          -- identifica la alerta en Grafana (regla + etiquetas)
    rule TEXT NOT NULL,                 -- nombre de la regla
    tenant TEXT,                        -- slug; NULL si es de la plataforma
    server TEXT,
    environment TEXT,
    severity TEXT,
    summary TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
    started_at TIMESTAMPTZ NOT NULL,    -- hora de detección
    resolved_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    email_status TEXT,                  -- enviado, error, sin-smtp, sin-destinatarios
    UNIQUE (fingerprint, started_at)
);

CREATE INDEX platform_alerts_recent_idx ON platform_alerts (status, started_at DESC);
