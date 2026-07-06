/**
 * Cluster discovery — unnamed groupings by stain/link/atmosphere overlap.
 * Accumulates namelessness_pressure on clusters without a current_name.
 */
import crypto from 'crypto';
import type { RoomObject } from './types.js';
import { getRoomDb, insertTrace } from './store.js';
import { logger } from '../logger.js';

export interface Cluster {
  id: string;
  discovered_at: string;
  atmosphere_fingerprint: string; // JSON: aggregate mood + stain shape
  shape: string;
  member_ids: string[];
  current_name: string | null;
  namelessness_pressure: number;
  stability: number;
  last_updated: string;
}

function shapeOverlap(a: RoomObject, b: RoomObject): number {
  const aShapes = a.atmosphere_stains.map((s) => s.shape);
  const bShapes = new Set(b.atmosphere_stains.map((s) => s.shape));
  const matches = aShapes.filter((s) => bShapes.has(s)).length;
  return matches;
}

function mutualLinkCount(a: RoomObject, b: RoomObject): number {
  const aLinks = new Set(a.links);
  const bLinks = new Set(b.links);
  let count = 0;
  if (aLinks.has(b.id) || bLinks.has(a.id)) count++;
  // Check shared link targets
  for (const l of aLinks) {
    if (bLinks.has(l)) count++;
  }
  return count;
}

function moodAffinityOverlap(a: RoomObject, b: RoomObject): number {
  const aKeys = Object.keys(a.mood_affinity);
  if (aKeys.length === 0) return 0;
  let overlapSum = 0;
  let total = 0;
  for (const k of aKeys) {
    const bVal = b.mood_affinity[k] ?? 0;
    overlapSum += Math.min(a.mood_affinity[k], bVal);
    total += Math.max(a.mood_affinity[k], bVal);
  }
  return total === 0 ? 0 : overlapSum / total;
}

function pairsCluster(a: RoomObject, b: RoomObject): boolean {
  if (shapeOverlap(a, b) >= 3) return true;
  if (mutualLinkCount(a, b) >= 2) return true;
  if (moodAffinityOverlap(a, b) > 0.7) return true;
  return false;
}

function computeFingerprint(members: RoomObject[]): {
  fingerprint: string;
  dominantShape: string;
} {
  const shapeCounts: Record<string, number> = {};
  for (const obj of members) {
    for (const stain of obj.atmosphere_stains) {
      shapeCounts[stain.shape] =
        (shapeCounts[stain.shape] ?? 0) + stain.strength;
    }
  }
  const dominantShape =
    Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    'diffuse';
  const fingerprint = JSON.stringify({
    shapes: shapeCounts,
    dominant: dominantShape,
  });
  return { fingerprint, dominantShape };
}

