import { homedir } from 'os';
import { join } from 'path';

export function resolveStateDir({ homeDir = homedir(), env = process.env } = {}) {
  return env.TV_SKILL_STATE_DIR || join(homeDir, '.tv-skill');
}
