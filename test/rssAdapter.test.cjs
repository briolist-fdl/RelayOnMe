'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRssAtomFeed } = require('../src/sources/rss/parseRssAtomFeed');
const { selectFeedItems } = require('../src/sources/rss/selectFeedItems');

const rss = `<?xml version="1.0"?><rss><channel><item><guid>event-1</guid><title>Open event</title><description>Everyone is welcome</description><link>https://example.com/event-1</link><author>Brio Team</author><category>Events</category></item><item><guid>news-1</guid><title>Internal notes</title><category>Internal</category></item></channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-1</id><title>Meetup</title><summary>Town square</summary><link href="https://example.com/atom-1"/><author><name>Brio Team</name></author><category term="Local"/></entry></feed>`;

test('RSS adapter normalizes stable items without provider-specific filter logic', () => {
  const feed = parseRssAtomFeed(rss);
  assert.equal(feed.kind, 'rss');
  assert.deepEqual(feed.items[0], { sourceItemId: 'event-1', title: 'Open event', summary: 'Everyone is welcome',
    link: 'https://example.com/event-1', author: 'Brio Team', categories: ['Events'], publishedAt: '', updatedAt: '' });
  const result = selectFeedItems(rss, { includeCategories: ['events'], requireLink: true });
  assert.deepEqual(result.selected.map(item => item.sourceItemId), ['event-1']);
  assert.deepEqual(result.held, [{ sourceItemId: 'news-1', reason: 'missing_link' }]);
});

test('Atom entries use canonical ID and link metadata', () => {
  const feed = parseRssAtomFeed(atom);
  assert.equal(feed.kind, 'atom');
  assert.deepEqual(feed.items[0], { sourceItemId: 'atom-1', title: 'Meetup', summary: 'Town square',
    link: 'https://example.com/atom-1', author: 'Brio Team', categories: ['Local'], publishedAt: '', updatedAt: '' });
});

test('RSS adapter holds unknown identities and rejects unsafe input bounds', () => {
  const result = parseRssAtomFeed('<rss><channel><item><title>No identifier</title></item></channel></rss>');
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.held, [{ reason: 'missing_item_identity' }]);
  assert.throws(() => parseRssAtomFeed('<feed/>'));
  assert.throws(() => parseRssAtomFeed('x'.repeat(32), { maxBytes: 2 }));
});
