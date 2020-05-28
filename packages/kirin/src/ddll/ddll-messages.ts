import {
    ConnectionRequest,
    Logger,
    Manager,
    Message,
    Path,
    ReplyMessage,
    RequestMessage,
    RequestMessageSpec,
    RetriableError,
    serializable,
    sleep,
} from "@web-overlay/manager";
import { DdllNode, DdllRejectReasons, LinkSeq, Status } from "./ddll";
import { override } from "core-decorators";

export interface DdllMessage {
    ddll: DdllNode;
}

function showOnReceive(msg: Message & DdllMessage): void {
    const name = msg.constructor.name;
    const manager = msg.manager;
    const logger = DdllNode.getLogger(manager, msg.ddll);
    logger.newEvent("receive %s", name);
    logger.debug("%s", msg);
}

function prologue(
    msg: Message & DdllMessage
): {
    name: string;
    manager: Manager;
    ddll?: DdllNode;
    logger: Logger;
} {
    showOnReceive(msg);
    return {
        name: msg.constructor.name,
        manager: msg.manager,
        ddll: msg.ddll,
        logger: DdllNode.getLogger(msg.manager, msg.ddll),
    };
}

/****************************************************************
 * Connection Requests
 ****************************************************************/

/**
 * Forward a piggybacked message to the closest predecessor of the specified targetKey.
 * At the closest node, the piggyback message's onReceive() is called.
 *
 * FTP = ForwardToPredecessor
 *
 *  A          B         C
 * -----FTP----> FTP.onReceive()
 *  <-FTPReply-:---FTP---> FTP.onReceive()
 *             <-FTPReply-
 *                         Piggyback.onReceive() if C is the closest
 *
 *  A          B         C        D
 * -----FTP----> FTP.onReceive()
 *  <-FTPReply-:---FTP---> FTP.onReceive()
 *             ! ReplyTimeout at B
 *             :--------FTP------> (retry)
 *
 */
@serializable
export class ForwardToPredecessor
    extends RequestMessage<ForwardToPredecessor, ForwardToPredecessorReply>
    implements DdllMessage {
    private readonly targetKey: string;
    private readonly piggybackMessage: Message & DdllMessage;
    private path: Path;

    constructor(
        manager: Manager,
        targetKey: string,
        piggybackMessage: Message & DdllMessage
    ) {
        super(manager);
        this.targetKey = targetKey;
        this.piggybackMessage = piggybackMessage;
        this.path = new Path([this.manager.getNodeId()]);
        this.onReply(async (reply) => {
            if (reply instanceof Error) {
                DdllNode.getLogger(manager, this.ddll).debug(
                    "ForwardToPredecessor: retry after 500msec!"
                );
                await sleep(500);
                // XXX: we have to prevent infinite loop
                const freq = new ForwardToPredecessor(
                    manager,
                    this.targetKey,
                    this.piggybackMessage
                );
                freq.path = this.path;
                freq.invokeOnReceive();
            }
        });
    }

    public getSpec(): RequestMessageSpec {
        return { replyClassName: ForwardToPredecessorReply.name };
    }

    public toString(): string {
        return `<${this.constructor.name} msgId=${this.msgId}, targetKey="${this.targetKey}", path=${this.path}>`;
    }

    protected onReceive(): void {
        this.onReceiveAsync().catch((err) => {
            DdllNode.getLogger(this.manager, this.ddll).fatal(
                "ForwardToPredecessor.onReceiveAsync got %s",
                err
            );
            console.error(err);
        });
    }

    protected async onReceiveAsync(): Promise<void> {
        const { name, manager, ddll, logger } = prologue(this);
        const closest = DdllNode.getClosestPrecedingConnection(
            manager,
            this.targetKey,
            false
        );
        if (!closest) {
            logger.debug("%s: no connection!", name);
            return;
        }
        // If this message is forwarded from A -> B -> C, and
        // C forwards to D via relay node X, then D receives a message whose
        // this.source is [D, X, C] and this.path is [C, B, A].
        // In this case, we want this.path as [D, X, C, B, A].
        for (const n of this.source!.asArray().reverse()) {
            this.path = this.path.prepend(n);
        }
        logger.debug(
            "closest=%s, this.source=%s, this.path=%s",
            closest,
            this.source,
            this.path
        );
        if (closest.getRemoteNodeId() !== manager.getNodeId()) {
            const freq = new ForwardToPredecessor(
                manager,
                this.targetKey,
                this.piggybackMessage
            );
            freq.path = this.path;
            closest.send(freq);
        } else {
            // I'm the closest node
            const dnode = DdllNode.getDdllNode(manager, closest.getLocalKey());
            if (!dnode) {
                DdllNode.getLogger(manager).error(
                    "no ddll for key %s",
                    closest.getRemoteKey()
                );
                throw new Error("should not happen");
            }
            logger.debug("dnode=%s", dnode);
            this.piggybackMessage.initFromContainer(this);
            this.piggybackMessage.source = this.path; // overwrite source
            // because initFromContainer() calls setAutomaticProps() only if PeerConnection is
            // explicitly specified, we call it to make sure that .ddll is set in the piggybackMessage.
            this.manager.setAutomaticProps(
                dnode.getKey(),
                this.piggybackMessage
            );
            this.piggybackMessage.invokeOnReceive();
        }
        this.sendReply(new ForwardToPredecessorReply(this));
    }
}
export interface ForwardToPredecessor extends DdllMessage {}

