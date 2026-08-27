import fs from 'fs';
import { defaultLogDir, defaultZcodeV2Config } from './paths.mjs';

export function runDoctor(cfg, { logDir, v2Path } = {}) {
  const checks = [];
  const add = (id, ok, detail) => {
    checks.push({ id, ok, detail });
  };

  const routes = (cfg && cfg.routes) || [];
  add('config', true, `routes=${routes.length}`);
  if (!routes.length) add('routes', false, 'no routes configured');
  else add('routes', true, `${routes.length} route(s)`);

  for (const r of routes) {
    const id = `inject:${r.match || '?'}`;
    if (!r.defaultInject) add(id, false, 'missing defaultInject');
    else add(id, true, Object.keys(r.defaultInject).join(', '));
    if (!r.upstream) add(`upstream:${r.match || '?'}`, false, 'missing upstream');
  }

  const logs = logDir || defaultLogDir();
  add('zcode-log', fs.existsSync(logs), logs);

  const v2 = v2Path || defaultZcodeV2Config();
  add('zcode-v2', fs.existsSync(v2), v2);

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
