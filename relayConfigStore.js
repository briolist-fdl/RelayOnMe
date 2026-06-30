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
  enabled = true,
}) {
  const result = await pool.query(
    `
    INSERT INTO relay_configs (
      guild_id,
      source_channel_id,
      target_channel_id,
      parser,
      enabled,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (source_channel_id)
    DO UPDATE SET
      guild_id = EXCLUDED.guild_id,
      target_channel_id = EXCLUDED.target_channel_id,
      parser = EXCLUDED.parser,
      enabled = EXCLUDED.enabled,
      updated_at = NOW()
    RETURNING *;
    `,
    [guildId, sourceChannelId, targetChannelId, parser, enabled]
  );

  return result.rows[0];
}

async function seedRelayConfigFromEnv() {
  if (
    !process.env.DISCORD_GUILD_ID ||
    !process.env.SOURCE_CHANNEL_ID ||
    !process.env.TARGET_CHANNEL_ID
  ) {
    console.log("Relay config seed skipped: missing env vars");
    return null;
  }

  return saveRelayConfig({
    guildId: process.env.DISCORD_GUILD_ID,
    sourceChannelId: process.env.SOURCE_CHANNEL_ID,
    targetChannelId: process.env.TARGET_CHANNEL_ID,
    parser: "campfire",
    enabled: true,
  });
}

module.exports = {
  getRelayConfigBySourceChannel,
  saveRelayConfig,
  seedRelayConfigFromEnv,
};