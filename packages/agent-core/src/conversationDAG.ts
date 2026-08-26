import type { StoredBlock } from "./types.js";

/**
 * A node in the conversation turn DAG representing a single conversational turn.
 * Inspired by Pi's session format, each node links to its parent turn, contains
 * its associated block IDs, and can carry an optional branch tag.
 */
export interface TurnDAGNode {
  /** Unique identifier for the turn. */
  turnId: string;
  /** Parent turn identifier, or null for root turns. */
  parentTurnId: string | null;
  /** Block IDs belonging to this turn (e.g. user prompt, assistant response, tool items). */
  blockIds: string[];
  /** Timestamp when the turn started (epoch ms). */
  timestamp: number;
  /** Optional branch tag/label (e.g. "main", "sidechat", "experiment"). */
  branchTag?: string | null;
}

/**
 * Input structure for building or inserting a turn into the DAG.
 */
export interface TurnDAGInput {
  turnId: string;
  parentTurnId?: string | null;
  blockIds?: string[];
  timestamp?: number;
  branchTag?: string | null;
}

/**
 * Indexed DAG of conversation turns supporting fast ancestor path lookup,
 * branch discovery, and leaf navigation.
 */
export interface TurnDAG {
  /** Map of turnId to TurnDAGNode for O(1) node lookup. */
  nodes: Map<string, TurnDAGNode>;
  /** Root turn IDs in the DAG (turns with parentTurnId === null or unresolvable parent). */
  rootTurnIds: string[];
  /** Map of turnId to array of child turn IDs for O(1) branch traversal. */
  children: Map<string, string[]>;
}

/**
 * Builds an indexed TurnDAG from an array of turns or timeline blocks.
 *
 * Supports:
 * - Explicit TurnDAGInput objects with explicit parentTurnId links.
 * - Sequential StoredBlock arrays, automatically grouping user and assistant blocks
 *   into linear turns.
 * - Multi-root forests and arbitrary branching trees.
 */
export function buildTurnDAG(
  turns: readonly (TurnDAGInput | StoredBlock)[],
): TurnDAG {
  const nodes = new Map<string, TurnDAGNode>();
  const children = new Map<string, string[]>();
  const rootTurnIds: string[] = [];

  const normalizedNodes: TurnDAGNode[] = [];

  const isAllStoredBlocks = turns.length > 0 && turns.every((item) => "role" in item && (item.role === "user" || item.role === "assistant"));
  if (isAllStoredBlocks) {
    let pendingUserBlockIds: string[] = [];
    let prevTurnId: string | null = null;

    for (const block of turns) {
      if (block.role === "user") {
        pendingUserBlockIds.push(block.id);
      } else if (block.role === "assistant") {
        const turnId = block.turnId || block.id;
        const existing = turnId === prevTurnId ? normalizedNodes[normalizedNodes.length - 1] : undefined;
        if (existing) {
          // Same turnId as the immediately preceding turn means this block belongs
          // to that same conversational turn (e.g. a turn split across multiple
          // stored blocks), not a new one. Fold it into the existing node instead
          // of appending a second node, which would end up parented to itself.
          existing.blockIds.push(...pendingUserBlockIds, block.id);
          pendingUserBlockIds = [];
          if (block.source === "fork-import") {
            existing.branchTag = "fork-import";
          }
          continue;
        }
        const blockIds = [...pendingUserBlockIds, block.id];
        pendingUserBlockIds = [];
        normalizedNodes.push({
          turnId,
          parentTurnId: prevTurnId,
          blockIds,
          timestamp: block.at,
          branchTag: block.source === "fork-import" ? "fork-import" : null,
        });
        prevTurnId = turnId;
      }
    }

    if (pendingUserBlockIds.length > 0) {
      const firstId = pendingUserBlockIds[0];
      const turnId = `turn-${firstId}`;
      normalizedNodes.push({
        turnId,
        parentTurnId: prevTurnId,
        blockIds: pendingUserBlockIds,
        timestamp: Date.now(),
        branchTag: null,
      });
    }
  } else {
    for (const item of turns) {
      if ("role" in item && (item.role === "user" || item.role === "assistant")) {
        const turnId = item.role === "assistant" ? item.turnId : item.id;
        normalizedNodes.push({
          turnId,
          parentTurnId: null,
          blockIds: [item.id],
          timestamp: item.at,
          branchTag: item.source === "fork-import" ? "fork-import" : null,
        });
      } else {
        normalizedNodes.push({
          turnId: item.turnId,
          parentTurnId: item.parentTurnId ?? null,
          blockIds: item.blockIds ? [...item.blockIds] : [],
          timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
          branchTag: item.branchTag ?? null,
        });
      }
    }
  }

  for (const node of normalizedNodes) {
    // A turn can never be its own parent; treat a self-referential parentTurnId
    // as unresolvable so the node surfaces as a root instead of an unreachable
    // node parented to itself.
    if (node.parentTurnId === node.turnId) {
      node.parentTurnId = null;
    }
    nodes.set(node.turnId, node);
    if (!children.has(node.turnId)) {
      children.set(node.turnId, []);
    }
  }

  for (const node of normalizedNodes) {
    const parentId = node.parentTurnId;
    if (parentId !== null && nodes.has(parentId)) {
      const siblings = children.get(parentId);
      if (siblings && !siblings.includes(node.turnId)) {
        siblings.push(node.turnId);
      }
    } else {
      if (!rootTurnIds.includes(node.turnId)) {
        rootTurnIds.push(node.turnId);
      }
    }
  }

  return {
    nodes,
    rootTurnIds,
    children,
  };
}

