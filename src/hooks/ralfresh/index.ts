/**
 * Ralfresh Hook - Ultimate Persistence Loop
 *
 * Initialization and phase creation for ralfresh.
 * State management is in ./state.ts to avoid circular dependency with ./loop.ts.
 */

import { canStartMode } from '../mode-registry/index.js';
import { initPlanNotepad } from '../../features/notepad-wisdom/index.js';
import { readRalfreshState, writeRalfreshState } from './state.js';
import type {
  RalfreshState,
  RalfreshPhase,
  RalfreshPhaseState,
  RalfreshConfig
} from './types.js';
import { MAX_PROMPT_LENGTH, MAX_ITERATIONS_LIMIT } from './types.js';

// Re-export types
export * from './types.js';

// Re-export state functions
export * from './state.js';

// Re-export loop functions (explicit to avoid wildcard cycle)
import {
  transitionRalfreshPhase,
  incrementRalfreshIteration,
  addRalfreshLearning,
  addRalfreshIssue,
  getRalfreshContext,
  getRalfreshContinuationPrompt,
  processRalfreshLoop,
  checkRalfreshLoop
} from './loop.js';

export {
  transitionRalfreshPhase,
  incrementRalfreshIteration,
  addRalfreshLearning,
  addRalfreshIssue,
  getRalfreshContext,
  getRalfreshContinuationPrompt,
  processRalfreshLoop,
  checkRalfreshLoop
};

/**
 * Create initial phase states
 */
function createInitialPhases(): Record<RalfreshPhase, RalfreshPhaseState> {
  return {
    planning: { status: 'pending' },
    execution: { status: 'pending' },
    review: { status: 'pending' },
    assess: { status: 'pending' },
    complete: { status: 'pending' },
    failed: { status: 'pending' }
  };
}

/**
 * Initialize ralfresh with mutual exclusion check
 *
 * @param directory Working directory
 * @param prompt Original user request
 * @param sessionId Optional session ID
 * @param config Optional configuration overrides
 * @returns Initial state or null if blocked by another exclusive mode
 */
export function initRalfresh(
  directory: string,
  prompt: string,
  sessionId?: string,
  config?: Partial<RalfreshConfig>
): RalfreshState | null {
  // Validate prompt length
  if (prompt.length > MAX_PROMPT_LENGTH) {
    console.error(`[Ralfresh] Prompt exceeds maximum length (${MAX_PROMPT_LENGTH} chars)`);
    return null;
  }

  // Validate maxIterations upper bound
  const requestedMaxIterations = config?.maxIterations ?? 5;
  if (requestedMaxIterations > MAX_ITERATIONS_LIMIT) {
    console.error(`[Ralfresh] maxIterations (${requestedMaxIterations}) exceeds limit (${MAX_ITERATIONS_LIMIT})`);
    return null;
  }

  // Check mutual exclusion
  const canStart = canStartMode('ralfresh', directory);
  if (!canStart.allowed) {
    console.error(`[Ralfresh] Cannot start: ${canStart.message}`);
    return null;
  }

  const now = new Date().toISOString();
  const timestamp = now.replace(/[:.]/g, '-').slice(0, 19);
  const notepadName = `ralfresh-${timestamp}`;

  // Initialize notepad for wisdom storage
  initPlanNotepad(notepadName, directory);

  const state: RalfreshState = {
    active: true,
    iteration: 1,
    maxIterations: requestedMaxIterations,
    phase: config?.skipPlanning ? 'execution' : 'planning',
    prompt,
    startedAt: now,
    completedAt: null,
    sessionId,
    notepadName,
    phases: createInitialPhases(),
    learnings: [],
    issues: []
  };

  // Mark first phase as in_progress
  state.phases[state.phase].status = 'in_progress';
  state.phases[state.phase].startedAt = now;

  if (writeRalfreshState(directory, state)) {
    return state;
  }

  return null;
}
