import assert = require("assert");
import * as GraphLib from "graphlib";
import {
    ArraySet,
    ArrayUtils,
    CircularSpace,
    ConcurrentExecutor,
    Deferred,
    EquitySet,
    GraphUtils,
    Path,
    prettyPrint,
    serializable,
    SerializeUtils,
    TimeoutDeferred,
    TimeoutError,
    transient,
} from "@web-overlay/manager";

/**
 * simple insertion and deletion test
 */
describe("misc", () => {
    it("testPath", () => {
        {
            const path = ["a", "b"];
            const opt = Path.optimizePath(path);
            // console.log(opt);
            assert(opt.toString() === path.toString());
        }
        {
            const path = ["a", "a"];
            const opt = Path.optimizePath(path);
            // console.log(opt);
            assert(opt.toString() === ["a"].toString());
        }
        {
            const path = ["a", "b", "b", "b", "c"];
            const opt = Path.optimizePath(path);
            // console.log(opt);
            assert(opt.toString() === ["a", "b", "c"].toString());
        }
        {
            const path = ["a", "b", "c", "d", "b"];
            const opt = Path.optimizePath(path);
            // console.log(opt);
            assert(opt.toString() === ["a", "b"].toString());
        }
        {
            const path = ["a", "b", "c", "b", "d", "e", "d", "f"];
            const opt = Path.optimizePath(path);
            // console.log(opt);
            assert(opt.toString() === ["a", "b", "d", "f"].toString());
        }
    });

    it("EquitySet", () => {
        const s1: EquitySet<string[]> = new EquitySet((v1, v2) => {
            // console.log("v1=", v1, ", v2=", v2);
            return v1.length === v2.length;
        });
        const a1 = ["a", "b"];
        const a2 = ["c", "d"];
        const a3 = ["e", "f", "g"];
        s1.add(a1);
        s1.add(a2);
        s1.add(a3);
        assert.strictEqual(s1.size, 2);
        assert.strictEqual(s1.has(a1), true);
        assert.strictEqual(s1.has(a3), true);
    });

    it("ArraySet", () => {
        const s1: ArraySet<string> = new ArraySet((v1, v2) => {
            return v1 === v2;
        });
        s1.add(["a", "b"]);
        s1.add(["a", "b"]);
        s1.add(["c", "d", "e"]);
        assert.strictEqual(s1.size, 2);
        assert.strictEqual(s1.has(["a", "b"]), true);
        assert.strictEqual(s1.has(["c", "d", "e"]), true);
        // console.log(s1);
    });

    it("intersects", () => {
        const a = ["a", "b", "c"];
        const b = ["b", "c", "d"];
        const c = ArrayUtils.intersects(a, b);
        assert.deepStrictEqual(c, ["b", "c"]);
        // console.log(c);
    });

    it("testConcurrentExecutor", async () => {
        const con = new ConcurrentExecutor<number>(4, 2);
        let i = 0;
        while (!con.isSatisfied()) {
            console.log("notCompleted " + i);
            await con.executeAsync(
                (): Promise<number> => {
                    const j = i;
                    console.log("start job j=" + j);
                    const defer = new Deferred<number>();
                    setTimeout(() => {
                        if (j % 2 === 0) {
                            console.log("success " + j);
                            defer.resolve(j);
                        } else {
                            console.log("fail " + j);
                            defer.reject("fail " + j);
                        }
                    }, 1000);
                    i++;
                    return defer.promise;
                }
            );
        }
        await con.waitAll();
        console.log("finished: " + con.getResults());
    }).timeout(10000);

    it("testTopK", () => {
        const g = new GraphLib.Graph({directed: false});
        g.setEdge("C", "D", 3);
        g.setEdge("C", "E", 2);
        g.setEdge("D", "F", 4);
        g.setEdge("D", "E", 1);
        g.setEdge("E", "F", 2);
        g.setEdge("E", "G", 3);
        g.setEdge("F", "G", 2);
        g.setEdge("F", "H", 1);
        g.setEdge("G", "H", 2);
        const topk = GraphUtils.computeShortestK(g, "C", "H", 10, (e) =>
            g.edge(e)
        );
        console.log("top-k=", topk);
        topk.forEach((p) =>
            console.log(
                "path: " + p + ", " + GraphUtils.weight(p, (e) => g.edge(e))
            )
        );
        const pruned = GraphUtils.pruneRedundantPaths(topk);
        console.log("pruned=", pruned);
    });

    it("prettyPrint", () => {
        const obj = {
            a: "a",
            b: 100,
            c: true,
            d: {e: "internal"},
            f: [10, 20, 30],
            g: false,
        };
        const x = prettyPrint(obj);
        assert.strictEqual(x, '{a="a", b=100, c, d={e="internal"}, f=[10, 20, 30], ~g}');
        // console.log(x);
    });

    it("TimeoutDeferred", async () => {
        const d = new TimeoutDeferred<string>(1000, "abc");
        // d.resolve("dd");
        try {
            await d;
            assert(false);
        } catch (err) {
            assert(err instanceof TimeoutError);
            assert.strictEqual(err.message, "abc");
        }
    });

    it("sortCircular", () => {
        const a = ["000", "aaa", "bbb"];
        const b = CircularSpace.sortCircular("aaa", a, (x) => x, true);
        // console.log(b);
        assert.deepStrictEqual(b, ["bbb", "000", "aaa"]);
        const c = CircularSpace.sortCircular("aaa", a, (x) => x, false);
        // console.log(c);
        assert.deepStrictEqual(c, ["aaa", "bbb", "000"]);
    });

    it("testTransient", () => {
        const nested = new NestedSample();
        assert.strictEqual(SerializeUtils.isSerializable(nested), true);
        const a = new Sample();
        nested.sample = a;
        a.a = "a";
        a.b = "b"; // transient
        a.c = "c"; // transient
        const json = JSON.stringify(nested);
        //console.log("JSON=", json);
        //for (const i in a) {
        //    console.log("a=", i);
        //}
        assert.strictEqual((nested as any).$class, undefined);
        const r = SerializeUtils.restorePrototype(JSON.parse(json));
        assert(r instanceof NestedSample);
        assert(r.sample instanceof Sample);
        //console.log("r=", r);
        //console.log("r=", Object.getOwnPropertyNames(r));
        //for (const i in r) {
        //    console.log("r=", i);
        //}
        assert.strictEqual(prettyPrint(r), '{sample={a="a"}}');
    });
});

@serializable
class Sample {
    a?: string;
    @transient
    b?: string;
    @transient
    c?: string;
}

@serializable
class NestedSample {
    sample?: Sample;
}
