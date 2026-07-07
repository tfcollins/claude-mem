// SPDX-License-Identifier: Apache-2.0
//
// Remote-store fork: push finished observations/summaries to the shared
// claude-mem server (POST /v1/memories) so every machine of one operator
// reads the same memory. Mirrors ChromaSync's call surface so the
// ResponseProcessor call sites stay symmetrical: local SQLite remains the
// source of truth and offline cache; this is an additive, fire-and-forget
// replica. Failures are logged and dropped — a dead LAN link must never
// block observation storage or a Claude session.
//
// Payload notes:
//   - `content` is the packed searchable text (title/subtitle/narrative/
//     facts) — it feeds the server's generated tsvector, so anything that
//     should be findable via /v1/search must be in here.
//   - `generationKey` = machineId:memorySessionId:localId rides the
//     server's (team_id, project_id, generation_key) partial-unique index,
//     so retries and outbox replays upsert instead of duplicating.
//   - The full structured observation lives in `metadata`; readers
//     (RemoteReader) rebuild display shapes from it. `metadata.project` is
//     the per-repo identity the server filters on.

import { ParsedObservation } from '../../sdk/parser.js';
import { fetchWithTimeout } from '../../shared/worker-utils.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { logger } from '../../utils/logger.js';

export interface RemoteStoreConfig {
  serverUrl: string;
  apiKey: string;
  projectId: string;
  machineId: string;
  readTimeoutMs: number;
  writeTimeoutMs: number;
}

interface SummaryForStore {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

/**
 * Resolve the remote-store config from settings, or null when the feature is
 * off or incompletely configured. Deliberately strict: a half-configured
 * remote store behaves as "off" rather than throwing from the worker.
 */
export function loadRemoteStoreConfig(
  settings: SettingsDefaults = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH),
): RemoteStoreConfig | null {
  if (settings.CLAUDE_MEM_REMOTE_STORE !== 'true') {
    return null;
  }
  const serverUrl = (settings.CLAUDE_MEM_SERVER_URL || '').replace(/\/+$/, '');
  const apiKey = settings.CLAUDE_MEM_SERVER_API_KEY || settings.CLAUDE_MEM_SERVER_BETA_API_KEY;
  const projectId = settings.CLAUDE_MEM_SERVER_PROJECT_ID || settings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID;
  if (!serverUrl || !apiKey || !projectId) {
    logger.warn('REMOTE', 'CLAUDE_MEM_REMOTE_STORE=true but server URL/API key/project id incomplete — remote store disabled', {
      hasUrl: Boolean(serverUrl),
      hasKey: Boolean(apiKey),
      hasProjectId: Boolean(projectId),
    });
    return null;
  }
  return {
    serverUrl,
    apiKey,
    projectId,
    machineId: settings.CLAUDE_MEM_MACHINE_ID,
    readTimeoutMs: clampMs(settings.CLAUDE_MEM_REMOTE_READ_TIMEOUT_MS, 1500),
    writeTimeoutMs: clampMs(settings.CLAUDE_MEM_REMOTE_WRITE_TIMEOUT_MS, 10000),
  };
}

function clampMs(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100 || n > 300000) return fallback;
  return Math.floor(n);
}

export class RemoteSync {
  constructor(private readonly config: RemoteStoreConfig) {}

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string,
  ): Promise<void> {
    const content = packText([
      obs.title,
      obs.subtitle,
      obs.narrative,
      ...(obs.facts || []),
      ...(obs.concepts || []),
    ]);
    if (!content) {
      // The server rejects empty content (nothing would be searchable).
      logger.debug('REMOTE', 'Skipping remote push of contentless observation', { observationId });
      return;
    }
    await this.push({
      kind: obs.type || 'observation',
      content,
      generationKey: `${this.config.machineId}:${memorySessionId}:obs:${observationId}`,
      metadata: {
        record: 'observation',
        project,
        machineId: this.config.machineId,
        memorySessionId,
        localId: observationId,
        promptNumber,
        createdAtEpoch,
        platformSource: normalizePlatformSource(platformSource),
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        narrative: obs.narrative,
        facts: obs.facts || [],
        concepts: obs.concepts || [],
        files_read: obs.files_read || [],
        files_modified: obs.files_modified || [],
      },
    });
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: SummaryForStore,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string,
  ): Promise<void> {
    const content = packText([
      summary.request,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
    ]);
    if (!content) {
      logger.debug('REMOTE', 'Skipping remote push of contentless summary', { summaryId });
      return;
    }
    await this.push({
      kind: 'session_summary',
      content,
      generationKey: `${this.config.machineId}:${memorySessionId}:summary:${summaryId}`,
      metadata: {
        record: 'summary',
        project,
        machineId: this.config.machineId,
        memorySessionId,
        localId: summaryId,
        promptNumber,
        createdAtEpoch,
        platformSource: normalizePlatformSource(platformSource),
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        next_steps: summary.next_steps,
        notes: summary.notes,
      },
    });
  }

  private async push(body: {
    kind: string;
    content: string;
    generationKey: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.config.serverUrl}/v1/memories`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: this.config.projectId,
          ...body,
        }),
      },
      this.config.writeTimeoutMs,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Remote store push failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
    }
  }
}

function packText(parts: Array<string | null | undefined>): string {
  return parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(part => part.length > 0)
    .join('\n');
}
