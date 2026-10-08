'use strict';

const text = value => typeof value === 'string' && value.trim().length > 0;
const fingerprint = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Pure comparison; adapter owns the monotonic source revision and canonical hash.
function planSourceObservation({ sourceMessageId, sourceRevision, sourceFingerprint }, existing = null) {
  if (!text(sourceMessageId) || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || !fingerprint(sourceFingerprint)) {
    return { status: 'invalid_observation' };
  }
  if (!existing) return { status: 'next' };
  if (!Number.isSafeInteger(existing.sourceRevision) || !text(existing.sourceMessageId) || !fingerprint(existing.sourceFingerprint)) {
    throw new TypeError('Invalid stored source observation');
  }
  if (sourceRevision < existing.sourceRevision) return { status: 'stale_observation' };
  if (sourceRevision > existing.sourceRevision) return { status: 'next' };
  if (sourceMessageId === existing.sourceMessageId && sourceFingerprint === existing.sourceFingerprint) return { status: 'repeat' };
  return { status: 'conflicting_observation' };
}

module.exports = { planSourceObservation };
