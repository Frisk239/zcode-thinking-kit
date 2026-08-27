import fs from 'fs';

export function writePidRecord(file, rec) {
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        pid: rec.pid,
        port: rec.port,
        startedAt: rec.startedAt || new Date().toISOString(),
        name: 'zcode-thinking-kit',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

export function readPidRecord(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      const pid = Number(j.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, port: j.port, startedAt: j.startedAt, name: j.name };
    }
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid };
  } catch {
    return null;
  }
}

export function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function removePidFile(file, onlyPid) {
  try {
    if (onlyPid) {
      const rec = readPidRecord(file);
      if (rec && rec.pid !== onlyPid) return;
    }
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
