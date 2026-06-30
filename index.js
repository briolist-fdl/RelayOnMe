require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./initDb");
const { getRelayMessage, saveRelayMessage } = require("./relayMessageStore");
const {
  getRelayConfigBySourceChannel,
  saveRelayConfig,
} = require("./relayConfigStore");

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
  console.log("RelayOnMe build: database-config-only-2026-06-30");

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

async function relayCampfireMeetup(parsed, message, client, config) {
  const targetChannel = await client.channels.fetch(config.target_channel_id);

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
    relayKey,
    targetMessageId: sentMessage.id,
    targetChannelId: metadata.targetChannelId,
    sourceMessageId: metadata.sourceMessageId,
    sourceChannelId: metadata.sourceChannelId,
    lastType: metadata.lastType,
  });
}

function getStringOption(interaction, names) {
  for (const name of names) {
    const value = interaction.options.getString(name);
    if (value) return value;
  }

  return null;
}

function getChannelOption(interaction, names) {
  for (const name of names) {
    const value = interaction.options.getChannel(name);
    if (value) return value;
  }

  return null;
}

async function replyEphemeral(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      ephemeral: true,
      content,
    });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    content,
  });
}

client.on("messageCreate", async (message) => {
  try {
    const config = await getRelayConfigBySourceChannel(message.channel.id);

    if (!config) return;

    console.log(
      `MESSAGE: ${message.author.tag} | ${message.channel.id} | ${message.content}`
    );

    if (config.parser !== "campfire") {
      console.log(`Unsupported parser: ${config.parser}`);
      return;
    }

    const parsed = parseCampfireMessage(message);

    if (!parsed) {
      console.log("Ignored source message");
      return;
    }

    console.log("PARSED CAMPFIRE MEETUP");
    console.log(parsed);

    await relayCampfireMeetup(parsed, message, client, config);
  } catch (error) {
    console.error("messageCreate handler failed:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "relay") return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "status") {
      await replyEphemeral(
        interaction,
        [
          "**RelayOnMe status**",
          "",
          "Storage: connected",
          "Mode: database-config",
        ].join("\n")
      );

      return;
    }

    if (subcommand === "add") {
      if (!interaction.guildId) {
        await replyEphemeral(interaction, "Relay can only be configured inside a server.");
        return;
      }

      const parser = getStringOption(interaction, ["parser"]);
      const sourceChannel = getChannelOption(interaction, [
        "source_channel",
        "source",
        "source-channel",
      ]);
      const targetChannel = getChannelOption(interaction, [
        "target_channel",
        "target",
        "target-channel",
      ]);

      if (!parser || !sourceChannel || !targetChannel) {
        await replyEphemeral(
          interaction,
          [
            "Missing relay config.",
            "",
            "Expected:",
            "- Parser",
            "- Source channel",
            "- Target channel",
          ].join("\n")
        );

        return;
      }

      const normalizedParser = parser.toLowerCase();

      if (normalizedParser !== "campfire") {
        await replyEphemeral(
          interaction,
          `Unsupported parser: ${parser}`
        );

        return;
      }

      await saveRelayConfig({
        guildId: interaction.guildId,
        sourceChannelId: sourceChannel.id,
        targetChannelId: targetChannel.id,
        parser: normalizedParser,
        enabled: true,
      });

      await replyEphemeral(
        interaction,
        [
          "Relay created.",
          "",
          `Parser: ${normalizedParser}`,
          `Source: <#${sourceChannel.id}>`,
          `Target: <#${targetChannel.id}>`,
        ].join("\n")
      );

      console.log(
        `Relay config saved: guild=${interaction.guildId} parser=${normalizedParser} source=${sourceChannel.id} target=${targetChannel.id}`
      );

      return;
    }

    await replyEphemeral(interaction, `Unknown relay subcommand: ${subcommand}`);
  } catch (error) {
    console.error("interactionCreate handler failed:", error);

    if (interaction.isRepliable()) {
      await replyEphemeral(interaction, "RelayOnMe command failed. Check logs.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);