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

const webhooks = await targetChannel.fetchWebhooks();
  let webhook = webhooks.find((hook) => hook.name === "RelayOnMe Campfire");

  if (!webhook) {
    webhook = await targetChannel.createWebhook({
      name: "RelayOnMe Campfire",
      reason: "RelayOnMe needs a webhook to mirror Campfire meetup posts",
    });
  }

  const sentMessage = await webhook.send({
  username: "Campfire",
  avatarURL: message.author.displayAvatarURL(),
  content: `📡 Campfire meetup ${parsed.type}`,
  embeds: [message.embeds[0]],
});

await saveRelayMessage({
  meetupUrl: parsed.meetupUrl,
  targetMessageId: sentMessage.id,
  targetChannelId: targetChannel.id,
  sourceMessageId: parsed.sourceMessageId,
  sourceChannelId: parsed.sourceChannelId,
  lastType: parsed.type,
});

const saved = await getRelayMessage(parsed.meetupUrl);

console.log("Saved row:");
console.log(saved);

console.log("Relay saved to database");
}

client.on("messageCreate", async (message) => {
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
});

client.login(process.env.DISCORD_TOKEN);