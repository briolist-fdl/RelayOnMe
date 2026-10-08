-- Explicit extension to the tested identity schema. No automatic application.
BEGIN;
CREATE TABLE relay_identity_v2.event_contexts (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  creator_namespace TEXT,
  creator_id TEXT,
  creator_source_ref TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (scope_id, event_id),
  FOREIGN KEY (scope_id, event_id) REFERENCES relay_identity_v2.events(scope_id, event_id),
  CHECK ((creator_namespace IS NULL AND creator_id IS NULL AND creator_source_ref IS NULL) OR
    (creator_namespace IS NOT NULL AND creator_id IS NOT NULL AND creator_source_ref IS NOT NULL AND
     length(btrim(creator_namespace)) > 0 AND length(btrim(creator_id)) > 0 AND length(btrim(creator_source_ref)) > 0))
);
CREATE TABLE relay_identity_v2.event_context_roles (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  role_id TEXT NOT NULL CHECK (length(btrim(role_id)) > 0),
  PRIMARY KEY (scope_id, event_id, role_id),
  FOREIGN KEY (scope_id, event_id) REFERENCES relay_identity_v2.event_contexts(scope_id, event_id)
);
COMMIT;