/**
 * Retrieves the linear ancestor path from the root turn down to the target turn.
 * Returns an ordered array [rootNode, ..., targetNode], or an empty array if targetTurnId does not exist.
 */
export function getTurnPath(dag: TurnDAG, targetTurnId: string): TurnDAGNode[] {
  const targetNode = dag.nodes.get(targetTurnId);
  if (!targetNode) {
    return [];
  }

  const path: TurnDAGNode[] = [];
  const visited = new Set<string>();
  let current: TurnDAGNode | undefined = targetNode;

  while (current) {
    if (visited.has(current.turnId)) {
      // Cycle guard: terminate traversal if a cycle is encountered
      break;
    }
    visited.add(current.turnId);
    path.push(current);

    if (current.parentTurnId === null) {
      break;
    }
    current = dag.nodes.get(current.parentTurnId);
  }

  path.reverse();
  return path;
}

/**
 * Retrieves direct child turns forking from the specified turn.
 * Returns an array of TurnDAGNode objects, or an empty array if no children exist.
 */
export function getTurnChildren(dag: TurnDAG, turnId: string): TurnDAGNode[] {
  const childIds = dag.children.get(turnId);
  if (!childIds || childIds.length === 0) {
    return [];
  }

  const result: TurnDAGNode[] = [];
  for (const childId of childIds) {
    const childNode = dag.nodes.get(childId);
    if (childNode) {
      result.push(childNode);
    }
  }
  return result;
}

/**
 * Retrieves all leaf turns in the DAG (turns with zero child branches).
 */
export function getTurnLeaves(dag: TurnDAG): TurnDAGNode[] {
  const leaves: TurnDAGNode[] = [];
  for (const [turnId, node] of dag.nodes) {
    const childIds = dag.children.get(turnId);
    if (!childIds || childIds.length === 0) {
      leaves.push(node);
    }
  }
  return leaves;
}

/**
 * Retrieves all transitive descendants of a turn in breadth-first order.
 */
export function getTurnDescendants(dag: TurnDAG, turnId: string): TurnDAGNode[] {
  const descendants: TurnDAGNode[] = [];
  const queue: string[] = [...(dag.children.get(turnId) ?? [])];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) continue;

    const node = dag.nodes.get(currentId);
    if (node) {
      descendants.push(node);
    }

    const nextChildIds = dag.children.get(currentId) ?? [];
    for (const nextId of nextChildIds) {
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push(nextId);
      }
    }
  }

  return descendants;
}

/**
 * Retrieves all unique non-null branch tags present in the DAG.
 */
export function getBranchTags(dag: TurnDAG): string[] {
  const tags = new Set<string>();
  for (const node of dag.nodes.values()) {
    if (node.branchTag) {
      tags.add(node.branchTag);
    }
  }
  return Array.from(tags);
}

/**
 * Finds all turns matching the specified branch tag.
 */
export function findTurnsByBranchTag(dag: TurnDAG, branchTag: string): TurnDAGNode[] {
  const matching: TurnDAGNode[] = [];
  for (const node of dag.nodes.values()) {
    if (node.branchTag === branchTag) {
      matching.push(node);
    }
  }
  return matching;
}

/**
 * Forks a new turn off an existing parent turn, mutating and returning the new node.
 */
export function forkTurn(
  dag: TurnDAG,
  parentTurnId: string,
  turnInput: Omit<TurnDAGInput, "parentTurnId">,
): TurnDAGNode {
  const parentNode = dag.nodes.get(parentTurnId);
  const resolvedParentTurnId = parentTurnId === turnInput.turnId ? null : parentTurnId;
  const newNode: TurnDAGNode = {
    turnId: turnInput.turnId,
    parentTurnId: parentNode && resolvedParentTurnId ? resolvedParentTurnId : null,
    blockIds: turnInput.blockIds ? [...turnInput.blockIds] : [],
    timestamp: typeof turnInput.timestamp === "number" ? turnInput.timestamp : Date.now(),
    branchTag: turnInput.branchTag ?? null,
  };

  dag.nodes.set(newNode.turnId, newNode);
  if (!dag.children.has(newNode.turnId)) {
    dag.children.set(newNode.turnId, []);
  }

  if (resolvedParentTurnId && parentNode) {
    const siblings = dag.children.get(resolvedParentTurnId);
    if (siblings && !siblings.includes(newNode.turnId)) {
      siblings.push(newNode.turnId);
    }
  } else {
    if (!dag.rootTurnIds.includes(newNode.turnId)) {
      dag.rootTurnIds.push(newNode.turnId);
    }
  }

  return newNode;
}
