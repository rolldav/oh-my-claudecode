import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeClaudeLaunchArgs,
  extractOmcLaunchFlags,
  runClaude,
  launchCommand,
} from '../launch.js';

// ─── extractOmcLaunchFlags ────────────────────────────────────────────────────

describe('extractOmcLaunchFlags', () => {
  it('returns empty claudeArgs when args is empty', () => {
    expect(extractOmcLaunchFlags([])).toEqual({
      session: undefined,
      noTmux: false,
      claudeArgs: [],
    });
  });

  it('passes unknown flags through as claudeArgs', () => {
    const result = extractOmcLaunchFlags(['--model', 'claude-opus-4-6', '--verbose']);
    expect(result.claudeArgs).toEqual(['--model', 'claude-opus-4-6', '--verbose']);
    expect(result.session).toBeUndefined();
    expect(result.noTmux).toBe(false);
  });

  it('extracts --session <name>', () => {
    const result = extractOmcLaunchFlags(['--session', 'my-project', '--verbose']);
    expect(result.session).toBe('my-project');
    expect(result.claudeArgs).toEqual(['--verbose']);
  });

  it('extracts --no-tmux', () => {
    const result = extractOmcLaunchFlags(['--no-tmux', '--model', 'claude-opus-4-6']);
    expect(result.noTmux).toBe(true);
    expect(result.claudeArgs).toEqual(['--model', 'claude-opus-4-6']);
  });

  it('extracts both --session and --no-tmux together', () => {
    const result = extractOmcLaunchFlags(['--session', 'my-work', '--no-tmux', '--dangerously-skip-permissions']);
    expect(result.session).toBe('my-work');
    expect(result.noTmux).toBe(true);
    expect(result.claudeArgs).toEqual(['--dangerously-skip-permissions']);
  });

  it('treats --session without a value as a flag with no session', () => {
    // --session at end of array without a following value should not crash
    const result = extractOmcLaunchFlags(['--model', 'x', '--session']);
    // '--session' has no following arg, so it's consumed as a flag with undefined session
    expect(result.session).toBeUndefined();
    expect(result.claudeArgs).toEqual(['--model', 'x']);
  });

  it('does not strip other flags that start with --', () => {
    const result = extractOmcLaunchFlags(['--plugin-dir', '/some/path', '--debug']);
    expect(result.claudeArgs).toEqual(['--plugin-dir', '/some/path', '--debug']);
  });
});

// ─── normalizeClaudeLaunchArgs ───────────────────────────────────────────────

describe('normalizeClaudeLaunchArgs', () => {
  it('passes unrecognized flags through unchanged', () => {
    expect(normalizeClaudeLaunchArgs(['--model', 'x', '--verbose'])).toEqual([
      '--model', 'x', '--verbose',
    ]);
  });

  it('converts --madmax to --dangerously-skip-permissions', () => {
    expect(normalizeClaudeLaunchArgs(['--madmax'])).toContain('--dangerously-skip-permissions');
    expect(normalizeClaudeLaunchArgs(['--madmax'])).not.toContain('--madmax');
  });

  it('converts --yolo to --dangerously-skip-permissions', () => {
    expect(normalizeClaudeLaunchArgs(['--yolo'])).toContain('--dangerously-skip-permissions');
  });

  it('deduplicates --dangerously-skip-permissions when combined with --madmax', () => {
    const result = normalizeClaudeLaunchArgs(['--madmax', '--dangerously-skip-permissions']);
    expect(result.filter(a => a === '--dangerously-skip-permissions')).toHaveLength(1);
  });

  it('deduplicates multiple bypass flags', () => {
    const result = normalizeClaudeLaunchArgs(['--madmax', '--yolo', '--dangerously-skip-permissions']);
    expect(result.filter(a => a === '--dangerously-skip-permissions')).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeClaudeLaunchArgs([])).toEqual([]);
  });
});

