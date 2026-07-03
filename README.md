# RelayOnMe

RelayOnMe is a Discord bot for relaying structured messages from one channel to another.

It is built for communities that need controlled message forwarding between channels, with support for Campfire meetup messages and creator-specific role mentions.

## Features

* Relay messages from a source channel to a target channel
* Configure relays per Discord server
* Enable, disable, inspect, list, or remove relay configurations
* Campfire-specific message parsing
* Campfire creator-to-role rules
* Optional fallback role mentions
* PostgreSQL-backed configuration storage
* Ephemeral admin responses for configuration commands

## Main command

RelayOnMe uses one main slash command:

```text
/relay
```

### Runtime/status

```text
/relay status
```

Shows RelayOnMe runtime and storage status.

### Relay configuration

```text
/relay config add
/relay config list
/relay config info
/relay config enable
/relay config disable
/relay config remove
```

These commands manage source-to-target relay configurations.

`/relay config add` creates or updates a relay from one source channel to one target channel.

Optional configuration can include a fallback group role to mention when no more specific Campfire creator rule matches.

### Campfire creator role rules

```text
/relay campfire creator_role_add
/relay campfire creator_role_list
/relay campfire creator_role_remove
```

These commands map a Campfire meetup creator to a Discord role for a specific source channel.

This allows RelayOnMe to mention the relevant group role when a matching Campfire meetup is relayed.

## Requirements

* Node.js
* PostgreSQL database
* Discord bot application
* Discord server where slash commands can be registered

## Environment variables

RelayOnMe is configured through environment variables.

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
GUILD_ID=
DATABASE_URL=

BOT_ID=relayonme
SUPPORT_MESSAGES_ENABLED=true
```

Alternative/fallback names currently supported by the command deployment script:

```env
CLIENT_ID=
DISCORD_GUILD_ID=
```

Optional:

```env
RELAY_ADMIN_ROLE_ID=
SUPPORT_MESSAGE_CHANCE=
```

`SUPPORT_MESSAGE_CHANCE` is intended for testing or temporary override only. Do not set it permanently unless you specifically want to override the bot default.

## Installation

Install dependencies:

```bash
npm install
```

Deploy slash commands:

```bash
node deploy-commands.js
```

Start the bot:

```bash
node index.js
```

## Database

RelayOnMe uses PostgreSQL.

The database connection is read from:

```env
DATABASE_URL=
```

Database initialization is handled by the bot startup/init flow.

## Permissions

RelayOnMe needs the Discord permissions required to:

* read source channels
* send messages in target channels
* use slash commands
* mention configured roles when applicable

Admin/configuration access can be restricted with:

```env
RELAY_ADMIN_ROLE_ID=
```

## Privacy and data

RelayOnMe stores configuration needed to operate relays, including server/channel configuration and Campfire creator role rules.

It may also store relay message references needed for relay tracking.

RelayOnMe is not designed as a general-purpose message archive.

## Support development

RelayOnMe is built as an open source community tool.

If it helps your server, you can support further development by voting for the bot when voting pages are available, contributing feedback or issues on GitHub, or supporting the developer here:

https://buymeacoffee.com/andreasviken

## Links

* GitHub: https://github.com/briolist-fdl/relayonme
* Support development: https://buymeacoffee.com/andreasviken

## License

ISC
