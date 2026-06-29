require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./initDb");
const { getRelayMessage, saveRelayMessage } = require("./relayMessageStore");

const CAMPFIRE_BOT_ID = "1224759021609685132";
const WEBHOOK_NAME = "RelayOnMe Campfire";

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

async function relayCampfireMeetup(parsed, message, client) {
  const targetChannel = await client.channels.fetch(process.env.TARGET_CHANNEL_ID);

  if (!targetChannel) {
    console.log("Target channel not found");
    return;
  }

  const webhooks = await targetChannel.fetchWebhooks();
  let webhook = webhooks.find((hook) => hook.name === WEBHOOK_NAME);

  if (!webhook) {
    webhook = await targetChannel.createWebhook({
      name: WEBHOOK_NAME,
      reason: "RelayOnMe needs a webhook to mirror Campfire meetup posts",
    });
  }

  const payload = {
    content: message.content,
    username: "Campfire",
    avatarURL: message.author.displayAvatarURL(),
    embeds: message.embeds,
    components: message.components,
  };

  await relayOrEditMessage({
    webhook,
    relayKey: parsed.meetupUrl,
    payload,
    metadata: {
      targetChannelId: targetChannel.id,
      sourceMessageId: parsed.sourceMessageId,
      sourceChannelId: parsed.sourceChannelId,
      lastType: parsed.type,
    },
  });
}

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
    meetupUrl: relayKey,
    targetMessageId: sentMessage.id,
    targetChannelId: metadata.targetChannelId,
    sourceMessageId: metadata.sourceMessageId,
    sourceChannelId: metadata.sourceChannelId,
    lastType: metadata.lastType,
  });
}

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