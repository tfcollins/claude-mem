// SPDX-License-Identifier: Apache-2.0
//
// Server-beta viewer compatibility shim (fork).
//
// The bundled viewer UI (plugin/ui/viewer-bundle.js) was built for the WORKER
// runtime: it fetches /api/observations|summaries|prompts (+ projects/settings/
// logs) and opens an SSE EventSource('/stream'). The server-beta runtime serves
// only /v1/* (key-gated) + the viewer static files, so every /api fetch 404s
// and the feed spins forever (usePagination leaves isLoading stuck true on any
// non-200). This router adapts the server's Postgres `observations` rows into
// the exact JSON shapes the existing bundle expects, so the shared-memory
// viewer renders without touching the UI bundle.
//
// Read-only and UNAUTHENTICATED at the app layer: the browser bundle sends no
// API key, and the deployment is single-user/LAN-only behind Traefik (like the
// other homelab dashboards). /v1/* stays key-gated and unchanged. If access
// control is ever wanted it goes at Traefik (forward-auth), no code change.
//
// Tenant scope is resolved server-side (the single bootstrap `local-hook-project`)
// since there is no bearer token to carry (project_id, team_id).

import type { Application, Request, Response } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresObservationRepository, type PostgresObservation } from '../../storage/postgres/observations.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

const LOCAL_HOOK_PROJECT_NAME = 'local-hook-project';
const SSE_KEEPALIVE_MS = 20_000;

// Viewer wire shapes (mirror src/services/worker-types.ts Observation/Summary,
// but `id` is the server row UUID — the UI treats id opaquely as a React key /
// dedup handle, and a UUID avoids cross-machine numeric-id collisions).
interface ViewerObservation {
  id: string;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: string;
  title: string;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
}

interface ViewerSummary {
  id: string;
  session_id: string;
  project: string;
  platform_source: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at: string;
  created_at_epoch: number;
}

interface Tenant {
  projectId: string;
  teamId: string;
}

export interface ViewerApiRoutesOptions {
  pool: PostgresPool;
}

export class ViewerApiRoutes implements RouteHandler {
  private tenant: Tenant | null = null;
  // Connected viewer SSE clients. Live memory writes fan out to these as the
  // new_observation / new_summary frames the bundle already handles, so an
  // open viewer updates without a refresh.
  private readonly clients = new Set<Response>();

  constructor(private readonly options: ViewerApiRoutesOptions) {}

  // Called by the /v1/memories write path (wired in ServerService) whenever a
  // memory row is created. Fire-and-forget; a broadcast failure must never
  // affect the write. Single-user deploy = one tenant, but guard on the
  // resolved tenant anyway so a foreign-tenant write never leaks into the view.
  broadcastMemory(row: PostgresObservation): void {
    if (this.clients.size === 0) return;
    if (this.tenant && row.projectId !== this.tenant.projectId) return;
    const record = (row.metadata as Record<string, unknown> | null)?.record;
    const event = record === 'summary'
      ? { type: 'new_summary', summary: toViewerSummary(row) }
      : { type: 'new_observation', observation: toViewerObservation(row) };
    this.broadcast(event);
  }

