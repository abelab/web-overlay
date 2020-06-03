import {
    Cleaner,
    defaultConfig,
    Logger,
    Manager,
    ManagerConfig,
    Message,
    MessageSpec,
    PeerConnection,
    ReplyMessage,
    RequestMessage,
    RequestMessageSpec,
    serializable,
} from "@web-overlay/manager";
import { PortalManager } from "..";
import { override } from "core-decorators";

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

export enum DummyRequestPattern {
    NORMAL,
    NOREPLY,
    DELAY,
    DUPLICATED,
    WRONG_REPLY_CLASS,
}

@serializable
export class DummyRequest extends RequestMessage<DummyRequest, DummyReply> {
    constructor(manager: Manager, private pattern: DummyRequestPattern) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: DummyReply.name,
        };
    }

    public onReceive(): void {
        const repl = new DummyReply(this);
        switch (this.pattern) {
            case DummyRequestPattern.NORMAL:
                this.sendReply(repl);
                break;
            case DummyRequestPattern.NOREPLY:
                break;
            case DummyRequestPattern.DELAY:
                // delayed reply
                this.manager.cleaner.startTimer(
                    this.manager,
                    "DummyReply.Delay",
                    defaultConfig.REPLY_TIMEOUT + 1000,
                    () => {
                        this.sendReply(repl);
                    }
                );
                break;
            case DummyRequestPattern.DUPLICATED:
                // duplicated reply
                this.sendReply(repl);
                this.sendReply(repl);
                break;
            case DummyRequestPattern.WRONG_REPLY_CLASS: {
                // wrong reply
                const repl2 = new DummyReply2(this);
                try {
                    this.sendReply(repl2);
                } catch (err) {
                    console.log("OK, got error: ", err.toString());
                }
                // correct reply
                this.sendReply(repl);
                break;
            }
        }
    }
}

@serializable
export class DummyReply extends ReplyMessage<DummyRequest, DummyReply> {
    constructor(req: DummyRequest) {
        super(req);
    }
}

@serializable
class DummyReply2 extends ReplyMessage<DummyRequest, DummyReply2> {
    constructor(req: DummyRequest) {
        super(req);
    }
}

@serializable
export class TextMessage extends Message {
    constructor(manager: Manager, public text: string) {
        super(manager);
    }

    public onReceive(): void {
        log(`node ${this.manager.getNodeId()} receives ${this.text}`);
        let str = receivedTexts.get(this.manager.getNodeId());
        if (!str) {
            str = this.text;
        } else {
            str += "," + this.text;
        }
        receivedTexts.set(this.manager.getNodeId(), str);
    }
}

@serializable
export class TextMessageNoSeq extends TextMessage {
    constructor(manager: Manager, public text: string) {
        super(manager, text);
    }

    public getSpec(): MessageSpec {
        return { ...super.getSpec(), noSequence: true };
    }
}

export const receivedTexts = new Map<string, string>();

export type ManagerType = "P" | "M" | "Perror";

/**
 * @param cleaner
 * @param num
 * @param noConnect
 * @param type     specifies the types of created Managers.
 * @param conf     ManagerConfig
 */
export async function prepareManagers(
    cleaner: Cleaner,
    num: number,
    noConnect = false,
    type: ManagerType[] | boolean = false,
    conf?: ManagerConfig
): Promise<[Manager[], PeerConnection[]]> {
    if (num <= 0) {
        throw new Error("num should be >0");
    }
    let types: ManagerType[] = [];
    if (Array.isArray(type)) {
        if (type.length !== num) {
            throw new Error("types.length !== num");
        }
        types = type;
    } else {
        types = new Array(num);
        types.fill(type ? "P" : "M");
    }
    const url = "http://localhost:8080";
    conf = conf || {};
    const manager0 = await new PortalManager({
        ...conf,
        MY_URL: url,
        NODE_ID: "P0",
    }).start();
    const managers: Manager[] = [manager0];
    const connections: PeerConnection[] = [];
    cleaner.push(() => manager0.destroy());
    for (let i = 1; i < num; i++) {
        let m: Manager;
        switch (types[i]) {
            case "P":
                m = await new PortalManager({
                    ...conf,
                    MY_URL: "http://localhost:" + (8080 + i),
                    NODE_ID: "P" + i,
                }).start();
                break;
            case "M":
                m = new Manager({
                    ...conf,
                    NODE_ID: "P" + i,
                });
                break;
            case "Perror":
                m = await new PortalManager({
                    ...conf,
                    MY_URL: PortalManager.TestURL,
                    NODE_ID: "P" + i,
                }).start();
                break;
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
