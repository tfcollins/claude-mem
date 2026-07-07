// SPDX-License-Identifier: Apache-2.0
//
// Remote-store fork surface: the endpoints multi-machine clients rely on.
//   - POST /v1/memories accepts generationKey and dedupes retries via the
//     (team_id, project_id, generation_key) partial-unique index.
//   - GET /v1/memories lists recent rows, optionally narrowed to one repo
//     via the metadata->>'project' filter.
//   - POST /v1/search accepts the same `project` narrowing.
//   - GET /v1/whoami resolves an API key to its tenant scope.
//   - Keys minted with HOOK_API_KEY_SCOPES can actually call these routes
//     (the scope set must match what requirePostgresServerAuth checks).
// Postgres-gated, same harness as data-deletion.test.ts.

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
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('remote-store routes (fork)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let hookKey: string;
  let teamId: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = `cm_rs_${randomUUID().replaceAll('-', '_')}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${q(schemaName)}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'home' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId, name: 'local-hook-project' });
    projectId = project.id;

    // The key uses EXACTLY the scopes the bootstrapper mints — this is the
    // regression test for the historical mismatch where bootstrap keys could
    // not call any Postgres /v1 route.
    hookKey = createRawApiKey();
    await storage.auth.createApiKey({
      keyHash: hashApiKey(hookKey),
      teamId,
      projectId: null,
      actorId: 'test',
      scopes: [...HOOK_API_KEY_SCOPES],
    });

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
    port = addr.port;
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

  const request = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${hookKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const memoryBody = (over: Record<string, unknown> = {}) => ({
    projectId,
    kind: 'observation',
    content: 'Configured Traefik wildcard TLS for the homelab reverse proxy',
    generationKey: 'machineA:sess-1:obs-1',
    metadata: { project: 'infra', machineId: 'machineA', record: 'observation' },
    ...over,
  });

  it('POST /v1/memories with the same generationKey twice creates one row', async () => {
    const first = await request('POST', '/v1/memories', memoryBody());
    expect(first.status).toBe(201);
    const { memory: m1 } = await first.json();

    const second = await request('POST', '/v1/memories', memoryBody());
    expect(second.status).toBe(201);
    const { memory: m2 } = await second.json();

    expect(m2.id).toBe(m1.id);
    const count = await client.query('SELECT count(*)::int AS n FROM observations');
    expect(count.rows[0].n).toBe(1);
  });

  it('GET /v1/memories lists newest-first and narrows by metadata project', async () => {
    await request('POST', '/v1/memories', memoryBody());
    await request('POST', '/v1/memories', memoryBody({
      generationKey: 'machineB:sess-9:obs-4',
      content: 'Fixed the flaky bun test in the claudemem fork',
      metadata: { project: 'claudemem', machineId: 'machineB', record: 'observation' },
    }));

    const all = await request('GET', `/v1/memories?projectId=${projectId}&limit=10`);
    expect(all.status).toBe(200);
    const { memories } = await all.json();
    expect(memories.length).toBe(2);

    const infraOnly = await request('GET', `/v1/memories?projectId=${projectId}&project=infra`);
    const { memories: filtered } = await infraOnly.json();
    expect(filtered.length).toBe(1);
    expect(filtered[0].metadata.project).toBe('infra');
    expect(filtered[0].metadata.machineId).toBe('machineA');
  });

  it('POST /v1/search finds rows by FTS and respects the project filter', async () => {
    await request('POST', '/v1/memories', memoryBody());
    await request('POST', '/v1/memories', memoryBody({
      generationKey: 'machineB:sess-9:obs-4',
      content: 'Traefik dashboard route added for the staging cluster',
      metadata: { project: 'claudemem', machineId: 'machineB', record: 'observation' },
    }));

    const search = await request('POST', '/v1/search', { projectId, query: 'traefik' });
    expect(search.status).toBe(200);
    const { observations } = await search.json();
    expect(observations.length).toBe(2);

    const narrowed = await request('POST', '/v1/search', { projectId, query: 'traefik', project: 'infra' });
    const { observations: infraObs } = await narrowed.json();
    expect(infraObs.length).toBe(1);
    expect(infraObs[0].metadata.project).toBe('infra');
  });

  it('GET /v1/whoami returns the key tenant scope', async () => {
    const res = await request('GET', '/v1/whoami');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teamId).toBe(teamId);
    expect(body.projectId).toBeNull();
    expect(body.scopes).toEqual([...HOOK_API_KEY_SCOPES]);
    expect(typeof body.apiKeyId).toBe('string');
  });

  it('rejects requests without a key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/whoami`);
    expect([401, 403]).toContain(res.status);
  });
});
