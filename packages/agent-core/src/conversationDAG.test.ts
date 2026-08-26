import { describe, expect, test } from "bun:test";
import {
  buildTurnDAG,
  findTurnsByBranchTag,
  forkTurn,
  getBranchTags,
  getTurnChildren,
  getTurnDescendants,
  getTurnLeaves,
  getTurnPath,
  type TurnDAG,
  type TurnDAGInput,
  type TurnDAGNode,
} from "./conversationDAG.js";
import {
  buildTurnDAG as indexBuildTurnDAG,
  getTurnChildren as indexGetTurnChildren,
  getTurnPath as indexGetTurnPath,
} from "./index.js";
import type { StoredBlock } from "./types.js";

describe("Conversation Turn DAG Engine", () => {
  test("exports buildTurnDAG, getTurnPath, and getTurnChildren from index.ts", () => {
    expect(typeof indexBuildTurnDAG).toBe("function");
    expect(typeof indexGetTurnPath).toBe("function");
    expect(typeof indexGetTurnChildren).toBe("function");
  });

  test("builds an empty TurnDAG when given an empty list", () => {
    const dag = buildTurnDAG([]);
    expect(dag.nodes.size).toBe(0);
    expect(dag.rootTurnIds).toEqual([]);
    expect(dag.children.size).toBe(0);
  });

  test("builds a single linear conversation path", () => {
    const turns: TurnDAGInput[] = [
      {
        turnId: "turn-root",
        parentTurnId: null,
        blockIds: ["b-u1", "b-a1"],
        timestamp: 1000,
        branchTag: "main",
      },
      {
        turnId: "turn-1",
        parentTurnId: "turn-root",
        blockIds: ["b-u2", "b-a2"],
        timestamp: 2000,
        branchTag: "main",
      },
      {
        turnId: "turn-2",
        parentTurnId: "turn-1",
        blockIds: ["b-u3", "b-a3"],
        timestamp: 3000,
        branchTag: "main",
      },
    ];

    const dag = buildTurnDAG(turns);

    expect(dag.rootTurnIds).toEqual(["turn-root"]);
    expect(dag.nodes.size).toBe(3);

    const rootChildren = getTurnChildren(dag, "turn-root");
    expect(rootChildren.length).toBe(1);
    expect(rootChildren[0].turnId).toBe("turn-1");

    const turn1Children = getTurnChildren(dag, "turn-1");
    expect(turn1Children.length).toBe(1);
    expect(turn1Children[0].turnId).toBe("turn-2");

    const turn2Children = getTurnChildren(dag, "turn-2");
    expect(turn2Children).toEqual([]);

    const path = getTurnPath(dag, "turn-2");
    expect(path.map((n) => n.turnId)).toEqual(["turn-root", "turn-1", "turn-2"]);
    expect(path[0].blockIds).toEqual(["b-u1", "b-a1"]);
    expect(path[1].blockIds).toEqual(["b-u2", "b-a2"]);
    expect(path[2].blockIds).toEqual(["b-u3", "b-a3"]);
  });

  test("builds multi-branch tree with forking conversations", () => {
    // Tree layout:
    //          root
    //         /    \
    //      fork-A  fork-B
    //       /        \
    //    leaf-A1    step-B2
    //                 \
    //                leaf-B3
    const turns: TurnDAGInput[] = [
      { turnId: "root", parentTurnId: null, blockIds: ["b-root"], timestamp: 100, branchTag: "main" },
      { turnId: "fork-A", parentTurnId: "root", blockIds: ["b-fa"], timestamp: 200, branchTag: "experiment-a" },
      { turnId: "leaf-A1", parentTurnId: "fork-A", blockIds: ["b-la1"], timestamp: 300, branchTag: "experiment-a" },
      { turnId: "fork-B", parentTurnId: "root", blockIds: ["b-fb"], timestamp: 210, branchTag: "sidechat" },
      { turnId: "step-B2", parentTurnId: "fork-B", blockIds: ["b-sb2"], timestamp: 310, branchTag: "sidechat" },
      { turnId: "leaf-B3", parentTurnId: "step-B2", blockIds: ["b-lb3"], timestamp: 410, branchTag: "sidechat" },
    ];

    const dag = buildTurnDAG(turns);

    // Root verification
    expect(dag.rootTurnIds).toEqual(["root"]);

    // Fork children retrieval
    const rootChildren = getTurnChildren(dag, "root");
    expect(rootChildren.map((n) => n.turnId).sort()).toEqual(["fork-A", "fork-B"]);

    // Path retrieval for branch A
    const pathA = getTurnPath(dag, "leaf-A1");
    expect(pathA.map((n) => n.turnId)).toEqual(["root", "fork-A", "leaf-A1"]);

    // Path retrieval for branch B
    const pathB = getTurnPath(dag, "leaf-B3");
    expect(pathB.map((n) => n.turnId)).toEqual(["root", "fork-B", "step-B2", "leaf-B3"]);

    // Descendants from root
    const descendants = getTurnDescendants(dag, "root");
    expect(descendants.length).toBe(5);
    const descendantIds = descendants.map((n) => n.turnId);
    expect(descendantIds).toContain("fork-A");
    expect(descendantIds).toContain("fork-B");
    expect(descendantIds).toContain("leaf-A1");
    expect(descendantIds).toContain("step-B2");
    expect(descendantIds).toContain("leaf-B3");

    // Leaf nodes discovery
    const leaves = getTurnLeaves(dag);
    const leafIds = leaves.map((n) => n.turnId).sort();
    expect(leafIds).toEqual(["leaf-A1", "leaf-B3"]);
  });

  test("supports multi-root forests with disjoint conversation trees", () => {
    const turns: TurnDAGInput[] = [
      { turnId: "tree1-root", parentTurnId: null, blockIds: ["b-t1-r"], timestamp: 100 },
      { turnId: "tree1-child", parentTurnId: "tree1-root", blockIds: ["b-t1-c"], timestamp: 200 },
      { turnId: "tree2-root", parentTurnId: null, blockIds: ["b-t2-r"], timestamp: 150 },
      { turnId: "tree2-child", parentTurnId: "tree2-root", blockIds: ["b-t2-c"], timestamp: 250 },
    ];

    const dag = buildTurnDAG(turns);
    expect(dag.rootTurnIds).toEqual(["tree1-root", "tree2-root"]);

    expect(getTurnPath(dag, "tree1-child").map((n) => n.turnId)).toEqual(["tree1-root", "tree1-child"]);
    expect(getTurnPath(dag, "tree2-child").map((n) => n.turnId)).toEqual(["tree2-root", "tree2-child"]);
  });

  test("builds TurnDAG from sequential StoredBlock array", () => {
    const blocks: StoredBlock[] = [
      { id: "ub-1", role: "user", text: "Hello", at: 1000 },
      {
        id: "ab-1",
        role: "assistant",
        turnId: "turn-alpha",
        items: [],
        state: "completed",
        at: 1050,
      },
      { id: "ub-2", role: "user", text: "How are you?", at: 2000 },
      {
        id: "ab-2",
        role: "assistant",
        turnId: "turn-beta",
        items: [],
        state: "completed",
        at: 2050,
        source: "fork-import",
      },
    ];

    const dag = buildTurnDAG(blocks);

    expect(dag.rootTurnIds).toEqual(["turn-alpha"]);
    expect(dag.nodes.size).toBe(2);

    const node1 = dag.nodes.get("turn-alpha");
    expect(node1).toBeDefined();
    expect(node1?.parentTurnId).toBeNull();
    expect(node1?.blockIds).toEqual(["ub-1", "ab-1"]);
    expect(node1?.timestamp).toBe(1050);
    expect(node1?.branchTag).toBeNull();

    const node2 = dag.nodes.get("turn-beta");
    expect(node2).toBeDefined();
    expect(node2?.parentTurnId).toBe("turn-alpha");
    expect(node2?.blockIds).toEqual(["ub-2", "ab-2"]);
    expect(node2?.timestamp).toBe(2050);
    expect(node2?.branchTag).toBe("fork-import");

    const path = getTurnPath(dag, "turn-beta");
    expect(path.map((n) => n.turnId)).toEqual(["turn-alpha", "turn-beta"]);
  });

  test("manages branch tags and finds turns by branch tag", () => {
    const turns: TurnDAGInput[] = [
      { turnId: "t0", parentTurnId: null, blockIds: ["b0"], timestamp: 10, branchTag: "main" },
      { turnId: "t1", parentTurnId: "t0", blockIds: ["b1"], timestamp: 20, branchTag: "main" },
      { turnId: "t2-fork", parentTurnId: "t0", blockIds: ["b2"], timestamp: 30, branchTag: "sidechat" },
      { turnId: "t3-fork", parentTurnId: "t2-fork", blockIds: ["b3"], timestamp: 40, branchTag: "sidechat" },
      { turnId: "t4-exp", parentTurnId: "t1", blockIds: ["b4"], timestamp: 50, branchTag: "experiment" },
    ];

    const dag = buildTurnDAG(turns);

    const tags = getBranchTags(dag).sort();
    expect(tags).toEqual(["experiment", "main", "sidechat"]);

    const sidechatTurns = findTurnsByBranchTag(dag, "sidechat");
    expect(sidechatTurns.map((n) => n.turnId)).toEqual(["t2-fork", "t3-fork"]);

    const experimentTurns = findTurnsByBranchTag(dag, "experiment");
    expect(experimentTurns.map((n) => n.turnId)).toEqual(["t4-exp"]);
  });

  test("forks a new turn dynamically onto an existing DAG", () => {
    const turns: TurnDAGInput[] = [
      { turnId: "base-root", parentTurnId: null, blockIds: ["b0"], timestamp: 100 },
      { turnId: "base-1", parentTurnId: "base-root", blockIds: ["b1"], timestamp: 200 },
    ];

    const dag = buildTurnDAG(turns);

    const forkedNode = forkTurn(dag, "base-root", {
      turnId: "forked-branch-1",
      blockIds: ["b-fork-1"],
      timestamp: 300,
      branchTag: "sidechat-fork",
    });

    expect(forkedNode.turnId).toBe("forked-branch-1");
    expect(forkedNode.parentTurnId).toBe("base-root");
    expect(forkedNode.branchTag).toBe("sidechat-fork");

    const rootChildren = getTurnChildren(dag, "base-root");
    expect(rootChildren.map((n) => n.turnId)).toEqual(["base-1", "forked-branch-1"]);

    const forkedPath = getTurnPath(dag, "forked-branch-1");
    expect(forkedPath.map((n) => n.turnId)).toEqual(["base-root", "forked-branch-1"]);
  });

  test("handles nonexistent target IDs and cycle guards safely", () => {
    const turns: TurnDAGInput[] = [
      { turnId: "t1", parentTurnId: null, blockIds: ["b1"], timestamp: 100 },
      { turnId: "t2", parentTurnId: "t1", blockIds: ["b2"], timestamp: 200 },
    ];

    const dag = buildTurnDAG(turns);

    // Non-existent lookups
    expect(getTurnPath(dag, "non-existent-turn")).toEqual([]);
    expect(getTurnChildren(dag, "non-existent-turn")).toEqual([]);

    // Dangling parent (points to an ID not in nodes)
    const danglingTurn: TurnDAGInput = {
      turnId: "orphan",
      parentTurnId: "missing-parent",
      blockIds: ["b-orphan"],
      timestamp: 300,
    };
    const orphanDag = buildTurnDAG([danglingTurn]);
    expect(orphanDag.rootTurnIds).toEqual(["orphan"]);
    expect(getTurnPath(orphanDag, "orphan").map((n) => n.turnId)).toEqual(["orphan"]);

    // Manually constructed cycle safety check
    const cycleDag: TurnDAG = {
      nodes: new Map<string, TurnDAGNode>([
        ["nodeA", { turnId: "nodeA", parentTurnId: "nodeB", blockIds: [], timestamp: 1 }],
        ["nodeB", { turnId: "nodeB", parentTurnId: "nodeA", blockIds: [], timestamp: 2 }],
      ]),
      rootTurnIds: [],
      children: new Map([
        ["nodeA", ["nodeB"]],
        ["nodeB", ["nodeA"]],
      ]),
    };

    // Cycle traversal should terminate without throwing or hanging
    const cyclePath = getTurnPath(cycleDag, "nodeA");
    expect(cyclePath.length).toBe(2);
  });
});
