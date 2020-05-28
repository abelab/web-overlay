import { serializable } from "./serialize";
import * as GraphLib from "graphlib";
import { ArrayUtils } from "../utils";
import { Manager } from "./manager";

/**
 * A path to some node.
 * A path consists of series of node ID and optional destination connection ID.
 */
@serializable
export class Path {
    private readonly elements: string[];
    public readonly connId?: number;

    constructor(forwardPath: string[], connId?: number) {
        this.elements = forwardPath.slice();
        this.connId = connId;
    }

    public get srcNodeId(): string {
        return this.elements[0];
    }

    public get destNodeId(): string {
        return this.elements[this.elements.length - 1];
    }

    public asArray(): string[] {
        return this.elements.slice();
    }

    public getEdgeSequence(): GraphLib.Edge[] {
        const s: GraphLib.Edge[] = [];
        for (let i = 0; i < this.elements.length - 1; i++) {
            s.push({
                v: this.elements[i],
                w: this.elements[i + 1],
            });
        }
        return s;
    }

    public nextHop(manager: Manager): string {
        const index = this.elements.indexOf(manager.getNodeId());
        if (index < 0) {
            throw new Error(
                `my nodeId (${manager.getNodeId()}) is not found in ${
                    this.elements
                }`
            );
        }
        if (index === this.elements.length - 1) {
            // if i'm the last element, send to myself
            return manager.getNodeId();
        }
        return this.elements[index + 1];
    }

    public toString(): string {
        return (
            `Path(${this.elements.join("->")}` +
            (typeof this.connId === "number" ? `, ${this.connId}` : "") +
            ")"
        );
    }

    // note that connId is not compared
    public isEqualPath(another: Path): boolean {
        return ArrayUtils.equals(this.elements, another.elements);
    }

    public getPathWithoutConnId(): Path {
        return new Path(this.elements);
    }

    /**
     * smaller score indicates a better path
     * @return {number}
     */
    public score(): number {
        return this.elements.length;
    }

    public prepend(node: string): Path {
        if (this.elements.length === 0 || this.elements[0] !== node) {
            const path = this.elements.slice();
            path.unshift(node);
            return new Path(path, this.connId);
        }
        return this;
    }

    public append(node: string): Path {
        if (
            this.elements.length === 0 ||
            this.elements[this.elements.length - 1] !== node
        ) {
            const path = this.elements.slice();
            path.push(node);
            return new Path(path, this.connId);
        }
        return this;
    }

    public optimize(): Path {
        const path = Path.optimizePath(this.elements);
        return new Path(path, this.connId);
    }

    public static optimizePath(p: string[]): string[] {
        for (let i = 0; i < p.length; i++) {
            for (let j = p.length - 1; i < j; j--) {
                if (p[i] === p[j]) {
                    p.splice(i + 1, j - i);
                    return Path.optimizePath(p);
                }
            }
        }
        return p;
    }

    public static sortByScore(paths: Path[]): Path[] {
        return paths.sort((a, b) => {
            return a.score() - b.score();
        });
    }
}
