import fs from 'node:fs';

export class ConfigError extends Error {}

const REQUIRED = [
  'server.host',
  'server.port',
  'server.version',
  'bot.username',
  'allowlist',
  'claude.model',
  'claude.effort',
  'limits.maxSteps',
  'limits.maxSeconds',
  'limits.queueSize',
  'limits.maxBuildBlocks',
  'limits.maxInspectBlocks',
  'limits.moveTimeoutSeconds',
  'perception.blockRadius',
  'perception.entityRadius',
  'perception.maxEntities',
  'perception.chatHistory',
  'reconnect.baseDelaySeconds',
  'reconnect.maxDelaySeconds',
  'protectedBlocks'
];

function getPath(obj, path) {
  return path.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

export function validateConfig(raw, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ConfigError('ANTHROPIC_API_KEY is not set. Put it in the .env file (see .env.example).');
  }

  const missing = REQUIRED.filter((path) => {
    const value = getPath(raw, path);
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw new ConfigError(`config.json is missing: ${missing.join(', ')}`);
  }

  if (!Array.isArray(raw.allowlist) || raw.allowlist.length === 0) {
    throw new ConfigError('config.json allowlist must list at least one player name.');
  }
  if (!Array.isArray(raw.protectedBlocks)) {
    throw new ConfigError('config.json protectedBlocks must be a list.');
  }

  if (raw.admins !== undefined && !Array.isArray(raw.admins)) {
    throw new ConfigError('config.json admins must be a list of player names.');
  }
  const dig = raw.limits.maxDigBlocks;
  if (dig !== undefined && !(Number.isInteger(dig) && dig > 0)) {
    throw new ConfigError('config.json limits.maxDigBlocks must be a whole number above 0.');
  }
  const warnCost = raw.limits.warnCostUsd;
  if (warnCost !== undefined && !(typeof warnCost === 'number' && warnCost >= 0)) {
    throw new ConfigError('config.json limits.warnCostUsd must be a number, 0 or more.');
  }
  const scale = raw.bot.pauseScale;
  if (scale !== undefined && !(typeof scale === 'number' && scale >= 0)) {
    throw new ConfigError('config.json bot.pauseScale must be a number, 0 or more.');
  }

  return {
    ...raw,
    // Players who may give standing orders and confirm breaking protected blocks.
    admins: raw.admins ?? raw.allowlist,
    // pauseScale scales the short human-like waits between actions, 0 for none.
    bot: { pauseScale: 1, ...raw.bot },
    claude: {
      fallback: true, strictTools: true, maxTokens: 16000, maxRetries: 2, busyReplies: true, buildEffort: 'high',
      routing: true, everydayModel: 'claude-sonnet-5-5', quickModel: 'claude-haiku-5-5', ...raw.claude
    },
    // maxDigBlocks is the biggest box dig_area takes. warnCostUsd is the job cost that gets a
    // warning (and again each time it doubles), 0 for none. It never stops a job.
    limits: { buildMaxSteps: 40, buildMaxSeconds: 1200, stuckSeconds: 45, quietSeconds: 60, maxDigBlocks: 1000, warnCostUsd: 2, ...raw.limits },
    idle: { enabled: true, freeTimeMinutes: 15, freeTimeSteps: 8, freeTimeSeconds: 240, defendRadius: 10, ...raw.idle },
    survival: { criticalHealth: 8, eatAtFood: 14, ...raw.survival }
  };
}

export function loadConfig(path = 'config.json', env = process.env) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Could not read ${path}. Copy config.example.json to ${path} and fill it in.`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${err.message}`);
  }

  return validateConfig(raw, env);
}
