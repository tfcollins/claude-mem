// SPDX-License-Identifier: Apache-2.0
//
// Viewer shim mappers: server observation rows → the worker Observation/Summary
// wire shapes the bundled viewer expects. Pure functions, no Postgres.

import { describe, it, expect } from 'bun:test';
import { toViewerObservation, toViewerSummary } from '../../src/server/runtime/ViewerApiRoutes.js';
import type { PostgresObservation } from '../../src/storage/postgres/observations.js';

const baseRow = (over: Partial<PostgresObservation> = {}): PostgresObservation => ({
  id: 'row-uuid-1',
  projectId: 'proj',
  teamId: 'team',
  serverSessionId: null,
  kind: 'discovery',
  content: 'packed content first line\nmore',
  generationKey: 'machine-a:sess-1:obs:42',
  metadata: {},
  embedding: null,
  createdByJobId: null,
  createdAtEpoch: 1750000000000,
  updatedAtEpoch: 1750000000000,
  ...over,
});

describe('toViewerObservation', () => {
  it('maps metadata into the worker Observation shape with JSON-string arrays', () => {
    const row = baseRow({
      metadata: {
        record: 'observation', project: 'infra', machineId: 'machine-a',
        memorySessionId: 'sess-1', localId: 42, promptNumber: 3,
        createdAtEpoch: 1750000000500, platformSource: 'claude', type: 'bugfix',
        title: 'Fixed the thing', subtitle: 'src/x.ts',
        narrative: 'A narrative.', facts: ['f1', 'f2'], concepts: ['c1'],
        files_read: ['a.ts'], files_modified: ['b.ts'],
      },
    });
    const o = toViewerObservation(row);
    expect(o.id).toBe('row-uuid-1'); // UUID, not the colliding numeric localId
    expect(o.memory_session_id).toBe('sess-1');
    expect(o.project).toBe('infra');
    expect(o.platform_source).toBe('claude');
    expect(o.type).toBe('bugfix');
    expect(o.title).toBe('Fixed the thing');
    expect(o.subtitle).toBe('src/x.ts');
    expect(o.text).toBeNull();
    expect(o.merged_into_project).toBeNull();
    expect(o.narrative).toBe('A narrative.');
    expect(JSON.parse(o.facts)).toEqual(['f1', 'f2']);
    expect(JSON.parse(o.concepts)).toEqual(['c1']);
    expect(JSON.parse(o.files_read)).toEqual(['a.ts']);
    expect(JSON.parse(o.files_modified)).toEqual(['b.ts']);
    expect(o.prompt_number).toBe(3);
    expect(o.created_at_epoch).toBe(1750000000500);
    expect(o.created_at).toBe(new Date(1750000000500).toISOString());
  });

  it('degrades safely when metadata is sparse (title falls back to content, arrays empty)', () => {
    const o = toViewerObservation(baseRow({ metadata: { record: 'observation' } }));
    expect(o.title).toBe('packed content first line');
    expect(o.platform_source).toBe('claude');
    expect(o.type).toBe('discovery'); // falls back to row.kind
    expect(JSON.parse(o.facts)).toEqual([]);
    expect(o.prompt_number).toBe(0);
    expect(o.created_at_epoch).toBe(1750000000000); // falls back to row.createdAtEpoch
  });
});

describe('toViewerSummary', () => {
  it('maps summary metadata into the worker Summary shape', () => {
    const row = baseRow({
      kind: 'session_summary',
      metadata: {
        record: 'summary', project: 'infra', memorySessionId: 'sess-1',
        platformSource: 'claude', createdAtEpoch: 1750000001000,
        request: 'Do the thing', investigated: 'looked', learned: 'learned it',
        completed: 'done', next_steps: 'next', notes: null,
      },
    });
    const s = toViewerSummary(row);
    expect(s.id).toBe('row-uuid-1');
    expect(s.session_id).toBe('sess-1');
    expect(s.project).toBe('infra');
    expect(s.request).toBe('Do the thing');
    expect(s.investigated).toBe('looked');
    expect(s.learned).toBe('learned it');
    expect(s.completed).toBe('done');
    expect(s.next_steps).toBe('next');
    expect(s.notes).toBeNull();
    expect(s.created_at_epoch).toBe(1750000001000);
  });
});