  private broadcast(event: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ ...event, timestamp: nowEpoch() })}\n\n`;
    for (const client of this.clients) {
      try { client.write(frame); } catch { this.clients.delete(client); }
    }
  }

  setupRoutes(app: Application): void {
    app.get('/api/observations', this.asyncHandler((req, res) => this.handleFeed(req, res, 'observation')));
    app.get('/api/summaries', this.asyncHandler((req, res) => this.handleFeed(req, res, 'summary')));
    // The shared server does not store raw user prompts (user_prompts is a
    // worker/SQLite concept). Honest empty — still 200 so the spinner clears.
    app.get('/api/prompts', (_req, res) => { res.json({ items: [], hasMore: false, offset: 0, limit: 20 }); });
    app.get('/api/projects', this.asyncHandler((req, res) => this.handleProjects(req, res)));
    app.get('/api/settings', (_req, res) => { res.json(SettingsDefaultsManager.getAllDefaults()); });
    app.get('/api/logs', (_req, res) => { res.json({ logs: '', path: '', exists: false }); });
    app.get('/api/context/preview', (_req, res) => {
      res.type('text/plain').send('Context preview is not available on the shared server viewer.');
    });
    app.get('/api/onboarding/explainer', (_req, res) => {
      res.type('text/markdown').send(ONBOARDING_MARKDOWN);
    });
    // Read-only central store: these modal actions cannot mutate per-machine
    // config. Report failure honestly rather than silently no-op.
    app.post('/api/settings', (_req, res) => {
      res.status(200).json({ success: false, error: 'The shared server viewer is read-only.' });
    });
    app.post('/api/logs/clear', (_req, res) => {
      res.status(200).json({ success: false, error: 'The shared server viewer is read-only.' });
    });
    app.get('/stream', (req, res) => this.handleStream(req, res));
  }

  private async handleFeed(req: Request, res: Response, record: 'observation' | 'summary'): Promise<void> {
    const { offset, limit } = parsePaging(req);
    const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
    const tenant = await this.resolveTenant();
    if (!tenant) {
      res.json({ items: [], hasMore: false, offset, limit });
      return;
    }
    const repo = new PostgresObservationRepository(this.options.pool);
    const { rows, hasMore } = await repo.listForViewer({
      projectId: tenant.projectId,
      teamId: tenant.teamId,
      record,
      project,
      offset,
      limit,
    });
    const items = record === 'observation'
      ? rows.map(toViewerObservation)
      : rows.map(toViewerSummary);
    res.json({ items, hasMore, offset, limit });
  }

  private async handleProjects(_req: Request, res: Response): Promise<void> {
    const tenant = await this.resolveTenant();
    if (!tenant) {
      res.json({ projects: [], sources: [], projectsBySource: {} });
      return;
    }
    const repo = new PostgresObservationRepository(this.options.pool);
    res.json(await repo.projectCatalog(tenant));
  }

  private handleStream(req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Defensive against proxy buffering of the stream.
      'X-Accel-Buffering': 'no',
    });
    // Default (unnamed) message frames — the client uses onmessage and
    // discriminates on data.type. No `event:` line.
    const send = (obj: unknown): void => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    send({ type: 'connected', timestamp: nowEpoch() });

    void (async () => {
      let projects: string[] = [];
      let sources: string[] = [];
      let projectsBySource: Record<string, string[]> = {};
      try {
        const tenant = await this.resolveTenant();
        if (tenant) {
          const catalog = await new PostgresObservationRepository(this.options.pool).projectCatalog(tenant);
          ({ projects, sources, projectsBySource } = catalog);
        }
      } catch (error) {
        logger.warn('SYSTEM', 'viewer shim: /stream initial_load failed', {}, error as Error);
      }
      // initial_load populates the header project-filter dropdown.
      send({ type: 'initial_load', projects, sources, projectsBySource, timestamp: nowEpoch() });
      send({ type: 'processing_status', isProcessing: false, queueDepth: 0, timestamp: nowEpoch() });
    })();

    // Register for live broadcasts (new_observation / new_summary).
    this.clients.add(res);

    const keepalive = setInterval(() => {
      // Comment frame keeps the connection alive without triggering onmessage.
      res.write(': ping\n\n');
    }, SSE_KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      this.clients.delete(res);
    });
  }

  // Resolve (projectId, teamId) for the single bootstrap tenant. Never caches a
  // null result — memory may not exist yet on first request; re-query until the
  // project appears, then cache.
  private async resolveTenant(): Promise<Tenant | null> {
    if (this.tenant) return this.tenant;
    try {
      const byName = await this.options.pool.query<{ id: string; team_id: string }>(
        'SELECT id, team_id FROM projects WHERE name = $1 LIMIT 1',
        [LOCAL_HOOK_PROJECT_NAME],
      );
      let row = byName.rows[0];
      if (!row) {
        const any = await this.options.pool.query<{ id: string; team_id: string }>(
          'SELECT id, team_id FROM projects ORDER BY created_at ASC LIMIT 1',
        );
        row = any.rows[0];
      }
      if (row) {
        this.tenant = { projectId: row.id, teamId: row.team_id };
        return this.tenant;
      }
      return null;
    } catch (error) {
      logger.warn('SYSTEM', 'viewer shim: tenant resolution failed', {}, error as Error);
      return null;
    }
  }

  private asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: (err?: unknown) => void): void => {
      fn(req, res).catch((error) => {
        logger.error('SYSTEM', 'viewer shim handler failed', {}, error as Error);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
        else next(error);
      });
    };
  }
}

function parsePaging(req: Request): { offset: number; limit: number } {
  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const rawOffset = Number.parseInt(String(req.query.offset ?? ''), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { offset, limit };
}

function meta(row: PostgresObservation): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}
function str(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
function numOr(v: unknown, fallback: number): number { return typeof v === 'number' ? v : fallback; }
function jsonArr(v: unknown): string { return JSON.stringify(Array.isArray(v) ? v : []); }
function nowEpoch(): number { return Date.now(); }

export function toViewerObservation(row: PostgresObservation): ViewerObservation {
  const m = meta(row);
  const epoch = numOr(m.createdAtEpoch, row.createdAtEpoch);
  return {
    id: row.id,
    memory_session_id: str(m.memorySessionId) ?? row.serverSessionId ?? '',
    project: str(m.project) ?? '',
    merged_into_project: null,
    platform_source: str(m.platformSource) ?? 'claude',
    type: str(m.type) ?? row.kind ?? 'discovery',
    title: str(m.title) ?? (row.content ? row.content.split('\n')[0] : 'Observation'),
    subtitle: str(m.subtitle),
    text: null,
    narrative: str(m.narrative),
    facts: jsonArr(m.facts),
    concepts: jsonArr(m.concepts),
    files_read: jsonArr(m.files_read),
    files_modified: jsonArr(m.files_modified),
    prompt_number: numOr(m.promptNumber, 0),
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
  };
}

export function toViewerSummary(row: PostgresObservation): ViewerSummary {
  const m = meta(row);
  const epoch = numOr(m.createdAtEpoch, row.createdAtEpoch);
  return {
    id: row.id,
    session_id: str(m.memorySessionId) ?? row.serverSessionId ?? '',
    project: str(m.project) ?? '',
    platform_source: str(m.platformSource) ?? 'claude',
    request: str(m.request),
    investigated: str(m.investigated),
    learned: str(m.learned),
    completed: str(m.completed),
    next_steps: str(m.next_steps),
    notes: str(m.notes),
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
  };
}

const ONBOARDING_MARKDOWN = `# claude-mem shared memory viewer

This is the central shared-memory server. It pools the observations and session
summaries that every machine's local claude-mem worker pushes here, so you can
browse memory from all machines in one place.

Memory is captured and compressed **locally on each machine** (on that machine's
Claude subscription) and replicated here. This viewer is read-only.
`;
