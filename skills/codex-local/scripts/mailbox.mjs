import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexError } from './app-server.mjs';

// The macOS terminal sandbox allows temporary files. A shared fixed path also works when TMPDIR differs.
export const root = join('/private/tmp', `antigravity-codex-local-${process.getuid()}`);
export const version = 1;
export const requestBytes = 256 * 1024;
export const resultBytes = 16 * 1024 * 1024;
export const readyFile = join(root, 'ready.json');
export const staleAfterMs = 8000;
export const jobFile = (id, kind) => join(root, `${id}.${kind}.json`);

export function checkMailbox(create = false) {
  try {
    if (create) {
      try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const state = lstatSync(root);
    if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077) !== 0) {
      throw new CodexError('UNSAFE_MAILBOX', 'The CLI mailbox must be a private directory owned by this user.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && !create) return false;
    throw error;
  }
}

export function readMessage(file, limit) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > limit) {
      throw new CodexError('INVALID_MESSAGE', 'Invalid mailbox message file.');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function remove(file) {
  try { unlinkSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function writeMessage(file, value, limit) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) throw new CodexError('MESSAGE_TOO_LARGE', 'The mailbox message exceeds the size limit.');
  const temporary = join(root, `${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    remove(temporary);
  }
}

export function ready() {
  const info = readMessage(readyFile, 4096);
  if (info?.version !== version || typeof info.generation !== 'string' || !Number.isFinite(info.updatedAt)
    || Math.abs(Date.now() - info.updatedAt) > staleAfterMs) return undefined;
  return info;
}