export function discoverClusters(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
): void {
  const db = getRoomDb(groupFolder);
  const now = new Date().toISOString();

  // Build adjacency: which objects should cluster together
  const nonArchived = objects.filter((o) => o.status !== 'archived');
  const graph = new Map<string, Set<string>>();
  for (const obj of nonArchived) graph.set(obj.id, new Set());

  for (let i = 0; i < nonArchived.length; i++) {
    for (let j = i + 1; j < nonArchived.length; j++) {
      const a = nonArchived[i];
      const b = nonArchived[j];
      if (pairsCluster(a, b)) {
        graph.get(a.id)!.add(b.id);
        graph.get(b.id)!.add(a.id);
      }
    }
  }

  // BFS to find connected components of 2-6 objects
  const visited = new Set<string>();
  const newClusters: Array<{ members: RoomObject[] }> = [];

  for (const obj of nonArchived) {
    if (visited.has(obj.id)) continue;
    const component: RoomObject[] = [];
    const queue = [obj];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur.id)) continue;
      visited.add(cur.id);
      component.push(cur);
      for (const neighborId of graph.get(cur.id) ?? []) {
        if (!visited.has(neighborId)) {
          const neighbor = nonArchived.find((o) => o.id === neighborId);
          if (neighbor) queue.push(neighbor);
        }
      }
    }
    if (component.length >= 2 && component.length <= 6) {
      newClusters.push({ members: component });
    }
  }

  // Load existing clusters
  const existingRows = db.prepare('SELECT * FROM clusters').all() as Array<{
    id: string;
    member_ids: string;
    current_name: string | null;
    namelessness_pressure: number;
    stability: number;
    discovered_at: string;
  }>;

  // Build set of member_ids signatures for dedup
  const memberSigToExisting = new Map<string, (typeof existingRows)[0]>();
  for (const row of existingRows) {
    const sig = JSON.parse(row.member_ids as string)
      .sort()
      .join(',');
    memberSigToExisting.set(sig, row);
  }

  let newCount = 0;
  let updatedCount = 0;

  const upsertStmt = db.prepare(`
    INSERT INTO clusters (id, discovered_at, atmosphere_fingerprint, shape, member_ids, current_name, namelessness_pressure, stability, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      atmosphere_fingerprint = excluded.atmosphere_fingerprint,
      shape = excluded.shape,
      member_ids = excluded.member_ids,
      namelessness_pressure = excluded.namelessness_pressure,
      stability = excluded.stability,
      last_updated = excluded.last_updated
  `);

  for (const { members } of newClusters) {
    const sig = members
      .map((m) => m.id)
      .sort()
      .join(',');
    const existing = memberSigToExisting.get(sig);
    const { fingerprint, dominantShape } = computeFingerprint(members);

    if (existing) {
      // Update existing cluster: accumulate namelessness pressure
      const discoveredAt = new Date(existing.discovered_at);
      const daysUnnamed = existing.current_name
        ? 0
        : (Date.now() - discoveredAt.getTime()) / (1000 * 60 * 60 * 24);
      const np = Math.min(
        1,
        existing.namelessness_pressure + members.length * daysUnnamed * 0.05,
      );

      upsertStmt.run(
        existing.id,
        existing.discovered_at,
        fingerprint,
        dominantShape,
        JSON.stringify(members.map((m) => m.id)),
        existing.current_name,
        np,
        Math.min(1, existing.stability + 0.02),
        now,
      );
      updatedCount++;
    } else {
      // New cluster
      const id = `cl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      upsertStmt.run(
        id,
        now,
        fingerprint,
        dominantShape,
        JSON.stringify(members.map((m) => m.id)),
        null,
        0,
        0.3,
        now,
      );
      newCount++;
      insertTrace(
        groupFolder,
        pulseId,
        'cluster_discovered',
        members.map((m) => m.id),
        `new cluster ${id} with ${members.length} members, shape=${dominantShape}`,
      );
    }
  }

  // Drop clusters whose all member links have died (members all archived)
  const archivedIds = new Set(
    objects.filter((o) => o.status === 'archived').map((o) => o.id),
  );
  for (const row of existingRows) {
    const memberIds: string[] = JSON.parse(row.member_ids as string);
    if (memberIds.every((mid) => archivedIds.has(mid))) {
      db.prepare('DELETE FROM clusters WHERE id = ?').run(row.id);
      logger.debug(
        { groupFolder, clusterId: row.id },
        'Cluster dropped (all members archived)',
      );
    }
  }

  // Update cluster_id on objects
  const allClusters = db.prepare('SELECT * FROM clusters').all() as Array<{
    id: string;
    member_ids: string;
  }>;
  for (const cl of allClusters) {
    const memberIds: string[] = JSON.parse(cl.member_ids as string);
    for (const mid of memberIds) {
      db.prepare('UPDATE objects SET cluster_id = ? WHERE id = ?').run(
        cl.id,
        mid,
      );
    }
  }

  if (newCount > 0 || updatedCount > 0) {
    logger.debug(
      { groupFolder, newCount, updatedCount },
      'Cluster discovery complete',
    );
  }
}

export function getAllClusters(groupFolder: string): Cluster[] {
  const db = getRoomDb(groupFolder);
  const rows = db.prepare('SELECT * FROM clusters').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    discovered_at: r.discovered_at as string,
    atmosphere_fingerprint: r.atmosphere_fingerprint as string,
    shape: r.shape as string,
    member_ids: JSON.parse(r.member_ids as string),
    current_name: r.current_name as string | null,
    namelessness_pressure: r.namelessness_pressure as number,
    stability: r.stability as number,
    last_updated: r.last_updated as string,
  }));
}

export function computeNamelessnessPressure(groupFolder: string): number {
  const db = getRoomDb(groupFolder);
  const rows = db
    .prepare('SELECT * FROM clusters WHERE current_name IS NULL')
    .all() as Array<{
    id: string;
    discovered_at: string;
    member_ids: string;
    namelessness_pressure: number;
  }>;

  let total = 0;
  const now = Date.now();
  for (const row of rows) {
    const memberIds: string[] = JSON.parse(row.member_ids as string);
    const daysUnnamed =
      (now - new Date(row.discovered_at).getTime()) / (1000 * 60 * 60 * 24);
    total += memberIds.length * daysUnnamed * 0.05;
  }
  return Math.min(1, total);
}
