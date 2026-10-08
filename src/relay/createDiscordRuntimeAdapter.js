'use strict';
const { createDiscordEvidence } = require('./createDiscordEvidence');
const { createDiscordTransport } = require('./createDiscordTransport');

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);

// Wiring only. This factory does not log in, register commands, migrate data or
// enable a scope. Call it after clientReady when an explicit v2 runtime is ready.
function createDiscordRuntimeAdapter({ client, maxScanMessages = 1000 } = {}) {
  if (!client?.channels || typeof client.channels.fetch !== 'function' ||
      !snowflake(client.user?.id))
    throw new TypeError('Discord runtime adapter requires a ready client');
  const evidence = createDiscordEvidence({ botUserId: client.user.id, maxScanMessages });
  const transport = createDiscordTransport({
    resolveChannel: channelId => client.channels.fetch(channelId), evidence,
  });
  return Object.freeze({ transport, evidence });
}

module.exports = { createDiscordRuntimeAdapter };
