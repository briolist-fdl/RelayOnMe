'use strict';

const { resolveRelayEvent } = require('./resolveRelayEvent');
const { deliverRelay } = require('./deliverRelay');

const text = value => typeof value === 'string' && value.trim().length > 0;

// Provider-neutral orchestration. An add-on is responsible for producing a
// normalized notice and payload; this core never imports a provider parser.
function createRelayProcessor({ pool, transport, resolveEvent = resolveRelayEvent, deliver = deliverRelay } = {}) {
  if (!pool || typeof pool.connect !== 'function' || !transport ||
      typeof transport.send !== 'function' || typeof transport.edit !== 'function' ||
      typeof resolveEvent !== 'function' || typeof deliver !== 'function')
    throw new TypeError('Relay processor needs a pool, transport and core operations');
  return Object.freeze({
    async process(notice) {
      if (!notice || !text(notice.scopeId) || !text(notice.guildId) ||
          !text(notice.sourceMessageId) || !Number.isSafeInteger(notice.sourceRevision) ||
          typeof notice.sourceFingerprint !== 'string' || !notice.payload ||
          typeof notice.payload !== 'object' || Array.isArray(notice.payload))
        throw new TypeError('Invalid relay notice');
      const identity = await resolveEvent(pool, notice);
      if (!['existing_event', 'new_event'].includes(identity.status)) return identity;
      const delivery = await deliver(pool, {
        scopeId: identity.scopeId, guildId: notice.guildId, eventId: identity.eventId,
        sourceMessageId: notice.sourceMessageId, sourceRevision: notice.sourceRevision,
        sourceFingerprint: notice.sourceFingerprint, payload: notice.payload, transport,
        ...(notice.timeoutMs == null ? {} : { timeoutMs: notice.timeoutMs }),
      });
      return { ...delivery, identityStatus: identity.status, eventId: identity.eventId };
    },
  });
}

module.exports = { createRelayProcessor };
