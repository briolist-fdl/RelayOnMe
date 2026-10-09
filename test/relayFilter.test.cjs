'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileRelayFilter } = require('../src/sources/matchRelayFilter');

const item = Object.freeze({ title: 'Community event this Saturday', summary: 'Bring friends.',
  link: 'https://example.com/events/42', author: 'Brio Team', categories: ['Events', 'Local'] });

test('relay filter selects only posts matching configured content rules', () => {
  const filter = compileRelayFilter({ includeKeywords: ['event'], includeCategories: ['local'],
    allowedAuthors: ['brio team'], requireLink: true });
  assert.deepEqual(filter.matches(item), { matched: true, reason: 'matched' });
  assert.deepEqual(filter.matches({ ...item, categories: ['News'] }), { matched: false, reason: 'category_not_included' });
  assert.deepEqual(filter.matches({ ...item, author: 'Other team' }), { matched: false, reason: 'author_not_allowed' });
});

test('exclusions take precedence and item data is not mutated', () => {
  const filter = compileRelayFilter({ includeKeywords: ['event'], excludeKeywords: ['cancelled'],
    excludeCategories: ['internal'] });
  assert.deepEqual(filter.matches({ ...item, summary: 'Cancelled because of weather.' }), { matched: false, reason: 'excluded_keyword' });
  assert.deepEqual(filter.matches({ ...item, categories: ['Internal'] }), { matched: false, reason: 'excluded_category' });
  assert.deepEqual(item.categories, ['Events', 'Local']);
});

test('invalid filter and source shapes fail closed', () => {
  assert.throws(() => compileRelayFilter({ includeKeywords: [''] }));
  assert.throws(() => compileRelayFilter({ allowedAuthors: 'brio' }));
  assert.throws(() => compileRelayFilter().matches({ categories: [''] }));
  assert.deepEqual(compileRelayFilter({ requireLink: true }).matches({ title: 'Post' }), { matched: false, reason: 'missing_link' });
});
