import { describe, it, expect, afterEach } from 'bun:test';
import { paths, DATA_DIR, resolveDataDir, expandHome, pinProcessCwd } from '../../src/shared/paths.js';
import { homedir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

describe('paths namespace', () => {
  it('exposes at least the known core accessors', () => {
    const keys = Object.keys(paths);
    const required = [
      'dataDir',
      'workerPid',
      'settings',
      'database',
      'chroma',
      'transcriptsConfig',
    ];
    for (const key of required) {
      expect(keys).toContain(key);
    }
  });

  it('every accessor returns a string starting with DATA_DIR', () => {
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      const value = paths[key]();
      expect(typeof value).toBe('string');
      expect(value.startsWith(DATA_DIR)).toBe(true);
    }
  });

  it('every accessor is a callable function', () => {
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      expect(typeof paths[key]).toBe('function');
    }
  });
});

describe('expandHome', () => {
  it('expands a leading ~/ to the home directory', () => {
    expect(expandHome('~/foo/bar')).toBe(join(homedir(), 'foo/bar'));
  });

  it('expands a bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('leaves an absolute path untouched', () => {
    const abs = join(homedir(), '.claude-mem');
    expect(expandHome(abs)).toBe(abs);
  });

  it('leaves a relative path (no ~) untouched', () => {
    expect(expandHome('foo/bar')).toBe('foo/bar');
  });

  it('does not expand ~ not at position 0', () => {
    // a tilde mid-path is a literal character, not a home reference
    expect(expandHome('foo/~bar')).toBe('foo/~bar');
  });

  it('does not touch a ~user/ form (out of scope)', () => {
    expect(expandHome('~someone/data')).toBe('~someone/data');
  });
});

describe('resolveDataDir tilde expansion', () => {
  // resolveDataDir consults process.env.CLAUDE_MEM_DATA_DIR first, so we can
  // exercise the expansion without touching the real settings.json on disk.
  const sentinel = '/__claude_mem_test_no_real_dir__';
  const origEnv = process.env.CLAUDE_MEM_DATA_DIR;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origEnv;
  });

  it('returns an absolute path when the env var is a literal ~ (no stray ~ dir)', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '~/.claude-mem';
    const resolved = resolveDataDir();
    expect(resolved).toBe(join(homedir(), '.claude-mem'));
    // the regression: a non-absolute, ~-prefixed value used to slip through and
    // become a cwd-relative path → a literal `~` directory on disk.
    expect(resolved.startsWith('~')).toBe(false);
    expect(join(resolved, 'logs')).toBe(join(homedir(), '.claude-mem', 'logs'));
  });

  it('returns the home dir when the env var is a bare ~', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '~';
    expect(resolveDataDir()).toBe(homedir());
  });

  it('still returns a real env-var value when it is already absolute', () => {
    process.env.CLAUDE_MEM_DATA_DIR = sentinel;
    expect(resolveDataDir()).toBe(sentinel);
  });
});

describe('pinProcessCwd', () => {
  // Regression: the worker daemon inherits whatever cwd its launching session
  // had (often an ephemeral git worktree). If that directory is later deleted
  // while the daemon keeps running, Bun's spawn() can't resolve the deleted
  // cwd and throws an ENOENT misattributed to the spawned command itself, not
  // the missing cwd — the daemon looks like it can't find `claude` when the
  // real problem is its own working directory no longer exists.
  it('lets spawn() succeed again after the cwd has been deleted out from under the process', async () => {
    const originalCwd = process.cwd();
    const deletedDir = mkdtempSync(join(tmpdir(), 'claude-mem-cwd-test-'));
    process.chdir(deletedDir);
    rmSync(deletedDir, { recursive: true, force: true });

    try {
      pinProcessCwd();
      // Async spawn, not spawnSync: this suite runs many test files in one
      // shared process, and a blocking spawnSync can stall other files' async
      // work enough to trip unrelated timeouts. spawn() proves the same fix
      // without that side effect.
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['--version']);
        child.on('error', reject);
        child.on('exit', resolve);
      });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('leaves the process cwd at DATA_DIR', () => {
    const originalCwd = process.cwd();
    try {
      pinProcessCwd();
      expect(process.cwd()).toBe(DATA_DIR);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
