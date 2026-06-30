const { pool } = require("./db");

async function getRelayMessage(relayKey) {
  const result = await pool.query(
    `
    SELECT *
    FROM relay_messages
    WHERE relay_key = $1
    LIMIT 1;
    `,
    [relayKey]
  );

  return result.rows[0] || null;
}

async function saveRelayMessage({
  relayKey,
  targetMessageId,
  targetChannelId,
  sourceMessageId,
  sourceChannelId,
  lastType,
}) {
  const result = await pool.query(
    `
    INSERT INTO relay_messages (
      relay_key,
      target_message_id,
      target_channel_id,
      source_message_id,
      source_channel_id,
      last_type,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (relay_key)
    DO UPDATE SET
      target_message_id = EXCLUDED.target_message_id,
      target_channel_id = EXCLUDED.target_channel_id,
      source_message_id = EXCLUDED.source_message_id,
      source_channel_id = EXCLUDED.source_channel_id,
      last_type = EXCLUDED.last_type,
      updated_at = NOW()
    RETURNING *;
    `,
    [
      relayKey,
      targetMessageId,
      targetChannelId,
      sourceMessageId,
      sourceChannelId,
      lastType,
    ]
  );

  return result.rows[0];
}

module.exports = {
  getRelayMessage,
  saveRelayMessage,
};