// ─── runClaude (unit, mocked execFileSync) ────────────────────────────────────

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../tmux-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-utils.js')>();
  return {
    ...actual,
    isTmuxAvailable: vi.fn(() => true),
    isClaudeAvailable: vi.fn(() => true),
    resolveLaunchPolicy: vi.fn(() => 'outside-tmux'),
    buildTmuxSessionName: vi.fn(() => 'omc-test-main-abc123'),
    listHudWatchPaneIdsInCurrentWindow: vi.fn(() => []),
    createHudWatchPane: vi.fn(() => null),
    killTmuxPane: vi.fn(),
  };
});

describe('runClaude', () => {
  let execFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('child_process');
    execFileSync = cp.execFileSync as ReturnType<typeof vi.fn>;
  });

  it('creates a tmux session when outside tmux (default)', () => {
    runClaude('/tmp/test', [], 'omc-test-id');
    // Should call tmux new-session
    const calls = execFileSync.mock.calls;
    const tmuxCall = calls.find((c: string[]) => c[0] === 'tmux') as string[] | undefined;
    expect(tmuxCall).toBeDefined();
    expect(tmuxCall![1]).toContain('new-session');
  });

  it('uses sanitized custom session name when options.session is provided', async () => {
    const { resolveLaunchPolicy } = await import('../tmux-utils.js');
    vi.mocked(resolveLaunchPolicy).mockReturnValue('outside-tmux');

    runClaude('/tmp/test', [], 'omc-test-id', { session: 'my custom session!' });

    const calls = execFileSync.mock.calls;
    const tmuxCall = calls.find((c: string[]) => c[0] === 'tmux') as string[] | undefined;
    expect(tmuxCall).toBeDefined();
    // Session name should be sanitized (spaces/! removed)
    const sessionNameArg = tmuxCall![1][tmuxCall![1].indexOf('-s') + 1];
    expect(sessionNameArg).toBe('my-custom-session');
  });

  it('runs claude directly when inside tmux', async () => {
    const { resolveLaunchPolicy } = await import('../tmux-utils.js');
    vi.mocked(resolveLaunchPolicy).mockReturnValue('inside-tmux');

    runClaude('/tmp/test', ['--verbose'], 'omc-test-id');

    const calls = execFileSync.mock.calls;
    const claudeCall = calls.find((c: string[]) => c[0] === 'claude') as string[] | undefined;
    expect(claudeCall).toBeDefined();
    expect(claudeCall![1]).toContain('--verbose');
  });

  it('runs claude directly when policy is direct', async () => {
    const { resolveLaunchPolicy } = await import('../tmux-utils.js');
    vi.mocked(resolveLaunchPolicy).mockReturnValue('direct');

    runClaude('/tmp/test', ['--model', 'x'], 'omc-test-id');

    const calls = execFileSync.mock.calls;
    const claudeCall = calls.find((c: string[]) => c[0] === 'claude') as string[] | undefined;
    expect(claudeCall).toBeDefined();
    expect(claudeCall![1]).toEqual(['--model', 'x']);
  });
});

// ─── launchCommand --no-tmux ──────────────────────────────────────────────────

describe('launchCommand with --no-tmux', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure we don't appear to be inside claude
    delete process.env.CLAUDECODE;
  });

  afterEach(() => {
    delete process.env.CLAUDECODE;
  });

  it('calls claude directly when noTmux is true', async () => {
    const cp = await import('child_process');
    const execFileSync = cp.execFileSync as ReturnType<typeof vi.fn>;

    await launchCommand(['--verbose'], { noTmux: true });

    const claudeCall = execFileSync.mock.calls.find((c: string[]) => c[0] === 'claude') as string[] | undefined;
    expect(claudeCall).toBeDefined();
    expect(claudeCall![1]).toContain('--verbose');

    // Must NOT create a tmux session
    const tmuxCall = execFileSync.mock.calls.find((c: string[]) => c[0] === 'tmux') as string[] | undefined;
    expect(tmuxCall).toBeUndefined();
  });

  it('exits with error when already inside claude session', async () => {
    process.env.CLAUDECODE = '1';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await launchCommand([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
