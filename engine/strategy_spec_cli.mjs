#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCaseLibrary } from './case_library.mjs';
import { suggestComplements } from './mechanism_map.mjs';
import { validatePineStrategy } from './pine_static_validator.mjs';
import { compileStrategy } from './strategy_compiler.mjs';
import { normalizeStrategySpec, validateStrategySpec } from './strategy_spec.mjs';

const COMMANDS = new Set(['validate', 'compile', 'inspect']);
const CASE_INDEX = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'profiles', 'index.json');

function loadDefaultCaseLibrary() {
  if (!existsSync(CASE_INDEX)) return { index: { schemaVersion: 1, cases: [] }, profiles: {} };
  return loadCaseLibrary(CASE_INDEX);
}

export function parseStrategySpecArgs(argv = []) {
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new Error('command must be validate, compile, or inspect');
  let inputPath = null;
  let outputPath = null;
  let specPath = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--spec') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--out') outputPath = value;
      else specPath = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (inputPath) {
      throw new Error(`unexpected positional argument: ${arg}`);
    } else {
      inputPath = arg;
    }
  }
  if (!inputPath) throw new Error(`${command} requires an input path`);
  if (command !== 'compile' && outputPath) throw new Error('--out is only valid for compile');
  if (command !== 'inspect' && specPath) throw new Error('--spec is only valid for inspect');
  return { command, inputPath, outputPath, specPath };
}

function absolute(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error.message}`);
  }
}

function readJson(path, label) {
  const raw = readText(path, label);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${label} ${path}: ${error.message}`);
  }
}

function atomicWrite(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = resolve(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temp, source);
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function compactSpec(spec) {
  const normalized = normalizeStrategySpec(spec);
  return {
    title: normalized.title || null,
    family: normalized.family || null,
    symbol: normalized.market?.symbol || null,
    timeframe: normalized.market?.timeframe || null,
    indicators: Array.isArray(normalized.indicators) ? normalized.indicators.length : 0,
    enabledFilters: Array.isArray(normalized.entry?.filters)
      ? normalized.entry.filters.filter(filter => filter?.enabled === true).length
      : 0,
  };
}

function reviewResult(spec, caseLibrary) {
  const validation = validateStrategySpec(spec);
  const status = validation.errors.length
    ? 'invalid'
    : validation.blockingAmbiguities.length
      ? 'ambiguous'
      : 'valid';
  return {
    exitCode: status === 'valid' ? 0 : status === 'ambiguous' ? 2 : 1,
    result: {
      status,
      spec: compactSpec(spec),
      errors: validation.errors,
      warnings: validation.warnings,
      blockingAmbiguities: validation.blockingAmbiguities,
      guidance: suggestComplements(spec, caseLibrary),
    },
  };
}

export function runStrategySpecCli(argv = [], {
  cwd = process.cwd(),
  caseLibrary = loadDefaultCaseLibrary(),
} = {}) {
  const args = parseStrategySpecArgs(argv);
  const inputPath = absolute(args.inputPath, cwd);

  if (args.command === 'validate' || args.command === 'compile') {
    const spec = readJson(inputPath, 'Strategy Spec');
    const review = reviewResult(spec, caseLibrary);
    if (review.exitCode !== 0 || args.command === 'validate') return review;
    if (!args.outputPath) throw new Error('compile requires --out <strategy.pine>');

    const output = absolute(args.outputPath, cwd);
    const compiled = compileStrategy(spec);
    atomicWrite(output, compiled.source);
    return {
      exitCode: 0,
      result: {
        status: 'compiled',
        spec: compactSpec(spec),
        output,
        file: basename(output),
        bytes: Buffer.byteLength(compiled.source),
        inputs: compiled.inputMap.length,
        warnings: compiled.warnings,
      },
    };
  }

  const source = readText(inputPath, 'Pine source');
  let inputMap = [];
  if (args.specPath) {
    const spec = readJson(absolute(args.specPath, cwd), 'Strategy Spec');
    const review = reviewResult(spec, caseLibrary);
    if (review.exitCode !== 0) return review;
    inputMap = compileStrategy(spec).inputMap;
  }
  const checked = validatePineStrategy(source, { inputMap });
  return {
    exitCode: checked.errors.length ? 1 : 0,
    result: {
      status: checked.errors.length ? 'invalid' : 'valid',
      file: basename(inputPath),
      errors: checked.errors,
      warnings: checked.warnings,
      facts: checked.facts,
    },
  };
}

function main() {
  try {
    const run = runStrategySpecCli(process.argv.slice(2));
    console.log(JSON.stringify(run.result));
    process.exitCode = run.exitCode;
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', code: 'IO_ERROR', error: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
