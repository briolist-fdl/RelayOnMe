-- Separate reviewed legacy rows from active v2 event ownership.
-- Apply only during an explicit, reviewed schema migration after relay-identity-v2.sql.
BEGIN;
CREATE TABLE relay_identity_v2.legacy_quarantines (
  provenance TEXT PRIMARY KEY CHECK (provenance ~ '^[0-9a-f]{64}$'),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('orphaned_scope', 'historical_duplicate')),
  evidence_ref TEXT NOT NULL CHECK (evidence_ref ~ '^[0-9a-f]{64}$'),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMIT;
