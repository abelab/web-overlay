import assert = require("assert");
import { defaultConfig, Logger, Manager, PeerConnection, sleep } from "../dist";
import { PortalManager } from "../dist/portal";
import { DummyRequest, DummyRequestPattern } from "./common";

const logger = new Logger("test", "", "");

describe("Portal", () => {
    let manager1: PortalManager;
    let manager2: Manager;

    afterEach(() => {
        manager1 && manager1.destroy();
        manager2 && manager2.destroy();
    });

    it("connectPortal succeeds", async () => {
        const url1 = "http://localhost:8000";
        // Logger.enable("DEBUG:*");
        manager1 = await new PortalManager({
            NODE_ID: "P1",
            MY_URL: url1,
        }).start();
        manager2 = new Manager({ NODE_ID: "P2" });
        const pc0 = await manager2.connectPortal(url1);
        const pc1 = await manager2.connectPortal(url1);
        const dummyKey = "$connectPortal";
        assert.strictEqual(pc0.isConnected(), true);
        assert.strictEqual(pc1.isConnected(), true);
        assert.strictEqual(pc0.getLocalKey(), dummyKey);
        assert.strictEqual(pc0.getRemoteKey(), dummyKey);
        assert.strictEqual(pc0.getRemoteNodeId(), "P1");
        assert.strictEqual(pc1.getLocalKey(), dummyKey);
        assert.strictEqual(pc1.getRemoteKey(), dummyKey);
        assert.strictEqual(pc1.getRemoteNodeId(), "P1");
        logger.debug("pc[0]=%s", pc0);
        logger.debug("pc[1]=%s", pc1);
        manager1.dumpConnections();
        manager2.dumpConnections();
        pc0.close();
        pc1.close();
    });

    /**
     * test request and reply: reply is delayed
     */
    it("delayed reply fails", async () => {
        const pc = await prepare();
        // Logger.enable("DEBUG:*");
        // establish WebSocket: P2 (client) -> P1 (server)
        const req = new DummyRequest(manager2!, DummyRequestPattern.DELAY);
        pc.send(req);
        const stat = { onReplyCalled: 0, onFailureCalled: 0 };
        observeReply(req, stat);
        await sleep(defaultConfig.REPLY_TIMEOUT + 500);
        assert.strictEqual(stat.onReplyCalled, 0);
        assert.strictEqual(stat.onFailureCalled, 1);
        return;
    }).timeout(10000); // default REPLY_TIMEOUT + 1000 = 7000

    it("duplicated reply succeeds", async () => {
        const pc = await prepare();
        const req = new DummyRequest(manager2!, DummyRequestPattern.DUPLICATED);
        pc.send(req);
        const stat = { onReplyCalled: 0, onFailureCalled: 0 };
        observeReply(req, stat);
        await sleep(4000);
        assert.strictEqual(stat.onReplyCalled, 1);
        assert.strictEqual(stat.onFailureCalled, 0);
        return;
    }).timeout(5000);

    it("wrong reply is ignored", async () => {
        const pc = await prepare();
        const req = new DummyRequest(
            manager2!,
            DummyRequestPattern.WRONG_REPLY_CLASS
        );
        pc.send(req);
        const stat = { onReplyCalled: 0, onFailureCalled: 0 };
        observeReply(req, stat);
        await sleep(4000);
        assert.strictEqual(stat.onReplyCalled, 1);
        assert.strictEqual(stat.onFailureCalled, 0);
        return;
    }).timeout(5000);

    async function prepare(): Promise<PeerConnection> {
        const url1 = "http://localhost:8000";
        manager1 = await new PortalManager({
            NODE_ID: "P1",
            MY_URL: url1,
        }).start();
        manager2 = new Manager({ NODE_ID: "P2" });
        return await manager2.connectPortal(url1);
    }

    function observeReply(
        req: DummyRequest,
        stat: { onReplyCalled: number; onFailureCalled: number }
    ): void {
        req.onReply((reply) => {
            if (reply instanceof Error) {
                logger.debug("failure %s", reply);
                stat.onFailureCalled++;
            } else {
                logger.debug("onReply is called!");
                stat.onReplyCalled++;
            }
        });
    }
});
