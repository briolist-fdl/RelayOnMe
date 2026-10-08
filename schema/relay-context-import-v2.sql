-- Explicit provenance ledger for verified legacy-context imports. Not auto-applied.
BEGIN;
CREATE TABLE relay_identity_v2.context_imports (
  provenance TEXT PRIMARY KEY CHECK (provenance ~ '^[0-9a-f]{64}$'),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  FOREIGN KEY (scope_id,event_id) REFERENCES relay_identity_v2.event_contexts(scope_id,event_id)
);
COMMIT;
