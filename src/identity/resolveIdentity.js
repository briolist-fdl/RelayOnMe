'use strict';

// Pure decisions only. Callers must read and apply decisions under a scope lock.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => typeof value === 'string' && value.length > 0;

function parseUrl(value, policy = {}) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const direct = (policy.meetupHosts || []).includes(url.hostname);
    const short = (policy.shortHosts || []).includes(url.hostname);
    if (!direct && !short) return null;
    const match = direct && url.pathname.match(/^\/discover\/meetup\/([^/]+)\/?$/);
    const meetupId = match && UUID.test(match[1]) ? match[1].toLowerCase() : null;
    if (direct && !meetupId && !short) return null;
    // Preserve path case and query, including ordering. Never use a generic ?id.
    return { url: url.href, meetupId };
  } catch {
    return null;
  }
}

function resolveIdentity({ scope, observation, redirectChain = [], policy = {},
  events = [], aliases = [], observations = [], migrationReady = false }) {
  if (!scope || !id(scope.id) || !id(scope.sourceChannelId) ||
      !observation || !id(observation.sourceMessageId) ||
      observation.sourceChannelId !== scope.sourceChannelId || scope.enabled !== true) {
    return { status: 'invalid_scope' };
  }
  if (![events, aliases, observations, redirectChain].every(Array.isArray)) {
    throw new TypeError('Identity collections must be arrays');
  }
  const source = parseUrl(observation.meetupUrl, policy);
  let urls = source ? [source] : [];
  if (redirectChain.length) {
    // This is a supplied, previously verified redirect trace, never fetched here.
    const parsed = redirectChain.map(url => parseUrl(url, policy));
    if (!source || parsed.length > 9 || parsed.some(url => !url) ||
        parsed[0].url !== source.url) return { status: 'invalid_evidence' };
    urls = parsed;
  }
  const ids = [...new Set(urls.map(url => url.meetupId).filter(Boolean))];
  if (ids.length > 1) return { status: 'identity_conflict' };
  const evidence = urls.map(url => ({ type: 'meetup_url', value: url.url }));
  if (ids.length) evidence.push({ type: 'meetup_id', value: ids[0] });
  const matches = aliases.filter(alias => alias.scopeId === scope.id && evidence.some(
    item => item.type === alias.type && item.value === alias.value));
  const seen = observations.filter(row => row.scopeId === scope.id &&
    row.sourceChannelId === observation.sourceChannelId &&
    row.sourceMessageId === observation.sourceMessageId && row.eventId != null);
  const eventIds = [...new Set([...matches, ...seen].map(row => row.eventId))];
  if (eventIds.length > 1) return { status: 'identity_conflict' };
  if (eventIds.length && (!id(eventIds[0]) || events.filter(event =>
    event.scopeId === scope.id && event.id === eventIds[0]).length !== 1)) {
    return { status: 'invalid_state' };
  }
  if (eventIds.length && ids.length && aliases.some(alias => alias.scopeId === scope.id &&
      alias.eventId === eventIds[0] && alias.type === 'meetup_id' && alias.value !== ids[0])) {
    return { status: 'identity_conflict' };
  }
  if (!eventIds.length && !ids.length) return { status: 'pending_identity' };
  if (!eventIds.length && migrationReady !== true) return { status: 'blocked_migration' };
  // A short URL becomes an alias only when a supplied trace proves its meetup ID.
  // Matching a source observation alone does not prove a newly supplied URL.
  const aliasesToAdd = ids.length ? evidence.filter(item => !matches.some(
    alias => alias.type === item.type && alias.value === item.value)) : [];
  return {
    status: eventIds.length ? 'existing_event' : 'new_event',
    eventId: eventIds[0] || null,
    aliasesToAdd: [...new Map(aliasesToAdd.map(item => [JSON.stringify(item), item])).values()],
  };
}

module.exports = { resolveIdentity, parseUrl, UUID };
