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

async function getPrimaryKey(tableName) {
  const result = await pool.query(
    `
    SELECT
      tc.constraint_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = $1
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position;
    `,
    [tableName]
  );

  if (result.rowCount === 0) return null;

  return {
    constraintName: result.rows[0].constraint_name,
    columns: result.rows.map((row) => row.column_name),
  };
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

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS target_message_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS target_channel_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS source_message_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS source_channel_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS last_type TEXT;
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE relay_messages
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  const hasMeetupUrl = await columnExists("relay_messages", "meetup_url");

  if (hasMeetupUrl) {
    await pool.query(`
      UPDATE relay_messages
      SET relay_key = meetup_url
      WHERE relay_key IS NULL
        AND meetup_url IS NOT NULL;
    `);

    const primaryKey = await getPrimaryKey("relay_messages");

    if (
      primaryKey &&
      primaryKey.columns.includes("meetup_url") &&
      !primaryKey.columns.includes("relay_key")
    ) {
      await pool.query(`
        ALTER TABLE relay_messages
        DROP CONSTRAINT ${primaryKey.constraintName};
      `);
    }

    await pool.query(`
      ALTER TABLE relay_messages
      ALTER COLUMN meetup_url DROP NOT NULL;
    `);
  }

  await pool.query(`
    UPDATE relay_messages
    SET relay_key = CONCAT('legacy:', target_channel_id, ':', target_message_id)
    WHERE relay_key IS NULL
      AND target_channel_id IS NOT NULL
      AND target_message_id IS NOT NULL;
  `);

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
      campfire_group_role_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE relay_configs
    ADD COLUMN IF NOT EXISTS campfire_group_role_id TEXT;
  `);

  console.log("Database initialized");
}

module.exports = { initDb };
