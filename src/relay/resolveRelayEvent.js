'use strict';

const { resolveIdentity } = require('../identity/resolveIdentity');

const text = value => typeof value === 'string' && value.trim().length > 0;
const fingerprint = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function validInput(input) {
  return input && text(input.scopeId) && text(input.guildId) && text(input.sourceMessageId) &&
    Number.isSafeInteger(input.sourceRevision) && input.sourceRevision >= 0 &&
    fingerprint(input.sourceFingerprint) && text(input.meetupUrl) &&
    Array.isArray(input.redirectChain);
}

// Generic identity persistence. The caller supplies only adapter-normalized source
// evidence; no provider parser, rendering, Discord object or network request lives here.
async function resolveRelayEvent(pool, input) {
  if (!pool || typeof pool.connect !== 'function' || !validInput(input))
    throw new TypeError('Invalid relay identity request');
  let client;
  let began = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN'); began = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['relay-identity:' + input.scopeId]);
    const scope = (await client.query(`SELECT scope_id,guild_id,source_channel_id,state,migration_ready
      FROM relay_identity_v2.scopes WHERE scope_id=$1 FOR UPDATE`, [input.scopeId])).rows[0];
    async function stop(result) { await client.query('ROLLBACK'); began = false; return result; }
    if (!scope || scope.guild_id !== input.guildId || scope.state !== 'active')
      return await stop({ status: 'invalid_scope' });
    const [events, aliases, observations] = await Promise.all([
      client.query('SELECT event_id FROM relay_identity_v2.events WHERE scope_id=$1', [scope.scope_id]),
      client.query('SELECT event_id,alias_type,alias_value FROM relay_identity_v2.aliases WHERE scope_id=$1', [scope.scope_id]),
      client.query(`SELECT event_id,source_message_id FROM relay_identity_v2.source_observations
        WHERE scope_id=$1 AND source_message_id=$2`, [scope.scope_id, input.sourceMessageId]),
    ]);
    const decision = resolveIdentity({
      scope: { id: scope.scope_id, sourceChannelId: scope.source_channel_id, enabled: true },
      observation: { sourceChannelId: scope.source_channel_id, sourceMessageId: input.sourceMessageId,
        meetupUrl: input.meetupUrl },
      redirectChain: input.redirectChain, policy: input.urlPolicy,
      events: events.rows.map(row => ({ scopeId: scope.scope_id, id: row.event_id })),
      aliases: aliases.rows.map(row => ({ scopeId: scope.scope_id, eventId: row.event_id,
        type: row.alias_type, value: row.alias_value })),
      observations: observations.rows.map(row => ({ scopeId: scope.scope_id,
        sourceChannelId: scope.source_channel_id, sourceMessageId: row.source_message_id,
        eventId: row.event_id })),
      migrationReady: scope.migration_ready === true,
    });
    if (!['existing_event', 'new_event'].includes(decision.status)) return await stop(decision);
    const eventId = decision.eventId || decision.aliasesToAdd.find(alias => alias.type === 'meetup_id')?.value;
    if (!text(eventId)) return await stop({ status: 'pending_identity' });
    if (decision.status === 'new_event') {
      await client.query('INSERT INTO relay_identity_v2.events (scope_id,event_id) VALUES ($1,$2)',
        [scope.scope_id, eventId]);
    }
    for (const alias of decision.aliasesToAdd) {
      await client.query(`INSERT INTO relay_identity_v2.aliases (scope_id,event_id,alias_type,alias_value)
        VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,alias_type,alias_value) DO NOTHING`,
      [scope.scope_id, eventId, alias.type, alias.value]);
    }
    await client.query('COMMIT'); began = false;
    return { status: decision.status, scopeId: scope.scope_id, eventId,
      aliasesAdded: decision.aliasesToAdd.length };
  } catch {
    if (began) { try { await client.query('ROLLBACK'); } catch {} }
    return { status: 'identity_unavailable' };
  } finally { if (client) client.release(true); }
}

module.exports = { resolveRelayEvent, validInput };
