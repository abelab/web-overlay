import assert = require("assert");
import { override } from "core-decorators";
import * as GraphLib from "graphlib";
import { suite, test, timeout } from "mocha-typescript";
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
    transient,
} from "..";

/**
 * simple insertion and deletion test
 */
@suite
class TestMisc {
    @test()
    public testPath(): void {
        {
            const path = ["a", "b"];
            const opt = Path.optimizePath(path);
            console.log(opt);
            assert(opt.toString() === path.toString());
        }
        {
            const path = ["a", "a"];
            const opt = Path.optimizePath(path);
            console.log(opt);
            assert(opt.toString() === ["a"].toString());
        }
        {
            const path = ["a", "b", "b", "b", "c"];
            const opt = Path.optimizePath(path);
            console.log(opt);
            assert(opt.toString() === ["a", "b", "c"].toString());
        }
        {
            const path = ["a", "b", "c", "d", "b"];
            const opt = Path.optimizePath(path);
            console.log(opt);
            assert(opt.toString() === ["a", "b"].toString());
        }
        {
            const path = ["a", "b", "c", "b", "d", "e", "d", "f"];
            const opt = Path.optimizePath(path);
            console.log(opt);
            assert(opt.toString() === ["a", "b", "d", "f"].toString());
        }
    }

    @test()
    public testPromise(): void {
        const promise = new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve();
                console.log("after resolve");
            });
        });
        promise.then(() => {
            console.log("then");
        });
    }

    @test()
    public testSet(): void {
        const s1: EquitySet<string[]> = new EquitySet((v1, v2) => {
            console.log("v1=", v1, ", v2=", v2);
            return v1.length === v2.length;
        });
        s1.add(["a", "b"]);
        s1.add(["c", "d"]);
        s1.add(["c", "d", "e"]);
        console.log(s1);
    }

    @test()
    public testArraySet(): void {
        const s1: ArraySet<string> = new ArraySet((v1, v2) => {
            return v1 === v2;
        });
        s1.add(["a", "b"]);
        s1.add(["a", "b"]);
        s1.add(["c", "d", "e"]);
        console.log(s1);
    }

    @test()
    public testIntersects(): void {
        const a = ["a", "b", "c"];
        const b = ["b", "c", "d"];
        const c = ArrayUtils.intersects(a, b);
        console.log(c);
    }

    @test(timeout(10000))
    public async testConcurrentExecutor(): Promise<void> {
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
    }

    @test
    public testTopK(): void {
        const g = new GraphLib.Graph({ directed: false });
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
    }

    @test
    public testOverride(): void {
        const child = new Child();
        child.aMethod(() => {
            //
        });
    }

    // @test
    public prttyPrint(): void {
        const obj = {
            a: "a",
            b: 100,
            c: true,
            d: { e: "internal" },
            f: [10, 20, 30],
            g: false,
        };
        const x = prettyPrint(obj);
        console.log(x);
    }

    // @test
    public async testDeferTimeout(): Promise<string> {
        const d = new TimeoutDeferred<string>(1000, "abc");
        d.resolve("dd");
        d.then(
            (s) => {
                console.log("resolved: " + s);
            },
            (err) => {
                console.log("error: " + err);
            }
        );
        return d.promise;
    }

    // @test
    public testSort(): void {
        const a = ["000", "aaa", "bbb"];
        const b = CircularSpace.sortCircular("000", a, (x) => x, true);
        console.log(b);
        const c = CircularSpace.sortCircular("000", a, (x) => x, false);
        console.log(c);
    }

    // @test
    public testConst(): void {
        let a = 10;
        const func = () => console.log(a);
        a = 20;
        func();
    }

    @test
    public testTransient(): void {
        const nested = new NestedSample();
        console.log(SerializeUtils.isSerializable(nested));
        const a = new Sample();
        nested.sample = a;
        a.a = "a";
        a.b = "b";
        a.c = "c";
        const json = JSON.stringify(nested);
        console.log("JSON=", json);
        for (const i in a) {
            console.log("a=", i);
        }
        console.log("$class=", (nested as any).$class);
        const r = SerializeUtils.restorePrototype(JSON.parse(json));
        console.log("r=", r);
        console.log("r=", Object.getOwnPropertyNames(r));
        for (const i in r) {
            console.log("r=", i);
        }
    }

    // @test(timeout(3000))
    // public async testCleanSched() {
    //     const clean = new Cleanup();
    //     let flag = undefined;
    //     clean.sched("TEST", 100, () => {
    //         flag = true;
    //     });
    //     clean.sched("TEST", 50, () => {
    //         flag = false;
    //     });
    //     await sleep(200);
    //     assert.strictEqual(flag, false);
    //     console.log(clean.toString());
    //     clean.sched("TEST", 100, () => {
    //         flag = true;
    //     });
    //     clean.clean();
    //     await sleep(200);
    //     assert.strictEqual(flag, false);
    //     console.log(clean.toString());
    //
    //     let count = 0;
    //     clean.sched("TEST1", 100, () => {
    //         count++;
    //     });
    //     clean.sched("TEST2", 100, () => {
    //         count++;
    //     });
    //     console.log(clean.toString());
    //     await sleep(200);
    //     assert.strictEqual(count, 2);
    // }
}

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

class Base {
    public aMethod(foo: (bar: string) => void): string {
        return "Base";
    }
    public foo(p: number, q: string): void {
        //
    }
}

class Child extends Base {
    @override
    public aMethod(foo: (bar: string) => void): string {
        return "Child";
    }
}
