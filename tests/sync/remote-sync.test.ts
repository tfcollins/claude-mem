// SPDX-License-Identifier: Apache-2.0
//
// RemoteSync (remote-store fork): payload mapping, generationKey stability,
// config gating. Fetch is captured in-process — no server needed.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RemoteSync, loadRemoteStoreConfig, type RemoteStoreConfig } from '../../src/services/sync/RemoteSync.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ParsedObservation } from '../../src/sdk/parser.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

let captured: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

function installFetch(status = 201): void {
  captured = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    captured.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ memory: { id: 'm-1' } }), { status });
  }) as typeof globalThis.fetch;
}

const config: RemoteStoreConfig = {
  serverUrl: 'https://claude-mem.home.example',
  apiKey: 'cmem_test',
  projectId: 'proj-uuid',
  machineId: 'machine-a',
  readTimeoutMs: 1500,
  writeTimeoutMs: 10000,
};

const obs: ParsedObservation = {
  type: 'decision',
  title: 'Use pgvector image',
  subtitle: 'keeps embedding stretch open',
  facts: ['pgvector/pgvector:pg17 is a Postgres 17 superset'],
  narrative: 'Chose pgvector image over plain postgres.',
  concepts: ['infra'],
  files_read: ['stacks/apps/claude-mem/docker-compose.yml'],
  files_modified: [],
};

describe('RemoteSync', () => {
  beforeEach(() => installFetch());
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('maps an observation to POST /v1/memories with packed content and full metadata', async () => {
    await new RemoteSync(config).syncObservation(42, 'mem-sess-1', 'infra', obs, 3, 1750000000, 'Claude Code');

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toBe('https://claude-mem.home.example/v1/memories');
    expect(req.method).toBe('POST');
    expect(req.headers['authorization']).toBe('Bearer cmem_test');
    expect(req.body.projectId).toBe('proj-uuid');
    expect(req.body.kind).toBe('decision');
    expect(req.body.generationKey).toBe('machine-a:mem-sess-1:obs:42');
    // Everything searchable is packed into content (feeds the tsvector).
    expect(req.body.content).toContain('Use pgvector image');
    expect(req.body.content).toContain('Chose pgvector image over plain postgres.');
    expect(req.body.content).toContain('pgvector/pgvector:pg17 is a Postgres 17 superset');
    // Full structured shape survives in metadata for read-side rebuilds.
    expect(req.body.metadata).toMatchObject({
      record: 'observation',
      project: 'infra',
      machineId: 'machine-a',
      memorySessionId: 'mem-sess-1',
      localId: 42,
      promptNumber: 3,
      createdAtEpoch: 1750000000,
      type: 'decision',
      title: 'Use pgvector image',
    });
  });

  it('generationKey is stable across retries of the same observation', async () => {
    const sync = new RemoteSync(config);
    await sync.syncObservation(42, 'mem-sess-1', 'infra', obs, 3, 1750000000);
    await sync.syncObservation(42, 'mem-sess-1', 'infra', obs, 3, 1750000000);
    expect(captured[0].body.generationKey).toBe(captured[1].body.generationKey);
  });

  it('maps a summary with kind session_summary and its own key namespace', async () => {
    await new RemoteSync(config).syncSummary(7, 'mem-sess-1', 'infra', {
      request: 'Deploy claude-mem to vulkan',
      investigated: 'stack conventions',
      learned: 'app_stack role rsyncs then compose up',
      completed: 'stack authored',
      next_steps: 'run the playbook',
      notes: null,
    }, 5, 1750000100, 'Claude Code');

    const req = captured[0];
    expect(req.body.kind).toBe('session_summary');
    expect(req.body.generationKey).toBe('machine-a:mem-sess-1:summary:7');
    expect(req.body.content).toContain('Deploy claude-mem to vulkan');
    expect(req.body.metadata.record).toBe('summary');
  });

  it('skips contentless observations instead of sending an invalid payload', async () => {
    await new RemoteSync(config).syncObservation(1, 'mem-sess-1', 'infra', {
      type: 'observation', title: null, subtitle: null, facts: [], narrative: null,
      concepts: [], files_read: [], files_modified: [],
    }, 1, 1750000000);
    expect(captured).toHaveLength(0);
  });

  it('throws on non-2xx so callers can log the failure', async () => {
    installFetch(401);
    await expect(
      new RemoteSync(config).syncObservation(42, 'mem-sess-1', 'infra', obs, 3, 1750000000),
    ).rejects.toThrow('HTTP 401');
  });
});

describe('loadRemoteStoreConfig', () => {
  const base = SettingsDefaultsManager.getAllDefaults();

  it('returns null when the feature flag is off (default)', () => {
    expect(loadRemoteStoreConfig(base)).toBeNull();
  });

  it('returns null when enabled but incompletely configured', () => {
    expect(loadRemoteStoreConfig({
      ...base,
      CLAUDE_MEM_REMOTE_STORE: 'true',
      CLAUDE_MEM_SERVER_URL: 'https://claude-mem.home.example',
      CLAUDE_MEM_SERVER_API_KEY: '',
      CLAUDE_MEM_SERVER_PROJECT_ID: '',
    })).toBeNull();
  });

  it('resolves a full config, trims trailing slash, clamps bad timeouts', () => {
    const resolved = loadRemoteStoreConfig({
      ...base,
      CLAUDE_MEM_REMOTE_STORE: 'true',
      CLAUDE_MEM_SERVER_URL: 'https://claude-mem.home.example/',
      CLAUDE_MEM_SERVER_API_KEY: 'cmem_x',
      CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-1',
      CLAUDE_MEM_MACHINE_ID: 'machine-a',
      CLAUDE_MEM_REMOTE_READ_TIMEOUT_MS: 'not-a-number',
      CLAUDE_MEM_REMOTE_WRITE_TIMEOUT_MS: '9999999',
    });
    expect(resolved).toEqual({
      serverUrl: 'https://claude-mem.home.example',
      apiKey: 'cmem_x',
      projectId: 'proj-1',
      machineId: 'machine-a',
      readTimeoutMs: 1500,
      writeTimeoutMs: 10000,
    });
  });

  it('falls back to legacy BETA key/project settings', () => {
    const resolved = loadRemoteStoreConfig({
      ...base,
      CLAUDE_MEM_REMOTE_STORE: 'true',
      CLAUDE_MEM_SERVER_URL: 'https://claude-mem.home.example',
      CLAUDE_MEM_SERVER_BETA_API_KEY: 'cmem_legacy',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'proj-legacy',
    });
    expect(resolved?.apiKey).toBe('cmem_legacy');
    expect(resolved?.projectId).toBe('proj-legacy');
  });
});
