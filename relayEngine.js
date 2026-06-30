const { getRelayMessage, saveRelayMessage } = require("./relayMessageStore");

async function relayOrEditMessage({ webhook, relayKey, payload, metadata }) {
  const existing = await getRelayMessage(relayKey);

  let sentMessage;

  if (existing?.target_message_id) {
    try {
      sentMessage = await webhook.editMessage(existing.target_message_id, payload);

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
  }

  sentMessage = await webhook.send(payload);

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
