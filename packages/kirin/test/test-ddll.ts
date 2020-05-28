import assert = require("assert");
import { DdllNode, MulticastReply, MulticastRequest, Status, DdllRejectReasons } from "../dist";
import {
    CircularSpace,
    Cleaner,
    EndOfReply,
    Logger,
    Manager,
    RequestMessageSpec,
    serializable,
    sleep,
    Deferred,
    Message,
    RejectionError,
} from "@web-overlay/manager";
import { override } from "core-decorators";
import { prepareManagers, TestReply, TestRequest } from "./common";

const logger = new Logger("test", "test", "");
let cleaner = new Cleaner(logger);

@serializable
export class TestMessage extends Message {
    static received = new Map<string /*key*/, string>();
    public constructor(manager: Manager, public text: string) {
        super(manager);
    }

    public onReceive(): void {
        const key = this.peerConnection?.getLocalKey();
        if (key) {
            TestMessage.received.set(key, this.text);
        } else {
            assert(false);
        }
    }
}

/**
 * Test Multicast Request
 */
@serializable
export class TestMulticastRequest extends MulticastRequest<
    TestMulticastRequest,
    TestMulticastReply
> {
    static received = new Map<string, string>();
    public constructor(manager: Manager, public text: string) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            ...super.getSpec(),
            replyClassName: TestMulticastReply.name,
        };
    }

    public onReceive(): void {
        const pc = this.peerConnection;
        assert(pc);
        if (pc) {
            const key = pc.getLocalKey();
            TestMulticastRequest.received.set(key, this.text);
            this.sendReply(new TestMulticastReply(this, ["TEST" + key]));
        }
    }
    public reduce(
        a: TestMulticastReply,
        b: TestMulticastReply
    ): TestMulticastReply {
        const reduced = new TestMulticastReply(this, a.texts.concat(b.texts));
        return reduced;
    }
}

@serializable
export class TestMulticastReply extends MulticastReply<
    TestMulticastRequest,
    TestMulticastReply
> {
    constructor(req: TestMulticastRequest, public texts: string[]) {
        super(req);
    }
}

