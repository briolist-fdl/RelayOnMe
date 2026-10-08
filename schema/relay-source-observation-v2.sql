-- Explicit extension for ordered, immutable source observations. Not auto-applied.
BEGIN;
ALTER TABLE relay_identity_v2.delivery_attempts
  ADD COLUMN source_revision BIGINT,
  ADD COLUMN source_fingerprint TEXT,
  ADD CONSTRAINT delivery_attempts_source_revision_check CHECK (source_revision IS NULL OR source_revision >= 0),
  ADD CONSTRAINT delivery_attempts_source_fingerprint_check CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE relay_identity_v2.deliveries
  ADD COLUMN source_revision BIGINT,
  ADD COLUMN source_fingerprint TEXT,
  ADD CONSTRAINT deliveries_source_revision_check CHECK (source_revision IS NULL OR source_revision >= 0),
  ADD CONSTRAINT deliveries_source_fingerprint_check CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$');
CREATE TABLE relay_identity_v2.source_observations (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  source_message_id TEXT NOT NULL CHECK (length(btrim(source_message_id)) > 0),
  source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_id,event_id,source_revision),
  UNIQUE (scope_id,event_id,attempt_id),
  FOREIGN KEY (scope_id,event_id) REFERENCES relay_identity_v2.events(scope_id,event_id),
  FOREIGN KEY (scope_id,event_id,attempt_id) REFERENCES relay_identity_v2.delivery_attempts(scope_id,event_id,attempt_id)
);
CREATE INDEX source_observations_latest ON relay_identity_v2.source_observations(scope_id,event_id,source_revision DESC);
COMMIT;
