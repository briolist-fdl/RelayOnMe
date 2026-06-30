require("dotenv").config();

const { ChannelType, REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("relay")
    .setDescription("Manage RelayOnMe relays")
    .addSubcommand((subcommand) =>
      subcommand.setName("status").setDescription("Show RelayOnMe status")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add or update a relay")
        .addStringOption((option) =>
          option
            .setName("parser")
            .setDescription("Parser to use")
            .setRequired(true)
            .addChoices({ name: "Campfire", value: "campfire" })
        )
        .addChannelOption((option) =>
          option
            .setName("source")
            .setDescription("Source channel to watch")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((option) =>
          option
            .setName("target")
            .setDescription("Target channel to relay into")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  console.log("Deploying commands with:");
  console.log("DISCORD_CLIENT_ID:", process.env.DISCORD_CLIENT_ID);
  console.log("DISCORD_GUILD_ID:", process.env.DISCORD_GUILD_ID);

  const result = await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: commands }
  );

  console.log("Slash commands deployed:");
  console.log(result.map((command) => command.name));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});