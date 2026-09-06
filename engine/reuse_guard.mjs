import { createHash } from 'node:crypto';

export function sourceDigest(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function verifySourceReadback(expected, actual) {
  // Monaco normalizes mixed CRLF/LF files. Ignore only line endings and our
  // injected trailing run tag, never Pine whitespace, statements or defaults.
  const normalize = value => String(value).replace(/\r\n/g, '\n');
  const normalizedActual = normalize(actual).replace(/\n\n\/\/ AUTO_TAG: AUTO_\d+\n?$/, '');
  const expectedDigest = sourceDigest(normalize(expected));
  const actualDigest = sourceDigest(normalizedActual);
  return { ok: expectedDigest === actualDigest, expectedDigest, actualDigest };
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
