// SPDX-License-Identifier: Apache-2.0
//
// RemoteReader (remote-store fork): row mapping, other-machine filtering,
// and the degrade-to-empty contract that keeps reads local-only when the
// server is unreachable.

import { describe, it, expect, afterEach } from 'bun:test';
import { RemoteReader, toObservationSearchResult } from '../../src/services/worker/RemoteReader.js';
import type { RemoteStoreConfig } from '../../src/services/sync/RemoteSync.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const config: RemoteStoreConfig = {
  serverUrl: 'https://claude-mem.home.example',
  apiKey: 'cmem_test',
  projectId: 'proj-uuid',
  machineId: 'machine-a',
  readTimeoutMs: 1500,
  writeTimeoutMs: 10000,
};

const remoteRow = (machineId: string, over: Record<string, unknown> = {}) => ({
  id: `srv-${machineId}`,
  kind: 'decision',
  content: 'Use pgvector image\nkeeps embedding stretch open',
  generationKey: `${machineId}:mem-1:obs:42`,
  createdAtEpoch: 1750000000000,
  metadata: {
    record: 'observation',
    project: 'infra',
    machineId,
    memorySessionId: 'mem-1',
    localId: 42,
    promptNumber: 3,
    createdAtEpoch: 1750000000000,
    type: 'decision',
    title: 'Use pgvector image',
    subtitle: 'keeps embedding stretch open',
    narrative: 'Chose pgvector image over plain postgres.',
    facts: ['fact-1'],
    concepts: ['infra'],
    files_read: [],
    files_modified: ['docker-compose.yml'],
    ...over,
  },
});

function serveMemories(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status })) as typeof globalThis.fetch;
}

describe('RemoteReader', () => {
  it('recentFromOtherMachines drops this machine\'s rows (the dedupe rule)', async () => {
    serveMemories({ memories: [remoteRow('machine-a'), remoteRow('machine-b')] });
    const rows = await new RemoteReader(config).recentFromOtherMachines('infra', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.machineId).toBe('machine-b');
  });

  it('recentFromOtherMachines returns [] on HTTP failure instead of throwing', async () => {
    serveMemories({ error: 'boom' }, 500);
    const rows = await new RemoteReader(config).recentFromOtherMachines('infra', 10);
    expect(rows).toEqual([]);
  });

  it('recentFromOtherMachines returns [] when the server is unreachable', async () => {
    globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof globalThis.fetch;
    const rows = await new RemoteReader(config).recentFromOtherMachines('infra', 10);
    expect(rows).toEqual([]);
  });

  it('search throws on failure so callers own the fallback decision', async () => {
    serveMemories({ error: 'nope' }, 401);
    await expect(new RemoteReader(config).search('traefik', 'infra', 5)).rejects.toThrow('HTTP 401');
  });

  it('toObservationSearchResult rebuilds the local row shape from metadata', () => {
    const [row] = [remoteRow('machine-b')].map(r => ({
      id: r.id, kind: r.kind, content: r.content,
      generationKey: r.generationKey, createdAtEpoch: r.createdAtEpoch,
      metadata: r.metadata as Record<string, unknown>,
    }));
    const mapped = toObservationSearchResult(row);
    expect(mapped.id).toBe(42);
    expect(mapped.project).toBe('infra');
    expect(mapped.type).toBe('decision');
    expect(mapped.title).toBe('Use pgvector image');
    expect(JSON.parse(mapped.facts!)).toEqual(['fact-1']);
    expect(JSON.parse(mapped.files_modified!)).toEqual(['docker-compose.yml']);
    expect(mapped.created_at_epoch).toBe(1750000000000);
    expect(mapped.created_at).toBe(new Date(1750000000000).toISOString());
  });
});
