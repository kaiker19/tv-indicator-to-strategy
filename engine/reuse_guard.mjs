import { createHash } from 'node:crypto';

export function sourceDigest(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function buildStudyRecord(name, source) {
  return { version: 1, name, sourceDigest: sourceDigest(source) };
}

export function evaluateReuse(record, name, source) {
  if (!record) return { ok: false, reason: 'record_missing' };
  if (record.version !== 1 || !record.name || !record.sourceDigest) {
    return { ok: false, reason: 'record_invalid' };
  }
  if (record.name !== name) return { ok: false, reason: 'strategy_changed' };
  if (record.sourceDigest !== sourceDigest(source)) return { ok: false, reason: 'source_changed' };
  return { ok: true, reason: 'source_match' };
}
