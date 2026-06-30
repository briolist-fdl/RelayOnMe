const { pool } = require("./db");

async function getRelayConfigBySourceChannel(sourceChannelId) {
  const result = await pool.query(
    `
    SELECT *
    FROM relay_configs
    WHERE source_channel_id = $1
      AND enabled = TRUE
    LIMIT 1;
    `,
    [sourceChannelId]
  );

  return result.rows[0] || null;
}

async function saveRelayConfig({
  guildId,
  sourceChannelId,
  targetChannelId,
  parser,
}) {
  const result = await pool.query(
    `
    INSERT INTO relay_configs (
      guild_id,
      source_channel_id,
      target_channel_id,
      parser,
      updated_at
    )
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (source_channel_id)
    DO UPDATE SET
      guild_id = EXCLUDED.guild_id,
      target_channel_id = EXCLUDED.target_channel_id,
      parser = EXCLUDED.parser,
      enabled = TRUE,
      updated_at = NOW()
    RETURNING *;
    `,
    [
      guildId,
      sourceChannelId,
      targetChannelId,
      parser,
    ]
  );

  return result.rows[0];
}

module.exports = {
  getRelayConfigBySourceChannel,
  saveRelayConfig,
};