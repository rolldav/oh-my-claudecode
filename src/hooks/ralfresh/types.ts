/**
 * Ralfresh Types
 *
 * Type definitions for the ralfresh hook - the ultimate persistence loop combining:
 * - ralplan (planning consensus)
 * - swarm/ultrawork (parallel execution)
 * - architect verification (quality gate)
 * - context refresh (clear and restart with learnings)
 */

/**
 * Ralfresh execution phases
 */
export type RalfreshPhase =
  | 'planning'    // ralplan consensus planning
  | 'execution'   // swarm/ultrawork parallel execution
  | 'review'      // architect verification
  | 'assess'      // evaluate results, decide next action
  | 'complete'    // successfully completed
  | 'failed';     // failed after max iterations

/**
 * Status of an individual phase
 */
export type RalfreshPhaseStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

/**
 * State for an individual phase
 */
export interface RalfreshPhaseState {
  status: RalfreshPhaseStatus;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Complete ralfresh state persisted to disk
 */
export interface RalfreshState {
  /** Whether ralfresh is currently active */
  active: boolean;
  /** Current iteration number (1-based) */
  iteration: number;
  /** Maximum iterations before stopping */
  maxIterations: number;
  /** Current phase of execution */
  phase: RalfreshPhase;
  /** Original user request */
  prompt: string;
  /** ISO timestamp when ralfresh started */
  startedAt: string;
  /** ISO timestamp when ralfresh completed (null if still running) */
  completedAt: string | null;
  /** Session ID the loop is bound to */
  sessionId?: string;
  /** Notepad name for wisdom storage */
  notepadName: string;
  /** Status of each phase */
  phases: Record<RalfreshPhase, RalfreshPhaseState>;
  /** Accumulated learnings from previous iterations */
  learnings: string[];
  /** Issues from architect rejections */
  issues: string[];
  /** Path to current iteration's plan */
  planPath?: string;
}

/**
 * Configuration overrides for ralfresh behavior
 */
export interface RalfreshConfig {
  /** Maximum iterations (default: 5) */
  maxIterations?: number;
  /** Number of swarm agents for execution phase */
  swarmAgents?: number;
  /** Skip planning phase (jump to execution) */
  skipPlanning?: boolean;
}

/**
 * Result returned by checkRalfreshLoop
 * Mapped to PersistentModeResult by persistent-mode handler
 */
export interface RalfreshLoopResult {
  /** Whether to block the stop event */
  shouldBlock: boolean;
  /** Message to inject into context */
  message: string;
  /** Current phase (for metadata) */
  phase?: string;
  /** Additional metadata */
  metadata?: {
    iteration?: number;
    maxIterations?: number;
  };
}

/**
 * Final result when ralfresh completes
 */
export interface RalfreshResult {
  /** Whether ralfresh completed successfully */
  success: boolean;
  /** Final phase reached */
  phase: RalfreshPhase;
  /** Total iterations performed */
  iterations: number;
  /** Accumulated learnings */
  learnings: string[];
}

/**
 * Default ralfresh configuration
 */
export const DEFAULT_RALFRESH_CONFIG: Required<RalfreshConfig> = {
  maxIterations: 5,
  swarmAgents: 3,
  skipPlanning: false
};

/** Maximum number of learnings to retain in state */
export const MAX_LEARNINGS = 100;

/** Maximum number of issues to retain in state */
export const MAX_ISSUES = 100;

/** Maximum character length for a single learning/issue entry */
export const MAX_ENTRY_LENGTH = 4096;

/** Maximum character length for the original prompt */
export const MAX_PROMPT_LENGTH = 32768; // 32KB reasonable limit

/** Maximum allowed value for maxIterations (upper bound) */
export const MAX_ITERATIONS_LIMIT = 50;
