require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  ApplicationIntegrationType,
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN");
}

if (!clientId) {
  throw new Error("Missing DISCORD_CLIENT_ID or CLIENT_ID");
}


const relayCommand = new SlashCommandBuilder()
  .setName("relay")
  .setDescription("Configure RelayOnMe message relays.")

  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Show RelayOnMe runtime and storage status.")
  )

  .addSubcommand((subcommand) =>
    subcommand
      .setName("demo")
      .setDescription("Preview selective relays and custom output privately.")
      .addStringOption((option) =>
        option.setName("example").setDescription("Choose a sample use case.").setRequired(true)
          .addChoices(
            { name: "Community news (RSS)", value: "news" },
            { name: "Remote job openings (RSS)", value: "jobs" },
            { name: "Stable releases (webhook)", value: "releases" },
            { name: "Local community events", value: "events" }
          )
      )
      .addStringOption((option) =>
        option.setName("template").setDescription("Optional output: {title}, {summary}, {url}, {author}, {categories}.")
          .setMaxLength(1500)
      )
      .addStringOption((option) =>
        option.setName("add_text").setDescription("Optional Markdown text block after the output.")
          .setMaxLength(500)
      )
  )

  .addSubcommand((subcommand) => subcommand
    .setName('preview').setDescription('Privately test a configured message relay with sample text.')
    .addChannelOption((option) => option.setName('source_channel').setDescription('Configured message source.').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((option) => option.setName('text').setDescription('Sample post to test against your filter and output.').setRequired(true).setMaxLength(1500))
    .addUserOption((option) => option.setName('author').setDescription('Optional sample author, especially for bot-only relays.'))
  )
  .addSubcommandGroup((group) =>
    group
      .setName("config")
      .setDescription("Manage relay configurations.")

      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Create or update a relay from one channel to another.")
          .addStringOption((option) =>
            option
              .setName("parser")
              .setDescription("Which parser should process messages from the source channel?")
              .setRequired(true)
              .addChoices({
                name: "Campfire",
                value: "campfire",
              }, {
                name: "Discord messages (filtered)",
                value: "messages",
              })
          )
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Channel RelayOnMe should watch for source messages.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
          .addChannelOption((option) =>
            option
              .setName("target_channel")
              .setDescription("Channel RelayOnMe should relay messages into.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
          .addRoleOption((option) =>
            option
              .setName("group_role")
              .setDescription("Fallback role to mention if no creator-specific Campfire rule matches.")
              .setRequired(false)
          )
          .addStringOption((option) => option.setName('include').setDescription('Messages: match any phrase; separate phrases with |.').setMaxLength(500))
          .addStringOption((option) => option.setName('exclude').setDescription('Messages: skip any matching phrase; separate with |.').setMaxLength(500))
          .addUserOption((option) => option.setName('author').setDescription('Messages: accept only this user or bot.'))
          .addStringOption((option) => option.setName('template').setDescription('Messages: output template, e.g. **{title}** or {original_content}.').setMaxLength(1500))
          .addStringOption((option) => option.setName('add_text').setDescription('Messages: append an optional Discord Markdown block.').setMaxLength(500))
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List relay configurations in this server.")
          .addBooleanOption((option) =>
            option
              .setName("include_disabled")
              .setDescription("Include disabled relay configurations in the list.")
              .setRequired(false)
          )
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("info")
          .setDescription("Show relay configuration for one source channel.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Source channel to inspect.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("Enable an existing relay configuration.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Source channel whose relay should be enabled.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("Disable a relay without deleting its configuration.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Source channel whose relay should be disabled.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Permanently remove a relay configuration.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Source channel whose relay config should be removed.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
          .addBooleanOption((option) =>
            option
              .setName("confirm")
              .setDescription("Must be true to permanently remove this relay config.")
              .setRequired(true)
          )
      )
  )

  .addSubcommandGroup((group) =>
    group
      .setName("campfire")
      .setDescription("Manage Campfire-specific relay behavior.")

      .addSubcommand((subcommand) =>
        subcommand
          .setName("creator_role_add")
          .setDescription("Map a Campfire meetup creator to a group role.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Campfire source channel this creator rule applies to.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
          .addUserOption((option) =>
            option
              .setName("creator")
              .setDescription("Discord user shown as creator in Campfire meetup messages.")
              .setRequired(true)
          )
          .addRoleOption((option) =>
            option
              .setName("group_role")
              .setDescription("Role to mention when this creator creates a Campfire meetup.")
              .setRequired(true)
          )
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("creator_role_list")
          .setDescription("List Campfire creator-to-role rules for one source channel.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Campfire source channel to list creator rules for.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
      )

      .addSubcommand((subcommand) =>
        subcommand
          .setName("creator_role_remove")
          .setDescription("Remove one Campfire creator-to-role rule.")
          .addChannelOption((option) =>
            option
              .setName("source_channel")
              .setDescription("Campfire source channel this creator rule applies to.")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
          .addUserOption((option) =>
            option
              .setName("creator")
              .setDescription("Discord creator user for the rule to remove.")
              .setRequired(true)
          )
          .addRoleOption((option) =>
            option
              .setName("group_role")
              .setDescription("Group role for the rule to remove.")
              .setRequired(true)
          )
          .addBooleanOption((option) =>
            option
              .setName("confirm")
              .setDescription("Must be true to permanently remove this creator rule.")
              .setRequired(true)
          )
      )
  );

const aboutCommand = new SlashCommandBuilder()
  .setName("about")
  .setDescription("Show RelayOnMe information and support channel.");

const commands = [relayCommand, aboutCommand].map(command => command
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .toJSON());

const rest = new REST({ version: "10" }).setToken(token);

const deployGlobalCommands =
  String(process.env.DEPLOY_GLOBAL_COMMANDS || "").toLowerCase() === "true";

async function deployCommands() {
  console.log("Deploying RelayOnMe slash commands...");
  console.log("Client ID:", clientId);
  console.log("Guild ID:", guildId || "(none)");
  console.log("Deploy global:", deployGlobalCommands);

  if (!clientId) {
    throw new Error("Missing DISCORD_CLIENT_ID or CLIENT_ID");
  }

  if (!deployGlobalCommands && !guildId) {
    throw new Error(
      "Missing GUILD_ID/DISCORD_GUILD_ID for guild deploy. Set DEPLOY_GLOBAL_COMMANDS=true to deploy globally."
    );
  }

  const route = deployGlobalCommands
    ? Routes.applicationCommands(clientId)
    : Routes.applicationGuildCommands(clientId, guildId);

  console.log(
    deployGlobalCommands
      ? "Deploying RelayOnMe commands globally."
      : `Deploying RelayOnMe commands to guild ${guildId}.`
  );

  await rest.put(route, {
    body: deployGlobalCommands ? commands
      : commands.map(({ contexts, integration_types, ...command }) => command),
  });

  console.log("RelayOnMe slash commands deployed.");
}

deployCommands().catch((error) => {
  console.error("Failed to deploy RelayOnMe slash commands:", error);
  process.exit(1);
});
