require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");

const { maybeAddSupportMessage } = require("./src/shared/supportDevelopment");
const { buildAbout } = require("./src/shared/about");
const { buildRelayDemo } = require("./src/demos/relayDemos");
const { prepareDiscordPost } = require("./src/sources/prepareDiscordPost");
const { relayDiscordPost } = require("./src/relay/relayDiscordPost");
const { compileRelayFilter } = require("./src/sources/matchRelayFilter");
const { compileRelayOutput } = require("./src/output/renderRelayOutput");
const { pool } = require("./db");

const { initDb } = require("./initDb");
const { parseCampfireMessage } = require("./parsers/campfireParser");
const {
  relayCampfireMeetup,
  createCampfireRelayKey,
} = require("./adapters/campfireAdapter");
const {
  getRelayConfigBySourceChannel,
  getRelayConfigByGuildAndSourceChannel,
  getRelayConfigsByGuild,
  saveRelayConfig,
  setRelayConfigEnabled,
  deleteRelayConfig,
  addCampfireCreatorRole,
  deleteCampfireCreatorRole,
  getCampfireCreatorRolesByConfig,
  getCampfireGroupRoleIdsForCreator,
  getCampfireMeetupContext,
  saveCampfireMeetupContext,
} = require("./relayConfigStore");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let databaseReady = false;
client.once("clientReady", async () => {
  console.log(`Login success as ${client.user.tag}`);
  console.log("RelayOnMe build: generic-discord-message-relays");

  try {
    await initDb();
    databaseReady = true;
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

function getUserOption(interaction, name) {
  return interaction.options.getUser(name);
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

async function replySuccess(interaction, content) {
  const contentWithSupport = maybeAddSupportMessage(content);

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      flags: MessageFlags.Ephemeral,
      content: contentWithSupport,
    });
    return;
  }

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: contentWithSupport,
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
    ...(config.parser === 'campfire'
      ? [`Default Campfire group role: ${formatCampfireGroupRole(config)}`]
      : [`Include phrases: ${config.content_filter?.includeKeywords?.length || 0}; exclude phrases: ${config.content_filter?.excludeKeywords?.length || 0}`,
        `Author restriction: ${config.content_filter?.allowedAuthors?.length ? 'yes' : 'no'}`,
        `Output: ${config.output_config?.template && config.output_config.template !== '{original_content}' ? 'custom template' : 'original text'}`]),
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

function formatCampfireCreatorRoleList(rows) {
  if (rows.length === 0) {
    return [
      "No Campfire creator role rules found.",
      "",
      "Create one with:",
      "/relay campfire creator_role_add",
    ].join("\n");
  }

  const lines = ["Campfire creator role rules", ""];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    lines.push(
      [
        `${i + 1}. <@${row.creator_discord_user_id}> → <@&${row.group_role_id}>`,
        `Source: <#${row.source_channel_id}>`,
        `Enabled: ${formatEnabled(row.enabled)}`,
      ].join("\n")
    );

    lines.push("");
  }

  return lines.join("\n").trim();
}

function dedupeIds(ids) {
  return [...new Set((ids || []).filter(Boolean))];
}

async function resolveCampfireGroupRoleIds({ config, parsed, relayKey }) {
  let roleIds = [];

  if (parsed.creatorDiscordUserId) {
    roleIds = await getCampfireGroupRoleIdsForCreator({
      relayConfigId: config.id,
      creatorDiscordUserId: parsed.creatorDiscordUserId,
    });
  }

  if (roleIds.length > 0) {
    roleIds = dedupeIds(roleIds);

    await saveCampfireMeetupContext({
      relayKey,
      relayConfigId: config.id,
      creatorDiscordUserId: parsed.creatorDiscordUserId,
      groupRoleIds: roleIds,
    });

    return roleIds;
  }

  const existingContext = await getCampfireMeetupContext(relayKey);

  if (existingContext?.group_role_ids?.length > 0) {
    return dedupeIds(existingContext.group_role_ids);
  }

  if (config.campfire_group_role_id) {
    roleIds = [config.campfire_group_role_id];

    await saveCampfireMeetupContext({
      relayKey,
      relayConfigId: config.id,
      creatorDiscordUserId: parsed.creatorDiscordUserId,
      groupRoleIds: roleIds,
    });

    return roleIds;
  }

  return [];
}

async function handleRelayStatus(interaction) {
  await replyEphemeral(
    interaction,
    [
      "**RelayOnMe status**",
      "",
      `Storage: ${databaseReady ? "ready" : "initializing or unavailable"}`,
      "Mode: database-config",
      "Commands: grouped-config",
      "Campfire creator roles: supported",
      "Discord message relays: filters, templates and private preview",
      "Direct RSS and inbound webhooks: under development",
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

  if (normalizedParser === 'campfire' && ['include', 'exclude', 'template', 'add_text'].some(name => getStringOption(interaction, name) != null)) {
    await replyEphemeral(interaction, "These filter and output options apply to message relays. Campfire uses the RelayOnMe Campfire add-on.");
    return;
  }

  if (!["campfire", "messages"].includes(normalizedParser)) {
    await replyEphemeral(interaction, `Unsupported parser: ${parser}`);
    return;
  }

  const existingConfig = await getRelayConfigByGuildAndSourceChannel(
    interaction.guildId,
    sourceChannel.id
  );

  if (sourceChannel.id === targetChannel.id) {
    await replyEphemeral(interaction, "Choose different source and target channels.");
    return;
  }
  if (existingConfig && existingConfig.parser !== normalizedParser) {
    await replyEphemeral(interaction, "This source already uses another adapter. Choose a different source to preserve its relay history.");
    return;
  }
  let contentFilter = null, outputConfig = null;
  if (normalizedParser === "messages") {
    if (groupRole) {
      await replyEphemeral(interaction, "The fallback group role is for Campfire. Message relays currently send without notifications.");
      return;
    }
    const phrases = name => (getStringOption(interaction, name) || '').split('|').map(value => value.trim()).filter(Boolean);
    contentFilter = { includeKeywords: phrases('include'), excludeKeywords: phrases('exclude') };
    const author = getUserOption(interaction, 'author');
    if (author) contentFilter.allowedAuthors = [author.id];
    outputConfig = {
      template: getStringOption(interaction, 'template') ?? '{original_content}',
      suffix: getStringOption(interaction, 'add_text') ?? '',
    };
    try { compileRelayFilter(contentFilter); compileRelayOutput(outputConfig); }
    catch {
      await replyEphemeral(interaction, "Invalid filter or output template. Use supported placeholders such as {original_content}, {title}, {summary}, {url} and {author}.");
      return;
    }
    const schema = await pool.query("SELECT to_regclass('relay_identity_v2.source_observations') AS ready");
    if (!schema.rows[0]?.ready) {
      await replyEphemeral(interaction, "Message relays require the v2 delivery schema. Contact the bot operator.");
      return;
    }
    const me = interaction.guild.members.me;
    const sourcePermissions = sourceChannel.permissionsFor(me);
    const targetPermissions = targetChannel.permissionsFor(me);
    if (!sourcePermissions?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]) ||
        !targetPermissions?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory])) {
      await replyEphemeral(interaction, "The bot needs permission to view both channels and read their history, and to send messages in the target.");
      return;
    }
  }

  const savedConfig = await saveRelayConfig({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
    targetChannelId: targetChannel.id,
    parser: normalizedParser,
    enabled: normalizedParser === 'campfire',
    campfireGroupRoleId: groupRole?.id ?? null,
    contentFilter,
    outputConfig,
  });

  const action = existingConfig ? "updated" : "created";

  await replySuccess(
    interaction,
    [
      `Relay ${action}.`,
      "",
      `Parser: ${savedConfig.parser}`,
      `Source: <#${savedConfig.source_channel_id}>`,
      `Target: <#${savedConfig.target_channel_id}>`,
      ...(normalizedParser === 'campfire' ? [`Default Campfire group role: ${formatCampfireGroupRole(savedConfig)}`] : []),
      `Enabled: ${formatEnabled(savedConfig.enabled)}`,
      ...(normalizedParser === 'messages' ? ["Test with /relay preview, then activate with /relay config enable."] : []),
    ].join("\n")
  );

  console.log(
    `Relay config ${action}: guild=${interaction.guildId} parser=${normalizedParser} source=${sourceChannel.id} target=${targetChannel.id} default_campfire_group_role=${savedConfig.campfire_group_role_id || "none"}`
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

  await replySuccess(
    interaction,
    [
      "Relay enabled.",
      "",
      `Source: <#${config.source_channel_id}>`,
      `Target: <#${config.target_channel_id}>`,
      `Parser: ${config.parser}`,
      `Default Campfire group role: ${formatCampfireGroupRole(config)}`,
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

  await replySuccess(
    interaction,
    [
      "Relay disabled.",
      "",
      `Source: <#${config.source_channel_id}>`,
      `Target: <#${config.target_channel_id}>`,
      `Parser: ${config.parser}`,
      `Default Campfire group role: ${formatCampfireGroupRole(config)}`,
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

  await replySuccess(
    interaction,
    [
      "Relay removed.",
      "",
      `Source: <#${deletedConfig.source_channel_id}>`,
      `Target: <#${deletedConfig.target_channel_id}>`,
      `Parser: ${deletedConfig.parser}`,
      `Default Campfire group role: ${formatCampfireGroupRole(deletedConfig)}`,
    ].join("\n")
  );

  console.log(
    `Relay config removed: guild=${interaction.guildId} source=${sourceChannel.id}`
  );
}

async function handleCampfireCreatorRoleAdd(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Campfire rules can only be configured inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");
  const creator = getUserOption(interaction, "creator");
  const groupRole = getRoleOption(interaction, "group_role");

  if (!sourceChannel || !creator || !groupRole) {
    await replyEphemeral(
      interaction,
      [
        "Missing Campfire creator role rule.",
        "",
        "Expected:",
        "- Source channel",
        "- Creator",
        "- Group role",
      ].join("\n")
    );

    return;
  }

  if (sourceChannel.guildId !== interaction.guildId) {
    await replyEphemeral(interaction, "Source channel must belong to this server.");
    return;
  }

  if (groupRole.guild.id !== interaction.guildId) {
    await replyEphemeral(interaction, "Group role must belong to this server.");
    return;
  }

  const savedRule = await addCampfireCreatorRole({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
    creatorDiscordUserId: creator.id,
    groupRoleId: groupRole.id,
  });

  if (!savedRule) {
    await replyEphemeral(
      interaction,
      [
        "No relay config found for this source channel.",
        "",
        "Create one first with:",
        "/relay config add",
        "",
        `Source: <#${sourceChannel.id}>`,
      ].join("\n")
    );

    return;
  }

  await replySuccess(
    interaction,
    [
      "Campfire creator role rule saved.",
      "",
      `Source: <#${sourceChannel.id}>`,
      `Creator: <@${creator.id}>`,
      `Group role: <@&${groupRole.id}>`,
    ].join("\n")
  );

  console.log(
    `Campfire creator role saved: guild=${interaction.guildId} source=${sourceChannel.id} creator=${creator.id} group_role=${groupRole.id}`
  );
}

async function handleCampfireCreatorRoleList(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Campfire rules can only be listed inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");

  if (!sourceChannel) {
    await replyEphemeral(interaction, "Missing source channel.");
    return;
  }

  const rows = await getCampfireCreatorRolesByConfig({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
  });

  await replyEphemeral(interaction, formatCampfireCreatorRoleList(rows));
}

async function handleCampfireCreatorRoleRemove(interaction) {
  if (!interaction.guildId) {
    await replyEphemeral(interaction, "Campfire rules can only be removed inside a server.");
    return;
  }

  const sourceChannel = getChannelOption(interaction, "source_channel");
  const creator = getUserOption(interaction, "creator");
  const groupRole = getRoleOption(interaction, "group_role");
  const confirm = getBooleanOption(interaction, "confirm", false);

  if (!sourceChannel || !creator || !groupRole) {
    await replyEphemeral(interaction, "Missing source channel, creator, or group role.");
    return;
  }

  if (!confirm) {
    await replyEphemeral(
      interaction,
      [
        "Campfire creator role rule was not removed.",
        "",
        "Run the command again with confirm: true to delete the rule.",
        `Source: <#${sourceChannel.id}>`,
        `Creator: <@${creator.id}>`,
        `Group role: <@&${groupRole.id}>`,
      ].join("\n")
    );

    return;
  }

  const deletedRule = await deleteCampfireCreatorRole({
    guildId: interaction.guildId,
    sourceChannelId: sourceChannel.id,
    creatorDiscordUserId: creator.id,
    groupRoleId: groupRole.id,
  });

  if (!deletedRule) {
    await replyEphemeral(
      interaction,
      [
        "No matching Campfire creator role rule found.",
        "",
        `Source: <#${sourceChannel.id}>`,
        `Creator: <@${creator.id}>`,
        `Group role: <@&${groupRole.id}>`,
      ].join("\n")
    );

    return;
  }

  await replySuccess(
    interaction,
    [
      "Campfire creator role rule removed.",
      "",
      `Source: <#${sourceChannel.id}>`,
      `Creator: <@${creator.id}>`,
      `Group role: <@&${groupRole.id}>`,
    ].join("\n")
  );

  console.log(
    `Campfire creator role removed: guild=${interaction.guildId} source=${sourceChannel.id} creator=${creator.id} group_role=${groupRole.id}`
  );
}

client.on("messageCreate", async (message) => {
  try {
    if (!databaseReady) return;
    const config = await getRelayConfigBySourceChannel(message.channel.id);

    if (!config) return;

    if (config.parser === 'messages') {
      const outcome = await relayDiscordPost({ pool, client, message, config });
      console.log(`Message relay outcome: ${outcome.status}`);
      return;
    }

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

    const relayKey = await createCampfireRelayKey(parsed);

    console.log("Relay key:", relayKey);

    const campfireGroupRoleIds = await resolveCampfireGroupRoleIds({
      config,
      parsed,
      relayKey,
    });

    await relayCampfireMeetup(parsed, message, client, config, {
      relayKey,
      campfireGroupRoleIds,
    });
  } catch (error) {
    console.error("messageCreate handler failed:", error);
  }
});

client.on('messageUpdate', async (_, message) => {
  try {
    if (!databaseReady) return;
    if (message.partial) message = await message.fetch();
    const config = await getRelayConfigBySourceChannel(message.channel.id);
    if (config?.parser !== 'messages') return;
    const outcome = await relayDiscordPost({ pool, client, message, config });
    console.log(`Message relay update outcome: ${outcome.status}`);
  } catch (error) {
    console.error('Message relay update failed:', error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "about") {
      const about = buildAbout();
      await interaction.reply({ content: about.content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName !== "relay") return;

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (!group && subcommand === "demo") {
      const example = getStringOption(interaction, "example");
      const template = getStringOption(interaction, "template");
      const addText = getStringOption(interaction, "add_text");
      let preview;
      try {
        preview = buildRelayDemo(example, {
          ...(template == null ? {} : { template }),
          ...(addText == null ? {} : { suffix: addText }),
        });
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
        await interaction.reply({
          content: "That output could not be previewed. Use supported placeholders and keep the result under 1,900 characters. Supported: {title}, {summary}, {url}, {author}, {categories}, {original_content}, {starts}, {ends}, {location}, {role_mentions}.",
          flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.reply({ ...preview, flags: MessageFlags.Ephemeral });
      return;
    }

    if (!group && subcommand === "status") {
      await handleRelayStatus(interaction);
      return;
    }

    if (!databaseReady) {
      await replyEphemeral(interaction, "Storage is initializing or unavailable. Try again shortly.");
      return;
    }

    if (!group && subcommand === "preview") {
      if (!(await requireRelayConfigPermission(interaction))) return;
      const source = getChannelOption(interaction, 'source_channel');
      const config = await getRelayConfigByGuildAndSourceChannel(interaction.guildId, source.id);
      if (!config || config.parser !== 'messages') {
        await replyEphemeral(interaction, "Create a message relay for this source first.");
        return;
      }
      const author = getUserOption(interaction, 'author') || interaction.user;
      const preview = prepareDiscordPost({ content: getStringOption(interaction, 'text'),
        author, embeds: [], url: '' }, config);
      const reasons = {
        excluded_keyword: 'It contains a word excluded by this relay.',
        keyword_not_included: "It doesn't contain a word this relay looks for.",
        author_not_allowed: 'This relay only forwards posts from selected authors.',
        missing_link: 'This relay requires a link.',
        excluded_category: 'Its category is excluded by this relay.',
        category_not_included: "Its category isn't selected for this relay.",
      };
      await interaction.reply({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        embeds: [{ title: preview.status === 'selected' ? 'This would be forwarded'
          : preview.status === 'invalid_output' ? 'The output needs adjusting' : 'This would be skipped',
          description: preview.status === 'selected' ? preview.payload.content
            : preview.status === 'invalid_output' ? 'Check the template and text length.'
            : reasons[preview.reason] || "It doesn't match this relay's filters.",
          footer: { text: 'Preview only.' } }] });
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

    if (group === "campfire") {
      if (!(await requireRelayConfigPermission(interaction))) {
        return;
      }

      if (subcommand === "creator_role_add") {
        await handleCampfireCreatorRoleAdd(interaction);
        return;
      }

      if (subcommand === "creator_role_list") {
        await handleCampfireCreatorRoleList(interaction);
        return;
      }

      if (subcommand === "creator_role_remove") {
        await handleCampfireCreatorRoleRemove(interaction);
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
