// we are moving to test-manager3.ts

// eslint-disable-next-line @typescript-eslint/no-var-requires
import {
    banner,
    DummyReply,
    DummyRequest,
    DummyRequestPattern,
    log,
    receivedTexts,
    TextMessage,
    TextMessageNoSeq,
    toFixedDigits,
} from "./common";
import { suite, test, timeout } from "mocha-typescript";
import {
    AnyClass,
    ConnectionRequest,
    defaultConfig,
    Deferred,
    Logger,
    Manager,
    ManagerConfig,
    Path,
    PeerConnection,
    RawConnection,
    serializable,
    sleep,
    WebRTCConnection,
    WsConnection,
    DisconnectedError,
    Cleaner,
} from "../dist";
import { PortalManager, WsServerConnection } from "../dist/portal";
import assert = require("assert");

let managers: Manager[] = [];
let toPortal: PeerConnection[] = [];
let acceptPromises: Promise<PeerConnection>[] = [];
let onDisconnectCalled: Deferred<boolean>[] = [];

const logger = new Logger("test", "test", "");

function findIndex(manager: Manager): number {
    for (let i = 0; i < managers.length; i++) {
        const n = managers[i];
        // console.log(i + "[" + n.getNodeId() + "]");
        if (n === manager) {
            return i;
        }
    }
    throw new Error("unknown manager!");
}

enum TestType {
    NORMAL,
    REJECT,
}

@serializable
class MyConnRequest extends ConnectionRequest {
    constructor(
        manager: Manager,
        localKey: string,
        public id: string,
        public type: TestType
    ) {
        super(manager, localKey);
    }
    public onReceive(): void {
        const k = this.manager.getNodeId();
        console.log(
            `MyConnRequest.onReceive: nodeId=${k}, id=${this.id}, type=${
                TestType[this.type]
            }`
        );
        switch (this.type) {
            case TestType.NORMAL:
                {
                    this.accept(k)
                        .then((pc) => {
                            log("connected(accept): " + pc);
                            const index = findIndex(this.manager);
                            pc.onDisconnect(() => {
                                log(
                                    "onDisconnect is called on Node " +
                                        index +
                                        ", " +
                                        pc
                                );
                                if (onDisconnectCalled[index]) {
                                    onDisconnectCalled[index].resolve(true);
                                }
                            });
                        })
                        .catch((err) => {
                            log(
                                `MyConnRequest.onReceive: nodeId=${k}, id=${this.id} got ${err}`
                            );
                            assert(false);
                        });
                }
                break;
            case TestType.REJECT: {
                log("*** REJECT! ***");
                this.reject("reject for test");
            }
        }
    }
}

@serializable
class FailureConnRequest extends ConnectionRequest {
    constructor(manager: Manager, localKey: string, public target: number) {
        super(manager, localKey);
    }
    public onReceive(): void {
        const manager = this.manager;
        log("FailureConnRequest.onReceive");
        managers[this.target].mute();
        const k = manager.getNodeId();
        const index = findIndex(manager);
        const promise = this.accept(k);
        manager.mgrLogger.log("index=" + index);
        acceptPromises[index] = promise;
        promise
            .then((pc) => {
                log("FailureConnRequest: accept succeeded:", pc);
            })
            .catch((err) => {
                log("FailureConnRequest: accept failed:", err);
            });
    }
}

enum NodeType {
    PORTAL,
    NODEJS,
    BROWSER,
    PORTAL_WRONG_URL,
}

abstract class TestBase {
    public readonly NUMS = 4;

    protected getURL(i: number): string {
        const port = 8000 + i;
        return `http://localhost:${port}`;
    }

    public after() {
        log("after!");
        // LogWriter.disable();
        managers.forEach((n) => {
            n.destroy();
        });
        managers = [];
        toPortal = [];
        receivedTexts.clear();
        acceptPromises = [];
        onDisconnectCalled = [];
    }

    /**
     * Initialize nodes.
     * If type[n] == true, node[n] is PortalManager and otherwise is Manager.
     * Each node establishes a connection to node[0].
     *
     * @param id
     * @param type
     * @param conf
     */
    protected async setup(
        id: string,
        type: NodeType[],
        conf?: ManagerConfig
    ): Promise<void> {
        for (let i = 0; i < type.length; i++) {
            const nodeId = "P" + toFixedDigits(i, 2);
            let node: Manager;
            switch (type[i]) {
                case NodeType.PORTAL:
                    node = await new PortalManager({
                        ...conf,
                        NODE_ID: nodeId,
                        MY_URL: this.getURL(i),
                    }).start();
                    break;
                case NodeType.PORTAL_WRONG_URL:
                    node = await new PortalManager({
                        ...conf,
                        NODE_ID: nodeId,
                        MY_URL: PortalManager.TestURL,
                    }).start();
                    break;
                case NodeType.NODEJS: /* FALL THROUGH */
                case NodeType.BROWSER:
                    node = new Manager({
                        ...conf,
                        NODE_ID: nodeId,
                    });
                    break;
                default:
                    throw new Error("should not happen");
            }
            managers[i] = node;
            toPortal[i] = await managers[i].connectPortal(this.getURL(0));
            onDisconnectCalled[i] = new Deferred<boolean>();
        }
    }

