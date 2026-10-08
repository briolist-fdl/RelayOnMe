'use strict';
const { createHash } = require('node:crypto');

const text = value => typeof value === 'string' && value.length > 0;
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const markerPrefix = '\n-# RelayOnMe ref: ';

function createDiscordEvidence({ botUserId, maxScanMessages = 1000 } = {}) {
  if (!snowflake(botUserId) || !Number.isInteger(maxScanMessages) ||
      maxScanMessages < 1 || maxScanMessages > 5000)
    throw new TypeError('Discord evidence requires a bot user ID and bounded scan');
  const marker = ({ attemptId, scopeId, eventId, sourceMessageId, operation,
    targetChannelId }) => {
    if (![attemptId, scopeId, eventId, sourceMessageId, operation, targetChannelId].every(text))
      throw new TypeError('Incomplete Discord evidence binding');
    const digest = createHash('sha256').update(JSON.stringify(['relayonme-discord-attempt-v1',
      attemptId, scopeId, eventId, sourceMessageId, operation, targetChannelId])).digest('hex');
    return markerPrefix + digest.slice(0, 32);
  };
  const verify = async ({ message, ...binding }) => {
    if (!message || message.author?.id !== botUserId || message.webhookId ||
        !snowflake(message.id) ||
        (message.channelId || message.channel?.id) !== binding.targetChannelId ||
        typeof message.content !== 'string') return { status: 'inconclusive' };
    const expected = marker(binding);
    if (!message.content.endsWith(expected)) return { status: 'inconclusive' };
    return { status: 'confirmed', evidenceRef: `discord:marker:${message.id}:${expected.slice(-32)}` };
  };
  return {
    async decorate({ payload, ...binding }) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          (payload.content != null && typeof payload.content !== 'string'))
        throw new TypeError('Discord evidence requires an object payload with string content');
      const content = payload.content || '';
      if (content.includes(markerPrefix)) throw new TypeError('Payload already contains an evidence marker');
      const next = content + marker(binding);
      if (next.length > 2000) throw new RangeError('Discord content cannot fit evidence marker');
      return { ...payload, content: next };
    },
    verify,
    async find({ target, signal, ...binding }) {
      if (!target?.messages || typeof target.messages.fetch !== 'function')
        throw new TypeError('Discord target cannot search messages');
      let before;
      let remaining = maxScanMessages;
      while (remaining > 0) {
        if (signal?.aborted) return null;
        const limit = Math.min(100, remaining);
        const page = await target.messages.fetch({ limit, cache: false,
          ...(before ? { before } : {}) });
        const messages = Array.isArray(page) ? page : [...(page?.values?.() || [])];
        if (!messages.length) return null;
        for (const message of messages) {
          if ((await verify({ message, ...binding })).status === 'confirmed') return message;
        }
        const ids = messages.map(message => message.id).filter(snowflake);
        if (ids.length !== messages.length) return null;
        before = ids.reduce((oldest, id) => BigInt(id) < BigInt(oldest) ? id : oldest);
        remaining -= messages.length;
        if (messages.length < limit) return null;
      }
      return null; // A bounded search never proves absence.
    },
  };
}

module.exports = { createDiscordEvidence };