@serializable
export class ForwardToPredecessorReply extends ReplyMessage<
    ForwardToPredecessor,
    ForwardToPredecessorReply
> {
    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface ForwardToPredecessorReply extends DdllMessage {}

/**
 * a ConnectionRequest used for establishing a left-side connection.
 */
@serializable
export class JoinLeftCReq extends ConnectionRequest implements DdllMessage {
    /**
     * constructor
     *
     * @param {Manager} manager
     * @param {string} localKey the key of the joining or repairing node
     * @param {boolean} isRepair true if this join operation is for repairing
     */
    constructor(
        manager: Manager,
        localKey: string,
        private isRepair: boolean,
        private allowSingleton: boolean
    ) {
        super(manager, localKey);
        this.piggybacked();
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            throw new Error("no ddll");
        }
        if (
            !this.isRepair &&
            (ddll.getKey() === this.connectKey ||
                ddll.right!.getRemoteKey() === this.connectKey)
        ) {
            // the joining node has the same key!
            logger.debug("reject: same key");
            this.reject(DdllRejectReasons.DUPLICATED_KEY);
            return;
        }
        if (
            this.isRepair &&
            ddll.getKey() === this.connectKey &&
            !this.allowSingleton
        ) {
            logger.debug("reject: singleton is not allowed");
            this.reject(DdllRejectReasons.AVOID_SINGLETON);
            return;
        }
        this.accept(ddll.getKey()).then(
            (pc) => ddll.cleaner.addChild(pc),
            () => {
                /* empty */
            }
        );
    }
}
export interface JoinLeftCReq extends DdllMessage {}

/**
 * joinのためのコネクション確立要求を処理する（右リンク用）．
 */
@serializable
export class JoinRightCReq extends ConnectionRequest implements DdllMessage {
    private hopCount = 0;

    constructor(manager: Manager, localKey: string) {
        super(manager, localKey);
    }
    /*
     * LEFT      JOINING_NODE   RIGHT
     *   <-------------                JoinRightCReq
     *   ----------------------------> JoinRightCReq
     *                   <===========> CONNECTION
     */
    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            throw new Error("no ddll");
        }
        if (
            this.hopCount === 0 &&
            ddll.right!.getRemoteKey() !== ddll.getKey()
        ) {
            this.hopCount++;
            ddll.right!.send(this);
        } else {
            this.accept(ddll.key).then(
                (pc) => ddll.cleaner.addChild(pc),
                () => {
                    /* empty */
                }
            );
        }
    }
}
export interface JoinRightCReq extends DdllMessage {}

/**
 * a ConnectionRequest used for node leaving.
 */
