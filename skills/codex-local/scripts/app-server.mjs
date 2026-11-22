import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

export class CodexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class AppServer extends EventEmitter {
  constructor({ binary = process.env.CODEX_LOCAL_BIN || (existsSync(bundledCodex) ? bundledCodex : 'codex'), cwd = process.cwd() } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.receive(line));
    this.child.stdin.on('error', error => this.disconnect(error.message));
    this.child.on('error', error => this.disconnect(error.code === 'ENOENT' ? 'The Codex executable was not found. Set CODEX_LOCAL_BIN to an installed Codex CLI.' : error.message));
    this.closed = new Promise(resolve => this.child.once('close', () => {
      this.disconnect('Codex App Server closed the connection.');
      resolve();
    }));
  }

  disconnect(message) {
    if (this.failure) return;
    this.failure = new CodexError('SERVER_DISCONNECTED', message);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
    this.emit('disconnect', this.failure);
  }

  write(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  receive(line) {
    if (this.failure) return;
    let message;
    try { message = JSON.parse(line); }
    catch { this.disconnect('Codex App Server returned invalid JSON.'); return; }
    if (message.method && message.id != null) {
      const { id, method } = message;
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        this.write({ id, result: { decision: 'decline' } });
      } else {
        this.write({ id, error: { code: -32601, message: 'This local client cannot fulfill interactive requests.' } });
      }
      return;
    }
    if (message.method) { this.emit('notification', message); return; }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new CodexError('RPC_ERROR', message.error.message, { method: request.method, rpc_code: message.error.code }));
    } else request.resolve(message.result);
  }

  request(method, params, timeoutMs = 15000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError('RPC_TIMEOUT', `Codex did not answer ${method} in time.`, { method }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'antigravity-codex-local', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    return result;
  }

  async close() {
    this.lines.close();
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 800);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2500);
    await this.closed;
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}

export function threadMetadata(thread) {
  return {
    thread_id: thread.id,
    title: thread.name ?? null,
    cwd: thread.cwd,
    status: thread.status?.type ?? null,
    updated_at: typeof thread.updatedAt === 'number' ? new Date(thread.updatedAt * 1000).toISOString() : null,
    ephemeral: thread.ephemeral === true,
  };
}

export async function readThread(client, id, limit, cursor) {
  const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
  const page = await client.request('thread/turns/list', {
    threadId: id, limit, cursor, sortDirection: 'desc', itemsView: 'full',
  });
  const turns = [...page.data].reverse().map(turn => {
    const messages = [];
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const text = item.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (text) messages.push({ role: 'user', text });
      } else if (item.type === 'agentMessage' && item.phase !== 'commentary' && item.text) {
        messages.push({ role: 'assistant', text: item.text });
      }
    }
    return { turn_id: turn.id, status: turn.status, messages };
  });
  return { thread: threadMetadata(thread), turns, next_cursor: page.nextCursor ?? null };
}

