import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { validateStrategyProfile } from './strategy_profile.mjs';

export const CASE_FAMILIES = Object.freeze([
  'trend',
  'mean_reversion',
  'breakout',
  'state_switching',
]);

function profileAt(profilesByPath, path) {
  if (profilesByPath instanceof Map) return profilesByPath.get(path);
  return profilesByPath?.[path];
}

function isSafeProfilePath(value) {
  if (typeof value !== 'string' || !value.endsWith('.json') || isAbsolute(value)) return false;
  return value.split(/[\\/]+/).every(part => part && part !== '.' && part !== '..');
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load ${label} ${path}: ${error.message}`);
  }
}

export function loadCaseLibrary(indexPath) {
  const index = readJson(indexPath, 'case library index');
  const profiles = {};
  for (const item of Array.isArray(index?.cases) ? index.cases : []) {
    if (!isSafeProfilePath(item?.profile)) continue;
    const profilePath = join(dirname(indexPath), item.profile);
    if (existsSync(profilePath)) profiles[item.profile] = readJson(profilePath, 'strategy profile');
  }
  return { index, profiles };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

export function validateCaseLibrary(index, profilesByPath = {}) {
  const errors = [];
  if (!index || typeof index !== 'object') {
    return { errors: ['case library index must be an object'], summary: { total: 0, qualified: 0, families: [] } };
  }
  if (index.schemaVersion !== 1) errors.push('case library schemaVersion must be 1');
  if (!Array.isArray(index.cases)) errors.push('case library cases must be an array');
  const cases = Array.isArray(index.cases) ? index.cases : [];
  const seenIds = new Set();
  const seenPaths = new Set();
  const families = new Set();
  let qualified = 0;

  for (let i = 0; i < cases.length; i++) {
    const item = cases[i] || {};
    const prefix = `cases[${i}]`;
    if (!item.id) errors.push(`${prefix}.id is required`);
    else if (seenIds.has(item.id)) errors.push(`duplicate case id: ${item.id}`);
    else seenIds.add(item.id);

    if (!isSafeProfilePath(item.profile)) errors.push(`${prefix}.profile must be a safe relative JSON path`);
    else if (seenPaths.has(item.profile)) errors.push(`duplicate profile path: ${item.profile}`);
    else seenPaths.add(item.profile);

    if (!CASE_FAMILIES.includes(item.family)) errors.push(`${prefix}.family must be one of ${CASE_FAMILIES.join(', ')}`);
    else families.add(item.family);
    if (!['qualified', 'counterexample'].includes(item.role)) errors.push(`${prefix}.role must be qualified or counterexample`);
    if (!item.lesson || typeof item.lesson !== 'string') errors.push(`${prefix}.lesson is required`);
    if (!validDate(item.evidenceDate)) errors.push(`${prefix}.evidenceDate must be YYYY-MM-DD`);
    if (item.role === 'qualified') qualified++;

    if (!isSafeProfilePath(item.profile)) continue;
    const profile = profileAt(profilesByPath, item.profile);
    if (!profile) {
      errors.push(`${prefix}.profile is missing: ${item.profile}`);
      continue;
    }
    const checked = validateStrategyProfile(profile, { mode: 'promoted' });
    errors.push(...checked.errors.map(error => `${prefix}.profile ${error}`));
    if (profile.profileId !== item.id) errors.push(`${prefix}.id does not match profile.profileId`);
    if (profile.strategy?.family !== item.family) errors.push(`${prefix}.family does not match profile.strategy.family`);
    if (item.role === 'qualified' && !['symbol_specific', 'cross_market'].includes(profile.verdict?.label)) {
      errors.push(`${prefix} qualified role requires a symbol_specific or cross_market verdict`);
    }
    if (item.role === 'counterexample' && profile.verdict?.label !== 'prefer_bh') {
      errors.push(`${prefix} counterexample role requires a prefer_bh verdict`);
    }
  }

  const missing = CASE_FAMILIES.filter(family => !families.has(family));
  if (missing.length) errors.push(`case library missing families: ${missing.join(', ')}`);
  if (qualified === 0) errors.push('case library requires at least one qualified positive profile');

  return {
    errors: [...new Set(errors)],
    summary: {
      total: cases.length,
      qualified,
      families: [...families].sort(),
    },
  };
}
