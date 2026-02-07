// src/team/fs-utils.ts

/**
 * Shared filesystem utilities with permission hardening.
 *
 * All file writes default to 0o600 (owner-only read/write).
 * All directory creates default to 0o700 (owner-only access).
 * Atomic writes use PID+timestamp temp files to prevent collisions.
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, resolve, relative } from 'path';

/** Atomic write: write JSON to temp file with permissions, then rename (prevents corruption on crash) */
export function atomicWriteJson(filePath: string, data: unknown, mode: number = 0o600): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode });
  renameSync(tmpPath, filePath);
}

/** Write file with explicit permission mode */
export function writeFileWithMode(filePath: string, data: string, mode: number = 0o600): void {
  writeFileSync(filePath, data, { encoding: 'utf-8', mode });
}

/** Append to file with explicit permission mode. Creates with mode if file doesn't exist. */
export function appendFileWithMode(filePath: string, data: string, mode: number = 0o600): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, data, { encoding: 'utf-8', mode });
  } else {
    appendFileSync(filePath, data, 'utf-8');
  }
}

/** Create directory with explicit permission mode */
export function ensureDirWithMode(dirPath: string, mode: number = 0o700): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true, mode });
}

/** Validate that a resolved path is under the expected base directory. Throws if not. */
export function validateResolvedPath(resolvedPath: string, expectedBase: string): void {
  const absResolved = resolve(resolvedPath);
  const absBase = resolve(expectedBase);
  const rel = relative(absBase, absResolved);
  if (rel.startsWith('..') || resolve(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}
