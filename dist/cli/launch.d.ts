/**
 * Native tmux shell launch for omc
 * Launches Claude Code with tmux session management and HUD integration
 */
/**
 * Options for controlling tmux session behaviour when launching Claude.
 */
export interface LaunchOptions {
    /** Custom tmux session name (overrides the auto-derived name). Only used when outside tmux. */
    session?: string;
    /** When true, skip tmux entirely and run claude in the current shell. */
    noTmux?: boolean;
}
/**
 * Extract omc-specific launch flags from a raw argv array.
 * Strips --session <name> and --no-tmux; everything else is forwarded to claude.
 */
export declare function extractOmcLaunchFlags(args: string[]): {
    session: string | undefined;
    noTmux: boolean;
    claudeArgs: string[];
};
/**
 * Normalize Claude launch arguments
 * Maps --madmax/--yolo to --dangerously-skip-permissions
 * All other flags pass through unchanged
 */
export declare function normalizeClaudeLaunchArgs(args: string[]): string[];
/**
 * preLaunch: Prepare environment before Claude starts
 * Currently a placeholder - can be extended for:
 * - Session state initialization
 * - Environment setup
 * - Pre-launch checks
 */
export declare function preLaunch(_cwd: string, _sessionId: string): Promise<void>;
/**
 * runClaude: Launch Claude CLI (blocks until exit)
 * Handles 3 scenarios:
 * 1. inside-tmux: Launch claude in current pane, HUD in bottom split
 * 2. outside-tmux: Create new tmux session with claude + HUD pane
 * 3. direct: tmux not available, run claude directly
 */
export declare function runClaude(cwd: string, args: string[], sessionId: string, options?: LaunchOptions): void;
/**
 * postLaunch: Cleanup after Claude exits
 * Currently a placeholder - can be extended for:
 * - Session cleanup
 * - State finalization
 * - Post-launch reporting
 */
export declare function postLaunch(_cwd: string, _sessionId: string): Promise<void>;
/**
 * Main launch command entry point
 * Orchestrates the 3-phase launch: preLaunch -> run -> postLaunch
 */
export declare function launchCommand(args: string[], options?: LaunchOptions): Promise<void>;
//# sourceMappingURL=launch.d.ts.map