import assert = require("assert");
import {
    Cleanable,
    Cleaner,
    ConnectionRequest,
    DEFAULT_LOG_SERVER_PORT,
    Deferred,
    Logger,
    Manager,
    ManagerConfig,
    Message,
    Path,
    PeerConnection,
    RawConnectionType,
    serializable,
    sleep,
} from "@web-overlay/manager";
import {DummyReply, DummyRequest, DummyRequestPattern, ManagerType, prepareManagers,} from "./common";
import {DisconnectedError} from "@web-overlay/manager/dist";

const logger = new Logger("test", "test", "");
let cleaner = new Cleaner(logger);

@serializable
class Container extends Message {
    constructor(manager: Manager, public payload: Message) {
        super(manager);
    }

    protected onReceive(): void {
        this.payload.initFromContainer(this);
        this.payload.invokeOnReceive();
    }
}

const beforeSendCounter = new Map<string, number>();
let acceptDeferred: Deferred<PeerConnection> | undefined = undefined;

type TestType = "normal" | "ignore" | "reject" | "muted-accept";
@serializable
class TestConnectionRequest extends ConnectionRequest {
    constructor(
        manager: Manager,
        localKey: string,
        public remoteKey: string,
        public type: TestType
    ) {
        super(manager, localKey);
    }

    public beforeSend(pc: PeerConnection): void {
        const nodeId = this.manager.getNodeId();
        console.log(
            `beforeSend is called at ${nodeId}, isRequestingNode=${this.isRequestingNode}`
        );
        beforeSendCounter.set(nodeId, (beforeSendCounter.get(nodeId) || 0) + 1);
        // console.log(new Error());
        super.beforeSend(pc);
    }

    protected onReceive(): void {
        switch (this.type) {
            case "muted-accept":
                this.manager.mute();
            // FALLTHROUGH
            // eslint-disable-next-line no-fallthrough
            case "normal":
                {
                    const promise = this.accept(this.remoteKey);
                    promise.then(
                        (reply) => {
                            logger.debug(
                                "%s: TestConnectionRequest.accept: got reply: %s",
                                this.manager.getNodeId(),
                                reply
                            );
                            if (acceptDeferred) {
                                acceptDeferred.resolve(reply);
                            }
                        },
                        (err) => {
                            if (acceptDeferred) {
                                acceptDeferred.reject(err);
                            }
                        }
                    );
                }
                break;
            case "ignore":
                break;
            case "reject":
                this.reject("REASON");
                break;
        }
    }
}

class CleanableClass implements Cleanable {
    public cleaner: Cleaner;
    constructor() {
        this.cleaner = new Cleaner(logger);
    }
    destroy(): void {
        logger.debug("CleanableClass: destroyed");
        this.cleaner.clean();
    }
}

