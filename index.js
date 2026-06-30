require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");

const { initDb } = require("./initDb");
const { getRelayMessage, saveRelayMessage } = require("./relayMessageStore");
const {
  getRelayConfigBySourceChannel,
  getRelayConfigByGuildAndSourceChannel,
  getRelayConfigsByGuild,
  saveRelayConfig,
  setRelayConfigEnabled,
  deleteRelayConfig,
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
  console.log("RelayOnMe build: relay-config-permission-guard-2026-06-30");

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

function extractCampfireMeetupId(urlString) {
  if (!urlString) return null;

  try {
    const url = new URL(urlString);

    const pathMatch = url.pathname.match(/\/discover\/meetup\/([^/?#]+)/i);
    if (pathMatch?.[1]) {
      return pathMatch[1];
    }

    const possibleQueryParams = [
      "meetupId",
      "meetup_id",
      "meetup",
      "eventId",
      "event_id",
      "id",
    ];

    for (const param of possibleQueryParams) {
      const value = url.searchParams.get(param);
      if (value) return value;
    }

    const uuidMatch = urlString.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );

    return uuidMatch?.[0] || null;
  } catch {
    return null;
  }
}

async function fetchRedirectLocation(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "RelayOnMe/1.0",
      },
    });

    return response.headers.get("location");
  } finally {
    clearTimeout(timeout);
  }
}

async function getRedirectLocation(url) {
  try {
    const headLocation = await fetchRedirectLocation(url, "HEAD");
    if (headLocation) return headLocation;
  } catch (error) {
    console.warn("Campfire HEAD redirect lookup failed:", error.message);
  }

  try {
    const getLocation = await fetchRedirectLocation(url, "GET");
    if (getLocation) return getLocation;
  } catch (error) {
    console.warn("Campfire GET redirect lookup failed:", error.message);
  }

  return null;
}

async function resolveFinalUrl(startUrl, maxRedirects = 8) {
  let currentUrl = startUrl;

  for (let i = 0; i < maxRedirects; i += 1) {
    const existingMeetupId = extractCampfireMeetupId(currentUrl);

    if (existingMeetupId) {
      return currentUrl;
    }

    const location = await getRedirectLocation(currentUrl);

    if (!location) {
      return currentUrl;
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  return currentUrl;
}

function normalizeRelayKeyPart(value) {
  return String(value || "unknown")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function createCampfireFallbackRelayKey(parsed) {
  const sourceChannelId = normalizeRelayKeyPart(parsed.sourceChannelId);
  const title = normalizeRelayKeyPart(parsed.title);
  const starts = normalizeRelayKeyPart(parsed.starts);
  const location = normalizeRelayKeyPart(parsed.location);

  return `campfire:fallback:${sourceChannelId}:${title}:${starts}:${location}`;
}

async function createCampfireRelayKey(parsed) {
  const directMeetupId = extractCampfireMeetupId(parsed.meetupUrl);

  if (directMeetupId) {
    return `campfire:meetup:${directMeetupId}`;
  }

  try {
    const finalUrl = await resolveFinalUrl(parsed.meetupUrl);
    const resolvedMeetupId = extractCampfireMeetupId(finalUrl);

    if (resolvedMeetupId) {
      console.log("Resolved Campfire meetup ID:", resolvedMeetupId);
      return `campfire:meetup:${resolvedMeetupId}`;
    }

    console.warn("Could not resolve stable Campfire meetup ID. Using fallback key.");
    console.warn("Campfire URL:", parsed.meetupUrl);
    console.warn("Resolved URL:", finalUrl);
  } catch (error) {
    console.warn("Campfire relay key resolution failed:", error.message);
  }

  return createCampfireFallbackRelayKey(parsed);
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

  const relayKey = await createCampfireRelayKey(parsed);

  console.log("Relay key:", relayKey);

  await relayOrEditMessage({
    webhook,
    relayKey,
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

function getChannelOption(interaction, name) {
  return interaction.options.getChannel(name);
}

function getStringOption(interaction, name) {
  return interaction.options.getString(name);
}

function getBooleanOption(interaction, name, fallback = false) {
  return interaction.options.getBoolean(name) ?? fallback;
}

async function replyEphemeral(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      flags: MessageFlags.Ephemeral,
      content,
    });
    return;
  }

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content,
  });
}

function memberHasRelayAdminRole(interaction) {
  const relayAdminRoleId = process.env.RELAY_ADMIN_ROLE_ID;

  if (!relayAdminRoleId) {
    return false;
  }

  const memberRoles = interaction.member?.roles;

  if (!memberRoles) {
    return false;
  }

  if (Array.isArray(memberRoles)) {
    return memberRoles.includes(relayAdminRoleId);
  }

  if (memberRoles.cache?.has(relayAdminRoleId)) {
    return true;
  }

  if (typeof memberRoles.has === "function") {
    return memberRoles.has(relayAdminRoleId);
  }

  return false;
}

function userCanManageRelayConfig(interaction) {
  if (!interaction.inGuild()) {
    return false;
  }

  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    return true;
  }

  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    return true;
  }

  return memberHasRelayAdminRole(interaction);
}

