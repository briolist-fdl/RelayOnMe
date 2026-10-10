# RelayOnMe

RelayOnMe forwards selected Discord posts from one channel to another.

Choose words or authors to include, exclude unwanted posts, and customize the output with your own text. The RelayOnMe Campfire add-on also supports meetup messages and creator-role rules.

## Add RelayOnMe to a server

[Install RelayOnMe](https://discord.com/oauth2/authorize?client_id=1521169153975779408&scope=bot%20applications.commands&permissions=536955904&integration_type=0)

The link requests Guild Install with permission to view channels, read message history, send messages, embed links and manage webhooks. RelayOnMe needs Manage Webhooks in target channels to find or create its relay webhook. A server administrator configures source and target channels with `/relay config add` and can restrict the bot role to those channels. Administrator permission is not required.

## Features

* Filter source messages by words, phrases or author
* Relay selected messages to another channel in the same server
* Customize output with templates and an extra Markdown text block
* Update the existing output when a matching source message is edited
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

### Private demos and output preview

```text
/relay demo example:news
/relay demo example:jobs
/relay demo example:releases
/relay demo example:events
```

Each example shows which synthetic source posts pass its filter and how the
selected post looks. Optional `template` replaces the sample output, and
`add_text` appends a Discord Markdown block. For example, a template can use
`**{title}**` followed by `<{url}>`. Supported fields also include `{summary}`,
`{author}`, `{categories}`, `{original_content}`, `{starts}`, `{ends}`,
`{location}`, and `{role_mentions}`. Missing values render as empty text.

Demos are private, never ping roles, and do not create subscriptions. RSS polling
and inbound webhooks are still under development. See
[the product roadmap](docs/product-roadmap.md) for release gates.

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

Choose **Discord messages (filtered)** to forward ordinary posts or output from
another RSS/webhook bot. Optional `include`/`exclude` phrases are separated with
`|`, `author` restricts the source user or bot, and `template`/`add_text` customize
the text with Discord Markdown. Message routes are saved disabled: test with
`/relay preview source_channel:<source> text:<sample>`, then activate with
`/relay config enable`. Edits update the same target post; repeated events do not
send another copy. See [live Discord relay setup](docs/live-discord-relays.md).

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
DEPLOY_GLOBAL_COMMANDS=false
BRIO_BOTS_GUILD_ID=
BRIO_BOTS_ABOUT_CHANNEL_ID=
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

For global registration, set `DEPLOY_GLOBAL_COMMANDS=true` explicitly. A guild ID is only required for guild registration. Registration changes Discord commands; it is not part of `npm test`.

`/about` links by default to `#relayonme` in BrioBots. The two optional
`BRIO_BOTS_GUILD_ID` and `BRIO_BOTS_ABOUT_CHANNEL_ID` variables may override
that destination when both are valid Discord IDs.

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
* manage webhooks in target channels to find or create the relay webhook
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

https://buymeacoffee.com/briolist

## Links

* GitHub: https://github.com/briolist-fdl/relayonme
* Support development: https://buymeacoffee.com/briolist

## License

ISC