describe("Manager APIs", () => {
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

    it("request API normal", async () => {
        const [[manager0, manager1], [pc1to0]] = await prepareManagers(
            cleaner,
            2
        );
        const req = new DummyRequest(manager1, DummyRequestPattern.NORMAL);
        let result;
        try {
            result = await req.request(pc1to0);
        } catch (err) {
            result = err;
        }
        logger.debug("result: %s", result);
        assert(result instanceof DummyReply);
        assert.deepStrictEqual((result as DummyReply).peerConnection, pc1to0);
    });

    it("request API error", async () => {
        const [[manager0, manager1], [pc1to0]] = await prepareManagers(
            cleaner,
            2
        );
        const req = new DummyRequest(manager1, DummyRequestPattern.NOREPLY);
        let result;
        try {
            result = await req.request(pc1to0);
        } catch (err) {
            result = err;
        }
        logger.debug("result: %s", result);
        assert(result instanceof Error);
    }).timeout(10000);

    it("connect succeeds (old API)", async () => {
        const [[manager0, manager1], [pc1to0]] = await prepareManagers(
            cleaner,
            2
        );
        acceptDeferred = new Deferred<PeerConnection>();
        const req = new TestConnectionRequest(manager0, "10", "20", "normal");
        req.forward(new Path(["P0", "P1"]));
        let result;
        try {
            result = await req.getConnectPromise();
        } catch (err) {
            result = err;
        }
        logger.debug("result: %s", result);
        await check(
            result,
            RawConnectionType.WebServerSocket,
            RawConnectionType.WebClientSocket
        );
    });

    it("connect succeeds (new API)", async () => {
        const [[manager0, manager1], [pc1to0]] = await prepareManagers(
            cleaner,
            2
        );
        // connect(PeerConnection)
        {
            acceptDeferred = new Deferred<PeerConnection>();
            const req = new TestConnectionRequest(
                manager1,
                manager1.getNodeId(),
                manager0.getNodeId(),
                "normal"
            );
            let result;
            try {
                result = await req.connect(pc1to0);
            } catch (err) {
                result = err;
            }
            logger.debug("result: %s", result);
            await check(
                result,
                RawConnectionType.WebClientSocket,
                RawConnectionType.WebServerSocket
            );
        }
        // connect() = local
        {
            acceptDeferred = new Deferred<PeerConnection>();
            const req = new TestConnectionRequest(
                manager0,
                manager0.getNodeId(),
                manager0.getNodeId(),
                "normal"
            );
            let result;
            // Logger.enable("*");
            try {
                result = await req.connect();
            } catch (err) {
                result = err;
            }
            logger.debug("result: %s", result);
            assert(result instanceof PeerConnection);
            // TODO: RawConnectionType should be Loopback
            /*await check(
                result,
                RawConnectionType.Loopback,
                RawConnectionType.Loopback
            );*/
        }
    });

    it("connect succeeds (new API, portal to portal)", async () => {
        const result = await testConnect(["P", "P", "P"]);
        check(
            result,
            RawConnectionType.WebServerSocket,
            RawConnectionType.WebClientSocket
        );
    });

    it("connect succeeds (new API, portal to non-portal)", async () => {
        const result = await testConnect(["P", "P", "M"]);
        assert(result instanceof PeerConnection);
        check(
            result,
            RawConnectionType.WebServerSocket,
            RawConnectionType.WebClientSocket
        );
    });

    it("connect succeeds (new API, non-portal to portal)", async () => {
        const result = await testConnect(["P", "M", "P"]);
        check(
            result,
            RawConnectionType.WebClientSocket,
            RawConnectionType.WebServerSocket
        );
    });

    it("connect succeeds (new API, non-portal to non-portal)", async () => {
        const result = await testConnect(["P", "M", "M"]);
        check(result, undefined, undefined);
    });

    it("connect succeeds (new API, non-portal to portal then relay)", async () => {
        const result = await testConnect(["P", "M", "Perror"]);
        check(result, undefined, undefined);
        if (result instanceof PeerConnection) {
            assert.deepStrictEqual(result.paths[0].asArray(), [
                "P1",
                "P0",
                "P2",
            ]);
        }
    });

    it("connect succeeds (new API, portal to non-portal then relay)", async () => {
        const result = await testConnect(["P", "Perror", "M"]);
        check(result, undefined, undefined);
        if (result instanceof PeerConnection) {
            assert.deepStrictEqual(result.paths[0].asArray(), [
                "P1",
                "P0",
                "P2",
            ]);
        }
    });

    it("connect fails by reject()", async () => {
        const result = await testConnect(["P", "M", "P"], "reject");
        if (result instanceof Error) {
            assert.strictEqual(result.message, "REASON");
        } else {
            assert(false, "result is not Error");
        }
    });

    it("connect fails by muted accept", async () => {
        const conf: ManagerConfig = {
            MAX_RAWCONNECTION_ESTABLISH_TIME: 1000,
            RELAY_CONNECTION_TIMEOUT: 1000,
            // DEBUG: "DEBUG:*",
        };
        const [connectP, acceptP] = await testConnectRaw(
            ["P", "P", "M"],
            "muted-accept",
            conf
        );
        const results = await Promise.all([
            negatePromise(connectP),
            negatePromise(acceptP),
        ]);
        assert(results[0] instanceof Error);
        assert(results[1] instanceof Error);
    }).timeout(10000);

    it("connect succeeds (URL)", async () => {
        const [[manager0, manager1]] = await prepareManagers(cleaner, 2, true);
        {
            const req = new TestConnectionRequest(
                manager1,
                manager1.getNodeId(),
                manager0.getNodeId(),
                "normal"
            );
            let result;
            // Logger.enable("DEBUG:*");
            try {
                result = await req.connect(manager0.getNodeSpec().serverUrl!);
            } catch (err) {
                result = err;
            }
            logger.debug("result: %s", result);
            assert(result instanceof PeerConnection);
            manager0.dumpConnectionsToLog();
            manager1.dumpConnectionsToLog();
        }
    });

    it("connect timeout (old API)", async () => {
        const [[manager0, manager1], [pc1to0]] = await prepareManagers(
            cleaner,
            2
        );
        const req = new TestConnectionRequest(
            manager0,
            manager0.getNodeId(),
            manager1.getNodeId(),
            "ignore"
        );
        req.forward(new Path(["P0", "P1"]));
        let result;
        try {
            result = await req.getConnectPromise();
        } catch (err) {
            result = err;
        }
        logger.debug("result: %s", result);
        assert(result instanceof Error);
    }).timeout(10000);

    it("connect timeout (new API)", async () => {
        const [[manager0, manager1], [pc1to0]] = await prepareManagers(
            cleaner,
            2
        );
        const req = new TestConnectionRequest(
            manager0,
            manager0.getNodeId(),
            manager1.getNodeId(),
            "ignore"
        );
        let result;
        try {
            result = await req.connect(new Path(["P0", "P1"]));
        } catch (err) {
            result = err;
        }
        logger.debug("result: %s", result);
        assert(result instanceof Error);
    }).timeout(10000);

    it("piggyback connect succeeds", async () => {
        const result = await testPiggyback("normal");
        assert(result instanceof PeerConnection);
        logger.debug("pc=%s", result);
    });

    it("piggyback connect timeout", async () => {
        const result = await testPiggyback("ignore");
        assert(result instanceof Error);
        logger.debug("pc=%s", result);
    }).timeout(10000);

    it("disconnect by idle", async () => {
        const conf: ManagerConfig = {
            // make RawConnection disconnect by 1sec idle.
            MAX_IDLE_TIME_BEFORE_RAW_CLOSE: 1000,
        };
        const result = await testConnect(["P", "M", "P"], "normal", conf);
        if (result instanceof Error) {
            assert(false);
        }
        if (result instanceof PeerConnection) {
            const pc = result;
            let isCallbackCalled;
            pc.onDisconnect(() => {
                isCallbackCalled = true;
            });
            assert.strictEqual(pc.isConnected(), true);
            assert.notStrictEqual(pc.getRawConnection(), undefined);
            assert.strictEqual(isCallbackCalled, undefined);
            // sleep 2sec and check if connections are disconnected
            await sleep(2000);
            assert.strictEqual(pc.isConnected(), false);
            assert.strictEqual(isCallbackCalled, true);
        }
    }).timeout(3000);

    it("beforeSend is called properly", async () => {
        const [[m0, m1, m2]] = await prepareManagers(cleaner, 3);
        {
            const req = new TestConnectionRequest(
                m1,
                m1.getNodeId(),
                m2.getNodeId(),
                "normal"
            );
            beforeSendCounter.clear();
            let result;
            try {
                result = await req.connect(
                    new Path([m1.getNodeId(), m0.getNodeId(), m2.getNodeId()])
                );
            } catch (err) {
                result = err;
            }
            logger.debug("result: %s", result);
            assert(result instanceof PeerConnection);
            assert.strictEqual(beforeSendCounter.get("P1"), 1);
            assert.strictEqual(beforeSendCounter.get("P0"), 1);
            assert.strictEqual(beforeSendCounter.get("P2"), undefined);
        }
    });

    it("muted node becomes suspicious", async () => {
        const [connectP, acceptP, managers] = await testConnectRaw(
            ["P", "M", "M"],
            "normal"
        );
        const pc1to2 = await connectP;
        const req = new DummyRequest(managers[1], DummyRequestPattern.NORMAL);
        managers[0].mute();
        try {
            const reply = await req.request(pc1to2);
            assert(false);
        } catch (err) {
            assert(err instanceof DisconnectedError);
            assert.deepStrictEqual(managers[1].getSuspiciousNodes(), [
                managers[0].getNodeId()
            ]);
        }
    }).timeout(10000);

    it("multiplexed PeerConnection", async () => {
        const [connectP, acceptP, managers] = await testConnectRaw(
            ["P", "M", "P"],
            "normal"
        );
        const pc1to2 = await connectP;
        assert.strictEqual(pc1to2.getConnectionType(), RawConnectionType.WebClientSocket);
        const req = new TestConnectionRequest(
            managers[1],
            managers[1].getNodeId(),
            managers[2].getNodeId(),
            "normal"
        );
        const pc1to2dash = await req.connect(new Path(["P1", "P0", "P2"]));
        assert.notStrictEqual(pc1to2, pc1to2dash);
        assert.strictEqual(pc1to2.getRawConnection(), pc1to2dash.getRawConnection());
    });

    it("redundant relay connection is established", async () => {
        const [
            managers,
            [pc1to0, pc2to0],
        ] = await prepareManagers(
            cleaner,
            5,
            false,
            ["P", "P", "P", "M", "M"]
        );
        // connect from P3 to {P1, P2}
        for (let i = 1; i <= 2; i++) {
            const req = new TestConnectionRequest(
                managers[3],
                managers[3].getNodeId(),
                managers[i].getNodeId(),
                "normal"
            );
            await req.connect(managers[i].getNodeSpec().serverUrl);
        }
        const req = new TestConnectionRequest(
            managers[4],
            managers[4].getNodeId(),
            managers[3].getNodeId(),
            "normal"
        );
        const pc = await req.connect(new Path(["P4", "P0", "P3"]));
        console.log(pc.toString());
        // check if we have 3 routes from P4 to P3
        assert.strictEqual(pc.paths.length, 3);
        // check if we can send a message from P4 to P3 even if some relay nodes are muted
        managers[0].mute();
        managers[1].mute(); // we still have P4->P2->P3 route
        const dum = new DummyRequest(managers[4], DummyRequestPattern.NORMAL);
        // Logger.enable("DEBUG:*");
        const reply = await dum.request(pc);
        assert(reply instanceof DummyReply);
        await sleep(10000);
        console.log(pc.toString());
        assert.strictEqual(pc.paths.length, 1);
        assert.strictEqual(pc.isConnected(), true);
    }).timeout(20000);

    it("redundancy of a relay connection increases", async () => {
        const conf: ManagerConfig = {
            RELAY_PATH_MAINTENANCE_PERIOD: 5 * 1000
        };
        const [
            managers,
            [pc1to0, pc2to0],
        ] = await prepareManagers(
            cleaner,
            5,
            false,
            ["P", "P", "P", "M", "M"],
            conf
        );
        let pc: PeerConnection;
        {
            const req = new TestConnectionRequest(
                managers[4],
                managers[4].getNodeId(),
                managers[3].getNodeId(),
                "normal"
            );
            pc = await req.connect(new Path(["P4", "P0", "P3"]));
            console.log(pc.toString());
            // check if we have 1 route from P4 to P3
            assert.strictEqual(pc.paths.length, 1);
        }
        // then, connect from P3 to P1 and from P4 to P2
        for (const [from, to] of [[3, 1], [4, 2]]) {
            const req = new TestConnectionRequest(
                managers[from],
                managers[from].getNodeId(),
                managers[to].getNodeId(),
                "normal"
            );
            await req.connect(managers[to].getNodeSpec().serverUrl);
        }
        await sleep(10000);
        console.log(pc.toString());
        assert.strictEqual(pc.paths.length, 3);
    }).timeout(20000);
});