function textInput(prompt) {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

function finalReply(items) {
  const messages = items.filter(item => item.type === 'agentMessage' && item.text?.trim());
  return (messages.findLast(item => item.phase === 'final_answer') ??
    messages.findLast(item => item.phase == null))?.text;
}

export async function runTurn(client, threadId, prompt, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const completed = new Map();
  const messages = new Map();
  let turnId;
  let wake;

  function notify({ method, params }) {
    if (params?.threadId !== threadId) return;
    if (method === 'turn/completed') {
      completed.set(params.turn.id, params.turn);
      if (params.turn.id === turnId) wake?.();
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (!messages.has(params.turnId)) messages.set(params.turnId, new Map());
      messages.get(params.turnId).set(params.item.id, params.item);
    }
  }

  client.on('notification', notify);
  try {
    let result;
    try {
      result = await client.request('turn/start', {
        threadId, clientUserMessageId: randomUUID(),
        input: textInput(prompt),
      }, Math.min(timeoutMs, 25000));
    } catch (error) {
      const delivery = error.code === 'RPC_ERROR' ? 'rejected' : 'unknown';
      throw new CodexError(error.code, error.message, { ...error.details, thread_id: threadId, delivery });
    }
    turnId = result.turn.id;
    const details = { thread_id: threadId, turn_id: turnId, delivery: 'accepted' };
    let turn = completed.get(turnId);
    if (!turn && result.turn.status !== 'inProgress') turn = result.turn;
    if (!turn) {
      const finished = await new Promise(resolve => {
        const onDisconnect = () => settle('closed');
        const timer = setTimeout(() => settle('timeout'), Math.max(0, deadline - performance.now()));
        function settle(reason) {
          clearTimeout(timer);
          client.off('disconnect', onDisconnect);
          wake = undefined;
          resolve(reason);
        }
        wake = () => settle('completed');
        client.once('disconnect', onDisconnect);
        if (client.failure) onDisconnect();
      });
      if (finished === 'timeout') {
        let interruption_requested = false;
        try {
          await client.request('turn/interrupt', { threadId, turnId }, 2500);
          interruption_requested = true;
        } catch { /* Keep the accepted turn ID for inspection. */ }
        throw new CodexError('TURN_TIMEOUT', 'Codex accepted the turn but did not finish by the deadline.', { ...details, interruption_requested });
      }
      if (finished === 'closed') throw new CodexError('SERVER_DISCONNECTED', 'Codex disconnected while the accepted turn was running.', details);
      turn = completed.get(turnId);
    }
    if (turn.status !== 'completed') {
      throw new CodexError('TURN_FAILED', turn.error?.message ?? `Codex turn ${turn.status}.`, { ...details, status: turn.status });
    }
    const replies = new Map(messages.get(turnId));
    for (const item of turn.items ?? []) if (item.type === 'agentMessage' && item.text) replies.set(item.id, item);
    const reply = finalReply([...replies.values()]);
    if (!reply) throw new CodexError('NO_REPLY', 'The completed turn did not contain a final text reply.', details);
    return { thread_id: threadId, turn_id: turnId, status: turn.status, reply };
  } finally {
    client.off('notification', notify);
  }
}

async function findQueuedTurn(client, query, baseline, clientId, remaining) {
  let cursor;
  do {
    if (remaining() <= 0) return;
    const page = await client.request('thread/turns/list', { ...query, limit: 10, cursor }, Math.min(15000, remaining()));
    for (const turn of page.data) {
      const inputIndex = turn.items.findIndex(item => item.type === 'userMessage' && item.clientId === clientId);
      if (inputIndex !== -1) return { turn, inputIndex };
      if (turn.id === baseline) return;
    }
    cursor = page.nextCursor;
  } while (cursor);
}

export async function runQueuedTurn(client, threadId, prompt, timeoutMs) {
  const query = { threadId, itemsView: 'summary', sortDirection: 'desc' };
  const previous = await client.request('thread/turns/list', { ...query, limit: 1 });
  const baseline = previous.data[0]?.id;
  const clientId = randomUUID();
  const details = { thread_id: threadId, client_message_id: clientId, delivery: 'unknown' };
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
  try {
    const { queuedSubmission } = await client.request('thread/queue/add',
      { threadId, clientUserMessageId: clientId, input: textInput(prompt) }, Math.min(15000, remaining()));
    details.queued_submission_id = queuedSubmission.id;
    details.delivery = 'queued';
    while (remaining()) {
      let match;
      try { match = await findQueuedTurn(client, query, baseline, clientId, remaining); }
      catch (error) {
        if (error.code === 'RPC_TIMEOUT' && !remaining()) break;
        throw error;
      }
      if (match) {
        const { turn, inputIndex } = match;
        details.turn_id = turn.id;
        details.delivery = 'accepted';
        if (turn.status === 'completed') {
          const otherInput = turn.items.findIndex((item, index) => index > inputIndex && item.type === 'userMessage');
          const reply = finalReply(turn.items.slice(inputIndex + 1, otherInput === -1 ? undefined : otherInput));
          if (reply) return { ...details, status: turn.status, reply };
          if (otherInput !== -1) throw new CodexError('REPLY_AMBIGUOUS', 'Another message arrived in the same turn before its final reply.');
          throw new CodexError('NO_REPLY', 'The completed turn did not contain a final text reply.');
        }
        // A reader in a separate process can see an unfinished turn as interrupted.
        if (turn.status !== 'inProgress' && turn.completedAt != null) {
          throw new CodexError('TURN_FAILED', turn.error?.message ?? `Codex turn ${turn.status}.`, { status: turn.status });
        }
      }
      await delay(Math.min(1500, remaining()));
    }
    if (!details.turn_id) {
      try {
        const { deleted } = await client.request('thread/queue/delete',
          { threadId, queuedSubmissionId: details.queued_submission_id }, 2500);
        details.delivery = deleted ? 'canceled' : 'unknown';
      } catch { details.delivery = 'unknown'; }
    }
    throw new CodexError('QUEUE_TIMEOUT', 'No matched final reply arrived before the deadline.');
  } catch (error) {
    if (!details.queued_submission_id && error.code === 'RPC_ERROR') details.delivery = 'rejected';
    throw new CodexError(error.code ?? 'QUEUE_ERROR', error.message, { ...error.details, ...details });
  }
}
