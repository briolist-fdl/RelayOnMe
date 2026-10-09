'use strict';
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { relayDiscordPost } = require('../src/relay/relayDiscordPost');

async function exerciseDiscordMessageRelay(database) {
  const pool = new Pool(database);
  const guild = '77777777777777777', source = '88888888888888888', target = '99999999999999999';
  const posts = new Map();
  let sends = 0, edits = 0;
  const client = { user: { id: '66666666666666666' }, channels: { fetch: async id => ({ id,
    messages: { fetch: async messageId => posts.get(messageId) },
    send: async payload => {
      const post = { id: String(55555555555555555n + BigInt(sends++)), content: payload.content,
        async edit(next) { edits++; this.content = next.content; return this; } };
      posts.set(post.id, post); return post;
    },
  }) } };
  try {
    await pool.query(`ALTER TABLE public.relay_configs
      ADD COLUMN IF NOT EXISTS content_filter JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS output_config JSONB NOT NULL DEFAULT '{}';`);
    const config = (await pool.query(`INSERT INTO public.relay_configs
      (id,guild_id,source_channel_id,target_channel_id,parser,enabled,content_filter,output_config)
      VALUES (1001,$1,$2,$3,'messages',TRUE,'{"includeKeywords":["release"]}','{"template":"{original_content}"}') RETURNING *`,
      [guild, source, target])).rows[0];
    const message = { guildId: guild, channelId: source, id: '44444444444444444',
      author: { id: '33333333333333333' }, content: 'New release', embeds: [], createdTimestamp: 1000 };
    const run = msg => relayDiscordPost({ pool, client, config, message: msg });
    assert.equal((await run(message)).status, 'created');
    assert.equal((await run(message)).status, 'already_processed');
    assert.equal(sends, 1);
    assert.equal((await run({ ...message, content: 'Updated release notes', editedTimestamp: 1001 })).status, 'edited');
    assert.equal(edits, 1);
    assert.equal(sends, 1);
    assert.equal((await run(message)).status, 'stale_observation');
    assert.equal((await run({ ...message, id: '44444444444444445', content: 'An unrelated update' })).status, 'filtered');
    await pool.query('UPDATE public.relay_configs SET enabled=FALSE WHERE id=1001');
    assert.equal((await run({ ...message, id: '44444444444444446' })).status, 'config_changed');
    assert.equal(sends, 1);
    return ['discord-post-delivered-with-durable-evidence', 'duplicate-discord-event-does-not-send',
      'discord-edit-keeps-the-original-target', 'old-discord-event-does-not-overwrite',
      'filtered-discord-post-never-dispatches', 'disabled-config-rechecked-before-dispatch'];
  } finally { await pool.end(); }
}
module.exports = { exerciseDiscordMessageRelay };