describe("cleaner", async () => {
    it("check", () => {
        // Logger.enable("*");

        const cleaner = new Cleaner(logger);
        const c: CleanableClass[] = [];
        for (let i = 0; i < 2; i++) {
            const x = new CleanableClass();
            cleaner.addChild(x);
            c.push(x);
        }
        console.log(cleaner.toString());
        c[1].destroy();
        console.log(cleaner.toString());
    });
});

describe("logger", async () => {
    // node.js does not exit on this test
    it.skip("check", () => {
        // Logger.enable("*");
        const testLogger = new Logger(
            "loggerTest",
            "loggerTest",
            "key",
            `http://localhost:${DEFAULT_LOG_SERVER_PORT}`
        );
        testLogger.debug("this is debug");
        testLogger.debug("aaa line1\nbbb line2\nccc line3");
        testLogger.destroy();
    });
});

async function testPiggyback(type: TestType): Promise<PeerConnection | Error> {
    const [[manager0, manager1]] = await prepareManagers(cleaner, 2);
    const req = new TestConnectionRequest(
        manager0,
        manager0.getNodeId(),
        manager1.getNodeId(),
        type
    );
    req.piggybacked();
    const container = new Container(manager0, req);
    container.forward(new Path(["P0", "P1"]));
    let result;
    try {
        result = await req.getConnectPromise();
    } catch (err) {
        result = err;
    }
    return result;
}

