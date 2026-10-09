'use strict';

const CONTENT_LIMIT = 1900; // Leaves space for the delivery evidence marker.
const fields = new Set(['title', 'summary', 'url', 'author', 'categories', 'original_content',
  'starts', 'ends', 'location', 'role_mentions']);
const plain = value => {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError('Output fields must be text');
  return value;
};
const escapeMarkdown = value => value.replace(/[\\`*_{}\[\]()~|>]/g, '\\$&');

function safeLink(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\s<>]/.test(value))
      throw Error();
    return url.href;
  } catch { throw new TypeError('Invalid output link'); }
}

function compileRelayOutput(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Invalid output configuration');
  for (const key of Object.keys(config)) {
    if (!['template', 'prefix', 'suffix', 'roleIds'].includes(key)) throw new TypeError('Unknown output option');
  }
  const template = config.template == null ? '{original_content}' : plain(config.template);
  const prefix = plain(config.prefix), suffix = plain(config.suffix);
  const roleIds = config.roleIds == null ? [] : config.roleIds;
  if (!Array.isArray(roleIds) || roleIds.length > 10 || roleIds.some(id => typeof id !== 'string' || !/^\d{17,20}$/.test(id)))
    throw new TypeError('Invalid output roles');
  const roles = Object.freeze([...new Set(roleIds)]);
  for (const block of [prefix, template, suffix]) {
    if (block.length > CONTENT_LIMIT) throw new RangeError('Output block is too long');
    for (const match of block.matchAll(/\{([^{}]+)\}/g)) {
      if (!fields.has(match[1])) throw new TypeError('Unknown output placeholder: ' + match[1]);
    }
  }
  return Object.freeze({
    render(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid output item');
      const values = Object.create(null);
      for (const name of ['title', 'summary', 'author', 'starts', 'ends', 'location'])
        values[name] = escapeMarkdown(plain(item[name]));
      if (item.categories != null && (!Array.isArray(item.categories) || item.categories.some(category => typeof category !== 'string')))
        throw new TypeError('Invalid output categories');
      values.categories = escapeMarkdown((item.categories || []).join(', '));
      values.url = safeLink(plain(item.link));
      values.original_content = plain(item.originalContent ?? item.summary);
      values.role_mentions = roles.map(id => `<@&${id}>`).join(' ');
      const fill = block => block.replace(/\{([^{}]+)\}/g, (_, name) => values[name]);
      const content = [prefix, template, suffix].map(fill).filter(Boolean).join('\n\n');
      if (!content.trim()) throw new TypeError('Output is empty');
      if (content.length > CONTENT_LIMIT) throw new RangeError('Output exceeds Discord content budget');
      return { content, allowedMentions: { parse: [], roles: [...roles], users: [], repliedUser: false } };
    },
  });
}

module.exports = { compileRelayOutput, CONTENT_LIMIT };
