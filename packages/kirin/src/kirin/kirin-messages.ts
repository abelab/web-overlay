import {
    ConnectionRequest,
    Logger,
    Manager,
    Message,
    serializable,
} from "@web-overlay/manager";
import { Direction, KirinNode, Passive2 } from "./kirin";

interface KirinMessage {
    kirin: KirinNode;
}

function showOnReceive(msg: Message & KirinMessage): void {
    const name = msg.constructor.name;
    const manager = msg.manager;
    const logger = KirinNode.getKirinLogger(manager, msg.kirin);
    logger.newEvent("receive %s", name);
    logger.debug("%s", msg);
}

function prologue(
    msg: Message & KirinMessage
): {
    name: string;
    manager: Manager;
    kirin?: KirinNode;
    logger: Logger;
} {
    showOnReceive(msg);
    return {
        name: msg.constructor.name,
        manager: msg.manager,
        kirin: msg.kirin,
        logger: KirinNode.getKirinLogger(msg.manager, msg.kirin),
    };
}

// TODO: implement half-close in Manager?
@serializable
export class KirinPeerConnectionClose extends Message {
    public onReceive(): void {
        const { name, manager, kirin, logger } = prologue(this);
        if (!kirin) {
            throw new Error("no kirin");
        }
        const pc = this.peerConnection;
        if (!pc) {
            logger.warn("no PeerConnnection");
            return;
        }
        if (kirin.oldConnectionsLocal.has(pc)) {
            logger.debug("KirinPeerConnectionClose: close: %s", pc);
            kirin.safeClose(pc);
            kirin.oldConnectionsLocal.delete(pc);
        } else {
            logger.debug("KirinPeerConnectionClose: add: %s", pc);
            kirin.oldConnectionsRemote.add(pc);
        }
    }
}
export interface KirinPeerConnectionClose extends KirinMessage {}

export interface FTUpdateParams {
    distance: number;
    level: number;
    // 要求ノードで，更新中のエントリが現在指しているリモートキー
    sourceKey: string | null;
    type: Passive2;
    direction: Direction;
}

@serializable
export class FTUpdateCRequest extends ConnectionRequest {
    constructor(
        manager: Manager,
        localKey: string,
        public params: FTUpdateParams
    ) {
        super(manager, localKey);
    }
    public onReceive(): void {
        const { name, manager, kirin, logger } = prologue(this);
        if (!kirin) {
            throw new Error("no kirin");
        }
        this.kirin.handleCReq(this);
    }

    public toString(): string {
        return `<FTUpdateCReq localKey=${
            this.connectKey
        }, ${this.toStringParams()}}>`;
    }

    private toStringParams(): string {
        const p = this.params;
        return (
            `${Direction[p.direction]}` +
            `, distance=${p.distance}` +
            `, level=${p.level}` +
            `, curkey=${p.sourceKey}` +
            `, ${Passive2[p.type]}`
        );
    }
}
export interface FTUpdateCRequest extends KirinMessage {}
