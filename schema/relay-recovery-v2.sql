-- Explicit extension for auditable reconciliation and replacement, not auto-applied.
BEGIN;
ALTER TABLE relay_identity_v2.delivery_attempts
  DROP CONSTRAINT delivery_attempts_operation_check,
  ADD CONSTRAINT delivery_attempts_operation_check CHECK (operation IN ('create','edit','replace')),
  DROP CONSTRAINT delivery_attempts_state_check,
  ADD CONSTRAINT delivery_attempts_state_check CHECK (state IN ('started','succeeded','uncertain','target_missing','superseded')),
  DROP CONSTRAINT delivery_attempts_scope_id_event_id_source_message_id_key,
  ADD CONSTRAINT delivery_attempts_source_operation_key UNIQUE (scope_id,event_id,source_message_id,operation),
  ADD CONSTRAINT delivery_attempts_scoped_id_key UNIQUE (scope_id,event_id,attempt_id),
  ADD COLUMN supersedes_attempt_id TEXT UNIQUE,
  ADD COLUMN resolution_ref TEXT,
  ADD CONSTRAINT replacement_parent_same_event FOREIGN KEY (scope_id,event_id,supersedes_attempt_id)
    REFERENCES relay_identity_v2.delivery_attempts(scope_id,event_id,attempt_id),
  ADD CONSTRAINT replacement_has_parent CHECK ((operation = 'replace') = (supersedes_attempt_id IS NOT NULL));
COMMIT;
