import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CodexError } from './app-server.mjs';
import { checkMailbox, jobFile, readMessage, ready, readyFile, remove, requestBytes, resultBytes, root, version, writeMessage } from './mailbox.mjs';
import { errorPayload, invoke } from './operations.mjs';

const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
if (!dataDir || !process.env.ANTIGRAVITY_LS_ADDRESS) throw new Error('Run the CLI host as an Antigravity Sidecar.');

process.umask(0o077);
checkMailbox(true);
const workspace = join(dataDir, 'workspace');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const generation = randomUUID();
const active = new Set();
const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const pendingFile = new RegExp(`^(${idPattern})\\.request\\.json$`);
const managedFile = new RegExp(`^(${idPattern})\\.(?:(?:request|running|result)\\.json|tmp)$`);

function heartbeat() {
  writeMessage(readyFile, { generation, version, updatedAt: Date.now() }, 4096);
}

async function processJob(id, running) {
  const reply = jobFile(id, 'result');
  try {
    const job = readMessage(running, requestBytes);
    if (!job || job.generation !== generation || !Number.isFinite(job.expiresAt) || job.expiresAt <= Date.now()) {
      throw new CodexError('STALE_REQUEST', 'The request expired or belongs to a previous Sidecar process.', { delivery: 'not_sent' });
    }
    if (!Array.isArray(job.args) || job.args.length === 0 || job.args.some(arg => typeof arg !== 'string')) {
      throw new CodexError('INVALID_REQUEST', 'Expected a Codex Local command.');
    }
    const value = await invoke(job.args, workspace);
    const result = job.args[0] === 'status' ? { ...value, transport: 'sidecar' } : value;
    writeMessage(reply, { ok: true, value: result }, resultBytes);
  } catch (error) {
    try { writeMessage(reply, { ok: false, ...errorPayload(error) }, resultBytes); }
    catch { console.error('Could not deliver a Codex Local CLI result.'); }
  } finally {
    remove(running);
    active.delete(id);
  }
}

function scan() {
  for (const name of readdirSync(root)) {
    if (active.size >= 4) break;
    const id = pendingFile.exec(name)?.[1];
    if (!id || active.has(id)) continue;
    const running = jobFile(id, 'running');
    try { renameSync(join(root, name), running); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    active.add(id);
    void processJob(id, running);
  }
}

function prune() {
  for (const name of readdirSync(root)) {
    const id = managedFile.exec(name)?.[1];
    if (!id || active.has(id)) continue;
    const file = join(root, name);
    try { if (Date.now() - lstatSync(file).mtimeMs > 65 * 60 * 1000) remove(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

heartbeat();
console.log('Codex Local CLI Sidecar ready.');
const heartbeatTimer = setInterval(heartbeat, 1000);
const scanTimer = setInterval(scan, 180);
const pruneTimer = setInterval(prune, 60000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(heartbeatTimer);
    clearInterval(scanTimer);
    clearInterval(pruneTimer);
    if (ready()?.generation === generation) remove(readyFile);
    process.exit(0);
  });
}