describe("DDLL", () => {
    beforeEach(() => {
        logger.info("before!");
        // Logger.enable("DEBUG:test,INFO:*");
        cleaner = new Cleaner(logger);
    });

    afterEach(() => {
        logger.info("after!");
        Logger.disable();
        cleaner.clean();
    });

    it("basic join leave", async () => {
        const num = 7;
        await joinLeave(num, false);
    });

    it("concurrent join leave", async () => {
        const num = 5;
        await joinLeave(num, true);
    }).timeout(10000);

    it("leave succeeds when left link is dead", async () => {
        const [d0, d1] = await prepareDDLL(2);
        await sleep(100); // need time for d0 receiving SetL
        d0.manager.destroy();
        await d1.leave();
    }).timeout(20000);

    it("leave succeeds while repairing", async () => {
        const [d0, d1] = await prepareDDLL(2);
        await sleep(100); // need time for d0 receiving SetL
        d0.manager.destroy();
        await sleep(1000); // wait for starting repair
        await d1.leave();
    }).timeout(20000);

    it("concurrent join leave (multi-key)", async () => {
        const num = 8;
        await joinLeave(num, true, "close");
    }).timeout(10000);

    it("unicast succeeds", async () => {
        const nodes = await prepareDDLL(5);
        const msg = new TestMessage(nodes[0].manager, "test");
        nodes[0].unicast(nodes[3].getKey(), msg);
        await sleep(100);
        assert.strictEqual(TestMessage.received.get(nodes[3].getKey()), "test");
    });

    it("unicastRequest succeeds", async () => {
        const nodes = await prepareDDLL(5);
        const req = new TestRequest(nodes[0].manager, "normal");
        let reply;
        try {
            reply = await nodes[0].unicastRequest(nodes[3].getKey(), req);
        } catch (err) {
            reply = err;
        }
        assert(reply instanceof TestReply);
        assert.strictEqual(
            (reply as TestReply).srcNodeId,
            nodes[3].manager.getNodeId()
        );
    });

    // it("unicastRequest fails (timeout)", async () => {
    //     const nodes = await prepareDDLL(5);
    //     const req = new TestRequest(nodes[0].manager, "ignore");
    //     let reply;
    //     Logger.enable("DEBUG:*");
    //     try {
    //         reply = await nodes[0].unicastRequest(nodes[3].getKey(), req);
    //     } catch (err) {
    //         reply = err;
    //     }
    //     assert(reply instanceof ReplyTimeoutError);
    // }).timeout(10000);

    it("unicastRequest succeeds (node2 fail and retransmit)", async () => {
        const nodes = await prepareDDLL(5, false, true);
        await sleep(1000);
        const req = new TestRequest(nodes[0].manager, "normal");
        let reply;
        // Logger.enable("DEBUG:*");
        try {
            nodes[2].manager.mute();
            reply = await nodes[0].unicastRequest(nodes[3].getKey(), req);
        } catch (err) {
            reply = err;
        }
        assert(reply instanceof TestReply);
        assert.strictEqual(
            (reply as TestReply).srcNodeId,
            nodes[3].manager.getNodeId()
        );
    }).timeout(10000);

    it("multicast succeeds", async () => {
        const num = 10;
        const nodes = await prepareDDLL(num, false, true);
        await sleep(100); // to ignore SetL from logs
        const min = nodes[2].getKey();
        const max = nodes[5].getKey();
        await checkMulticast(nodes, 0, min, max);
        await checkMulticast(nodes, 2, min, max);
        await checkMulticast(nodes, 3, min, max);
        await checkMulticast(nodes, 5, min, max);
        await checkMulticast(nodes, 6, min, max);
        // expect [5, 6, 7, 8, 9, 0, 1]
        await checkMulticast(nodes, 0, max, min);
        await checkMulticast(nodes, 6, max, min);
        // expect [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        await checkMulticast(nodes, 0, "00", "99");
        await checkMulticast(nodes, 9, "00", "99");
        await checkMulticast(nodes, 5, "00", "00");
    }).timeout(10000);

    it("multicast retransmit succeeds", async () => {
        const num = 4;
        const nodes = await prepareDDLL(num, false, true);
        await sleep(100); // to ignore SetL from logs
        nodes[2].manager.mute(); // mute nodes[2]
        const { req, replies, error } = await doMulticast(nodes, 0, "0", "0");
        assert.strictEqual(error, undefined);
        replies.sort();
        assert(req.numberOfRetransmission > 0);
        assert.deepStrictEqual(replies, ["TESTP0", "TESTP1", "TESTP3"]);
    }).timeout(10000);

    it("recovery succeeds (node0 is destroyed)", async () => {
        const nodes = await prepareDDLL(4, false, true);
        // Logger.enable("DEBUG:*");
        logger.info("destroy node0!");
        nodes[0].manager.destroy();
        dump(nodes);
        await sleep(1000);
        logger.info("after sleep");
        dump(nodes);
        checkConsistency([nodes[1], nodes[2], nodes[3]]);
        await leaveDDLL(nodes);
    }).timeout(20000);

    it("recovery succeeds (mute node0)", async () => {
        // Logger.enable("DEBUG:*");
        const nodes = await prepareDDLL(4, false, true);
        logger.info("mute node0!");
        nodes[0].manager.mute();
        logger.info("after mute");
        dump(nodes);
        await sleep(
            DdllNode.PING_PERIOD + nodes[0].manager.config.ACK_TIMEOUT + 1000
        );
        logger.info("after sleep");
        dump(nodes);
        checkConsistency([nodes[1], nodes[2], nodes[3]]);
        await leaveDDLL(nodes);
    }).timeout(20000);

    it("multicast succeeds (multi-key)", async () => {
        const num = 10;
        const nodes = await prepareDDLL(num, false, true, "apart");
        await sleep(100); // to ignore SetL from logs
        const min = nodes[2].getKey();
        const max = nodes[8].getKey();
        await checkMulticast(nodes, 0, min, max);
        await checkMulticast(nodes, 2, min, max);
        await checkMulticast(nodes, 3, min, max);
        await checkMulticast(nodes, 5, min, max);
        await checkMulticast(nodes, 6, min, max);
        // expect [5, 6, 7, 8, 9, 0, 1]
        await checkMulticast(nodes, 0, max, min);
        await checkMulticast(nodes, 6, max, min);
        // expect [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        await checkMulticast(nodes, 0, "00", "99");
        await checkMulticast(nodes, 9, "00", "99");
        await checkMulticast(nodes, 5, "00", "00");
    }).timeout(10000);

    it("connect() succeeds", async () => {
        const nodes = await prepareDDLL(8, false, true);
        {
            const pc = await nodes[2].connect(nodes[5].getKey() + "!", {
                exactKey: false,
            });
            assert.strictEqual(pc.getLocalKey(), nodes[2].getKey());
            assert.strictEqual(pc.getRemoteKey(), nodes[5].getKey());
        }
        {
            let result;
            try {
                result = await nodes[2].connect(nodes[5].getKey() + "!", {
                    exactKey: false,
                    webrtcOnly: true,
                });
            } catch (err) {
                result = err;
            }
            console.log("result=" + result);
            assert(result instanceof RejectionError);
            assert.strictEqual(result.message, DdllRejectReasons.CONSTRAINT);
        }
        {
            let result;
            try {
                result = await nodes[2].connect(nodes[5].getKey() + "!", {
                    exactKey: true,
                });
            } catch (err) {
                result = err;
            }
            console.log("result=" + result);
            assert(result instanceof RejectionError);
            assert.strictEqual(result.message, DdllRejectReasons.NO_EXACT_KEY);
        }
    });
});

