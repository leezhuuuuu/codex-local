import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AppServer, CodexError, readThread, runQueuedTurn, runTurn, threadMetadata } from './app-server.mjs';

const help = `Codex Local

Usage:
  codex-local status
  codex-local list [--search TITLE] [--cwd DIRECTORY] [--limit N] [--cursor CURSOR] [--archived]
  codex-local read THREAD_ID [--tail TURNS] [--cursor CURSOR]
  codex-local new --prompt TEXT [--title TITLE] [--cwd DIRECTORY] [--model MODEL] [--ephemeral]
  codex-local send THREAD_ID --prompt TEXT [--read-only]

For new and send, use --prompt-file FILE instead of --prompt. Use - for stdin.
Both commands wait for the reply. --timeout SECONDS defaults to 180.
Local execution defaults to read-only. Pass --workspace-write to allow edits.
When Codex already owns the thread, send uses its existing permissions.
An explicit --read-only or --workspace-write requires the thread to be available for local execution.
Successful commands return JSON on stdout. Errors return JSON on stderr.
`;

const string = { type: 'string' };
const bool = { type: 'boolean' };
const turnOptions = { prompt: string, 'prompt-file': string, timeout: string, 'workspace-write': bool };
const options = {
  status: {},
  list: { search: string, cwd: string, limit: string, cursor: string, archived: bool },
  read: { tail: string, cursor: string },
  new: { ...turnOptions, title: string, cwd: string, model: string, ephemeral: bool },
  send: { ...turnOptions, 'read-only': bool },
};

function threadId(value) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value ?? '')) {
    throw new CodexError('INVALID_THREAD_ID', 'Expected a Codex thread UUID.');
  }
  return value.toLowerCase();
}

function numeric(option, input, fallback, maximum) {
  if (input === undefined) return fallback;
  const number = /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new CodexError('USAGE', `--${option} requires an integer from 1 to ${maximum}.`);
  }
  return number;
}

function promptText(values, allowFile) {
  const hasText = values.prompt !== undefined;
  const hasFile = values['prompt-file'] !== undefined;
  if (hasText === hasFile) throw new CodexError('USAGE', 'Provide exactly one of --prompt and --prompt-file.');
  let text = values.prompt;
  if (hasFile) {
    if (!allowFile) throw new CodexError('INVALID_PROMPT_SOURCE', 'The CLI must read prompt files before sending the request.');
    try { text = readFileSync(values['prompt-file'] === '-' ? 0 : values['prompt-file'], 'utf8'); }
    catch (error) { throw new CodexError('PROMPT_UNAVAILABLE', error.message); }
  }
  if (!text.trim() || text.includes('\0')) throw new CodexError('INVALID_PROMPT', 'Provide nonempty text without NUL characters.');
  return text;
}

function directory(value) {
  const target = resolve(value ?? process.cwd());
  try { if (statSync(target).isDirectory()) return target; }
  catch { /* Report missing paths and non-directories consistently. */ }
  throw new CodexError('INVALID_DIRECTORY', `Directory unavailable: ${target}`);
}

async function lockedSend(id, action) {
  // macOS lockf keeps the exclusive lock until this helper's stdin closes.
  const file = join(tmpdir(), `antigravity-codex-${process.getuid()}-${id}.lock`);
  const lock = spawn('/usr/bin/lockf', ['-ks', '-t', '0', file, '/bin/sh', '-c', 'printf "ready\\n"; /bin/cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => lock.once('close', resolve));
  lock.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      lock.stdout.once('data', resolve);
      lock.once('error', error => reject(new CodexError('LOCK_UNAVAILABLE', error.message)));
      closed.then(code => reject(new CodexError(code === 75 ? 'BUSY' : 'LOCK_UNAVAILABLE',
        code === 75 ? 'A local request is already sending to this Codex thread.' : 'Could not acquire the local Codex thread lock.',
        { thread_id: id, delivery: 'not_sent' })));
    });
    return await action();
  } finally {
    lock.stdin.end();
    await closed;
  }
}

async function withServer(cwd, action) {
  const server = new AppServer({ cwd });
  try {
    const info = await server.initialize();
    return await action(server, info);
  } finally {
    await server.close();
  }
}