@serializable
class LeaveCReq extends ConnectionRequest implements DdllMessage {
    /**
     * constructor
     *
     * @param manager
     * @param localKey  left node key
     * @param leaveKey  leaving node key
     * @param targetKey right node key
     */
    constructor(
        manager: Manager,
        localKey: string,
        private leaveKey: string,
        private targetKey: string
    ) {
        super(manager, localKey);
    }
    /*
     * LEFT        LEAVING_NODE   RIGHT(TARGET)
     *   <---------- SetRLeave
     *   ----------> LeaveCReq
     *                   ------------> LeaveCReq
     *   <===========================> CONNECTION
     */
    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            throw new Error("no ddll");
        }
        if (ddll.getKey() === this.leaveKey) {
            if (ddll.right!.getRemoteKey() === this.targetKey) {
                ddll.right!.send(this);
            } else {
                this.reject("right node is changed");
            }
            return;
        }
        if (ddll.getKey() === this.targetKey) {
            logger.debug("%s: accept", name);
            this.accept(ddll.key).then(
                (pc) => ddll.cleaner.addChild(pc),
                () => {
                    /* empty */
                }
            );
            return;
        }
        // should not happen!
        logger.error("%s: SENT TO WRONG NODE?", name);
        this.reject("sent to wrong node");
    }
}
interface LeaveCReq extends DdllMessage {}

@serializable
export class KeyBasedCReq extends ConnectionRequest implements DdllMessage {
    private readonly target: string;
    constructor(
        manager: Manager,
        localKey: string,
        target: string,
        public params: {
            exactKey?: boolean;
            webrtcOnly?: boolean;
        }
    ) {
        super(manager, localKey, {
            webrtcOnly: params.webrtcOnly,
        });
        this.target = target;
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            throw new Error("no ddll");
        }
        const closest = DdllNode.getClosestPrecedingConnection(
            manager,
            this.target,
            true
        );
        if (!closest) {
            logger.warn("no closest connection!");
            return;
        }
        logger.debug("target=%s, closest=%s", this.target, closest);
        if (closest.getRemoteNodeId() === manager.getNodeId()) {
            const node = DdllNode.getDdllNode(manager, closest.getRemoteKey());
            if (!node) {
                throw new Error("should not happen");
            }
            if (this.params.exactKey && node.key !== this.target) {
                this.reject(DdllRejectReasons.NO_EXACT_KEY);
                return;
            }
            this.accept(node.key, {
                webrtcOnly: this.params.webrtcOnly,
            }).catch(() => {
                /* empty */
            });
        } else {
            closest.send(this); // forward
        }
    }
}
export interface KeyBasedCReq extends DdllMessage {}

@serializable
export class SetRJoin extends RequestMessage<SetRJoin, SetRJoinReply>
    implements DdllMessage {
    constructor(
        manager: Manager,
        private rcur: string,
        private rnewseq: LinkSeq
    ) {
        super(manager);
    }

    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: SetRJoinReply.name,
        };
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            throw new Error("no ddll");
        }
        const pc = this.peerConnection;
        if (!pc || !ddll) {
            logger.warn("SetRJoin: no PeerConnection nor DdllNode!");
            return;
        }
        if (
            ddll.status === Status.IN &&
            ddll.right!.getRemoteKey() === this.rcur
        ) {
            ddll.right = pc;
            // we cannot close node.right here because it may still be a valid link for the remote node!
            const msg = new SetRJoinReply(this, "ack", ddll.rseq.next());
            this.sendReply(msg);
            ddll.rseq = this.rnewseq;
            logger.debug("after SetRJoin: %s", ddll);
        } else {
            logger.info(
                "SetRJoin.onReceive: reply with SetRNak: current status=%s, current right=%s, rcur=%s",
                ddll.status,
                ddll.right!.getRemoteKey(),
                this.rcur
            );
            const msg = new SetRJoinReply(this, "nak");
            this.sendReply(msg);
        }
    }
}
export interface SetRJoin extends DdllMessage {}

