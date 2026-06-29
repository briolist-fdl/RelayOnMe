require("dotenv").config();


require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./initDb");
const { getRelayMessage, saveRelayMessage } = require("./relayMessageStore");


const client = new Client({
  intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
],
});

client.once("clientReady", async () => {
  console.log(`Login success as ${client.user.tag}`);
  console.log("RelayOnMe build: message-debug-2026-06-29");
  console.log("SOURCE_CHANNEL_ID:", process.env.SOURCE_CHANNEL_ID);
  console.log("TARGET_CHANNEL_ID:", process.env.TARGET_CHANNEL_ID);
  try {
    await initDb();
  } catch (error) {
    console.error("Database init failed:", error);
  }
});

function parseCampfireMessage(message) {
  const CAMPFIRE_BOT_ID = "1224759021609685132";

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

  const creatorDiscordUserId = message.mentions.users.first()?.id || null;

  const isCommunityAmbassadorHosted = Object.keys(fields).some((fieldName) =>
    fieldName.includes("Hosted by a Community Ambassador")
  );

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

    creatorDiscordUserId,
    isCommunityAmbassadorHosted,
  };
}

async function relayCampfireMeetup(parsed, message, client) {
  const targetChannel = await client.channels.fetch(process.env.TARGET_CHANNEL_ID);

  if (!targetChannel) {
    console.log("Target channel not found");
    return;
  }

async function relayOrEditMessage({
  webhook,
  parsed,
  sourceMessage,
  targetChannelId,
}) {
  const existing = await getRelayMessage(parsed.meetupUrl);

const payload = {
  content: sourceMessage.content,
  username: "Campfire",
  avatarURL: sourceMessage.author.displayAvatarURL(),
  embeds: sourceMessage.embeds,
  components: sourceMessage.components,
};

  let sentMessage;

  if (existing?.target_message_id) {
    try {
      sentMessage = await webhook.editMessage(existing.target_message_id, payload);

      await saveRelayMessage({
        meetupUrl: parsed.meetupUrl,
        targetMessageId: sentMessage.id,
        targetChannelId,
        sourceMessageId: parsed.sourceMessageId,
        sourceChannelId: parsed.sourceChannelId,
        lastType: parsed.type,
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

  await saveRelayMessage({
    meetupUrl: parsed.meetupUrl,
    targetMessageId: sentMessage.id,
    targetChannelId,
    sourceMessageId: parsed.sourceMessageId,
    sourceChannelId: parsed.sourceChannelId,
    lastType: parsed.type,
  });

  console.log("Relay message posted:", sentMessage.id);
  return sentMessage;
}

const webhooks = await targetChannel.fetchWebhooks();
  let webhook = webhooks.find((hook) => hook.name === "RelayOnMe Campfire");

  if (!webhook) {
    webhook = await targetChannel.createWebhook({
      name: "RelayOnMe Campfire",
      reason: "RelayOnMe needs a webhook to mirror Campfire meetup posts",
    });
  }

await relayOrEditMessage({
  webhook,
  parsed,
  sourceMessage: message,
  targetChannelId: targetChannel.id,
});

client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== process.env.SOURCE_CHANNEL_ID) return;

    console.log(
      `MESSAGE: ${message.author.tag} | ${message.channel.id} | ${message.content}`
    );

    const parsed = parseCampfireMessage(message);

    if (!parsed) {
      console.log("Ignored source message");
      return;
    }

    console.log("PARSED CAMPFIRE MEETUP");
    console.log(parsed);

    await relayCampfireMeetup(parsed, message, client);
  } catch (error) {
    console.error("messageCreate handler failed:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);