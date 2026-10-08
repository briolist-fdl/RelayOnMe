-- Offline schema proposal, not connected to initDb and not applied by this project.
-- Intentionally fail if this schema already exists; do not conceal schema drift.
BEGIN;
CREATE SCHEMA relay_identity_v2;

CREATE TABLE relay_identity_v2.scopes (
  scope_id TEXT PRIMARY KEY CHECK (length(btrim(scope_id)) > 0),
  relay_config_id INTEGER NOT NULL CHECK (relay_config_id > 0),
  guild_id TEXT NOT NULL CHECK (length(btrim(guild_id)) > 0),
  source_channel_id TEXT NOT NULL CHECK (length(btrim(source_channel_id)) > 0),
  target_channel_id TEXT NOT NULL CHECK (length(btrim(target_channel_id)) > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  migration_ready BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (relay_config_id, target_channel_id),
  UNIQUE (scope_id, target_channel_id)
  -- No FK to legacy relay_configs: deleting a legacy config must not erase history.
);

CREATE TABLE relay_identity_v2.events (
  scope_id TEXT NOT NULL REFERENCES relay_identity_v2.scopes(scope_id),
  event_id TEXT NOT NULL CHECK (length(btrim(event_id)) > 0),
  PRIMARY KEY (scope_id, event_id)
);

CREATE TABLE relay_identity_v2.aliases (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  alias_type TEXT NOT NULL CHECK (alias_type IN ('meetup_id', 'meetup_url')),
  alias_value TEXT NOT NULL CHECK (length(btrim(alias_value)) > 0),
  PRIMARY KEY (scope_id, alias_type, alias_value),
  FOREIGN KEY (scope_id, event_id) REFERENCES relay_identity_v2.events(scope_id, event_id),
  CHECK (alias_type <> 'meetup_id' OR alias_value ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
CREATE UNIQUE INDEX one_meetup_id_per_event
  ON relay_identity_v2.aliases(scope_id, event_id) WHERE alias_type = 'meetup_id';

CREATE TABLE relay_identity_v2.deliveries (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  target_channel_id TEXT NOT NULL,
  target_message_id TEXT CHECK (length(btrim(target_message_id)) > 0),
  source_message_id TEXT CHECK (length(btrim(source_message_id)) > 0),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered', 'uncertain')),
  PRIMARY KEY (scope_id, event_id),
  UNIQUE (target_channel_id, target_message_id),
  FOREIGN KEY (scope_id, event_id) REFERENCES relay_identity_v2.events(scope_id, event_id),
  FOREIGN KEY (scope_id, target_channel_id)
    REFERENCES relay_identity_v2.scopes(scope_id, target_channel_id),
  CHECK (delivery_state <> 'delivered' OR target_message_id IS NOT NULL)
);

CREATE TABLE relay_identity_v2.imports (
  provenance TEXT PRIMARY KEY CHECK (provenance ~ '^[0-9a-f]{64}$'),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  FOREIGN KEY (scope_id, event_id) REFERENCES relay_identity_v2.events(scope_id, event_id)
);
-- Roles, observation persistence, send intents and replacement history are separate
-- subsequent work. This schema alone is not a usable delivery engine.
COMMIT;
