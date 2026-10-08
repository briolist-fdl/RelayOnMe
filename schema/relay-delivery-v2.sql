-- Explicit extension; no automatic runtime migration.
BEGIN;
CREATE TABLE relay_identity_v2.delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL CHECK (length(btrim(source_message_id)) > 0),
  operation TEXT NOT NULL CHECK (operation IN ('create','edit')),
  previous_message_id TEXT,
  result_message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('started','succeeded','uncertain','target_missing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_id,event_id,source_message_id),
  FOREIGN KEY (scope_id,event_id) REFERENCES relay_identity_v2.events(scope_id,event_id),
  CHECK (state <> 'succeeded' OR result_message_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_unresolved_delivery_per_event ON relay_identity_v2.delivery_attempts(scope_id,event_id)
  WHERE state IN ('started','uncertain','target_missing');
COMMIT;
