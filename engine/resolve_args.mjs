export function parseResolveArgs(argv) {
  const kindIdx = argv.indexOf('--kind');
  const idIdx = argv.indexOf('--id');
  const outIdx = argv.indexOf('--out');
  const optionValueIndexes = [kindIdx, idIdx, outIdx]
    .filter(i => i >= 0)
    .map(i => i + 1);
  return {
    kind: kindIdx >= 0 ? argv[kindIdx + 1] : 'all',
    directId: idIdx >= 0 ? argv[idIdx + 1] : null,
    outputPath: outIdx >= 0 ? argv[outIdx + 1] : null,
    query: argv.find((arg, i) => !arg.startsWith('--') && !optionValueIndexes.includes(i)),
  };
}
