// SPDX-License-Identifier: Apache-2.0
//
// Remote-store fork: read path against the shared claude-mem server.
// The worker is the only thing that talks to the network — hooks keep
// hitting the local worker, so a dead server can cost at most
// `readTimeoutMs` inside the worker, never a hung Claude session. Callers
// treat every failure as "no remote rows" and fall back to local data.
//
// Rows come back as the flat server observation (kind/content/metadata);
// the structured observation RemoteSync packed into `metadata` is rebuilt
// here into the local ObservationSearchResult shape so formatters and MCP
// tools can render remote rows exactly like local ones.

import { fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import type { RemoteStoreConfig } from '../sync/RemoteSync.js';
import type { ObservationSearchResult } from '../sqlite/types.js';

export interface RemoteMemory {
  id: string;
  kind: string;
  content: string;
  generationKey: string | null;
  createdAtEpoch: number;
  metadata: Record<string, unknown>;
}

export class RemoteReader {
  constructor(private readonly config: RemoteStoreConfig) {}

  getMachineId(): string {
    return this.config.machineId;
  }

  /** Newest-first rows for one repo (`project` = local repo name). */
  async recent(project: string, limit: number): Promise<RemoteMemory[]> {
    const params = new URLSearchParams({
      projectId: this.config.projectId,
      project,
      limit: String(limit),
    });
    const response = await fetchWithTimeout(
      `${this.config.serverUrl}/v1/memories?${params}`,
      { headers: { 'Authorization': `Bearer ${this.config.apiKey}` } },
      this.config.readTimeoutMs,
    );
    if (!response.ok) {
      throw new Error(`Remote store list failed: HTTP ${response.status}`);
    }
    const body = await response.json() as { memories?: unknown[] };
    return (body.memories ?? []).map(mapRemoteRow);
  }

  /** Server-side FTS, optionally narrowed to one repo. */
  async search(query: string, project: string | undefined, limit: number): Promise<RemoteMemory[]> {
    const response = await fetchWithTimeout(
      `${this.config.serverUrl}/v1/search`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: this.config.projectId,
          query,
          limit,
          ...(project ? { project } : {}),
        }),
      },
      this.config.readTimeoutMs,
    );
    if (!response.ok) {
      throw new Error(`Remote store search failed: HTTP ${response.status}`);
    }
    const body = await response.json() as { observations?: unknown[] };
    return (body.observations ?? []).map(mapRemoteRow);
  }

  /**
   * Rows written by OTHER machines — the interesting ones for context
   * injection (this machine's rows are already in its local timeline).
   * Any failure is logged at debug and returns [] so callers stay simple.
   */
  async recentFromOtherMachines(project: string, limit: number): Promise<RemoteMemory[]> {
    try {
      const rows = await this.recent(project, limit);
      return rows.filter(row => row.metadata.machineId !== this.config.machineId);
    } catch (error) {
      logger.debug('REMOTE', 'Remote recent fetch failed — context stays local-only', {
        project,
      }, error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }
}

function mapRemoteRow(raw: unknown): RemoteMemory {
  const row = (raw ?? {}) as Record<string, unknown>;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ''),
    kind: String(row.kind ?? 'observation'),
    content: String(row.content ?? ''),
    generationKey: typeof row.generationKey === 'string' ? row.generationKey : null,
    createdAtEpoch: typeof row.createdAtEpoch === 'number' ? row.createdAtEpoch : 0,
    metadata,
  };
}

/**
 * Rebuild the local search-result shape from the structured observation
 * RemoteSync stored in metadata. Only `record: 'observation'` rows map
 * cleanly; callers should filter on that first.
 */
export function toObservationSearchResult(row: RemoteMemory): ObservationSearchResult {
  const m = row.metadata;
  const epoch = typeof m.createdAtEpoch === 'number' ? m.createdAtEpoch : row.createdAtEpoch;
  return {
    id: typeof m.localId === 'number' ? m.localId : 0,
    memory_session_id: typeof m.memorySessionId === 'string' ? m.memorySessionId : '',
    project: typeof m.project === 'string' ? m.project : '',
    text: null,
    type: (typeof m.type === 'string' ? m.type : 'discovery') as ObservationSearchResult['type'],
    title: typeof m.title === 'string' ? m.title : null,
    subtitle: typeof m.subtitle === 'string' ? m.subtitle : null,
    facts: JSON.stringify(Array.isArray(m.facts) ? m.facts : []),
    narrative: typeof m.narrative === 'string' ? m.narrative : null,
    concepts: JSON.stringify(Array.isArray(m.concepts) ? m.concepts : []),
    files_read: JSON.stringify(Array.isArray(m.files_read) ? m.files_read : []),
    files_modified: JSON.stringify(Array.isArray(m.files_modified) ? m.files_modified : []),
    prompt_number: typeof m.promptNumber === 'number' ? m.promptNumber : null,
    discovery_tokens: 0,
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
  };
}
