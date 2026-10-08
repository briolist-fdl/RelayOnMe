'use strict';
const { createHash } = require('node:crypto');
const text = value => typeof value === 'string' && value.trim().length > 0;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));
  if (['string','number','boolean'].includes(typeof value) || value === null) return value;
  throw new TypeError('Observation payload must be JSON data');
}
function createSourceObservation({ sourceMessageId, sourceRevision, payload }) {
  if (!text(sourceMessageId) || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new TypeError('Invalid source observation identity');
  const sourceFingerprint=createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  return { sourceMessageId,sourceRevision,sourceFingerprint };
}
module.exports={createSourceObservation,canonical};