function parseCommand([command, ...args]) {
  if (!command || ['--help', '-h', 'help'].includes(command)) return null;
  if (!Object.hasOwn(options, command)) throw new CodexError('USAGE', `Unknown command ${command}. Run with --help.`);

  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { ...options[command], help: { ...bool, short: 'h' } } });
  } catch (error) { throw new CodexError('USAGE', error.message); }
  const { values, positionals } = parsed;
  if (values.help) return null;
  if (values['read-only'] && values['workspace-write']) {
    throw new CodexError('USAGE', 'Choose either --read-only or --workspace-write.');
  }
  const hasId = command === 'read' || command === 'send';
  if (positionals.length !== Number(hasId)) throw new CodexError('USAGE', `${command} ${hasId ? 'requires one thread ID' : 'takes no positional arguments'}.`);
  const id = hasId ? threadId(positionals[0]) : undefined;
  const writing = command === 'new' || command === 'send';
  const timeout = writing ? numeric('timeout', values.timeout, 180, 3600) * 1000 : undefined;
  return { command, values, id, writing, timeout };
}

export function prepare(argv) {
  const parsed = parseCommand(argv);
  if (!parsed) return { help };
  const { command, values, id, writing, timeout } = parsed;
  if (writing) {
    values.prompt = promptText(values, true);
    delete values['prompt-file'];
  }
  if (values.cwd !== undefined) values.cwd = resolve(values.cwd);
  const args = id ? [command, id] : [command];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'boolean') { if (value) args.push(`--${key}`); }
    else args.push(`--${key}=${value}`);
  }
  return { args, waitMs: writing ? timeout + 65000 : 50000 };
}

export async function invoke(argv, defaultCwd) {
  const parsed = parseCommand(argv);
  if (!parsed) return help;
  const { command, values, id, writing, timeout } = parsed;
  const prompt = writing ? promptText(values, false) : undefined;
  if (command === 'new' && values['workspace-write'] && !values.cwd) {
    throw new CodexError('USAGE', 'Specify --cwd for edits in a new Codex workspace.');
  }
  const cwd = directory(values.cwd ?? defaultCwd);
  const sandbox = values['workspace-write'] ? 'workspace-write' : 'read-only';

  async function operation() {
    return withServer(cwd, async (server, info) => {
      if (command === 'status') return { ready: true, server: info.userAgent, platform: info.platformOs };
      if (command === 'list') {
        const response = await server.request('thread/list', {
          limit: numeric('limit', values.limit, 20, 100), cursor: values.cursor,
          sortKey: 'updated_at', currentAccountOnly: true, archived: values.archived ?? false,
          searchTerm: values.search, cwd: values.cwd === undefined ? undefined : cwd,
        });
        return { threads: response.data.map(threadMetadata), next_cursor: response.nextCursor ?? null };
      }
      if (command === 'read') return readThread(server, id, numeric('tail', values.tail, 5, 100), values.cursor);

      if (command === 'new') {
        const { thread } = await server.request('thread/start', {
          cwd, model: values.model, ephemeral: values.ephemeral === true, sandbox, approvalPolicy: 'never',
        });
        if (values.ephemeral && thread.ephemeral !== true) {
          throw new CodexError('EPHEMERAL_UNAVAILABLE', 'Codex did not create an ephemeral thread.', { thread_id: thread.id, delivery: 'not_sent' });
        }
        if (values.title?.trim()) {
          try { await server.request('thread/name/set', { threadId: thread.id, name: values.title }); }
          catch (error) { throw new CodexError(error.code, error.message, { ...error.details, thread_id: thread.id, delivery: 'not_sent' }); }
        }
        return { ...await runTurn(server, thread.id, prompt, timeout), ephemeral: thread.ephemeral === true };
      }

      const { thread: saved } = await server.request('thread/read', { threadId: id, includeTurns: false });
      if (saved.status?.type === 'active') throw new CodexError('BUSY', 'This Codex thread has an active turn.', { thread_id: id, delivery: 'not_sent' });
      let thread;
      try {
        ({ thread } = await server.request('thread/resume', { threadId: id, excludeTurns: true, sandbox, approvalPolicy: 'never' }));
      } catch (error) {
        if (error.details?.rpc_code !== -32600 || !error.message.includes(`thread ${id} already has an active writer`)) {
          throw new CodexError(error.code, error.message, { ...error.details, thread_id: id, delivery: 'not_sent' });
        }
        if (values['read-only'] || values['workspace-write']) {
          throw new CodexError('THREAD_OWNED', 'The current Codex process controls this thread and its sandbox.', { thread_id: id, delivery: 'not_sent' });
        }
        return runQueuedTurn(server, id, prompt, timeout);
      }
      if (thread.id !== id || thread.status?.type === 'active' || thread.canAcceptDirectInput === false) {
        throw new CodexError('THREAD_UNAVAILABLE', 'Codex did not open the requested thread for a new turn.', { thread_id: id, delivery: 'not_sent' });
      }
      return runTurn(server, id, prompt, timeout);
    });
  }

  return command === 'send' ? lockedSend(id, operation) : operation();
}

export function errorPayload(error) {
  return { error: { code: error.code ?? 'UNEXPECTED', message: error.message, ...error.details } };
}
