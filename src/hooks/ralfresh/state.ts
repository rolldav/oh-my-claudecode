/**
 * Ralfresh State Management
 *
 * Extracted from index.ts to break circular dependency with loop.ts.
 * Provides: read/write/clear state, active check, sub-mode cleanup.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import type { RalfreshState } from './types.js';

/**
 * Valid ralfresh phases for state validation
 */
const VALID_PHASES = new Set<string>([
  'planning',
  'execution',
  'review',
  'assess',
  'complete',
  'failed'
]);

/**
 * Get the state file path for ralfresh
 *
 * TRUST BOUNDARY: The `directory` parameter is expected to come from trusted
 * sources (process.cwd() or Claude Code hook input.directory). This function
 * normalizes the path to resolve any `..` segments but does NOT validate that
 * the directory is within an allowed base path - that responsibility lies with
 * the caller.
 *
 * @param directory - Working directory (trusted input from Claude Code)
 * @returns Absolute path to the state file
 */
function getStateFilePath(directory: string): string {
  // Normalize path to resolve any ../.. segments
  const normalizedDir = resolve(directory);
  return join(normalizedDir, '.omc', 'state', 'ralfresh-state.json');
}

/**
 * Ensure the .omc/state directory exists
 */
function ensureStateDir(directory: string): void {
  const normalizedDir = resolve(directory);
  const stateDir = join(normalizedDir, '.omc', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Validate that parsed JSON has required RalfreshState fields
 */
function isValidRalfreshState(obj: unknown): obj is RalfreshState {
  if (typeof obj !== 'object' || obj === null) return false;
  const state = obj as Record<string, unknown>;

  return (
    typeof state.active === 'boolean' &&
    typeof state.iteration === 'number' &&
    typeof state.maxIterations === 'number' &&
    typeof state.phase === 'string' &&
    VALID_PHASES.has(state.phase) &&
    typeof state.prompt === 'string' &&
    typeof state.startedAt === 'string' &&
    typeof state.notepadName === 'string' &&
    typeof state.phases === 'object' &&
    Array.isArray(state.learnings) &&
    Array.isArray(state.issues)
  );
}

/**
 * Read ralfresh state from disk
 */
export function readRalfreshState(directory: string): RalfreshState | null {
  const stateFile = getStateFilePath(directory);

  if (!existsSync(stateFile)) {
    return null;
  }

  try {
    const content = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(content);

    if (!isValidRalfreshState(parsed)) {
      console.error('[Ralfresh] Invalid state file format');
      return null;
    }

    return parsed;
  } catch (error) {
    console.error('[Ralfresh] Failed to read state:', error);
    return null;
  }
}

/**
 * Write ralfresh state to disk
 *
 * Uses atomic write pattern (temp file + rename) to prevent corruption
 * on crash during write.
 *
 * CONCURRENCY NOTE: This function performs a file write without locking.
 * It assumes a single-writer model where only one process/thread modifies
 * ralfresh state at a time. This is safe in the Claude Code context where
 * hooks run synchronously within a single session.
 */
export function writeRalfreshState(directory: string, state: RalfreshState): boolean {
  try {
    ensureStateDir(directory);
    const stateFile = getStateFilePath(directory);
    const tempFile = stateFile + '.tmp';

    // Write to temp file first
    writeFileSync(tempFile, JSON.stringify(state, null, 2));

    // Atomic rename
    renameSync(tempFile, stateFile);

    return true;
  } catch (error) {
    console.error('[Ralfresh] Failed to write state:', error);
    return false;
  }
}

/**
 * Clear ralfresh state
 */
export function clearRalfreshState(directory: string): boolean {
  const stateFile = getStateFilePath(directory);

  if (!existsSync(stateFile)) {
    return true;
  }

  try {
    unlinkSync(stateFile);
    return true;
  } catch (error) {
    console.error('[Ralfresh] Failed to clear state:', error);
    return false;
  }
}

/**
 * Check if ralfresh is currently active
 */
export function isRalfreshActive(directory: string): boolean {
  const state = readRalfreshState(directory);
  return state?.active === true;
}

/**
 * Clear all sub-mode states associated with ralfresh
 *
 * Uses MANUAL deletion for both local and global state to preserve
 * session ownership verification. clearModeState() cannot be used
 * because it deletes global state unconditionally without session checks.
 *
 * @param directory Working directory
 * @param sessionId Session ID to verify ownership for global state cleanup
 * @param force Force deletion of global state without session check
 */
export function clearAllRalfreshSubModes(
  directory: string,
  sessionId?: string,
  force: boolean = false
): boolean {
  const stateDir = join(directory, '.omc', 'state');
  let success = true;

  // ========== LOCAL STATE CLEANUP (manual) ==========
  // Manual local file deletion (safer - doesn't touch global)
  const localFilesToDelete = [
    // Ralplan / plan consensus (not a registered mode)
    'plan-consensus.json',
    // Swarm (SQLite + marker)
    'swarm.db',
    'swarm.db-wal',
    'swarm.db-shm',
    'swarm-active.marker',
    // Ultrawork
    'ultrawork-state.json',
    // Ralph
    'ralph-state.json',
    'ralph-verification.json'
  ];

  for (const file of localFilesToDelete) {
    const filePath = join(stateDir, file);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch (error) {
        console.error(`[Ralfresh] Failed to delete ${file}:`, error);
        success = false;
      }
    }
  }

  // ========== GLOBAL STATE CLEANUP (manual, with session check) ==========
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    console.warn('[Ralfresh] HOME/USERPROFILE not set, skipping global state cleanup');
    return success;
  }

  const globalStateDir = join(homeDir, '.claude');
  const globalFiles = ['ultrawork-state.json', 'ralph-state.json'];

  for (const file of globalFiles) {
    const filePath = join(globalStateDir, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const state = JSON.parse(content);

        // Only delete global state if:
        // 1. force=true (explicit force clean requested by caller), OR
        // 2. sessionId provided AND matches state's session
        //
        // NOTE: Omitting both sessionId and force=false results in NO deletion
        // of global state. This is intentional to prevent accidental cleanup
        // of other sessions' state.
        const sessionMatches = sessionId &&
          (state.session_id === sessionId || state.sessionId === sessionId);

        if (force || sessionMatches) {
          unlinkSync(filePath);
        }
      } catch (error) {
        console.error(`[Ralfresh] Failed to delete global state ${file}:`, error);
        success = false;
      }
    }
  }

  return success;
}
