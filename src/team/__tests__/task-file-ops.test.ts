import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readTask, updateTask, findNextTask, areBlockersResolved,
  writeTaskFailure, readTaskFailure, listTaskIds, isTaskRetryExhausted
} from '../task-file-ops.js';
import type { TaskFile } from '../types.js';

const TEST_TEAM = 'test-team-ops';
const TASKS_DIR = join(homedir(), '.claude', 'tasks', TEST_TEAM);

function writeTask(task: TaskFile): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

beforeEach(() => {
  mkdirSync(TASKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TASKS_DIR, { recursive: true, force: true });
});

describe('readTask', () => {
  it('reads existing task', () => {
    const task: TaskFile = {
      id: '1', subject: 'Test', description: 'Desc', status: 'pending',
      owner: 'worker1', blocks: [], blockedBy: [],
    };
    writeTask(task);
    const result = readTask(TEST_TEAM, '1');
    expect(result).toEqual(task);
  });

  it('returns null for missing task', () => {
    expect(readTask(TEST_TEAM, 'nonexistent')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    mkdirSync(TASKS_DIR, { recursive: true });
    writeFileSync(join(TASKS_DIR, 'bad.json'), '{invalid json');
    expect(readTask(TEST_TEAM, 'bad')).toBeNull();
  });
});

describe('updateTask', () => {
  it('updates status while preserving other fields', () => {
    const task: TaskFile = {
      id: '1', subject: 'Test', description: 'Desc', status: 'pending',
      owner: 'worker1', blocks: [], blockedBy: [],
    };
    writeTask(task);
    updateTask(TEST_TEAM, '1', { status: 'in_progress' });
    const result = readTask(TEST_TEAM, '1');
    expect(result?.status).toBe('in_progress');
    expect(result?.subject).toBe('Test');
  });

  it('preserves unknown fields', () => {
    mkdirSync(TASKS_DIR, { recursive: true });
    const taskWithExtra = { id: '1', subject: 'Test', description: 'Desc', status: 'pending', owner: 'w', blocks: [], blockedBy: [], customField: 'keep' };
    writeFileSync(join(TASKS_DIR, '1.json'), JSON.stringify(taskWithExtra));
    updateTask(TEST_TEAM, '1', { status: 'completed' });
    const raw = JSON.parse(readFileSync(join(TASKS_DIR, '1.json'), 'utf-8'));
    expect(raw.customField).toBe('keep');
    expect(raw.status).toBe('completed');
  });
});

describe('findNextTask', () => {
  it('finds pending task assigned to worker', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result?.id).toBe('1');
  });

  it('skips completed tasks', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'completed', owner: 'w1', blocks: [], blockedBy: [] });
    expect(await findNextTask(TEST_TEAM, 'w1')).toBeNull();
  });

  it('skips tasks owned by other workers', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w2', blocks: [], blockedBy: [] });
    expect(await findNextTask(TEST_TEAM, 'w1')).toBeNull();
  });

  it('skips tasks with unresolved blockers', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    writeTask({ id: '2', subject: 'T2', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: ['1'] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result?.id).toBe('1');
  });

  it('returns blocked task when blockers resolved', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'completed', owner: 'w1', blocks: [], blockedBy: [] });
    writeTask({ id: '2', subject: 'T2', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: ['1'] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result?.id).toBe('2');
  });

  it('returns null for empty dir', async () => {
    expect(await findNextTask(TEST_TEAM, 'w1')).toBeNull();
  });

  it('writes claim marker with claimedBy and claimPid', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result).not.toBeNull();
    // After findNextTask, the task file should have claim fields
    const raw = JSON.parse(readFileSync(join(TASKS_DIR, '1.json'), 'utf-8'));
    expect(raw.claimedBy).toBe('w1');
    expect(raw.claimPid).toBe(process.pid);
    expect(typeof raw.claimedAt).toBe('number');
  });
});

describe('areBlockersResolved', () => {
  it('returns true for empty blockers', () => {
    expect(areBlockersResolved(TEST_TEAM, [])).toBe(true);
  });

  it('returns true when all blockers completed', () => {
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'completed', owner: 'w', blocks: [], blockedBy: [] });
    expect(areBlockersResolved(TEST_TEAM, ['1'])).toBe(true);
  });

  it('returns false when blocker still pending', () => {
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    expect(areBlockersResolved(TEST_TEAM, ['1'])).toBe(false);
  });
});

describe('writeTaskFailure / readTaskFailure', () => {
  it('creates failure sidecar', () => {
    writeTaskFailure(TEST_TEAM, '1', 'timeout error');
    const failure = readTaskFailure(TEST_TEAM, '1');
    expect(failure?.taskId).toBe('1');
    expect(failure?.lastError).toBe('timeout error');
    expect(failure?.retryCount).toBe(1);
  });

  it('increments retryCount', () => {
    writeTaskFailure(TEST_TEAM, '1', 'err1');
    writeTaskFailure(TEST_TEAM, '1', 'err2');
    const failure = readTaskFailure(TEST_TEAM, '1');
    expect(failure?.retryCount).toBe(2);
    expect(failure?.lastError).toBe('err2');
  });

  it('returns null for missing sidecar', () => {
    expect(readTaskFailure(TEST_TEAM, '999')).toBeNull();
  });
});

describe('listTaskIds', () => {
  it('lists task IDs sorted numerically', () => {
    writeTask({ id: '3', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    writeTask({ id: '2', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    expect(listTaskIds(TEST_TEAM)).toEqual(['1', '2', '3']);
  });

  it('excludes tmp and failure files', () => {
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    writeFileSync(join(TASKS_DIR, '1.json.tmp.123'), '{}');
    writeFileSync(join(TASKS_DIR, '1.failure.json'), '{}');
    expect(listTaskIds(TEST_TEAM)).toEqual(['1']);
  });

  it('returns empty for nonexistent team', () => {
    expect(listTaskIds('nonexistent_team_xyz')).toEqual([]);
  });
});

describe('isTaskRetryExhausted', () => {
  it('returns true after 5 failures (default max)', () => {
    for (let i = 0; i < 5; i++) {
      writeTaskFailure(TEST_TEAM, '1', `error-${i}`);
    }
    expect(isTaskRetryExhausted(TEST_TEAM, '1')).toBe(true);
  });

  it('returns false after 4 failures (below default max)', () => {
    for (let i = 0; i < 4; i++) {
      writeTaskFailure(TEST_TEAM, '1', `error-${i}`);
    }
    expect(isTaskRetryExhausted(TEST_TEAM, '1')).toBe(false);
  });

  it('returns false when no failure sidecar exists', () => {
    expect(isTaskRetryExhausted(TEST_TEAM, '999')).toBe(false);
  });

  it('respects custom maxRetries parameter', () => {
    for (let i = 0; i < 3; i++) {
      writeTaskFailure(TEST_TEAM, '1', `error-${i}`);
    }
    expect(isTaskRetryExhausted(TEST_TEAM, '1', 3)).toBe(true);
    expect(isTaskRetryExhausted(TEST_TEAM, '1', 4)).toBe(false);
  });
});