async function testConnectRaw(
    managerTypes: ManagerType[],
    testType: TestType = "normal",
    conf?: ManagerConfig
): Promise<[Promise<PeerConnection>, Promise<PeerConnection>, Manager[]]> {
    const [
        managers,
        [pc1to0, pc2to0],
    ] = await prepareManagers(
        cleaner,
        managerTypes.length,
        false,
        managerTypes,
        conf
    );
    const [manager0, manager1, manager2] = managers;
    acceptDeferred = new Deferred<PeerConnection>();
    const req = new TestConnectionRequest(
        manager1,
        manager1.getNodeId(),
        manager2.getNodeId(),
        testType
    );
    const connectPromise = req.connect(new Path(["P1", "P0", "P2"]));
    return [connectPromise, acceptDeferred.promise, managers];
}

async function testConnect(
    managerTypes: ManagerType[],
    testType: TestType = "normal",
    conf?: ManagerConfig
): Promise<PeerConnection | Error> {
    const [connectP, acceptP] = await testConnectRaw(
        managerTypes,
        testType,
        conf
    );
    let result;
    try {
        result = await connectP;
    } catch (err) {
        result = err;
    }
    logger.debug("result: %s", result);
    return result;
}

async function check(
    result: PeerConnection | Error,
    type1: RawConnectionType | undefined,
    type2: RawConnectionType | undefined
): Promise<void> {
    assert(result instanceof PeerConnection);
    if (result instanceof PeerConnection) {
        assert.strictEqual(
            result.getRawConnection()?.getConnectionType(),
            type1
        );
    }
    const acceptResult = await acceptDeferred!.promise;
    assert(acceptResult instanceof PeerConnection);
    if (acceptResult instanceof PeerConnection) {
        assert.strictEqual(
            acceptResult.getRawConnection()?.getConnectionType(),
            type2
        );
    }
}

function negatePromise<T extends object>(promise: Promise<T>): Promise<Error> {
    return promise.then(
        (result) => {
            throw new Error(result.toString());
        },
        (err) => {
            return err;
        }
    );
}