/**
 * create Manager and DdllNode.
 *
 * @param num      number of DDLL nodes to be created (not equals to the number of Manager when multiKey=true
 * @param concurrent
 * @param allPortal
 * @param multiKey
 */
async function prepareDDLL(
    num: number,
    concurrent = false,
    allPortal = false,
    multiKey: "no" | "close" | "apart" = "no"
): Promise<DdllNode[]> {
    if (num <= 0) {
        throw new Error("num should be >0");
    }
    if (multiKey !== "no" && num % 2 !== 0) {
        throw new Error("num must be even if multiKey");
    }
    const numberOfManager = multiKey !== "no" ? num / 2 : num;
    const [m, c] = await prepareManagers(
        cleaner,
        numberOfManager,
        false,
        allPortal
    );
    const ddllNodes = [];
    for (let i = 0; i < num; i++) {
        let manager: Manager;
        let key;
        switch (multiKey) {
            case "no":
            case "apart":
                // P0, P1, P2, X-P0, X-P1, X-P2
                manager = m[i % numberOfManager];
                key = (i < numberOfManager ? "" : "X-") + manager.getNodeId();
                break;
            case "close":
                // P0, P0-X, P1, P1-X, P2, P2-X
                manager = m[Math.floor(i / 2)];
                key = manager.getNodeId() + (i % 2 === 0 ? "" : "-X");
                break;
            default:
                throw new Error("illegal multiKey");
        }
        const d = new DdllNode(key, manager);
        cleaner.push(() => d.destroy());
        ddllNodes.push(d);
    }
    ddllNodes.sort();
    await ddllNodes[0].initInitialNode();
    if (!concurrent) {
        for (let i = 1; i < num; i++) {
            const d = ddllNodes[i];
            await d.join(m[0].getNodeSpec().serverUrl);
            cleaner.push(() => d.destroy());
        }
    } else {
        const promises = [];
        for (let i = 1; i < num; i++) {
            const d = ddllNodes[i];
            promises.push(d.join(m[0].getNodeSpec().serverUrl));
            cleaner.push(() => d.destroy());
        }
        await Promise.all(promises);
    }
    return ddllNodes;
}

