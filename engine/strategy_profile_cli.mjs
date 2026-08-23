#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  buildStrategyProfile,
  sanitizeProfileForPromotion,
  validateProfileInput,
  validateStrategyProfile,
} from './strategy_profile.mjs';

const VALUE_FLAGS = new Set(['--meta', '--source', '--out']);

export function parseProfileArgs(argv = []) {
  let summaryPath = null;
  let metadataPath = null;
  let sourcePath = null;
  let outputPath = null;
  let promote = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--meta') metadataPath = value;
      else if (arg === '--source') sourcePath = value;
      else outputPath = value;
      continue;
    }
    if (arg === '--promote') {
      promote = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (summaryPath) throw new Error(`unexpected positional argument: ${arg}`);
    summaryPath = arg;
  }

  return { summaryPath, metadataPath, sourcePath, outputPath, promote };
}

function absolutePath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${label} ${path}: ${error.message}`);
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function runProfileCli(argv = [], {
  cwd = process.cwd(),
  createdAt = null,
} = {}) {
  const args = parseProfileArgs(argv);
  if (!args.summaryPath) throw new Error('run_summary.json path is required');
  if (!args.metadataPath) throw new Error('--meta <strategy_profile_meta.json> is required');

  const summaryPath = absolutePath(args.summaryPath, cwd);
  const metadataPath = absolutePath(args.metadataPath, cwd);
  const summary = readJson(summaryPath, 'summary');
  const metadata = readJson(metadataPath, 'metadata');
  const recordedSource = args.sourcePath || summary.source?.path;
  if (!recordedSource) throw new Error('Pine source path is missing; pass --source <strategy.pine>');
  const sourcePath = absolutePath(recordedSource, cwd);
  let source;
  try {
    source = readFileSync(sourcePath, 'utf8');
  } catch (error) {
    const hint = args.sourcePath ? '' : ' Pass --source <strategy.pine> when the recorded path came from another working directory.';
    throw new Error(`cannot read Pine source ${sourcePath}: ${error.message}.${hint}`);
  }
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const inputValidation = validateProfileInput({ summary, metadata, sourceSha256 });
  if (inputValidation.errors.length) throw new Error(inputValidation.errors.join('; '));

  let profile = buildStrategyProfile({
    summary,
    metadata,
    sourceSha256,
    summaryPath,
    createdAt,
  });
  const mode = args.promote ? 'promoted' : 'runtime';
  if (args.promote) profile = sanitizeProfileForPromotion(profile);
  const profileValidation = validateStrategyProfile(profile, { mode });
  if (profileValidation.errors.length) throw new Error(profileValidation.errors.join('; '));

  const outputPath = args.outputPath
    ? absolutePath(args.outputPath, cwd)
    : join(dirname(summaryPath), 'strategy_profile.json');
  atomicWriteJson(outputPath, profile);
  return {
    output: outputPath,
    label: profile.verdict.label,
    warnings: [...new Set([...inputValidation.warnings, ...profileValidation.warnings])],
  };
}

function main() {
  try {
    console.log(JSON.stringify(runProfileCli(process.argv.slice(2))));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
