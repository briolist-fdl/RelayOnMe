const { pool } = require("./db");

async function columnExists(tableName, columnName) {
  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = $1
      AND column_name = $2
    LIMIT 1;
    `,
    [tableName, columnName]
  );

  return result.rowCount > 0;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relay_messages (
      relay_key TEXT PRIMARY KEY,
      target_message_id TEXT NOT NULL,
      target_channel_id TEXT NOT NULL,
      source_message_id TEXT,
      source_channel_id TEXT,
      last_type TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS relay_key TEXT;
  `);

  const hasMeetupUrl = await columnExists("relay_messages", "meetup_url");

  if (hasMeetupUrl) {
    await pool.query(`
      UPDATE relay_messages
      SET relay_key = meetup_url
      WHERE relay_key IS NULL
        AND meetup_url IS NOT NULL;
    `);
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS relay_messages_relay_key_idx
    ON relay_messages (relay_key);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS relay_configs (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL UNIQUE,
      target_channel_id TEXT NOT NULL,
      parser TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("Database initialized");
}

module.exports = { initDb };