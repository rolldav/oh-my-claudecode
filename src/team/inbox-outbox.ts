// src/team/inbox-outbox.ts

/**
 * Inbox/Outbox JSONL Messaging for MCP Team Bridge
 *
 * File-based communication channels between team lead and MCP workers.
 * Uses JSONL format with offset cursor for efficient incremental reads.
 */

import {
  readFileSync, existsSync,
  statSync, unlinkSync, renameSync, openSync,
  readSync, closeSync
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { InboxMessage, OutboxMessage, ShutdownSignal, InboxCursor } from './types.js';
import { sanitizeName } from './tmux-session.js';
import { appendFileWithMode, writeFileWithMode, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';

/** Maximum bytes to read from inbox in a single call (10 MB) */
const MAX_INBOX_READ_SIZE = 10 * 1024 * 1024;

// --- Path helpers ---

function teamsDir(teamName: string): string {
  const result = join(homedir(), '.claude', 'teams', sanitizeName(teamName));
  validateResolvedPath(result, join(homedir(), '.claude', 'teams'));
  return result;
}

function inboxPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.jsonl`);
}

function inboxCursorPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.offset`);
}

function outboxPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'outbox', `${sanitizeName(workerName)}.jsonl`);
}

function signalPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'signals', `${sanitizeName(workerName)}.shutdown`);
}

/** Ensure directory exists for a file path */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  ensureDirWithMode(dir);
}

// --- Outbox (worker -> lead) ---

/**
 * Append a message to the outbox JSONL file.
 * Creates directories if needed.
 */
export function appendOutbox(teamName: string, workerName: string, message: OutboxMessage): void {
  const filePath = outboxPath(teamName, workerName);
  ensureDir(filePath);
  appendFileWithMode(filePath, JSON.stringify(message) + '\n');
}

/**
 * Rotate outbox if it exceeds maxLines.
 * Keeps the most recent maxLines/2 entries, discards older.
 * Prevents unbounded growth.
 */
export function rotateOutboxIfNeeded(teamName: string, workerName: string, maxLines: number): void {
  const filePath = outboxPath(teamName, workerName);
  if (!existsSync(filePath)) return;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length <= maxLines) return;

    // Keep the most recent half
    const keepCount = Math.floor(maxLines / 2);
    const kept = lines.slice(-keepCount);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileWithMode(tmpPath, kept.join('\n') + '\n');
    renameSync(tmpPath, filePath);
  } catch {
    // Rotation failure is non-fatal
  }
}

/**
 * Rotate inbox if it exceeds maxSizeBytes.
 * Keeps the most recent half of lines, discards older.
 * Prevents unbounded growth of inbox files.
 */
export function rotateInboxIfNeeded(teamName: string, workerName: string, maxSizeBytes: number): void {
  const filePath = inboxPath(teamName, workerName);
  if (!existsSync(filePath)) return;

  try {
    const stat = statSync(filePath);
    if (stat.size <= maxSizeBytes) return;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // Keep the most recent half
    const keepCount = Math.max(1, Math.floor(lines.length / 2));
    const kept = lines.slice(-keepCount);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileWithMode(tmpPath, kept.join('\n') + '\n');
    renameSync(tmpPath, filePath);

    // Reset cursor since file content changed
    const cursorFile = inboxCursorPath(teamName, workerName);
    writeFileWithMode(cursorFile, JSON.stringify({ bytesRead: 0 }));
  } catch {
    // Rotation failure is non-fatal
  }
}

// --- Inbox (lead -> worker) ---

/**
 * Read new inbox messages using offset cursor.
 *
 * Uses byte-offset cursor to avoid clock skew issues:
 * 1. Read cursor from {worker}.offset file (default: 0)
 * 2. Open inbox JSONL, seek to offset
 * 3. Read from offset to EOF
 * 4. Parse new JSONL lines
 * 5. Update cursor to new file position
 *
 * Handles file truncation (cursor > file size) by resetting cursor.
 */
