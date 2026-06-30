require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");

const { initDb } = require("./initDb");
const { parseCampfireMessage } = require("./parsers/campfireParser");
const { relayCampfireMeetup } = require("./adapters/campfireAdapter");
const {
  getRelayConfigBySourceChannel,
  getRelayConfigByGuildAndSourceChannel,
  getRelayConfigsByGuild,
  saveRelayConfig,
  setRelayConfigEnabled,
  deleteRelayConfig,
} = require("./relayConfigStore");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", async () => {
  console.log(`Login success as ${client.user.tag}`);
  console.log("RelayOnMe build: campfire-group-role-2026-06-30");

  try {
    await initDb();
  } catch (error) {
    console.error("Database init failed:", error);
  }
});

function getChannelOption(interaction, name) {
  return interaction.options.getChannel(name);
}

function getRoleOption(interaction, name) {
  return interaction.options.getRole(name);
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

function formatCampfireGroupRole(config) {
  return config.campfire_group_role_id
    ? `<@&${config.campfire_group_role_id}>`
    : "none";
}

function formatRelayConfig(config, index = null) {
  const heading = index === null ? "Relay config" : `${index}. ${config.parser}`;

  return [
    heading,
    `Parser: ${config.parser}`,
    `Source: <#${config.source_channel_id}>`,
    `Target: <#${config.target_channel_id}>`,
    `Campfire group role: ${formatCampfireGroupRole(config)}`,
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
      "Campfire group role: supported",
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
  const groupRole = getRoleOption(interaction, "group_role");

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

  if (groupRole && groupRole.guild.id !== interaction.guildId) {
    await replyEphemeral(interaction, "Group role must belong to this server.");
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
    campfireGroupRoleId: groupRole?.id ?? null,
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
      `Campfire group role: ${formatCampfireGroupRole(savedConfig)}`,
      `Enabled: ${formatEnabled(savedConfig.enabled)}`,
    ].join("\n")
  );

  console.log(
    `Relay config ${action}: guild=${interaction.guildId} parser=${normalizedParser} source=${sourceChannel.id} target=${targetChannel.id} campfire_group_role=${savedConfig.campfire_group_role_id || "none"}`
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
      `Campfire group role: ${formatCampfireGroupRole(config)}`,
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
      `Campfire group role: ${formatCampfireGroupRole(config)}`,
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
      `Campfire group role: ${formatCampfireGroupRole(deletedConfig)}`,
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
