// SPDX-License-Identifier: Apache-2.0
//
// Viewer shim routes end-to-end against real Postgres: the /api/* endpoints the
// bundled viewer needs must return 200 with the right shapes (all three feed
// endpoints must be 200 or the UI spins forever), split observations from
// summaries by metadata->>'record', paginate, and require NO auth (the browser
// bundle sends no key). Postgres-gated, same harness as remote-store-routes.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ViewerApiRoutes } from '../../src/server/runtime/ViewerApiRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('viewer API shim routes', () => {
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
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = `cm_vw_${randomUUID().replaceAll('-', '_')}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${q(schemaName)}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'local-hook-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'local-hook-project' });

    const mkObs = (i: number, project_name: string) => storage.observations.create({
      projectId: project.id, teamId: team.id, kind: 'discovery',
      content: `observation ${i} content`,
      generationKey: `machine-a:sess-1:obs:${i}`,
      metadata: {
        record: 'observation', project: project_name, machineId: 'machine-a',
        memorySessionId: 'sess-1', localId: i, promptNumber: i, createdAtEpoch: 1750000000000 + i,
        platformSource: 'claude', type: 'discovery', title: `Obs ${i}`, subtitle: null,
        narrative: `narrative ${i}`, facts: [`fact ${i}`], concepts: [], files_read: [], files_modified: [],
      },
    });
    // 3 observations (2 infra, 1 claudemem) + 1 summary
    await mkObs(1, 'infra');
    await mkObs(2, 'infra');
    await mkObs(3, 'claudemem');
    await storage.observations.create({
      projectId: project.id, teamId: team.id, kind: 'session_summary',
      content: 'summary content', generationKey: 'machine-a:sess-1:summary:1',
      metadata: {
        record: 'summary', project: 'infra', memorySessionId: 'sess-1', platformSource: 'claude',
        createdAtEpoch: 1750000005000, request: 'Deploy', investigated: 'x', learned: 'y',
        completed: 'z', next_steps: 'w', notes: null,
      },
    });

    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ViewerApiRoutes({ pool: pool as never }));
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

  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  it('serves all three feed endpoints with 200 (so the viewer never spins) and NO auth', async () => {
    const [obs, sum, prompts] = await Promise.all([
      get('/api/observations'), get('/api/summaries'), get('/api/prompts'),
    ]);
    expect(obs.status).toBe(200);
    expect(sum.status).toBe(200);
    expect(prompts.status).toBe(200);
    expect((await prompts.json())).toEqual({ items: [], hasMore: false, offset: 0, limit: 20 });
  });

  it('splits observations from summaries by metadata record', async () => {
    const obs = await (await get('/api/observations')).json();
    const sum = await (await get('/api/summaries')).json();
    expect(obs.items).toHaveLength(3);
    expect(obs.items.every((o: any) => typeof o.facts === 'string')).toBe(true);
    expect(obs.items[0].title).toMatch(/^Obs /);
    expect(sum.items).toHaveLength(1);
    expect(sum.items[0].request).toBe('Deploy');
  });

  it('narrows the feed by repo (metadata project) filter', async () => {
    const infra = await (await get('/api/observations?project=infra')).json();
    const other = await (await get('/api/observations?project=claudemem')).json();
    expect(infra.items).toHaveLength(2);
    expect(other.items).toHaveLength(1);
    expect(other.items[0].project).toBe('claudemem');
  });

  it('paginates with offset/limit and reports hasMore', async () => {
    const page1 = await (await get('/api/observations?offset=0&limit=2')).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await (await get('/api/observations?offset=2&limit=2')).json();
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it('serves the project catalog for the filter dropdown', async () => {
    const cat = await (await get('/api/projects')).json();
    expect(cat.projects.sort()).toEqual(['claudemem', 'infra']);
    expect(cat.sources).toEqual(['claude']);
    expect(cat.projectsBySource.claude.sort()).toEqual(['claudemem', 'infra']);
  });

  it('/stream emits connected + initial_load as default SSE messages', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stream`, { headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: ');
    expect(text).toContain('"type":"connected"');
    await reader.cancel();
  });
});
