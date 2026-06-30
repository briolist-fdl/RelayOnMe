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

async function getRelayConfigByGuildAndSourceChannel(guildId, sourceChannelId) {
  const result = await pool.query(
    `
    SELECT *
    FROM relay_configs
    WHERE guild_id = $1
      AND source_channel_id = $2
    LIMIT 1;
    `,
    [guildId, sourceChannelId]
  );

  return result.rows[0] || null;
}

async function getRelayConfigsByGuild(guildId, includeDisabled = false) {
  const result = await pool.query(
    `
    SELECT *
    FROM relay_configs
    WHERE guild_id = $1
      AND ($2::BOOLEAN = TRUE OR enabled = TRUE)
    ORDER BY enabled DESC, parser ASC, source_channel_id ASC;
    `,
    [guildId, includeDisabled]
  );

  return result.rows;
}

async function saveRelayConfig({
  guildId,
  sourceChannelId,
  targetChannelId,
  parser,
  enabled = true,
  campfireGroupRoleId = null,
}) {
  const result = await pool.query(
    `
    INSERT INTO relay_configs (
      guild_id,
      source_channel_id,
      target_channel_id,
      parser,
      enabled,
      campfire_group_role_id,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (source_channel_id)
    DO UPDATE SET
      guild_id = EXCLUDED.guild_id,
      target_channel_id = EXCLUDED.target_channel_id,
      parser = EXCLUDED.parser,
      enabled = EXCLUDED.enabled,
      campfire_group_role_id = COALESCE(
        EXCLUDED.campfire_group_role_id,
        relay_configs.campfire_group_role_id
      ),
      updated_at = NOW()
    RETURNING *;
    `,
    [guildId, sourceChannelId, targetChannelId, parser, enabled, campfireGroupRoleId]
  );

  return result.rows[0];
}

async function setRelayConfigEnabled({ guildId, sourceChannelId, enabled }) {
  const result = await pool.query(
    `
    UPDATE relay_configs
    SET enabled = $3,
        updated_at = NOW()
    WHERE guild_id = $1
      AND source_channel_id = $2
    RETURNING *;
    `,
    [guildId, sourceChannelId, enabled]
  );

  return result.rows[0] || null;
}

async function deleteRelayConfig({ guildId, sourceChannelId }) {
  const result = await pool.query(
    `
    DELETE FROM relay_configs
    WHERE guild_id = $1
      AND source_channel_id = $2
    RETURNING *;
    `,
    [guildId, sourceChannelId]
  );

  return result.rows[0] || null;
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
  getRelayConfigByGuildAndSourceChannel,
  getRelayConfigsByGuild,
  saveRelayConfig,
  setRelayConfigEnabled,
  deleteRelayConfig,
  seedRelayConfigFromEnv,
};
