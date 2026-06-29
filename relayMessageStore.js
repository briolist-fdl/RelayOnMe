const { query } = require("./db");

async function getRelayMessage(meetupUrl) {
  const result = await query(
    `
    SELECT *
    FROM relay_messages
    WHERE meetup_url = $1
    `,
    [meetupUrl]
  );

  return result.rows[0] || null;
}

async function saveRelayMessage({
  meetupUrl,
  targetMessageId,
  targetChannelId,
  sourceMessageId,
  sourceChannelId,
  lastType,
}) {
  await query(
    `
    INSERT INTO relay_messages (
      meetup_url,
      target_message_id,
      target_channel_id,
      source_message_id,
      source_channel_id,
      last_type,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (meetup_url)
    DO UPDATE SET
      target_message_id = EXCLUDED.target_message_id,
      target_channel_id = EXCLUDED.target_channel_id,
      source_message_id = EXCLUDED.source_message_id,
      source_channel_id = EXCLUDED.source_channel_id,
      last_type = EXCLUDED.last_type,
      updated_at = NOW()
    `,
    [
      meetupUrl,
      targetMessageId,
      targetChannelId,
      sourceMessageId,
      sourceChannelId,
      lastType,
    ]
  );
}

module.exports = {
  getRelayMessage,
  saveRelayMessage,
};