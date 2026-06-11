import type { ObjectId, Predicate } from "../core/types.js";
import type { SearchResult } from "../index/search.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import type { StoredMemoryRelation } from "../storage/relations.js";

export const QUERY_SEED_LIMIT = 20;
export const QUERY_SCORE_FLOOR_MIN = 20;
export const QUERY_SCORE_FLOOR_RATIO = 0.2;

export interface SelectQuerySubgraphOptions {
  objects: readonly StoredMemoryObject[];
  relations: readonly StoredMemoryRelation[];
  matches: readonly SearchResult[];
}

export interface QuerySeed {
  object: StoredMemoryObject;
  score: number;
}

export interface QueryConnectedNode {
  node: StoredMemoryObject;
  predicate: Predicate;
  via: ObjectId;
}

export interface QuerySubgraph {
  seeds: QuerySeed[];
  connected: QueryConnectedNode[];
  openQuestions: QueryConnectedNode[];
}

export function selectQuerySubgraph(options: SelectQuerySubgraphOptions): QuerySubgraph {
  const objectsById = mapObjectsById(options.objects);
  const seeds = selectSeeds(options.matches, objectsById);

  if (seeds.length === 0) {
    return {
      seeds: [],
      connected: [],
      openQuestions: []
    };
  }

  const seedIds = new Set(seeds.map((seed) => seed.object.sidecar.id));
  const connected: QueryConnectedNode[] = [];
  const openQuestions: QueryConnectedNode[] = [];
  const connectedIds = new Set<ObjectId>();
  const activeRelations = [...options.relations]
    .filter((relation) => relation.relation.status === "active")
    .sort(compareRelationsById);

  for (const seed of seeds) {
    const seedId = seed.object.sidecar.id;

    for (const stored of activeRelations) {
      const neighborId = neighborForSeed(stored, seedId);

      if (neighborId === null || seedIds.has(neighborId) || connectedIds.has(neighborId)) {
        continue;
      }

      const neighbor = objectsById.get(neighborId);

      if (neighbor === undefined || neighbor.sidecar.status === "superseded") {
        continue;
      }

      connectedIds.add(neighborId);

      const entry: QueryConnectedNode = {
        node: neighbor,
        predicate: stored.relation.predicate,
        via: seedId
      };

      if (isOpenQuestion(neighbor)) {
        openQuestions.push(entry);
      } else {
        connected.push(entry);
      }
    }
  }

  return {
    seeds,
    connected,
    openQuestions
  };
}

function selectSeeds(
  matches: readonly SearchResult[],
  objectsById: ReadonlyMap<ObjectId, StoredMemoryObject>
): QuerySeed[] {
  const ranked = [...matches].sort((left, right) => right.score - left.score);
  const topScore = ranked[0]?.score;

  if (topScore === undefined) {
    return [];
  }

  const floor = Math.max(QUERY_SCORE_FLOOR_MIN, QUERY_SCORE_FLOOR_RATIO * topScore);
  const seeds: QuerySeed[] = [];
  const seen = new Set<ObjectId>();

  for (const match of ranked) {
    if (match.score < floor || seen.has(match.id)) {
      continue;
    }

    const object = objectsById.get(match.id);

    if (object === undefined) {
      continue;
    }

    seen.add(match.id);
    seeds.push({
      object,
      score: match.score
    });
  }

  return seeds;
}

function neighborForSeed(stored: StoredMemoryRelation, seedId: ObjectId): ObjectId | null {
  if (stored.relation.from === seedId) {
    return stored.relation.to;
  }

  if (stored.relation.to === seedId) {
    return stored.relation.from;
  }

  return null;
}

function isOpenQuestion(object: StoredMemoryObject): boolean {
  return object.sidecar.type === "question" && object.sidecar.status === "open";
}

function mapObjectsById(
  objects: readonly StoredMemoryObject[]
): Map<ObjectId, StoredMemoryObject> {
  return new Map(objects.map((object) => [object.sidecar.id, object]));
}

function compareRelationsById(
  left: StoredMemoryRelation,
  right: StoredMemoryRelation
): number {
  return left.relation.id.localeCompare(right.relation.id);
}