@serializable
export class SetRJoinReply extends ReplyMessage<SetRJoin, SetRJoinReply>
    implements DdllMessage {
    public readonly type: string;
    public readonly rnewseq?: LinkSeq;
    constructor(req: SetRJoin, type: "ack", rnewseqOrReason: LinkSeq);
    constructor(req: SetRJoin, type: "nak");
    constructor(req: SetRJoin, type: string, rnewseqOrReason?: LinkSeq) {
        super(req);
        this.type = type;
        if (type === "ack") {
            this.rnewseq = rnewseqOrReason as LinkSeq;
        }
    }

    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface SetRJoinReply extends DdllMessage {}

@serializable
export class SetRLeave extends RequestMessage<SetRLeave, SetRLeaveReply>
    implements DdllMessage {
    constructor(
        manager: Manager,
        private rcur: string,
        private rnewseq: LinkSeq,
        private rnewkey: string
    ) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return { replyClassName: SetRLeaveReply.name };
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            logger.info("no ddll (maybe ok)");
            return;
        }
        const pc = this.peerConnection;
        if (!pc) {
            // a SetRLeave message may be received after closing right PeerConnection.
            // (consider the case where immediately after receiving SetL message)
            // we ignore such messages.
            logger.warn("%s: no PeerConnection", name);
            return;
        }
        if (
            ddll.status === Status.IN &&
            ddll.right!.getRemoteKey() === this.rcur
        ) {
            const msg = new LeaveCReq(
                manager,
                ddll.key,
                this.rcur,
                this.rnewkey
            );
            ddll.cleaner.addChild(msg.getPeerConnection());
            msg.connect(ddll.right!)
                .then((newpc) => {
                    logger.newEvent("SetRLeave: connected");
                    // コネクションが確立したら，再度自ノードの右リンクが変わってないか確認
                    if (
                        ddll.status === Status.IN &&
                        ddll.right!.getRemoteKey() === this.rcur
                    ) {
                        // 先に SetL を送信し，次に SetRLeaveReply を送信する．
                        // 順序が逆の場合，
                        // |---SetRAck--->|            |
                        // |              |---Close--->| (有効な左リンクが切れた!)
                        // |----------->SetL-----------|
                        // という順序になる場合がある．
                        newpc.send(new SetL(this.manager, this.rnewseq));
                        const reply = new SetRLeaveReply(
                            this,
                            "ack",
                            ddll.rseq.next()
                        );
                        this.sendReply(reply);
                        ddll.rseq = this.rnewseq;
                        ddll.right = newpc;
                        logger.debug("SetRLeave: after SetRLeave: %s", ddll);
                    } else {
                        logger.debug("SetRLeave: send SetRNak (1)");
                        const reply = new SetRLeaveReply(this, "nak");
                        this.sendReply(reply);
                    }
                })
                .catch((err) => {
                    logger.newEvent("SetRLeave: not connected: " + err);
                    logger.debug("SetRLeave: send SetRNak (2)");
                    const reply = new SetRLeaveReply(this, "nak");
                    this.sendReply(reply);
                });
        } else {
            logger.debug("SetRLeave: send SetRNak (3)");
            const reply = new SetRLeaveReply(this, "nak");
            this.sendReply(reply);
        }
    }
}
export interface SetRLeave extends DdllMessage {}

