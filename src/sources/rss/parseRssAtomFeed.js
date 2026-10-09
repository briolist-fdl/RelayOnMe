'use strict';

const { XMLParser } = require('fast-xml-parser');

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 250;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const valueText = value => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  const node = object(value);
  return node ? text(node['#text']) : '';
};
const categories = value => [...new Set(array(value).map(item => text(valueText(item) || object(item)?.['@_term'])).filter(Boolean))];
const first = values => values.find(Boolean) || '';

function atomLink(value) {
  const links = array(value).map(object).filter(Boolean);
  return first(links.filter(link => !link['@_rel'] || link['@_rel'] === 'alternate').map(link => text(link['@_href']))) ||
    first(links.map(link => text(link['@_href'])));
}

function normalizeRssItem(item) {
  const node = object(item) || {};
  const link = first([text(node.link), text(node.guid?.['@_isPermaLink'] === 'true' ? valueText(node.guid) : ''), text(node.guid)]);
  const sourceItemId = first([valueText(node.guid), link]);
  return { sourceItemId, title: valueText(node.title), summary: first([valueText(node.description), valueText(node['content:encoded'])]),
    link, author: first([valueText(node.author), valueText(node['dc:creator'])]), categories: categories(node.category),
    publishedAt: first([valueText(node.pubDate), valueText(node.published)]), updatedAt: first([valueText(node.lastBuildDate), valueText(node.updated)]) };
}

function normalizeAtomEntry(entry) {
  const node = object(entry) || {};
  const link = atomLink(node.link);
  const authorNode = array(node.author).map(object).find(Boolean);
  return { sourceItemId: first([valueText(node.id), link]), title: valueText(node.title),
    summary: first([valueText(node.summary), valueText(node.content)]), link,
    author: first([valueText(authorNode?.name), valueText(node.author)]), categories: categories(node.category),
    publishedAt: valueText(node.published), updatedAt: valueText(node.updated) };
}

function parseRssAtomFeed(xml, { maxBytes = MAX_FEED_BYTES, maxItems = MAX_ITEMS } = {}) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') === 0 || Buffer.byteLength(xml, 'utf8') > maxBytes)
    throw new TypeError('Invalid feed document');
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS) throw new TypeError('Invalid feed item limit');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
    trimValues: true, parseTagValue: false, processEntities: false, htmlEntities: false });
  let document;
  try { document = parser.parse(xml); } catch { throw new TypeError('Invalid feed XML'); }
  const rssChannel = object(document?.rss)?.channel;
  const atomFeed = object(document?.feed);
  let kind, raw;
  if (rssChannel) { kind = 'rss'; raw = array(rssChannel.item).map(normalizeRssItem); }
  else if (atomFeed) { kind = 'atom'; raw = array(atomFeed.entry).map(normalizeAtomEntry); }
  else throw new TypeError('Unsupported feed format');
  const items = [], held = [];
  for (const item of raw.slice(0, maxItems)) {
    if (!item.sourceItemId) held.push({ reason: 'missing_item_identity' });
    else items.push(Object.freeze(item));
  }
  return Object.freeze({ kind, items: Object.freeze(items), held: Object.freeze(held) });
}

module.exports = { parseRssAtomFeed, MAX_FEED_BYTES, MAX_ITEMS };
