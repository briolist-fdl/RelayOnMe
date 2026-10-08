'use strict';
const text = value => typeof value === 'string' && value.trim().length > 0;
const missing = error => error?.code === 10008;

function createDiscordTransport({ resolveChannel, evidence }) {
  if (typeof resolveChannel !== 'function' || !evidence || typeof evidence.decorate !== 'function' ||
      typeof evidence.verify !== 'function') throw new TypeError('Discord transport needs channel resolver and evidence strategy');
  const abortable = async (signal, work) => {
    if (signal?.aborted) throw Error('Cancelled');
    let listener;
    const cancelled = new Promise((_, reject) => { listener = () => reject(Error('Cancelled')); signal?.addEventListener('abort', listener, { once:true }); });
    try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
    finally { signal?.removeEventListener('abort', listener); }
  };
  const channel = async id => {
    const value = await resolveChannel(id);
    if (!value || value.id !== id || typeof value.send !== 'function' || !value.messages?.fetch) throw Error('Invalid target channel');
    return value;
  };
  const payload = async request => {
    const value = await evidence.decorate({ attemptId:request.attemptId, scopeId:request.scopeId, eventId:request.eventId,
      sourceMessageId:request.sourceMessageId, operation:request.operation,
      targetChannelId:request.targetChannelId, payload:request.payload });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid evidence payload');
    // Adapter owns a strict silent default even if caller payload contains mentions.
    return { ...value, allowedMentions:{ parse:[] } };
  };
  return {
    async send(request) {
      const target = await channel(request.targetChannelId);
      const message = await abortable(request.signal, async () => {
        const outgoing = await payload(request);
        if (request.signal?.aborted) throw Error('Cancelled');
        return target.send(outgoing);
      });
      if (!text(message?.id)) throw Error('Discord send returned no message ID');
      return { messageId:message.id };
    },
    async edit(request) {
      try {
        const target = await channel(request.targetChannelId);
        const current = await abortable(request.signal, () => target.messages.fetch(request.messageId));
        if (!current || current.id !== request.messageId || typeof current.edit !== 'function') throw Error('Invalid target message');
        const message = await abortable(request.signal, async () => {
          const outgoing = await payload(request);
          if (request.signal?.aborted) throw Error('Cancelled');
          return current.edit(outgoing);
        });
        if (message?.id !== request.messageId) throw Error('Discord edit returned changed message ID');
        return { messageId:message.id };
      } catch (error) { if (missing(error)) error.kind='target_missing'; throw error; }
    },
    async inspect(request) {
      try {
        const target = await channel(request.targetChannelId);
        let message;
        if (text(request.previousMessageId)) message = await abortable(request.signal, () => target.messages.fetch(request.previousMessageId));
        else if (typeof evidence.find === 'function') message = await abortable(request.signal, () => evidence.find({ target, ...request }));
        else return { status:'inconclusive' };
        if (!message || !text(message.id)) return { status:'inconclusive' };
        const proof = await evidence.verify({ message, attemptId:request.attemptId, scopeId:request.scopeId,
          eventId:request.eventId, sourceMessageId:request.sourceMessageId,
          operation:request.operation, targetChannelId:request.targetChannelId });
        if (!proof || proof.status !== 'confirmed' || !text(proof.evidenceRef)) return { status:'inconclusive' };
        return { status:'confirmed', messageId:message.id, scopeId:request.scopeId,eventId:request.eventId,
          attemptId:request.attemptId,targetChannelId:request.targetChannelId,evidenceRef:proof.evidenceRef };
      } catch (error) {
        if (missing(error) && request.operation === 'edit' && text(request.previousMessageId)) return {
          status:'missing',messageId:request.previousMessageId,scopeId:request.scopeId,eventId:request.eventId,
          attemptId:request.attemptId,targetChannelId:request.targetChannelId,evidenceRef:'discord:missing:'+request.previousMessageId };
        return { status:'inconclusive' };
      }
    },
  };
}
module.exports={createDiscordTransport};
