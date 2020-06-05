import {
    Cleanable,
    Cleaner,
    Logger,
    Manager,
    PeerConnection,
    ReplyMessage,
    RequestMessage,
    RequestMessageSpec,
    serializable,
    sleep,
} from "@web-overlay/manager";
import { PortalManager } from "@web-overlay/portal";
import { createPStoreClass, DdllNode, PStoreIf, Status } from "..";
import assert = require("assert");

export function toFixedDigits(num: number, d: number): string {
    return ("000000000" + num.toString()).substr(-d);
}

export const logger = new Logger("test", "test", "");

export function log(format: string, ...args: any[]): void {
    logger.info(format, ...args);
}

export function banner(format: string, ...args: any[]): void {
    logger.info("****" + format + "**********************", args);
}

export abstract class TestBase implements Cleanable {
    protected manager: Manager[] = [];
    protected url0 = "http://localhost:8080";
    protected ddllNodes: PStoreIf[] = [];
    protected keys: string[] = [];
    public key2index = new Map<string, number>();
    public received: string[] = [];
    public cleaner: Cleaner;

    constructor() {
        this.cleaner = new Cleaner(logger);
    }

    // if true, all nodes used for testing are portal node.
    public static NO_WEBRTC_ON_NODE = true;

    public destroy() {
        this.after();
    }

    public before() {
        Logger.enable("DEBUG:test,INFO:*");
    }

    public after() {
        banner("TestBase.after is called");
        // debug.enable("web*,ddll*");
        // LogWriter.enable("*");
        this.cleaner.clean();
        DdllNode.PING_PERIOD = 5000;
    }

    protected async testDrive(
        num: number,
        testFunc: () => Promise<void>
    ): Promise<void> {
        await this.createNodes(num);
        await this.ddllNodes[0].initInitialNode();
        for (let i = 1; i < num; i++) {
            await this.ddllNodes[i].join(this.url0);
        }
        await testFunc();
        Logger.disable();
        for (let i = 0; i < num; i++) {
            if (this.ddllNodes[i].status === Status.IN) {
                await this.ddllNodes[i].leave();
                await sleep(100);
            }
        }
        logger.info("testDrive finished");
    }

    public createNode(key: string, manager: Manager): PStoreIf {
        const clazz = createPStoreClass(DdllNode);
        return new clazz(key, manager);
    }

    protected async createManagers(num: number): Promise<void> {
        for (let i = 0; i < num; i++) {
            this.keys[i] = toFixedDigits(i, 2);
            if (i === 0) {
                this.manager[0] = await new PortalManager({
                    NODE_ID: "P" + this.keys[i],
                    MY_URL: this.url0,
                }).start();
            } else {
                let manager: Manager;
                if (TestBase.NO_WEBRTC_ON_NODE) {
                    const url = "http://localhost:" + (8080 + i);
                    manager = await new PortalManager({
                        NODE_ID: "P" + this.keys[i],
                        MY_URL: url,
                    }).start();
                } else {
                    manager = new Manager({ NODE_ID: "P" + this.keys[i] });
                }
                this.manager[i] = manager;
            }
            this.manager[i].registerApp(this.keys[i], "testBase", this);
            this.key2index.set(this.keys[i], i);
            this.cleaner.push(() => {
                banner("CLEANUP MANAGER" + i);
                this.manager[i].destroy();
            });
        }
    }

    protected async createNodes(num: number): Promise<void> {
        await this.createManagers(num);
        for (let i = 0; i < num; i++) {
            this.ddllNodes[i] = this.createNode(this.keys[i], this.manager[i]);
            this.cleaner.push(() => {
                this.ddllNodes[i].destroy();
            });
        }
    }

    protected dump(nodes?: DdllNode[]): void {
        if (!nodes) {
            nodes = this.ddllNodes;
        }
        for (const n of nodes) {
            logger.debug(n.toString());
            n.manager.dumpConnectionsToLog();
        }
    }

    protected checkConsistency(nodes: DdllNode[]): void {
        const num = nodes.length;
        for (let i = 0; i < nodes.length; i++) {
            // p -> u -> q
            const u = nodes[i];
            const p = nodes[(i + num - 1) % num];
            const q = nodes[(i + 1) % num];
            assert(
                u.right!.getRemoteKey() === q.getKey(),
                `node ${u.key}'s right is not ${
                    q.key
                } (${u.right!.getRemoteKey()})`
            );
            assert(
                u.left!.getRemoteKey() === p.getKey(),
                `node ${u.key}'s left is not ${
                    p.key
                } (${u.left!.getRemoteKey()})`
            );
            assert(
                u.rseq.compareTo(q.lseq) === 0,
                `node ${u.key}'s rseq is not equal to ${q.key}'s left one`
            );
        }
    }
}

export type TestRequestType = "normal" | "ignore";

@serializable
export class TestRequest extends RequestMessage<TestRequest, TestReply> {
    constructor(manager: Manager, public type: TestRequestType) {
        super(manager);
    }

    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: TestReply.name,
        };
    }

    protected onReceive(): void {
        switch (this.type) {
            case "normal":
                this.sendReply(new TestReply(this));
                break;
            case "ignore":
                break;
        }
    }
}

@serializable
export class TestReply extends ReplyMessage<TestRequest, TestReply> {
    constructor(req: TestRequest) {
        super(req);
    }
}

export async function prepareManagers(
    cleaner: Cleaner,
    num: number,
    noConnect = false,
    allPortal = false
): Promise<[Manager[], PeerConnection[]]> {
    if (num <= 0) {
        throw new Error("num should be >0");
    }
    const url = "http://localhost:8080";
    const manager0 = await new PortalManager({
        MY_URL: url,
        NODE_ID: "P0",
    }).start();
    const managers: Manager[] = [manager0];
    const connections: PeerConnection[] = [];
    cleaner.push(() => manager0.destroy());
    for (let i = 1; i < num; i++) {
        let m: Manager;
        if (allPortal) {
            m = await new PortalManager({
                MY_URL: "http://localhost:" + (8080 + i),
                NODE_ID: "P" + i,
            }).start();
        } else {
            m = new Manager({
                NODE_ID: "P" + i,
            });
        }
        managers.push(m);
        cleaner.push(() => m.destroy());
        if (!noConnect) {
            const pc = await m.connectPortal(url);
            connections.push(pc);
        }
    }
    return [managers, connections];
}
