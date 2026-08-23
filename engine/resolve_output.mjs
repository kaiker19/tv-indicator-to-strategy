import { writeFileSync } from 'node:fs';

export function compactResolvedSource(result, outputPath, write = writeFileSync) {
  if (!outputPath) return result;
  const holder = result.source ? result : result.matches?.find(match => match.source);
  if (!holder?.source) return result;
  write(outputPath, holder.source);
  holder.sourcePath = outputPath;
  holder.sourceLines = holder.source.split(/\r?\n/).length;
  holder.sourceBytes = Buffer.byteLength(holder.source);
  delete holder.source;
  return result;
}
