'use strict';

const { compileRelayFilter } = require('../matchRelayFilter');
const { parseRssAtomFeed } = require('./parseRssAtomFeed');

function selectFeedItems(xml, filterInput, limits) {
  const feed = parseRssAtomFeed(xml, limits);
  const filter = compileRelayFilter(filterInput);
  const selected = [], held = [...feed.held];
  for (const item of feed.items) {
    const result = filter.matches(item);
    if (result.matched) selected.push(item);
    else held.push({ sourceItemId: item.sourceItemId, reason: result.reason });
  }
  return Object.freeze({ kind: feed.kind, selected: Object.freeze(selected), held: Object.freeze(held) });
}

module.exports = { selectFeedItems };
