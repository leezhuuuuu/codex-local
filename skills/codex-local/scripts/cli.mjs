import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexError } from './app-server.mjs';
import { checkMailbox, jobFile, readMessage, ready, remove, requestBytes, resultBytes, writeMessage } from './mailbox.mjs';
import { errorPayload, prepare } from './operations.mjs';

async function callHost(args, waitMs) {
  const host = checkMailbox() && ready();
  if (!host) throw new CodexError('SIDECAR_UNAVAILABLE', 'Open Antigravity and enable the Codex Local plugin.', { delivery: 'not_sent' });
  const id = randomUUID();
  const request = jobFile(id, 'request');
  const response = jobFile(id, 'result');
  const expiresAt = Date.now() + waitMs;
  writeMessage(request, { generation: host.generation, expiresAt, args }, requestBytes);

  function cancel(signal) {
    try { remove(request); } finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
  }
  const interrupt = () => cancel('SIGINT');
  const terminate = () => cancel('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    let lastCheck = 0;
    for (;;) {
      const result = readMessage(response, resultBytes);
      if (result) {
        if (result.ok) return result.value;
        const { code, message, ...details } = result.error;
        throw new CodexError(code, message, details);
      }
      const now = Date.now();
      if (now >= expiresAt) {
        throw new CodexError('HOST_TIMEOUT', 'Timed out waiting for the local Sidecar. Check the target chat before retrying.',
          { delivery: remove(request) ? 'not_sent' : 'unknown', request_id: id });
      }
      if (now - lastCheck >= 1000) {
        if (ready()?.generation !== host.generation) {
          throw new CodexError('HOST_RESTARTED', 'The local Sidecar stopped or restarted. Check the target chat before retrying.',
            { delivery: remove(request) ? 'not_sent' : 'unknown', request_id: id });
        }
        lastCheck = now;
      }
      await delay(180);
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    remove(request);
    remove(response);
  }
}

process.umask(0o077);
try {
  const command = prepare(process.argv.slice(2));
  if (command.help) process.stdout.write(command.help);
  else process.stdout.write(JSON.stringify(await callHost(command.args, command.waitMs), null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify(errorPayload(error)) + '\n');
  process.exitCode = 1;
}
