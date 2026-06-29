const { query } = require("./db");

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS relay_messages (
      meetup_url TEXT PRIMARY KEY,
      target_message_id TEXT NOT NULL,
      target_channel_id TEXT NOT NULL,
      source_message_id TEXT,
      source_channel_id TEXT,
      last_type TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("Database initialized");
}

module.exports = { initDb };