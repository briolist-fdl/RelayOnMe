'use strict';

const text = value => typeof value === 'string' && value.trim().length > 0;
const normalize = value => String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
const list = (value, name) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => !text(item))) throw new TypeError(`Invalid ${name}`);
  return [...new Set(value.map(normalize))];
};

// A deliberately small, provider-neutral rule set. Source adapters map their
// RSS/Webhook payloads to this shape before calling it.
function compileRelayFilter(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid relay filter');
  const filter = Object.freeze({
    includeKeywords: list(input.includeKeywords, 'include keywords'),
    excludeKeywords: list(input.excludeKeywords, 'exclude keywords'),
    includeCategories: list(input.includeCategories, 'include categories'),
    excludeCategories: list(input.excludeCategories, 'exclude categories'),
    allowedAuthors: list(input.allowedAuthors, 'allowed authors'),
    requireLink: input.requireLink === true,
  });
  return Object.freeze({
    filter,
    matches(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid source item');
      const body = normalize(`${item.title || ''}\n${item.summary || ''}`);
      const categories = list(item.categories, 'item categories');
      const author = item.author == null ? '' : normalize(item.author);
      const link = item.link == null ? '' : String(item.link).trim();
      if (filter.requireLink && !/^https?:\/\/[^\s]+$/i.test(link)) return { matched: false, reason: 'missing_link' };
      if (filter.allowedAuthors.length && !filter.allowedAuthors.includes(author)) return { matched: false, reason: 'author_not_allowed' };
      if (filter.excludeKeywords.some(keyword => body.includes(keyword))) return { matched: false, reason: 'excluded_keyword' };
      if (filter.includeKeywords.length && !filter.includeKeywords.some(keyword => body.includes(keyword))) return { matched: false, reason: 'keyword_not_included' };
      if (filter.excludeCategories.some(category => categories.includes(category))) return { matched: false, reason: 'excluded_category' };
      if (filter.includeCategories.length && !filter.includeCategories.some(category => categories.includes(category))) return { matched: false, reason: 'category_not_included' };
      return { matched: true, reason: 'matched' };
    },
  });
}

module.exports = { compileRelayFilter };