    protected dumpConnectionsToLog(): void {
        managers.forEach((n) => {
            n.dumpConnectionsToLog();
        });
    }

    protected async doSendReceive(
        pc: PeerConnection,
        msgClass?: AnyClass
    ): Promise<void> {
        log("connected(connect): " + pc);
        //await sleep(1000);
        const from = parseInt(
            pc
                .getManager()
                .getNodeId()
                .replace(/[^0-9]/g, "")
        );
        let expect: string | undefined = undefined;
        for (let i = 0; i < 100; i++) {
            const clazz = msgClass ? msgClass : TextMessage;
            const text = String(i);
            const msg = new clazz(managers[from], text);
            expect = expect ? expect + "," + text : text;
            pc.send(msg);
        }
        await sleep(500);
        assert.strictEqual(receivedTexts.get(pc.getRemoteNodeId()), expect);
        log("**** doSendReceive OK *****************************");
    }

    protected async doTestRequest(
        pc: PeerConnection,
        sender = 1
    ): Promise<void> {
        log("connected(connect): " + pc);
        await sleep(1000);
        let received: any;
        const msg = new DummyRequest(
            managers[sender],
            DummyRequestPattern.NORMAL
        );
        msg.onReply((reply) => {
            received = reply;
        });
        pc.send(msg);
        await sleep(1000);
        assert.notEqual(received, undefined);
        assert(received instanceof DummyReply);
    }
}

@suite
class TestWebSocket1 extends TestBase {
    @test(timeout(10000))
    public async testAckTimeout(): Promise<void> {
        // Logger.enable("*");
        await this.setup("TestAckTimeout", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
        ]);
        const msg = new MyConnRequest(
            managers[1],
            "10",
            "TestAckTimeout",
            TestType.NORMAL
        );
        // nodes[0].mute();
        msg.forward(new Path(["P01", "P00", "P02"]));
        const pc1to2 = await msg.getConnectPromise();
        log(pc1to2.toString());
        const msg2 = new DummyRequest(managers[1], DummyRequestPattern.NORMAL);
        managers[0].mute();
        pc1to2.send(msg2);
        const d = new Deferred<void>();
        msg2.onReply((reply) => {
            log("got reply! %s", reply);
            if (reply instanceof DisconnectedError) {
                log(pc1to2.toString());
                log("suspicious=", managers[1].getSuspiciousNodes());
                assert.deepStrictEqual(managers[1].getSuspiciousNodes(), [
                    "P00",
                ]);
                d.resolve();
            } else {
                d.reject(new Error("unexpected reply: " + reply));
            }
        });
        return d.promise;
    }
}

@suite
class TestMultiplex extends TestBase {
    @test(timeout(30000))
    public async test1(): Promise<void> {
        await this.setup("TestMultiplex", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.NODEJS,
        ]);
        // debug.enable("webrtc*,simple-peer");
        const msg1 = new MyConnRequest(
            managers[1],
            "10",
            "TestMultiplex-1",
            TestType.NORMAL
        );
        msg1.forward(new Path(["P01", "P00", "P02"]));
        const pc1 = await msg1.getConnectPromise();
        await sleep(100);
        const msg2 = new MyConnRequest(
            managers[1],
            "10",
            "TestMultiplex-2",
            TestType.NORMAL
        );
        msg2.forward(new Path(["P01", "P00", "P02"]));
        const pc2 = await msg2.getConnectPromise();
        this.dumpConnectionsToLog();
        assert(pc1.getRawConnection() === pc2.getRawConnection());
        return this.doSendReceive(pc2);
    }
}

/*
 *  P1=====+
 *   |     I
 *  P0(P)  I
 *   |     I
 *  P2=====+
 *
 * Establish a relay connection from P1 to P2
 */
