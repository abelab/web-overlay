import * as GraphLib from "graphlib";
import { ArrayUtils } from "./misc-utils";

export class GraphUtils {
    public static dijkstra(
        g: GraphLib.Graph,
        source: string,
        sink: string,
        weightFn?: (e: GraphLib.Edge) => number
    ): string[] | null {
        const dij = GraphLib.alg.dijkstra(
            g,
            source,
            weightFn,
            (v) => g.nodeEdges(v) as any
        );
        const shortestPath: string[] = [];
        if (!dij[sink]) {
            return null;
        }
        for (
            let cursor = sink, t: GraphLib.Path = dij[cursor];
            t.distance > 0;
            t = dij[cursor], cursor = t.predecessor
        ) {
            if (t.distance === Infinity) {
                return null;
            }
            shortestPath.unshift(cursor);
        }
        return shortestPath;
    }

    public static weight(
        path: string[],
        weightFn?: (e: GraphLib.Edge) => number
    ): number {
        if (!weightFn) {
            weightFn = (e) => 1;
        }
        let w = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const edge = {
                v: path[i],
                w: path[i + 1],
            };
            w += weightFn(edge);
        }
        return w;
    }

    /**
     * Compute K-shortest loopless paths based on the algorithm of Yen, Jin Y. (Jul 1971).
     * "Finding the k Shortest Loopless Paths in a Network". Management Science. 17 (11): 712–716.
     *
     * This is an implementation of the pseudo code in https://en.wikipedia.org/wiki/Yen%27s_algorithm"
     *
     * @param {GraphLib.Graph} g
     * @param {string} source
     * @param {string} sink
     * @param {number} K
     * @param {(e: GraphLib.Edge) => number} weightFn
     * @return {string[][]}
     */
    public static computeShortestK(
        g: GraphLib.Graph,
        source: string,
        sink: string,
        K: number,
        weightFn?: (e: GraphLib.Edge) => number
    ): string[][] {
        const a: string[][] = [];
        // Determine the shortest path from the source to the sink.
        const a0 = GraphUtils.dijkstra(g, source, sink, weightFn);
        if (!a0) {
            return [];
        }
        a.push(a0);

        // Initialize the heap to store the potential kth shortest path.
        const b: string[][] = [];
        const json = GraphLib.json.write(g);

        for (let k = 1; k < K; k++) {
            // The spur node ranges from the first node to the next to last node in the previous k-shortest path.
            for (let i = 0; i < a[k - 1].length - 1; i++) {
                // Spur node is retrieved from the previous k-shortest path, k − 1.
                const spurNode = a[k - 1][i];
                // The sequence of nodes from the source to the spur node of the previous k-shortest path.
                const rootPath = a[k - 1].slice(0, i + 1);
                // console.log("a[k-1]=", a[k - 1], ", spurNode=", spurNode, ", rootPath=", rootPath);
                // copy the graph
                const g0 = GraphLib.json.read(json);
                a.forEach((p) => {
                    if (ArrayUtils.equals(rootPath, p.slice(0, i + 1))) {
                        // Remove the links that are part of the previous shortest paths which share the same root path.
                        g0.removeEdge({
                            v: p[i],
                            w: p[i + 1],
                        });
                        /*const next = p[i + 1];
                        console.log("!!! remove " + next);
                        g0.removeNode(next);*/
                    }
                });
                rootPath.forEach((node) => {
                    if (node !== spurNode) {
                        g0.removeNode(node);
                    }
                });
                // console.log("g0=", GraphLib.json.write(g0));
                // Calculate the spur path from the spur node to the sink.
                const spurPath = GraphUtils.dijkstra(
                    g0,
                    spurNode,
                    sink,
                    weightFn
                );
                if (!spurPath) {
                    continue;
                }
                // Entire path is made up of the root path and spur path.
                const totalPath = rootPath.concat(spurPath.slice(1));
                // console.log("totalPath=", totalPath);

                // Add the potential k-shortest path to the heap.
                b.push(totalPath);
            }
            if (b.length === 0) {
                // This handles the case of there being no spur paths, or no spur paths left.
                // This could happen if the spur paths have already been exhausted (added to A),
                // or there are no spur paths at all - such as when both the source and sink vertices
                // lie along a "dead end".
                break;
            }
            // Sort the potential k-shortest paths by cost.
            b.sort((path1, path2) => {
                return GraphUtils.weight(path1) - GraphUtils.weight(path2);
                // return path1.length - path2.length;
            });
            // Add the lowest cost path becomes the k-shortest path.
            a[k] = b[0];
            b.shift();
        }
        return a;
    }
    public static pruneRedundantPaths(paths: string[][]): string[][] {
        const pruned: string[][] = [];
        pruned.push(paths[0]);
        paths.shift();
        paths.forEach((cur) => {
            let redundant = false;
            for (const p of pruned) {
                // check if all items in p is included in cur
                const diff = ArrayUtils.subtract(p, cur);
                if (diff.length === 0) {
                    redundant = true;
                    break;
                }
            }
            if (!redundant) {
                pruned.push(cur);
            }
        });
        return pruned;
    }

    /**
     * グラフgの頂点nodeから距離hのノードまでのパスをすべて返す．
     * @param {module:graphlib.Graph} g
     * @param {string} node
     * @param {number} distance
     * @return {Path[]}
     */
    public static getPathsToDistantNode(
        g: GraphLib.Graph,
        node: string,
        distance: number
    ): string[][] {
        const hnodes: string[] = [];
        const dij = GraphLib.alg.dijkstra(
            g,
            node,
            undefined,
            (v) => g.nodeEdges(v) as any
        );
        // console.log("getPathsToDistantNode: node=", node, ", distance=", distance, ", dij=", dij);
        Object.keys(dij).forEach((p) => {
            const path: GraphLib.Path = dij[p];
            if (path.distance === distance) {
                hnodes.push(p);
            }
        });
        // console.log("hnodes=", hnodes);
        const results: string[][] = [];
        hnodes.forEach((p) => {
            const paths = GraphUtils.computeShortestK(g, node, p, 10, (e) => 1);
            // console.log("paths=", paths);
            paths.forEach((q) => {
                if (q.length - 1 === distance) {
                    results.push(q);
                }
            });
        });
        // console.log("return=", results);
        return results;
    }
}
