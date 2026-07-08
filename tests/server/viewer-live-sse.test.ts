// SPDX-License-Identifier: Apache-2.0
//
// Live viewer updates end-to-end: a POST /v1/memories write must fan out to an
// open /stream client as the new_observation / new_summary frame the bundle
// consumes (ServerV1PostgresRoutes.onMemoryCreated → ViewerApiRoutes.broadcast).
// Exercises the real wiring both route classes share in ServerService.
// Postgres-gated, same harness as remote-store-routes.test.ts.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { ViewerApiRoutes } from '../../src/server/runtime/ViewerApiRoutes.js';
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

// Read decoded SSE text until a `data:` frame whose JSON matches `pick`, or throw on timeout.
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pick: (data: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (pick(data)) return data;
    }
  }
  throw new Error('SSE frame not received before timeout');
}

describe('viewer live SSE updates', () => {
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
  let apiKey: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = `cm_sse_${randomUUID().replaceAll('-', '_')}`;
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
    projectId = project.id;
    apiKey = createRawApiKey();
    await storage.auth.createApiKey({
      keyHash: hashApiKey(apiKey), teamId: team.id, projectId: project.id,
      actorId: 'test', scopes: [...HOOK_API_KEY_SCOPES],
    });

    const viewerApi = new ViewerApiRoutes({ pool: pool as never });
    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
      onMemoryCreated: (obs) => viewerApi.broadcastMemory(obs),
    }));
    server.registerRoutes(viewerApi);
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

  const postMemory = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('pushes a new_observation frame to an open /stream client when a memory is written', async () => {
    const sse = await fetch(`http://127.0.0.1:${port}/stream`, { headers: { Accept: 'text/event-stream' } });
    const reader = sse.body!.getReader();
    // Drain the connected/initial_load handshake first.
    await readFrame(reader, (d) => d.type === 'initial_load');

    const res = await postMemory({
      projectId, kind: 'discovery', content: 'Live obs about traefik routing',
      generationKey: 'machine-a:sess-1:obs:99',
      metadata: {
        record: 'observation', project: 'infra', machineId: 'machine-a', memorySessionId: 'sess-1',
        localId: 99, promptNumber: 1, createdAtEpoch: 1750000009000, platformSource: 'claude',
        type: 'discovery', title: 'Live traefik note', subtitle: null, narrative: 'streamed live',
        facts: ['f'], concepts: [], files_read: [], files_modified: [],
      },
    });
    expect(res.status).toBe(201);

    const frame = await readFrame(reader, (d) => d.type === 'new_observation');
    expect(frame.observation.title).toBe('Live traefik note');
    expect(frame.observation.project).toBe('infra');
    expect(typeof frame.observation.facts).toBe('string'); // JSON-string, matches /api shape
    expect(JSON.parse(frame.observation.facts)).toEqual(['f']);
    await reader.cancel();
  });

  it('pushes a new_summary frame for a summary write', async () => {
    const sse = await fetch(`http://127.0.0.1:${port}/stream`, { headers: { Accept: 'text/event-stream' } });
    const reader = sse.body!.getReader();
    await readFrame(reader, (d) => d.type === 'initial_load');

    await postMemory({
      projectId, kind: 'session_summary', content: 'Live summary body',
      generationKey: 'machine-a:sess-1:summary:5',
      metadata: {
        record: 'summary', project: 'infra', memorySessionId: 'sess-1', platformSource: 'claude',
        createdAtEpoch: 1750000010000, request: 'Ship live SSE', investigated: 'x', learned: 'y',
        completed: 'z', next_steps: 'w', notes: null,
      },
    });

    const frame = await readFrame(reader, (d) => d.type === 'new_summary');
    expect(frame.summary.request).toBe('Ship live SSE');
    expect(frame.summary.project).toBe('infra');
    await reader.cancel();
  });
});
