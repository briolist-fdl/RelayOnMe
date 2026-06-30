const CAMPFIRE_BOT_ID = "1224759021609685132";

function parseCampfireMessage(message) {
  if (message.author.id !== CAMPFIRE_BOT_ID) return null;
  if (message.embeds.length === 0) return null;

  const embed = message.embeds[0];
  const content = message.content || "";

  if (!embed.url || !embed.url.includes("cmpf.re")) return null;

  const fields = {};
  for (const field of embed.fields) {
    fields[field.name] = field.value;
  }

  let type = "unknown";

  if (content.includes("created")) {
    type = "created";
  } else if (content.includes("updated")) {
    type = "updated";
  } else if (content.includes("starting soon")) {
    type = "starting_soon";
  }

  return {
    type,
    sourceMessageId: message.id,
    sourceChannelId: message.channel.id,
    meetupUrl: embed.url,
    title: embed.title || null,
    description: embed.description || null,
    starts: fields["🗓️ Starts"] || null,
    ends: fields["🗓️ Ends"] || null,
    location: fields["📍Location"] || null,
    creatorDiscordUserId: message.mentions.users.first()?.id || null,
    isCommunityAmbassadorHosted: Object.keys(fields).some((fieldName) =>
      fieldName.includes("Hosted by a Community Ambassador")
    ),
  };
}

module.exports = {
  parseCampfireMessage,
};
