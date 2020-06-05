// eslint-disable no-constant-condition
import { DdllNode, NREPLICA, PerKeyEnt, PStoreError, PutOption } from "..";
import { Logger, sleep } from "@web-overlay/manager";
import { TestBase } from "./common";
import { suite, test, timeout } from "mocha-typescript";
import assert = require("assert");

interface TestValue {
    val: string;
}
@suite
export class TestPStore extends TestBase {
    @test(timeout(10000))
    public async test1(): Promise<void> {
        DdllNode.PING_PERIOD = 0;
        await this.createNodes(5);
        // insert "00" and "01"
        await this.ddllNodes[0].initInitialNode();
        await this.ddllNodes[1].join(this.url0);
        await sleep(1000);
        // Logger.enable("DEBUG:*ddll");
        const putSrc = 0;
        const getSrc = 1;
        const option: PutOption = {};
        // stored at node "00"
        const v1: TestValue = { val: "Hello000" };
        await this.ddllNodes[putSrc].rawPut("000", v1, option);
        // stored at node "00"
        const v2: TestValue = { val: "Hello001" };
        await this.ddllNodes[putSrc].rawPut("000", v2, {
            index: 1,
        });
        // stored at node "01"
        const v4: TestValue = { val: "Hello040" };
        await this.ddllNodes[putSrc].rawPut("040", v4, option);
        await this.ddllNodes[2].join(this.url0);
        await this.ddllNodes[3].join(this.url0);
        await this.ddllNodes[4].join(this.url0);
        await sleep(1000);
        {
            // check rawGet
            const v = (await this.ddllNodes[getSrc].rawGetMulti(
                "000",
                0,
                2
            )) as TestValue[];
            console.log("get() returns ", v);
            assert.deepStrictEqual(v[0], v1);
            assert.deepStrictEqual(v[1], v2);
        }
        {
            const v = (await this.ddllNodes[getSrc].rawGet(
                "040"
            )) as TestValue[];
            console.log("get() returns ", v);
            assert.deepStrictEqual(v, v4);
        }
        {
            // check overwrite
            try {
                await this.ddllNodes[putSrc].rawPut("000", v2, {
                    index: 0,
                    noOverwrite: true,
                });
                assert(false);
            } catch (err) {
                assert.strictEqual(
                    err.message,
                    PStoreError.OVERWRITE_FORBIDDEN
                );
            }
        }
        // check replication
        {
            assert(NREPLICA >= 2);
            const p1: Map<string, PerKeyEnt> = (this.ddllNodes[1] as any)
                .pStore;
            assert(p1.get("000") !== undefined);
            const p2: Map<string, PerKeyEnt> = (this.ddllNodes[2] as any)
                .pStore;
            assert(p2.get("000") !== undefined);
        }
        // eslint-disable-next-line no-constant-condition
        if (false) {
            // observe periodic replication...
            // await sleep(30000);
            this.ddllNodes[4].doReplication();
            await sleep(100);
            this.ddllNodes[3].doReplication();
            await sleep(100);
            this.ddllNodes[2].doReplication();
            await sleep(100);
            this.ddllNodes[1].doReplication();
            await sleep(100);
        }
        // eslint-disable-next-line no-constant-condition
        if (true) {
            // check non-existing key
            const p = this.ddllNodes[getSrc].rawGet("non-existing-key");
            await p.then(
                (v) => {
                    console.log("get() returns ", v);
                    assert(false);
                },
                (err) => {
                    console.log("get() error: " + err.toString());
                    assert.strictEqual(err.message, PStoreError.NO_SUCH_KEY);
                }
            );
        }
    }
}
