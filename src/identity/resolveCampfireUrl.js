'use strict';

const { performance } = require('node:perf_hooks');
const { parseUrl } = require('./resolveIdentity');
const { campfireUrlPolicy } = require('./campfireUrlPolicy');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function discardBody(response) {
  // Do not read HTML, await an unbounded body, or leave GET bodies to GC.
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
}

async function readHeaders(url, method, { fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController();
  let finished = false;
  let timer;
  let onAbort;
  const stopped = new Promise(resolve => {
    const stop = reason => {
      if (finished) return;
      finished = true;
      resolve({ kind: reason });
      controller.abort();
    };
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const request = Promise.resolve().then(async () => {
    if (finished) return { kind: 'cancelled' };
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'manual', signal: controller.signal,
        credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'User-Agent': 'RelayOnMe/1.0' },
      });
      if (finished) return { kind: 'timeout' };
      // Injected transports must also honor manual redirects.
      if (response.redirected || (response.url && response.url !== url)) {
        return { kind: 'invalid_transport' };
      }
      const status = response.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return { kind: 'invalid_transport' };
      }
      return { kind: 'response', status, location: response.headers.get('location') };
    } catch {
      return { kind: 'network_error' };
    } finally {
      discardBody(response);
    }
  });
  try {
    return await Promise.race([request, stopped]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function allowedUrl(value, base) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) return null;
  try {
    return parseUrl(base ? new URL(value, base).href : value, campfireUrlPolicy);
  } catch { return null; }
}

async function resolveCampfireUrl(sourceUrl, {
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 4000,
  totalTimeoutMs = 12000,
  maxRedirects = 8,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function' ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 7000 ||
      !Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 30000 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 8) {
    throw new TypeError('Invalid resolver options');
  }
  const initial = allowedUrl(sourceUrl);
  if (!initial) return { status: 'rejected', reason: 'unapproved_url' };
  const deadline = performance.now() + totalTimeoutMs;
  const chain = [initial.url];
  let current = initial;
  while (true) {
    if (signal?.aborted) return { status: 'cancelled' };
    // A validated direct URL is already identity evidence. Do not fetch event content.
    if (current.meetupId) return {
      status: 'resolved', meetupId: current.meetupId, redirectChain: chain,
    };
    if (chain.length - 1 >= maxRedirects) return { status: 'unresolved', reason: 'hop_limit' };
    let next;
    for (const method of ['HEAD', 'GET']) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { status: 'unresolved', reason: 'timeout' };
      const response = await readHeaders(current.url, method, {
        fetchImpl, signal, timeoutMs: Math.min(requestTimeoutMs, Math.ceil(remaining)),
      });
      if (signal?.aborted || response.kind === 'cancelled') return { status: 'cancelled' };
      if (performance.now() >= deadline) return { status: 'unresolved', reason: 'timeout' };
      if (response.kind === 'invalid_transport') return { status: 'rejected', reason: 'invalid_transport' };
      if (response.status === 429) return { status: 'unresolved', reason: 'rate_limited' };
      if (response.kind === 'response' && REDIRECTS.has(response.status) && response.location) {
        next = allowedUrl(response.location, current.url);
        if (!next) return { status: 'rejected', reason: 'unapproved_redirect' };
        if (chain.includes(next.url)) return { status: 'unresolved', reason: 'redirect_loop' };
        break;
      }
      if (method === 'GET') return { status: 'unresolved', reason:
        response.kind === 'response' ? 'no_redirect' : response.kind };
    }
    chain.push(next.url);
    current = next;
  }
}

module.exports = { resolveCampfireUrl };