@serializable
export class SetRLeaveReply extends ReplyMessage<SetRLeave, SetRLeaveReply>
    implements DdllMessage {
    public readonly type: string;
    public readonly rnewseq?: LinkSeq;
    constructor(req: SetRLeave, type: "ack", rnewseqOrReason: LinkSeq);
    constructor(req: SetRLeave, type: "nak");
    constructor(req: SetRLeave, type: string, rnewseqOrReason?: LinkSeq) {
        super(req);
        this.type = type;
        if (type === "ack") {
            this.rnewseq = rnewseqOrReason as LinkSeq;
        }
    }

    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface SetRLeaveReply extends DdllMessage {}

@serializable
export class SetL extends Message {
    constructor(manager: Manager, private seq: LinkSeq) {
        super(manager);
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        if (!ddll) {
            throw new Error("no ddll");
        }
        const pc = this.peerConnection;
        if (!pc) {
            logger.warn("%s: no PeerConnection", name);
            return;
        }
        if (ddll.lseq.compareTo(this.seq) < 0) {
            const prev = ddll.left;
            ddll.lseq = this.seq;
            ddll.left = pc;
            ddll.monitorLeftLink();
            ddll.logger.debug("SetL: after SetL: %s", ddll);
            if (prev) {
                // delay closing because we may recently have used the left link
                // and waiting for some replies.
                ddll.cleaner.startTimer(
                    manager,
                    "ddll.SetL.delayclose",
                    1000,
                    () => ddll.safeClose(prev)
                );
            }
            if (ddll.status === Status.DEL && ddll.leaveDefer) {
                logger.debug("SetL: received while leaving");
                ddll.status = Status.IN;
                ddll.leaveDefer.reject(
                    new RetriableError("SetL received while leaving")
                );
            }
        } else {
            logger.info("this.seq <= node.lseq");
        }
    }
}
export interface SetL extends DdllMessage {}

@serializable
export class Unicast extends Message implements DdllMessage {
    constructor(manager: Manager, public destKey: string, public msg: Message) {
        super(manager);
    }

    public toString(): string {
        return `<${this.constructor.name} msgId=${this.msgId}, destKey=${this.destKey}>`;
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        const next = DdllNode.getClosestPrecedingConnection(
            manager,
            this.destKey
        );
        if (!next) {
            logger.warn("no valid connection for key %s", this.destKey);
            throw new Error("no connection");
        }
        if (next.getRemoteNodeId() !== manager.getNodeId()) {
            logger.debug("Unicast.send: send to %s", next);
            next.send(this);
            return;
        }
        const node = DdllNode.getDdllNode(manager, next.getRemoteKey());
        if (node?.isResponsible(this.destKey)) {
            this.msg.initFromContainer(this);
            manager.setAutomaticProps(node.getKey(), this.msg);
            manager.receive(this.msg);
            return;
        }
        // this happens if right node is faulty and not yet recovered.
        logger.info(
            "Unicast.send: wait and retry later. key=%s, pc=%s",
            this.destKey,
            next
        );
        manager.cleaner.startTimer(manager, "unicast-delay", 1000, () =>
            this.onReceive()
        );
    }
}
export interface Unicast extends DdllMessage {}

/*
 * Messages for repairing
 */
@serializable
export class Ping extends RequestMessage<Ping, Pong> implements DdllMessage {
    /*
     * the receiver node (left node) may have closed the PeerConnection
     * for this node, we explicitly specify targetKey so that the receiver node
     * can send a Pong message back.
     */
    constructor(manager: Manager, public targetKey: string) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return { replyClassName: Pong.name };
    }

    public onReceive(): void {
        const { name, manager, ddll, logger } = prologue(this);
        let pong: Pong;
        if (!ddll) {
            logger.warn("ping: no DdllNode for key %s", this.targetKey);
            pong = new Pong(this, undefined, undefined);
        } else if (!ddll.right) {
            ddll.logger.info("ping: no right link: %s", this.ddll);
            pong = new Pong(this, undefined, undefined);
        } else {
            pong = new Pong(this, ddll.right.getRemoteKey(), ddll.rseq);
        }
        this.sendReply(pong);
    }
}
export interface Ping extends DdllMessage {}

@serializable
export class Pong extends ReplyMessage<Ping, Pong> implements DdllMessage {
    constructor(
        req: Ping,
        public leftSucc: string | undefined,
        public rseq: LinkSeq | undefined
    ) {
        super(req);
    }

    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}

export interface Pong extends DdllMessage {}

@serializable
export class GetRight extends RequestMessage<GetRight, GetRightReply>
    implements DdllMessage {
    constructor(manager: Manager) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return { replyClassName: GetRightReply.name };
    }

    public onReceive(): void {
        showOnReceive(this);
        const reply = new GetRightReply(this, this.ddll.right!.getRemoteKey());
        this.sendReply(reply);
    }
}
export interface GetRight extends DdllMessage {}

@serializable
export class GetRightReply extends ReplyMessage<GetRight, GetRightReply> {
    constructor(req: GetRight, public key: string) {
        super(req);
    }
    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface GetRightReply extends DdllMessage {}
