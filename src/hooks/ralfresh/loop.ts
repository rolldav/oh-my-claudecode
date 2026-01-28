/**
 * Ralfresh Loop - Phase Transitions and Continuation Logic
 *
 * Handles:
 * - Phase transitions with validation
 * - Iteration increment and reset
 * - Wisdom accumulation (learnings, issues)
 * - Continuation prompt generation
 * - Loop check for persistent-mode integration
 */

import { readRalfreshState, writeRalfreshState, clearRalfreshState, clearAllRalfreshSubModes } from './state.js';
import { MAX_LEARNINGS, MAX_ISSUES, MAX_ENTRY_LENGTH } from './types.js';
import type { RalfreshState, RalfreshPhase, RalfreshLoopResult } from './types.js';
import { addLearning as addNotepadLearning, addIssue as addNotepadIssue, readPlanWisdom } from '../../features/notepad-wisdom/index.js';

/**
 * Valid phase transitions
 */
const VALID_TRANSITIONS: Record<RalfreshPhase, RalfreshPhase[]> = {
  planning: ['execution'],
  execution: ['review'],
  review: ['assess'],
  // NOTE: assess->planning is NOT allowed directly. Use incrementRalfreshIteration()
  // which properly increments iteration, resets phases, and clears sub-mode state.
  assess: ['complete', 'failed'],
  complete: [],
  failed: []
};

/**
 * Transition ralfresh to a new phase
 *
 * CONCURRENCY NOTE: This function performs a read-modify-write cycle without
 * file locking. It assumes a single-writer model where only one process/thread
 * modifies ralfresh state at a time. This is safe in the Claude Code context
 * where hooks run synchronously within a single session.
 */
export function transitionRalfreshPhase(
  directory: string,
  newPhase: RalfreshPhase
): RalfreshState | null {
  const state = readRalfreshState(directory);
  if (!state || !state.active) {
    return null;
  }

  // Validate transition
  const validNextPhases = VALID_TRANSITIONS[state.phase];
  if (!validNextPhases.includes(newPhase)) {
    console.error(`[Ralfresh] Invalid phase transition: ${state.phase} -> ${newPhase}`);
    return null;
  }

  const now = new Date().toISOString();

  // Complete current phase
  state.phases[state.phase].status = 'complete';
  state.phases[state.phase].completedAt = now;

  // Start new phase
  state.phase = newPhase;
  state.phases[newPhase].status = 'in_progress';
  state.phases[newPhase].startedAt = now;

  // Handle terminal phases
  if (newPhase === 'complete' || newPhase === 'failed') {
    state.active = false;
    state.completedAt = now;
  }

  if (writeRalfreshState(directory, state)) {
    return state;
  }
  return null;
}

/**
 * Increment ralfresh iteration (after architect rejection)
 * Resets phases and prepares for new iteration
 *
 * CONCURRENCY NOTE: Performs read-modify-write without file locking.
 * Assumes single-writer model - safe in Claude Code hook context.
 */
export function incrementRalfreshIteration(directory: string, sessionId?: string): RalfreshState | null {
  const state = readRalfreshState(directory);
  if (!state || !state.active) {
    return null;
  }

  // Check max iterations
  if (state.iteration >= state.maxIterations) {
    console.error(`[Ralfresh] Max iterations (${state.maxIterations}) reached`);
    return transitionRalfreshPhase(directory, 'failed');
  }

  const now = new Date().toISOString();

  // Increment iteration
  state.iteration += 1;

  // Reset all phase statuses
  for (const phase of Object.keys(state.phases) as RalfreshPhase[]) {
    state.phases[phase] = { status: 'pending' };
  }

  // Start planning phase
  state.phase = 'planning';
  state.phases.planning.status = 'in_progress';
  state.phases.planning.startedAt = now;

  // Clear linked sub-modes for fresh start
  clearAllRalfreshSubModes(directory, sessionId);

  if (writeRalfreshState(directory, state)) {
    return state;
  }
  return null;
}

/**
 * Add a learning to ralfresh state and notepad
 *
 * CONCURRENCY NOTE: Performs read-modify-write without file locking.
 * Assumes single-writer model - safe in Claude Code hook context.
 */
export function addRalfreshLearning(directory: string, learning: string): boolean {
  const state = readRalfreshState(directory);
  if (!state) {
    return false;
  }

  // Truncate entry if too long
  const truncatedLearning = learning.length > MAX_ENTRY_LENGTH
    ? learning.slice(0, MAX_ENTRY_LENGTH - 3) + '...'
    : learning;

  // Add to state, keeping only most recent entries
  state.learnings.push(truncatedLearning);
  if (state.learnings.length > MAX_LEARNINGS) {
    state.learnings = state.learnings.slice(-MAX_LEARNINGS);
  }

  // Also write to notepad
  addNotepadLearning(state.notepadName, truncatedLearning, directory);

  return writeRalfreshState(directory, state);
}

/**
 * Add an issue to ralfresh state and notepad
 *
 * CONCURRENCY NOTE: Performs read-modify-write without file locking.
 * Assumes single-writer model - safe in Claude Code hook context.
 */
