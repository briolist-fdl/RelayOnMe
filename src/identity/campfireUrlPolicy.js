'use strict';

// Opt-in policy, verified against public Campfire web resources on 2026-09-30.
// This allowlist does not authenticate a redirect trace or prove short-link stability.
// See docs/campfire-url-verification.md before connecting a network resolver.
const campfireUrlPolicy = Object.freeze({
  meetupHosts: Object.freeze(['campfire.nianticlabs.com', 'campfire.scopely.com']),
  shortHosts: Object.freeze(['cmpf.re']),
});

module.exports = { campfireUrlPolicy };
