// SPDX-License-Identifier: Apache-2.0
//
// The multi-machine contract, end-to-end minus the LLM: machine A's worker
// pushes observations through the REAL Postgres-backed server; machine B's
// worker reads them back via recent + search and rebuilds local row shapes.
// This is the integration seam upstream got wrong once already
// (ServerClient.buildAddObservationPayload sends no `content` and 400s), so
// the client classes here are the production RemoteSync/RemoteReader, not
// hand-rolled fetches. Postgres-gated, same harness as data-deletion.test.ts.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { HOOK_API_KEY_SCOPES, hashApiKey, createRawApiKey } from '../../src/services/hooks/server-bootstrap.js';
import { RemoteSync, type RemoteStoreConfig } from '../../src/services/sync/RemoteSync.js';
import { RemoteReader, toObservationSearchResult } from '../../src/services/worker/RemoteReader.js';
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('remote store: two machines share memory through the server', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let spies: ReturnType<typeof spyOn>[] = [];
  let machineA: RemoteStoreConfig;
  let machineB: RemoteStoreConfig;

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = `cm_2m_${randomUUID().replaceAll('-', '_')}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${q(schemaName)}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    // Mirror `server keys mint`: one shared team/project, one key per machine,
    // keys PROJECT-scoped with the bootstrap scope set.
    const team = await storage.teams.create({ name: 'local-hook-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'local-hook-project' });
    const mintKey = async (): Promise<string> => {
      const raw = createRawApiKey();
      await storage.auth.createApiKey({
        keyHash: hashApiKey(raw),
        teamId: team.id,
        projectId: project.id,
        actorId: 'system:local-hook-bootstrap',
        scopes: [...HOOK_API_KEY_SCOPES],
      });
      return raw;
    };

    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const addr = server.getHttpServer()?.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');

    const base = {
      serverUrl: `http://127.0.0.1:${addr.port}`,
      projectId: project.id,
      readTimeoutMs: 1500,
      writeTimeoutMs: 10000,
    };
    machineA = { ...base, apiKey: await mintKey(), machineId: 'machine-a' };
    machineB = { ...base, apiKey: await mintKey(), machineId: 'machine-b' };
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    spies.forEach(s => s.mockRestore());
    mock.restore();
  });

  it('A pushes an observation; B sees it via recent and search, A does not see its own row', async () => {
    await new RemoteSync(machineA).syncObservation(7, 'mem-sess-A1', 'claudemem', {
      type: 'bugfix',
      title: 'Fixed bootstrap key scopes',
      subtitle: 'memories:write/read now match the routes',
      facts: ['HOOK_API_KEY_SCOPES was events:write etc.', 'Postgres routes check memories:*'],
      narrative: 'Bootstrap keys could not call any /v1 route until the scope set matched.',
      concepts: ['auth'],
      files_read: [],
      files_modified: ['src/services/hooks/server-bootstrap.ts'],
    }, 2, Date.now(), 'Claude Code');

    // Machine B: context-inject path (recent, other machines only)
    const readerB = new RemoteReader(machineB);
    const shared = await readerB.recentFromOtherMachines('claudemem', 10);
    expect(shared).toHaveLength(1);
    expect(shared[0].metadata.machineId).toBe('machine-a');

    // Machine B: search path, with local row-shape rebuild
    const found = await readerB.search('bootstrap scopes', 'claudemem', 10);
    expect(found).toHaveLength(1);
    const rebuilt = toObservationSearchResult(found[0]);
    expect(rebuilt.title).toBe('Fixed bootstrap key scopes');
    expect(rebuilt.type).toBe('bugfix');
    expect(rebuilt.project).toBe('claudemem');
    expect(JSON.parse(rebuilt.files_modified!)).toEqual(['src/services/hooks/server-bootstrap.ts']);

    // Machine A: its own row is filtered out of the shared view
    const readerA = new RemoteReader(machineA);
    expect(await readerA.recentFromOtherMachines('claudemem', 10)).toHaveLength(0);
  });

  it('retried pushes stay single-row; repo filter separates projects; summaries ride along', async () => {
    const syncA = new RemoteSync(machineA);
    const obs = {
      type: 'discovery' as const,
      title: 'Vulkan hosts the stack',
      subtitle: null,
      facts: [],
      narrative: 'claude-mem stack deploys to vulkan via the app_stack role.',
      concepts: ['infra'],
      files_read: [],
      files_modified: [],
    };
    await syncA.syncObservation(11, 'mem-sess-A2', 'infra', obs, 1, Date.now());
    await syncA.syncObservation(11, 'mem-sess-A2', 'infra', obs, 1, Date.now()); // retry
    await syncA.syncSummary(3, 'mem-sess-A2', 'infra', {
      request: 'Deploy the claude-mem stack',
      investigated: 'stack conventions',
      learned: 'app_stack rsyncs then compose up',
      completed: 'stack deployed',
      next_steps: 'mint keys',
      notes: null,
    }, 1, Date.now());

    const count = await client.query(`SELECT count(*)::int AS n FROM observations WHERE metadata->>'project' = 'infra'`);
    expect(count.rows[0].n).toBe(2); // 1 observation (deduped) + 1 summary

    const readerB = new RemoteReader(machineB);
    // Repo filter: the infra rows never leak into the claudemem repo's view.
    expect(await readerB.recentFromOtherMachines('claudemem', 10)).toHaveLength(0);
    const infraRows = await readerB.recentFromOtherMachines('infra', 10);
    expect(infraRows).toHaveLength(2);
    const kinds = infraRows.map(r => r.kind).sort();
    expect(kinds).toEqual(['discovery', 'session_summary']);
  });
});