async function leaveDDLL(nodes: DdllNode[], concurrent = false): Promise<void> {
    if (!concurrent) {
        nodes.forEach(async (node) => await node.leave());
    } else {
        return Promise.all(nodes.map((node) => node.leave())).then(() => {
            return;
        });
    }
}

async function joinLeave(
    num: number,
    concurrent: boolean,
    multiKey: "no" | "close" | "apart" = "no"
): Promise<void> {
    const nodes = await prepareDDLL(num, concurrent, true, multiKey);
    await sleep(100); // need time for d0 receiving SetL
    // Logger.enable("DEBUG:*");
    // dump(nodes);
    // Logger.disable();
    for (let i = 0; i < num; i++) {
        const a = nodes[i];
        const b = nodes[(i + 1) % num];
        assert.strictEqual(a.status, Status.IN);
        assert.strictEqual(a.right?.getRemoteKey(), b.getKey());
        assert.strictEqual(b.left?.getRemoteKey(), a.getKey());
    }
    await leaveDDLL(nodes, concurrent);
}

function dump(nodes: DdllNode[]): void {
    for (const n of nodes) {
        logger.debug(n.toString());
        // n.manager.dumpConnectionsToLog();
    }
}

function checkConsistency(nodes: DdllNode[]): void {
    const num = nodes.length;
    for (let i = 0; i < nodes.length; i++) {
        // p -> u -> q
        const u = nodes[i];
        const p = nodes[(i + num - 1) % num];
        const q = nodes[(i + 1) % num];
        assert.strictEqual(u.right!.getRemoteKey(), q.getKey());
        assert.strictEqual(u.left!.getRemoteKey(), p.getKey());
        assert.strictEqual(u.rseq.compareTo(q.lseq), 0);
    }
}

async function checkMulticast(
    nodes: DdllNode[],
    start: number,
    min: string,
    max: string
): Promise<void> {
    const { req, replies, error } = await doMulticast(nodes, start, min, max);
    assert.strictEqual(req.isCompleted(), true);
    assert.strictEqual(req.getIncompleteRanges().length, 0);
    assert.strictEqual(req.numberOfRetransmission, 0);
    assert.strictEqual(error, undefined);
    const expected: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const key = nodes[i].getKey();
        if (CircularSpace.isOrdered(min, true, key, max, false)) {
            assert.strictEqual(TestMulticastRequest.received.get(key), "probe");
            expected.push("TEST" + key);
        } else {
            assert.strictEqual(
                TestMulticastRequest.received.get(key),
                undefined
            );
        }
    }
    replies.sort();
    console.log(replies);
    assert.deepStrictEqual(replies, expected);
}

async function doMulticast(
    nodes: DdllNode[],
    start: number,
    min: string,
    max: string
): Promise<{ req: TestMulticastRequest; replies: string[]; error?: Error }> {
    TestMulticastRequest.received.clear();
    const req = new TestMulticastRequest(nodes[start].manager, "probe");
    let replies: string[] = [];
    const defer = new Deferred<void>();
    req.onReply((rep) => {
        if (rep instanceof EndOfReply) {
            logger.debug("REPLY FINISHED");
            defer.resolve();
        } else if (rep instanceof Error) {
            logger.debug("REPLY GOT ERROR: %s", rep);
            defer.reject();
        } else if (rep instanceof TestMulticastReply) {
            logger.debug("REPLY RECEIVED: %s", rep.texts);
            replies = replies.concat(rep.texts);
        } else {
            throw new Error("check: should not happen");
        }
    });
    nodes[start].multicast(min, max, req);
    let error: Error | undefined = undefined;
    try {
        await defer.promise;
    } catch (err) {
        error = err;
    }
    return {
        req: req,
        replies: replies,
        error: error,
    };
}
