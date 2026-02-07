import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('bridge-entry security', () => {
  const source = readFileSync(join(__dirname, '..', 'bridge-entry.ts'), 'utf-8');

  it('does NOT use process.cwd()', () => {
    expect(source).not.toContain('process.cwd()');
  });

  it('has validateBridgeWorkingDirectory function', () => {
    expect(source).toContain('validateBridgeWorkingDirectory');
  });

  it('validates config path is under ~/.claude/ or .omc/', () => {
    expect(source).toContain('.claude/');
    expect(source).toContain('.omc/');
  });

  it('sanitizes team and worker names', () => {
    expect(source).toContain('sanitizeName(config.teamName)');
    expect(source).toContain('sanitizeName(config.workerName)');
  });

  it('uses realpathSync for symlink resolution', () => {
    expect(source).toContain('realpathSync');
  });

  it('checks path is under homedir', () => {
    expect(source).toContain("home + '/'");
  });

  it('verifies git worktree', () => {
    expect(source).toContain('getWorktreeRoot');
  });

  it('validates working directory exists and is a directory', () => {
    expect(source).toContain('statSync(workingDirectory)');
    expect(source).toContain('isDirectory()');
  });

  it('validates provider is codex or gemini', () => {
    expect(source).toContain("config.provider !== 'codex'");
    expect(source).toContain("config.provider !== 'gemini'");
  });

  it('has signal handlers for graceful cleanup', () => {
    expect(source).toContain('SIGINT');
    expect(source).toContain('SIGTERM');
    expect(source).toContain('deleteHeartbeat');
    expect(source).toContain('unregisterMcpWorker');
  });

  it('validates required config fields', () => {
    expect(source).toContain('teamName');
    expect(source).toContain('workerName');
    expect(source).toContain('provider');
    expect(source).toContain('workingDirectory');
    expect(source).toContain('Missing required config field');
  });

  it('applies default configuration values', () => {
    expect(source).toContain('pollIntervalMs');
    expect(source).toContain('taskTimeoutMs');
    expect(source).toContain('maxConsecutiveErrors');
    expect(source).toContain('outboxMaxLines');
    expect(source).toContain('maxRetries');
  });
});