export function readNewInboxMessages(teamName: string, workerName: string): InboxMessage[] {
  const inbox = inboxPath(teamName, workerName);
  const cursorFile = inboxCursorPath(teamName, workerName);

  if (!existsSync(inbox)) return [];

  // Read cursor
  let offset = 0;
  if (existsSync(cursorFile)) {
    try {
      const cursor: InboxCursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
      offset = cursor.bytesRead;
    } catch { /* reset to 0 */ }
  }

  // Check file size
  const stat = statSync(inbox);

  // Handle file truncation (cursor beyond file size)
  if (stat.size < offset) {
    offset = 0;
  }

  if (stat.size <= offset) return []; // No new data

  // Read from offset (capped to prevent OOM on huge inboxes)
  const readSize = stat.size - offset;
  const cappedSize = Math.min(readSize, MAX_INBOX_READ_SIZE);
  if (cappedSize < readSize) {
    console.warn(`[inbox-outbox] Inbox for ${workerName} exceeds ${MAX_INBOX_READ_SIZE} bytes, reading truncated`);
  }
  const fd = openSync(inbox, 'r');
  const buffer = Buffer.alloc(cappedSize);
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }

  const newData = buffer.toString('utf-8');
  const messages: InboxMessage[] = [];
  let lastNewlineOffset = 0; // Track bytes consumed through last complete line

  const lines = newData.split('\n');
  let bytesProcessed = 0;
  for (const line of lines) {
    bytesProcessed += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
      lastNewlineOffset = bytesProcessed;
    } catch {
      // Stop at first malformed line — don't skip past it
      break;
    }
  }

  // Advance cursor only through last successfully parsed newline boundary
  const newOffset = offset + (lastNewlineOffset > 0 ? lastNewlineOffset : 0);
  ensureDir(cursorFile);
  const newCursor: InboxCursor = { bytesRead: newOffset > offset ? newOffset : offset };
  writeFileWithMode(cursorFile, JSON.stringify(newCursor));

  return messages;
}

/** Read ALL inbox messages (for initial load or debugging) */
export function readAllInboxMessages(teamName: string, workerName: string): InboxMessage[] {
  const inbox = inboxPath(teamName, workerName);
  if (!existsSync(inbox)) return [];

  try {
    const content = readFileSync(inbox, 'utf-8');
    const messages: InboxMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
    return messages;
  } catch {
    return [];
  }
}

/** Clear inbox (truncate file + reset cursor) */
export function clearInbox(teamName: string, workerName: string): void {
  const inbox = inboxPath(teamName, workerName);
  const cursorFile = inboxCursorPath(teamName, workerName);

  if (existsSync(inbox)) {
    try { writeFileWithMode(inbox, ''); } catch { /* ignore */ }
  }
  if (existsSync(cursorFile)) {
    try { writeFileWithMode(cursorFile, JSON.stringify({ bytesRead: 0 })); } catch { /* ignore */ }
  }
}

// --- Shutdown signals ---

/** Write a shutdown signal file */
export function writeShutdownSignal(teamName: string, workerName: string, requestId: string, reason: string): void {
  const filePath = signalPath(teamName, workerName);
  ensureDir(filePath);
  const signal: ShutdownSignal = {
    requestId,
    reason,
    timestamp: new Date().toISOString(),
  };
  writeFileWithMode(filePath, JSON.stringify(signal, null, 2));
}

/** Check if shutdown signal exists, return parsed content or null */
export function checkShutdownSignal(teamName: string, workerName: string): ShutdownSignal | null {
  const filePath = signalPath(teamName, workerName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ShutdownSignal;
  } catch {
    return null;
  }
}

/** Delete the shutdown signal file after processing */
export function deleteShutdownSignal(teamName: string, workerName: string): void {
  const filePath = signalPath(teamName, workerName);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// --- Cleanup ---

/** Remove all inbox/outbox/signal files for a worker */
export function cleanupWorkerFiles(teamName: string, workerName: string): void {
  const files = [
    inboxPath(teamName, workerName),
    inboxCursorPath(teamName, workerName),
    outboxPath(teamName, workerName),
    signalPath(teamName, workerName),
  ];
  for (const f of files) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
