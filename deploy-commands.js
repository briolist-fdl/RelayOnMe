require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
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

if (!guildId) {
  throw new Error("Missing GUILD_ID or DISCORD_GUILD_ID");
}

const relayCommand = new SlashCommandBuilder()
  .setName("relay")
  .setDescription("Configure RelayOnMe message relays.")

  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Show RelayOnMe runtime and storage status.")
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

const commands = [relayCommand.toJSON()];

const rest = new REST({ version: "10" }).setToken(token);

async function deployCommands() {
  console.log("Deploying RelayOnMe slash commands...");
  console.log("Client ID:", clientId);
  console.log("Guild ID:", guildId);

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });

  console.log("RelayOnMe slash commands deployed.");
}

deployCommands().catch((error) => {
  console.error("Failed to deploy RelayOnMe slash commands:", error);
  process.exit(1);
});