@suite
class TestRelay1 extends TestBase {
    @test(timeout(60000))
    public async testSinglePath(): Promise<void> {
        // Logger.enable("*");
        await this.setup("TestRelay1", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.NODEJS,
        ]);
        const msg = new MyConnRequest(
            managers[1],
            "10",
            "TestRelay1",
            TestType.NORMAL
        );
        msg.forward(new Path(["P01", "P00", "P02"]));
        const pc1To2 = await msg.getConnectPromise();
        pc1To2.onDisconnect(() => {
            log("onDisconnect is called on Node1," + pc1To2);
            onDisconnectCalled[1].resolve(true);
        });
        assert.strictEqual(pc1To2.getRawConnection(), undefined);
        assert.strictEqual(pc1To2.paths[0].asArray().length, 3);
        await this.doSendReceive(pc1To2);
        await sleep(1000);
        // P02 から P00 への rawConnection を切断し，PeerConnectionが切断されることを確認する
        log("*** close raw");
        (toPortal[2].getRawConnection() as RawConnection).close();
        const req = new DummyRequest(managers[1], DummyRequestPattern.NORMAL);
        req.onReply((reply) => {
            log("DummyRequest.onReply: got: " + reply);
            assert(reply instanceof Error);
        });
        pc1To2.send(req);
        await Promise.all([onDisconnectCalled[1], onDisconnectCalled[2]]);
        managers.forEach((n) => {
            n.dumpConnections();
        });
        assert(
            managers[0].getSuspiciousNodes().indexOf(managers[0].getNodeId()) <
                0
        );
    }
}

/*eslint no-irregular-whitespace: ["error", { "skipComments": true }]*/
/*
 *     P1 - P3
 *    /  \
 *  P0(P) |
 *   \　 /
 *    P2
 *
 * この状態で，P3からP2にRelayPathを確立する
 */
@suite
class TestRelay2 extends TestBase {
    @test(timeout(30000))
    public async test1(): Promise<void> {
        await this.setup("TestRelay2", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.NODEJS,
        ]);
        // Logger.enable("*");

        // connect P02 with P01
        const msg = new MyConnRequest(
            managers[2],
            "20",
            "TestRelay2-1",
            TestType.NORMAL
        );
        msg.forward(new Path(["P02", "P00", "P01"]));
        const pc1 = await msg.getConnectPromise();
        log("**** 1st connection established *****************************");
        // connect P03 with P01
        const msg2 = new MyConnRequest(
            managers[3],
            "30",
            "TestRelay2-2",
            TestType.NORMAL
        );
        msg2.forward(new Path(["P03", "P00", "P01"]));
        const pc2 = await msg2.getConnectPromise();
        log("**** 2nd connection established *****************************");
        // connect P03 with P02
        const msg3 = new MyConnRequest(
            managers[3],
            "30",
            "TestRelay2-3",
            TestType.NORMAL
        );
        msg3.forward(new Path(["P03", "P00", "P02"]));
        const pc3 = await msg3.getConnectPromise();
        log("**** 3rd connection established *****************************");
        managers.forEach((n) => {
            n.dumpConnectionsToLog();
        });
        // await this.doTest(pc3, 3, 2);
        await this.doTestRequest(pc3, 3);
        await sleep(1000);
        pc3.close();
        await sleep(1000);
        this.dumpConnectionsToLog();
    }
}

/*
 *     P1
 *    /  \
 *  [P0] [P3]
 *   \
 *    P2
 *
 * この状態で，P2からP1にRelayPathを確立する
 */
@suite
class TestRelay3 extends TestBase {
    @test(timeout(30000))
    public async testDualPaths(): Promise<void> {
        // Logger.enable("*");
        // debug.enable("*");
        await this.setup("TestRelay3", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.PORTAL,
        ]);

        // connect P01 -> P03
        const pc1to3 = await managers[1].connectPortal(
            managers[3].getNodeSpec().serverUrl as string
        );

        // connect P02 with P01
        const msg = new MyConnRequest(
            managers[2],
            "20",
            "TestRelay3",
            TestType.NORMAL
        );
        msg.forward(new Path(["P02", "P00", "P01"]));
        const pc2to1 = await msg.getConnectPromise();
        banner("connection from P02 to P01 is established");
        log(pc2to1.toString());
        assert.strictEqual(pc2to1.paths.length, 2);
        // Logger.enable("DEBUG:*");
        await this.doSendReceive(pc2to1, TextMessageNoSeq);
        banner("close P01->P03");
        (pc1to3.getRawConnection() as RawConnection).close();
        await sleep(1000);
        await this.doTestRequest(pc2to1, 2);
        await sleep(1000);
        assert.strictEqual(pc2to1.paths.length, 1);
    }
}

/*
 *   P1---+----+
 *   |    |    |
 *  [P0] [P3] [P4]
 *   |    |    |
 *  P2----+----+
 *
 */
@suite
class TestRelay4 extends TestBase {
    @test(timeout(40000))
    public async testLaterAddAnotherPath(): Promise<void> {
        await this.setup("TestRelay4", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.PORTAL,
            NodeType.PORTAL,
        ]);
        // LogWriter.enable("*");
        // connect P01 -> P03
        const msg1 = new MyConnRequest(
            managers[1],
            "10",
            "TestRelay4-1",
            TestType.NORMAL
        );
        msg1.forward(new Path(["P01", "P00", "P03"]));
        const pc1to3 = await msg1.getConnectPromise();
        banner("connection from P01 to P03 is established");
        assert.notStrictEqual(pc1to3.getRawConnection(), undefined);