export function addRalfreshIssue(directory: string, issue: string): boolean {
  const state = readRalfreshState(directory);
  if (!state) {
    return false;
  }

  // Truncate entry if too long
  const truncatedIssue = issue.length > MAX_ENTRY_LENGTH
    ? issue.slice(0, MAX_ENTRY_LENGTH - 3) + '...'
    : issue;

  // Add to state, keeping only most recent entries
  state.issues.push(truncatedIssue);
  if (state.issues.length > MAX_ISSUES) {
    state.issues = state.issues.slice(-MAX_ISSUES);
  }

  // Also write to notepad
  addNotepadIssue(state.notepadName, truncatedIssue, directory);

  return writeRalfreshState(directory, state);
}

/**
 * Get accumulated context for ralfresh continuation
 */
export function getRalfreshContext(directory: string): string {
  const state = readRalfreshState(directory);
  if (!state) {
    return '';
  }

  const parts: string[] = [];

  // Load notepad wisdom
  const wisdom = readPlanWisdom(state.notepadName, directory);
  if (wisdom) {
    if (wisdom.learnings.length > 0) {
      parts.push(`## Previous Learnings\n${wisdom.learnings.map(l => `- ${l}`).join('\n')}`);
    }
    if (wisdom.decisions.length > 0) {
      parts.push(`## Decisions Made\n${wisdom.decisions.map(d => `- ${d}`).join('\n')}`);
    }
    if (wisdom.issues.length > 0) {
      parts.push(`## Known Issues\n${wisdom.issues.map(i => `- ${i}`).join('\n')}`);
    }
    if (wisdom.problems.length > 0) {
      parts.push(`## Problems Encountered\n${wisdom.problems.map(p => `- ${p}`).join('\n')}`);
    }
  }

  // Add iteration context
  parts.push(`\n## Ralfresh Status\n- Iteration: ${state.iteration}/${state.maxIterations}\n- Phase: ${state.phase}\n- Original Task: ${state.prompt}`);

  return parts.join('\n\n');
}

/**
 * Generate phase-specific continuation prompt
 */
export function getRalfreshContinuationPrompt(state: RalfreshState): string {
  const iterInfo = `[Iteration ${state.iteration}/${state.maxIterations}]`;

  switch (state.phase) {
    case 'planning':
      return `${iterInfo} **RALFRESH PLANNING PHASE**

You are in the ralfresh planning phase. Use the /oh-my-claudecode:ralplan skill to achieve planning consensus between Planner, Architect, and Critic.

Original task: ${state.prompt}

DO NOT STOP until planning consensus is reached. When approved, transition to execution phase.`;

    case 'execution':
      return `${iterInfo} **RALFRESH EXECUTION PHASE**

You are in the ralfresh execution phase. Use /oh-my-claudecode:swarm or /oh-my-claudecode:ultrawork to execute the approved plan with maximum parallelism.

Original task: ${state.prompt}

DO NOT STOP until all planned work is implemented. When complete, transition to review phase.`;

    case 'review':
      return `${iterInfo} **RALFRESH REVIEW PHASE**

You are in the ralfresh review phase. Spawn the Architect agent to verify the implementation meets all requirements.

Original task: ${state.prompt}

The Architect MUST approve before proceeding. If rejected, capture issues and transition to assess phase.`;

    case 'assess':
      return `${iterInfo} **RALFRESH ASSESSMENT PHASE**

The Architect has reviewed the implementation. Based on the review:

- If APPROVED: Transition to 'complete' phase. Task is done.
- If REJECTED with iterations remaining: Capture learnings, increment iteration, start fresh planning with wisdom.
- If REJECTED and max iterations reached: Transition to 'failed' phase. Report partial completion.

Original task: ${state.prompt}`;

    default:
      return '';
  }
}

/**
 * Process ralfresh loop status for persistent-mode integration
 * Returns RalfreshLoopResult which is mapped to PersistentModeResult by persistent-mode
 *
 * NOTE: This function has side effects - it clears state when ralfresh reaches a terminal phase.
 */
export async function processRalfreshLoop(
  sessionId?: string,
  directory?: string
): Promise<RalfreshLoopResult | null> {
  const workingDir = directory || process.cwd();
  const state = readRalfreshState(workingDir);

  // Not active
  if (!state?.active) {
    return null;
  }

  // Check if in terminal phase
  if (state.phase === 'complete' || state.phase === 'failed') {
    // Clean up and allow stop
    clearRalfreshState(workingDir);
    clearAllRalfreshSubModes(workingDir, sessionId);
    return {
      shouldBlock: false,
      message: state.phase === 'complete'
        ? `✅ Ralfresh completed successfully after ${state.iteration} iteration(s).`
        : `⚠️ Ralfresh failed after ${state.iteration} iteration(s). Max iterations reached.`,
      phase: state.phase,
      metadata: {
        iteration: state.iteration,
        maxIterations: state.maxIterations
      }
    };
  }

  // Active phase - block stop and inject continuation
  const continuationPrompt = getRalfreshContinuationPrompt(state);
  const context = getRalfreshContext(workingDir);

  return {
    shouldBlock: true,
    message: `<ralfresh-continuation>

${continuationPrompt}

${context ? `<ralfresh-wisdom>\n${context}\n</ralfresh-wisdom>` : ''}

</ralfresh-continuation>`,
    phase: state.phase,
    metadata: {
      iteration: state.iteration,
      maxIterations: state.maxIterations
    }
  };
}

/**
 * @deprecated Use processRalfreshLoop instead.
 * Scheduled for removal in v4.0.0.
 */
export const checkRalfreshLoop = processRalfreshLoop;
