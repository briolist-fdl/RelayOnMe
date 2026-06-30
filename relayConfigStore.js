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

async function addCampfireCreatorRole({
  guildId,
  sourceChannelId,
  creatorDiscordUserId,
  groupRoleId,
}) {
  const config = await getRelayConfigByGuildAndSourceChannel(
    guildId,
    sourceChannelId
  );

  if (!config) return null;

  const result = await pool.query(
    `
    INSERT INTO relay_campfire_creator_roles (
      relay_config_id,
      creator_discord_user_id,
      group_role_id,
      enabled,
      updated_at
    )
    VALUES ($1, $2, $3, TRUE, NOW())
    ON CONFLICT (relay_config_id, creator_discord_user_id, group_role_id)
    DO UPDATE SET
      enabled = TRUE,
      updated_at = NOW()
    RETURNING *;
    `,
    [config.id, creatorDiscordUserId, groupRoleId]
  );

  return result.rows[0];
}

async function deleteCampfireCreatorRole({
  guildId,
  sourceChannelId,
  creatorDiscordUserId,
  groupRoleId,
}) {
  const config = await getRelayConfigByGuildAndSourceChannel(
    guildId,
    sourceChannelId
  );

  if (!config) return null;

  const result = await pool.query(
    `
    DELETE FROM relay_campfire_creator_roles
    WHERE relay_config_id = $1
      AND creator_discord_user_id = $2
      AND group_role_id = $3
    RETURNING *;
    `,
    [config.id, creatorDiscordUserId, groupRoleId]
  );

  return result.rows[0] || null;
}

async function getCampfireCreatorRolesByConfig({ guildId, sourceChannelId }) {
  const result = await pool.query(
    `
    SELECT
      r.*,
      c.guild_id,
      c.source_channel_id,
      c.target_channel_id,
      c.parser
    FROM relay_campfire_creator_roles r
    JOIN relay_configs c
      ON c.id = r.relay_config_id
    WHERE c.guild_id = $1
      AND c.source_channel_id = $2
    ORDER BY r.creator_discord_user_id ASC, r.group_role_id ASC;
    `,
    [guildId, sourceChannelId]
  );

  return result.rows;
}

async function getCampfireGroupRoleIdsForCreator({
  relayConfigId,
  creatorDiscordUserId,
}) {
  if (!creatorDiscordUserId) return [];

  const result = await pool.query(
    `
    SELECT group_role_id
    FROM relay_campfire_creator_roles
    WHERE relay_config_id = $1
      AND creator_discord_user_id = $2
      AND enabled = TRUE
    ORDER BY group_role_id ASC;
    `,
    [relayConfigId, creatorDiscordUserId]
  );

  return result.rows.map((row) => row.group_role_id);
}

async function getCampfireMeetupContext(relayKey) {
  const result = await pool.query(
    `
    SELECT *
    FROM relay_campfire_meetup_context
    WHERE relay_key = $1
    LIMIT 1;
    `,
    [relayKey]
  );

  return result.rows[0] || null;
}

async function saveCampfireMeetupContext({
  relayKey,
  relayConfigId,
  creatorDiscordUserId,
  groupRoleIds,
}) {
  const roleIds = [...new Set((groupRoleIds || []).filter(Boolean))];

  const result = await pool.query(
    `
    INSERT INTO relay_campfire_meetup_context (
      relay_key,
      relay_config_id,
      creator_discord_user_id,
      group_role_ids,
      updated_at
    )
    VALUES ($1, $2, $3, $4::JSONB, NOW())
    ON CONFLICT (relay_key)
    DO UPDATE SET
      relay_config_id = EXCLUDED.relay_config_id,
      creator_discord_user_id = COALESCE(
        EXCLUDED.creator_discord_user_id,
        relay_campfire_meetup_context.creator_discord_user_id
      ),
      group_role_ids = CASE
        WHEN jsonb_array_length(EXCLUDED.group_role_ids) > 0
        THEN EXCLUDED.group_role_ids
        ELSE relay_campfire_meetup_context.group_role_ids
      END,
      updated_at = NOW()
    RETURNING *;
    `,
    [
      relayKey,
      relayConfigId,
      creatorDiscordUserId || null,
      JSON.stringify(roleIds),
    ]
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
  getRelayConfigByGuildAndSourceChannel,
  getRelayConfigsByGuild,
  saveRelayConfig,
  setRelayConfigEnabled,
  deleteRelayConfig,
  addCampfireCreatorRole,
  deleteCampfireCreatorRole,
  getCampfireCreatorRolesByConfig,
  getCampfireGroupRoleIdsForCreator,
  getCampfireMeetupContext,
  saveCampfireMeetupContext,
  seedRelayConfigFromEnv,
};