async function requireRelayConfigPermission(interaction) {
  if (userCanManageRelayConfig(interaction)) {
    return true;
  }

  await replyEphemeral(
    interaction,
    [
      "You do not have permission to manage relay configs.",
      "",
      "Required:",
      "- Administrator",
      "- Manage Server",
      "- or configured Relay admin role",
    ].join("\n")
  );

  return false;
}


function formatEnabled(value) {
  return value ? "yes" : "no";
}

function formatRelayConfig(config, index = null) {
  const heading = index === null ? "Relay config" : `${index}. ${config.parser}`;

  return [
    heading,
    `Parser: ${config.parser}`,
    `Source: <#${config.source_channel_id}>`,
    `Target: <#${config.target_channel_id}>`,
    `Enabled: ${formatEnabled(config.enabled)}`,
  ].join("\n");
}

function formatRelayConfigList(configs) {
  if (configs.length === 0) {
    return [
      "No relay configurations found.",
      "",
      "Create one with:",
      "/relay config add",
    ].join("\n");
  }

  const maxItems = 20;
  const visibleConfigs = configs.slice(0, maxItems);

  const lines = ["Relay configurations", ""];

  for (let i = 0; i < visibleConfigs.length; i += 1) {
    lines.push(formatRelayConfig(visibleConfigs[i], i + 1));
    lines.push("");
  }

  if (configs.length > maxItems) {
    lines.push(`Showing ${maxItems} of ${configs.length} relay configurations.`);
  }

  return lines.join("\n").trim();
}

async function handleRelayStatus(interaction) {
  await replyEphemeral(
    interaction,
    [
      "**RelayOnMe status**",
      "",
      "Storage: connected",
      "Mode: database-config",
      "Commands: grouped-config",
    ].join("\n")
  );
}

async function handleRelayConfigAdd(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Relay can only be configured inside a server.");
    return;
  }

  const parser = getStringOption(interaction, "parser");
  const sourceChannel = getChannelOption(interaction, "source_channel");
  const targetChannel = getChannelOption(interaction, "target_channel");

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

  if (sourceChannel.guildId !== interaction.guildId) {
    await replyEphemeral(interaction, "Source channel must belong to this server.");
    return;
  }

  if (targetChannel.guildId !== interaction.guildId) {
    await replyEphemeral(interaction, "Target channel must belong to this server.");
    return;
  }

  const normalizedParser = parser.toLowerCase();

  if (normalizedParser !== "campfire") {
    await replyEphemeral(interaction, `Unsupported parser: ${parser}`);
    return;
  }

  const existingConfig = await getRelayConfigByGuildAndSourceChannel(
    interaction.guildId,
    sourceChannel.id
  );

  const savedConfig = await saveRelayConfig({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
    targetChannelId: targetChannel.id,
    parser: normalizedParser,
    enabled: true,
  });

  const action = existingConfig ? "updated" : "created";

  await replyEphemeral(
    interaction,
    [
      `Relay ${action}.`,
      "",
      `Parser: ${savedConfig.parser}`,
      `Source: <#${savedConfig.source_channel_id}>`,
      `Target: <#${savedConfig.target_channel_id}>`,
      `Enabled: ${formatEnabled(savedConfig.enabled)}`,
    ].join("\n")
  );

  console.log(
    `Relay config ${action}: guild=${interaction.guildId} parser=${normalizedParser} source=${sourceChannel.id} target=${targetChannel.id}`
  );
}

async function handleRelayConfigList(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Relay configs can only be listed inside a server.");
    return;
  }

  const includeDisabled = getBooleanOption(interaction, "include_disabled", false);
  const configs = await getRelayConfigsByGuild(interaction.guildId, includeDisabled);

  await replyEphemeral(interaction, formatRelayConfigList(configs));
}