        // connect P02 -> P01 (relay)
        const msg2 = new MyConnRequest(
            managers[2],
            "20",
            "TestRelay4-2",
            TestType.NORMAL
        );
        msg2.forward(new Path(["P02", "P00", "P01"]));
        const pc2to1 = await msg2.getConnectPromise();
        banner("connection from P02 to P01 is established");
        // confirm that we have 2 paths
        assert.strictEqual(pc2to1.paths.length, 2);
        log("**** mute P00 ****");
        managers[0].mute();
        // check if we can transmit messages without using P00
        await this.doSendReceive(pc2to1);

        // establish connection between P01-P04 and check if we have another path via P04
        await managers[1].connectPortal(this.getURL(4));
        banner("connection from P01 to P04 is established");
        await sleep(defaultConfig.RELAY_PATH_MAINTENANCE_PERIOD + 5 * 1000);
        log("PC2TO1=%S", pc2to1);
        assert.strictEqual(pc2to1.paths.length, 2);

        log("finish!");
        managers.forEach((n) => {
            n.dumpConnectionsToLog();
        });
    }

    @test(timeout(10000))
    public async testRelayPathWhenRawConnectionsHasBeenReady(): Promise<void> {
        const h = "RelayPathWhenRawConnectionsHasBeenReady";
        await this.setup(h, [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.PORTAL,
            NodeType.PORTAL,
            NodeType.PORTAL,
        ]);
        // connect {P01, P02} -> {P03, P04, P05}
        for (let i = 3; i < 6; i++) {
            const msg1 = new MyConnRequest(
                managers[1],
                "10",
                h,
                TestType.NORMAL
            );
            msg1.forward(new Path(["P01", "P00", managers[i].getNodeId()]));
            await msg1.getConnectPromise();
            const msg2 = new MyConnRequest(
                managers[2],
                "20",
                h,
                TestType.NORMAL
            );
            msg2.forward(new Path(["P02", "P00", managers[i].getNodeId()]));
            await msg2.getConnectPromise();
        }
        Logger.enable("*");
        banner("setup finished");
        // connect P02 -> P01 (relay)
        const msg2 = new MyConnRequest(
            managers[2],
            "20",
            "TestRelay4-2",
            TestType.NORMAL
        );
        msg2.forward(new Path(["P02", "P00", "P01"]));
        const pc2to1 = await msg2.getConnectPromise();
        banner("connection from P02 to P01 is established");
        assert(defaultConfig.MINIMUM_RELAY_PATHS <= 4);
        assert(pc2to1.paths.length >= defaultConfig.MINIMUM_RELAY_PATHS);
        managers.forEach((n) => {
            n.dumpConnectionsToLog();
        });
    }

    @test(timeout(10000))
    public async testRelayPathNumber(): Promise<void> {
        await this.setup("TestRelayPathNumber", [
            NodeType.PORTAL,
            NodeType.NODEJS,
            NodeType.NODEJS,
            NodeType.PORTAL,
            NodeType.PORTAL,
            NodeType.PORTAL,
        ]);
        Logger.enable("*");
        // connect P01 -> P03, P04, P05
        for (let i = 3; i < 6; i++) {
            const msg1 = new MyConnRequest(
                managers[1],
                "10",
                "TestRelay4-1",
                TestType.NORMAL
            );
            msg1.forward(new Path(["P01", "P00", managers[i].getNodeId()]));
            await msg1.getConnectPromise();
        }
        banner("setup finished");

        // connect P02 -> P01 (relay)
        const msg2 = new MyConnRequest(
            managers[2],
            "20",
            "TestRelay4-2",
            TestType.NORMAL
        );
        msg2.forward(new Path(["P02", "P00", "P01"]));
        const pc2to1 = await msg2.getConnectPromise();
        banner("connection from P02 to P01 is established");
        assert(defaultConfig.MINIMUM_RELAY_PATHS <= 4);
        assert(pc2to1.paths.length >= defaultConfig.MINIMUM_RELAY_PATHS);
        managers.forEach((n) => {
            n.dumpConnectionsToLog();
        });
    }

    // @test(timeout(40000))
    public async testConnectAny(): Promise<void> {
        Logger.enable("DEBUG:*");
        const manager = new Manager();
        [
            "http://NONEXISTINGDOMAINxxx.com:8000",
            "http://NONEXISTINGDOMAINxxx.com:8001",
            "http://NONEXISTINGDOMAINxxx.com:8002",
        ].forEach((url) => manager.addPortalURL(url));
        const pc1 = await manager.connectAnyPortal();
    }
}
