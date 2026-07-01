const { MessageFlags } = require('discord.js');
const { getBotConfig } = require('./botDirectory');

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampChance(value) {
  return Math.max(0, Math.min(1, value));
}

function getSupportSettings() {
  const bot = getBotConfig();

  const defaultChance =
    typeof bot.supportMessageChance === 'number'
      ? bot.supportMessageChance
      : 0.2;

  return {
    enabled: envBool(process.env.SUPPORT_MESSAGES_ENABLED, true),
    chance: clampChance(
      envNumber(process.env.SUPPORT_MESSAGE_CHANCE, defaultChance)
    ),
  };
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildSupportLinks(bot) {
  const links = [];

  if (bot.githubUrl) {
    links.push(`⭐ [GitHub](${bot.githubUrl})`);
  }

  if (bot.topggUrl) {
    links.push(`👍 [Vote](${bot.topggUrl})`);
  }

  if (bot.discordBotListUrl) {
    links.push(`👍 [Discord Bot List](${bot.discordBotListUrl})`);
  }

  if (bot.buyMeACoffeeUrl) {
    links.push(`☕ [Buy Me a Coffee](${bot.buyMeACoffeeUrl})`);
  }

  return links;
}

function buildSupportMessage() {
  const bot = getBotConfig();
  const links = buildSupportLinks(bot);

  if (links.length === 0) {
    return '';
  }

  const linkText = links.join(' · ');

  const variants = [
  `${bot.name} is community-maintained. Helpful links: ${linkText}`,
  `Support continued development of ${bot.name}: ${linkText}`,
  `${bot.name} is built as an open source community tool. ${linkText}`,
  `Help keep ${bot.name} maintained and improving: ${linkText}`,
];

  return randomItem(variants);
}

function maybeAddSupportMessage(content) {
  const settings = getSupportSettings();

  if (!settings.enabled) return content;
  if (Math.random() >= settings.chance) return content;

  const supportMessage = buildSupportMessage();

  if (!supportMessage) return content;

  return `${content}\n\n---\n${supportMessage}`;
}

function successReply(content) {
  return {
    content: maybeAddSupportMessage(content),
    flags: MessageFlags.Ephemeral,
  };
}

function successEdit(content) {
  return {
    content: maybeAddSupportMessage(content),
  };
}

function plainEphemeralReply(content) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
  };
}

module.exports = {
  maybeAddSupportMessage,
  successReply,
  successEdit,
  plainEphemeralReply,
};