async function handleRelayConfigInfo(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Relay config can only be inspected inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");

  if (!sourceChannel) {
    await replyEphemeral(interaction, "Missing source channel.");
    return;
  }

  const config = await getRelayConfigByGuildAndSourceChannel(
    interaction.guildId,
    sourceChannel.id
  );

  if (!config) {
    await replyEphemeral(
      interaction,
      [
        "No relay config found for this source channel.",
        "",
        `Source: <#${sourceChannel.id}>`,
      ].join("\n")
    );

    return;
  }

  await replyEphemeral(interaction, formatRelayConfig(config));
}

async function handleRelayConfigEnable(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Relay config can only be enabled inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");

  if (!sourceChannel) {
    await replyEphemeral(interaction, "Missing source channel.");
    return;
  }

  const config = await setRelayConfigEnabled({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
    enabled: true,
  });

  if (!config) {
    await replyEphemeral(
      interaction,
      [
        "No relay config found for this source channel.",
        "",
        `Source: <#${sourceChannel.id}>`,
      ].join("\n")
    );

    return;
  }

  await replyEphemeral(
    interaction,
    [
      "Relay enabled.",
      "",
      `Source: <#${config.source_channel_id}>`,
      `Target: <#${config.target_channel_id}>`,
      `Parser: ${config.parser}`,
    ].join("\n")
  );

  console.log(
    `Relay config enabled: guild=${interaction.guildId} source=${sourceChannel.id}`
  );
}

async function handleRelayConfigDisable(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Relay config can only be disabled inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");

  if (!sourceChannel) {
    await replyEphemeral(interaction, "Missing source channel.");
    return;
  }

  const config = await setRelayConfigEnabled({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
    enabled: false,
  });

  if (!config) {
    await replyEphemeral(
      interaction,
      [
        "No relay config found for this source channel.",
        "",
        `Source: <#${sourceChannel.id}>`,
      ].join("\n")
    );

    return;
  }

  await replyEphemeral(
    interaction,
    [
      "Relay disabled.",
      "",
      `Source: <#${config.source_channel_id}>`,
      `Target: <#${config.target_channel_id}>`,
      `Parser: ${config.parser}`,
    ].join("\n")
  );

  console.log(
    `Relay config disabled: guild=${interaction.guildId} source=${sourceChannel.id}`
  );
}

async function handleRelayConfigRemove(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Relay config can only be removed inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");
  const confirm = getBooleanOption(interaction, "confirm", false);

  if (!sourceChannel) {
    await replyEphemeral(interaction, "Missing source channel.");
    return;
  }

  if (!confirm) {
    await replyEphemeral(
      interaction,
      [
        "Relay was not removed.",
        "",
        "Run the command again with confirm: true to delete the config.",
        `Source: <#${sourceChannel.id}>`,
      ].join("\n")
    );

    return;
  }

  const deletedConfig = await deleteRelayConfig({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
  });

  if (!deletedConfig) {
    await replyEphemeral(
      interaction,
      [
        "No relay config found for this source channel.",
        "",
        `Source: <#${sourceChannel.id}>`,
      ].join("\n")
    );

    return;
  }

  await replyEphemeral(
    interaction,
    [
      "Relay removed.",
      "",
      `Source: <#${deletedConfig.source_channel_id}>`,
      `Target: <#${deletedConfig.target_channel_id}>`,
      `Parser: ${deletedConfig.parser}`,
    ].join("\n")
  );

  console.log(
    `Relay config removed: guild=${interaction.guildId} source=${sourceChannel.id}`
  );
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

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (!group && subcommand === "status") {
      await handleRelayStatus(interaction);
      return;
    }

    if (group === "config") {
      if (!(await requireRelayConfigPermission(interaction))) {
        return;
      }

      if (subcommand === "add") {
        await handleRelayConfigAdd(interaction);
        return;
      }

      if (subcommand === "list") {
        await handleRelayConfigList(interaction);
        return;
      }

      if (subcommand === "info") {
        await handleRelayConfigInfo(interaction);
        return;
      }

      if (subcommand === "enable") {
        await handleRelayConfigEnable(interaction);
        return;
      }

      if (subcommand === "disable") {
        await handleRelayConfigDisable(interaction);
        return;
      }

      if (subcommand === "remove") {
        await handleRelayConfigRemove(interaction);
        return;
      }
    }

    await replyEphemeral(
      interaction,
      `Unknown relay command: ${group ? `${group} ` : ""}${subcommand}`
    );
  } catch (error) {
    console.error("interactionCreate handler failed:", error);

    if (interaction.isRepliable()) {
      await replyEphemeral(interaction, "RelayOnMe command failed. Check logs.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
