'use strict';
const { prepareDiscordPost } = require('../sources/prepareDiscordPost');
const { createSourceObservation } = require('./createSourceObservation');
const { deliverRelay } = require('./deliverRelay');
const { createDiscordRuntimeAdapter } = require('./createDiscordRuntimeAdapter');

async function relayDiscordPost({ pool, client, message, config }) {
  if (!message.guildId || message.guildId !== config.guild_id || message.channelId !== config.source_channel_id ||
      config.parser !== 'messages' || !config.enabled || message.author?.id === client.user.id)
    return { status: 'ignored' };
  // Our own bot-owned webhooks include the legacy Campfire output.
  if (message.webhookId) {
    const webhook = await message.fetchWebhook();
    if (webhook.owner?.id === client.user.id) return { status: 'ignored' };
  }
  const prepared = prepareDiscordPost(message, config);
  if (prepared.status !== 'selected') return prepared;
  const scopeId = `discord-config:${config.id}:${config.target_channel_id}`;
  const eventId = `discord-message:${message.id}`;
  const observation = createSourceObservation({ sourceMessageId: message.id,
    sourceRevision: message.editedTimestamp || message.createdTimestamp,
    payload: { content: message.content || '', embeds: (message.embeds || []).map(embed => embed.toJSON()) } });
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const fresh = (await connection.query(`SELECT * FROM public.relay_configs WHERE id=$1 FOR SHARE`, [config.id])).rows[0];
    if (!fresh?.enabled || fresh.parser !== 'messages' || fresh.guild_id !== message.guildId ||
        fresh.source_channel_id !== message.channelId || fresh.target_channel_id !== config.target_channel_id ||
        JSON.stringify(fresh.content_filter) !== JSON.stringify(config.content_filter) ||
        JSON.stringify(fresh.output_config) !== JSON.stringify(config.output_config)) {
      await connection.query('ROLLBACK');
      return { status: 'config_changed' };
    }
    await connection.query(`INSERT INTO relay_identity_v2.scopes
      (scope_id,relay_config_id,guild_id,source_channel_id,target_channel_id,state,migration_ready)
      VALUES ($1,$2,$3,$4,$5,'active',TRUE) ON CONFLICT (scope_id) DO NOTHING`,
      [scopeId, config.id, message.guildId, message.channelId, config.target_channel_id]);
    await connection.query(`INSERT INTO relay_identity_v2.events (scope_id,event_id) VALUES ($1,$2)
      ON CONFLICT (scope_id,event_id) DO NOTHING`, [scopeId, eventId]);
    await connection.query('COMMIT');
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch {}
    throw error;
  } finally { connection.release(); }
  const { transport } = createDiscordRuntimeAdapter({ client });
  return deliverRelay(pool, { scopeId, guildId: message.guildId, eventId, ...observation,
    payload: prepared.payload, transport });
}
module.exports = { relayDiscordPost };
