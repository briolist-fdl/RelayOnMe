const { getRelayMessage, saveRelayMessage } = require("./relayMessageStore");

const NO_ALLOWED_MENTIONS = {
  parse: [],
};

function withAllowedMentions(payload, allowedMentions) {
  return {
    ...payload,
    allowedMentions: allowedMentions || NO_ALLOWED_MENTIONS,
  };
}

async function relayOrEditMessage({
  webhook,
  relayKey,
  payload,
  metadata,
  createAllowedMentions = NO_ALLOWED_MENTIONS,
  editAllowedMentions = NO_ALLOWED_MENTIONS,
}) {
  const existing = await getRelayMessage(relayKey);

  let sentMessage;

  if (existing?.target_message_id) {
    const editPayload = withAllowedMentions(payload, editAllowedMentions);

    try {
      sentMessage = await webhook.editMessage(existing.target_message_id, editPayload);

      await saveRelayMetadata({
        relayKey,
        sentMessage,
        metadata,
      });

      console.log("Relay message edited:", sentMessage.id);
      return sentMessage;
    } catch (error) {
      if (error.code !== 10008) {
        console.error("Failed to edit relay message:", error);
        throw error;
      }

      console.warn("Relay target message was deleted. Posting new relay message.");
    }

    sentMessage = await webhook.send(editPayload);

    await saveRelayMetadata({
      relayKey,
      sentMessage,
      metadata,
    });

    console.log("Relay message posted:", sentMessage.id);
    return sentMessage;
  }

  const createPayload = withAllowedMentions(payload, createAllowedMentions);

  sentMessage = await webhook.send(createPayload);

  await saveRelayMetadata({
    relayKey,
    sentMessage,
    metadata,
  });

  console.log("Relay message posted:", sentMessage.id);
  return sentMessage;
}

async function saveRelayMetadata({ relayKey, sentMessage, metadata }) {
  await saveRelayMessage({
    relayKey,
    targetMessageId: sentMessage.id,
    targetChannelId: metadata.targetChannelId,
    sourceMessageId: metadata.sourceMessageId,
    sourceChannelId: metadata.sourceChannelId,
    lastType: metadata.lastType,
  });
}

module.exports = {
  relayOrEditMessage,
};
