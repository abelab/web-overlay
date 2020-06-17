import { override } from "core-decorators";
import {
    AcceptOptions,
    ConnectOptions,
    ConnectSpec,
    ConnectType,
    Manager,
    NodeSpec,
    ReplyTimeoutError,
} from "./manager";
import { PeerConnection } from "./peerconnection";
import { RawConnection, RawConnectionType } from "./raw/raw";
import { serializable, SerializeUtils, transient } from "./serialize";
import { Path } from "./path";
import { Cleaner } from "./cleaner";
import { Deferred, prettyPrint, quote } from "../utils";

export interface MessageSpec {
    noAck?: boolean;
    // TODO: currently all messages are noSequence! (see PeerConnection#send)
    noSequence?: boolean;
}

/**
 * Base class of all messages
 */
export abstract class Message {
    public static readonly ACK_TIMEOUT_TIMER_NAME = "Message.ackTimeout";
    /** used to dedupe messages sent over multiple paths */
    public readonly msgId: number;

    /** path to the source (originating) node, which is initialized by
     * {@link Message#initSource} in the source node and updated by
     * {@link Message#updateSource} at recipient nodes */
    public source?: Path;
    /** path to the destination node, if specified at the source node */
    public destination?: Path;
    /** message sequence number assigned by PeerConnection */
    public sequence?: number;
    /** ID for pairing this message and ACK message, assigned by {@link prepareForAck}. */
    public ackRequestId?: number;
    protected isPiggybacked?: boolean;
    @transient
    private _manager: Manager;
    @transient
    public cleaner: Cleaner;
    /** the rawConnection that this message is received via. */
    @transient
    public rawConnection?: RawConnection;
    /** target PeerConnection, set at the recipient node if destination has a target connection ID */
    @transient
    public peerConnection?: PeerConnection;
    /** refers to the container message if this message is piggybacked */
    @transient
    protected container?: Message;
    /** to figure out if this instance is received one or created (new()'ed) one */
    @transient
    public isReceived = false;

    /**
     * @constructor
     * @param {Manager} manager
     * @param destination
     */
    public constructor(manager: Manager, destination?: Path) {
        this._manager = manager;
        this.destination = destination;
        this.msgId = manager.nextMsgId++;
        this.cleaner = new Cleaner(manager.mgrLogger, manager.cleaner);
    }

    public get manager(): Manager {
        return this._manager;
    }

    // should be overridden
    public getSpec(): MessageSpec {
        return {};
    }

    public getMsgId(): number {
        return this.msgId;
    }

    public invokeOnReceive(key?: string): void {
        if (!this.source) {
            this.initSource();
        }
        if (key) {
            this.manager.setAutomaticProps(key, this);
        }
        // to allow code like:
        //   const msg = new SomeMessage();
        //   msg.invokeOnReceive();
        if (!this.isReceived) {
            this.beforeSend();
        }
        try {
            this.onReceive();
        } catch (err) {
            this.manager.mgrLogger.error(
                "%s.onReceive throws %s",
                this.constructor.name,
                err
            );
            console.error(err);
        }
    }

    /**
     * Message handler, called when this message is received at a recipient node.
     */
    protected abstract onReceive(): void;

    public afterRestore(manager: Manager): void {
        this._manager = manager;
        this.cleaner = new Cleaner(manager.mgrLogger, manager.cleaner);
    }

    /**
     * Declare that this message is a piggy-backed message;
     * this message is not sent directly but enclosed in another message.
     */
    public piggybacked(): void {
        this.beforeSend();
        this.isPiggybacked = true;
    }

    /**
     * Initialize some properties by copying from a container message.
     * Used for a piggy-backed message.
     * @param {Message} container
     */
    public initFromContainer(container: Message): void {
        if (!this.isPiggybacked) {
            throw new Error("not piggybacked message");
        }
        if (this.container) {
            throw new Error("this.container is already set");
        }
        this.container = container;
        this._manager = container.manager;
        this.rawConnection = container.rawConnection;
        this.peerConnection = container.peerConnection;
        this.isReceived = true;
        if (container.source) {
            this.source = new Path(
                container.source.asArray(),
                container.source.connId
            );
        }
    }

    public get srcNodeId(): string | undefined {
        return this.source ? this.source.destNodeId : undefined;
    }

    public get destNodeId(): string | undefined {
        return this.destination ? this.destination.destNodeId : undefined;
    }

    public initSource(pc?: PeerConnection): void {
        this.source = new Path(
            [this.manager.getNodeId()],
            pc?.getLocalConnId()
        );
    }

    public updateSource(): void {
        if (!this.source) {
            throw new Error("no this.source");
        }
        this.source = this.source.prepend(this.manager.getNodeId());
    }

    public beforeSend(pc?: PeerConnection): void {
        if (this.isPiggybacked) {
            throw new Error("tried to send a piggy-backed message directly");
        }
    }

    /**
     * forward this message along with this.destination or specified destination.
     */
    public forward(destination?: Path): void {
        if (!this.source) {
            this.initSource();
        }
        this.manager.mgrLogger.debug("Message.forward: %s", this);
        if (destination) {
            if (this.destination) {
                throw new Error("this.destination is already set");
            }
            if (
                destination.connId !== undefined &&
                !(this instanceof ProbePath) &&
                !(this instanceof GetNeighbors) &&
                !(this instanceof ClosePeerConnection)
            ) {
                throw new Error(
                    "Message.forward: destination.connId should be undefined"
                );
            }
            this.destination = destination;
        } else if (!this.destination) {
            throw new Error("Message.forward: this.destination is null");
        }
        const f = this.destination.asArray();
        const index = f.lastIndexOf(this.manager.getNodeId());
        if (index < 0) {
            throw new Error(
                "Message.forward: destination does not contain myself"
            );
        }
        this.beforeSend();
        if (f.length - 1 === index) {
            // destination is myself
            this.manager.receive(this);
            return;
        }
        // destination is not myself
        const next = f[index + 1];
        const raw = this.manager.getRawConnectionByNodeId(next);
        if (raw) {
            raw.send(this);
            return;
        }
        // no next hop!
        this.manager.mgrLogger.warn(
            ".forward: no next hop RawConnection (%s)",
            next
        );
        if (
            this.srcNodeId === undefined ||
            this.srcNodeId === this.manager.getNodeId()
        ) {
            // In most cases, calling this method is not surrounded by try-catch.
            // throw new Error("No next hop");
        } else {
            const notify = new NoNextHopNotify(
                this.manager,
                this.source!.optimize(),
                this.manager.getNodeId(),
                next
            );
            notify.forward();
        }
    }

    public toString(): string {
        return `<${this.constructor.name} ${JSON.stringify(this)}>`;
    }

    public destroy(): void {
        this.cleaner.clean();
    }

    public prepareForAck(destRaw: RawConnection): void {
        const manager = this.manager;
        if (
            manager.config.ACK_TIMEOUT === 0 ||
            this.isPiggybacked ||
            this.getSpec().noAck ||
            destRaw.getConnectionType() === RawConnectionType.Loopback
        ) {
            return;
        }
        // Note that this.ackRequestId is modified if prepareForAck is called more than once.
        const ackRequestId = manager.nextAckId++;
        this.ackRequestId = ackRequestId;
        manager.mgrLogger.debug("prepareForAck: ackRequestId=%d", ackRequestId);
        const ackStat = new AckStat(this, destRaw);
        this.manager.unAckedMessages.set(ackRequestId, ackStat);
        ackStat.cleaner.push(() => {
            this.manager.unAckedMessages.delete(ackRequestId);
        });
        ackStat.cleaner.startTimer(
            manager,
            Message.ACK_TIMEOUT_TIMER_NAME,
            manager.config.ACK_TIMEOUT,
            () => {
                manager.mgrLogger.debug("ack timeout: %s", this);
                const dest = destRaw.getRemoteNodeId();
                if (dest) {
                    manager._registerSuspiciousNode(dest);
                }
                ackStat.destroy();
                destRaw.destroy();
            }
        );
    }

    public sendAckIfNecessary(raw: RawConnection): void {
        /*
         * If this message is not sent via PeerConnection,
         * this.source.connId === null.
         */
        if (
            this.manager.config.ACK_TIMEOUT > 0 &&
            !this.getSpec().noAck &&
            this.ackRequestId !== undefined &&
            raw.getConnectionType() !== RawConnectionType.Loopback
        ) {
            const ack = new Ack(this.manager, this.ackRequestId);
            this.manager.mgrLogger.debug(
                "sendAck: %s to %s",
                ack,
                this.rawConnection
            );
            raw.send(ack);
        }
    }

    public ackReceived(ackStat: AckStat): void {
        this.manager.mgrLogger.debug(
            "Ack received for %s, ack time=%d",
            ackStat.message,
            Date.now() - ackStat.time
        );
        ackStat.destroy();
    }
}

export interface RequestMessageSpec extends MessageSpec {
    replyClassName: string;
    noReplyTimeout?: boolean;
    allowMultipleReply?: boolean;
}

export class AckStat {
    private readonly manager: Manager;
    public readonly time = Date.now();
    cleaner: Cleaner;
    constructor(public message: Message, public destRaw: RawConnection) {
        this.manager = message.manager;
        this.cleaner = new Cleaner(this.manager.mgrLogger);
    }
    public destroy(): void {
        this.cleaner.clean();
    }
}

export class EndOfReply {}
export type ReplyNotification = EndOfReply | Error;

export type ReplyHandler<U> = (resp: U | Error) => void;
export type StreamingReplyHandler<U> = (resp: U | EndOfReply | Error) => void;

/**
 * A base class for requesting messages.
 */
export abstract class RequestMessage<
    T extends RequestMessage<T, U>,
    U extends ReplyMessage<T, U>
> extends Message {
    public static readonly REPLY_TIMER_NAME = "RequestMessage.replyTimer";

    @transient
    protected isFailed = false;
    @transient
    public _onReply?: ReplyHandler<U> | StreamingReplyHandler<U>;
    @transient
    public readonly isRequestingNode: boolean;

    /**
     * @constructor
     *
     * @param manager
     */
    protected constructor(manager: Manager) {
        super(manager);
        this.isRequestingNode = true;
    }

    @override
    public getSpec(): RequestMessageSpec {
        throw new Error("getSpec() should be overridden");
    }

    private prepareForReply(): void {
        if (this.getSpec().noReplyTimeout) {
            return;
        }
        this.cleaner.startTimer(
            this.manager,
            RequestMessage.REPLY_TIMER_NAME,
            this.manager.config.REPLY_TIMEOUT,
            () => {
                this.fail(new ReplyTimeoutError("timeout: " + this));
            }
        );
    }

    @override
    public beforeSend(pc?: PeerConnection): void {
        if (this.isRequestingNode) {
            // call prepareForReply at most once
            if (!this.manager._lookupRequestMessage(this.msgId)) {
                this.prepareForReply();
            }
        }
        this.manager._registerRequestMessage(this, pc);
        this.cleaner.push(() =>
            this.manager._unregisterRequestMessage(this.getMsgId())
        );
        super.beforeSend(pc);
    }

    /**
     * Setup a reply handler.
     *
     * @param handler
     */
    public onReply(handler: ReplyHandler<U>): void {
        if (this._onReply) {
            throw new Error("onReply handler is already set");
        }
        this._onReply = handler;
    }

    /**
     * Setup a streaming reply handler.
     *
     * @param {(resp: (ReplyNotification | U)) => void} handler
     */
    public onStreamingReply(handler: StreamingReplyHandler<U>): void {
        if (this._onReply) {
            throw new Error("onStreamingReply handler is already set");
        }
        this._onReply = handler;
    }

    /**
     * Send a reply message to the sender.
     * This method must be called at a recipient node.
     *
     * @param msg
     */
    public sendReply(msg: U): void {
        this.checkReply(msg);
        msg.forward();
    }

    protected checkReply(msg: U): void {
        if (msg instanceof NoNextHopNotify) {
            return;
        }
        if (!SerializeUtils.isSerializable(msg)) {
            throw new Error("message is not @serializable");
        }
        const replyClassName = this.getSpec().replyClassName;
        if (msg.constructor.name !== replyClassName) {
            throw new Error(
                "message is not an instance of " +
                    replyClassName +
                    ", " +
                    msg.constructor.name
            );
        }
    }

    public _gotReply(reply: U | ReplyNotification): void {
        const onReplyHandler = this._onReply;
        if (reply instanceof Error) {
            // reset the message so that this message can be retransmit
            this._onReply = undefined;
            this.isPiggybacked = undefined;
        }
        if (!(reply instanceof EndOfReply) && !(reply instanceof Error)) {
            try {
                this.checkReply(reply);
            } catch (err) {
                this.manager.mgrLogger.warn(
                    "GOT UNEXPECTED REPLY MESSAGE TYPE: %s",
                    reply
                );
                return;
            }
        }
        if (!onReplyHandler) {
            this.destroy();
            this.manager.mgrLogger.warn(
                "%s: GOT REPLY OR ERROR BUT onReply HANDLER IS NOT SET: reply=%s, request=%s",
                this.constructor.name,
                reply,
                this
            );
        } else {
            onReplyHandler(reply as U); // or as ReplyNotification
            if (!this.getSpec().allowMultipleReply) {
                this.destroy();
            }
        }
    }

    /**
     * Make the request fail.
     *
     * @param {Error} err
     */
    public fail(err: Error): void {
        this.manager.mgrLogger.info(
            "RequestMessage.fail: err=%s, this=%s",
            err,
            this
        );
        if (!this.isFailed) {
            this.isFailed = true;
            this._gotReply(err);
        }
    }

    public async requestAndHandle<V>(
        dest: PeerConnection | RawConnection | Path,
        container: Message | undefined,
        handler: (_: U) => V,
        onError?: (_: Error) => V
    ): Promise<V> {
        const defer = new Deferred<V>();
        this.onReply((reply) => {
            this.manager.mgrLogger.debug("requestAndHandle: got reply!");
            if (reply instanceof Error) {
                if (onError) {
                    try {
                        defer.resolve(onError(reply));
                    } catch (err) {
                        defer.reject(err);
                    }
                } else {
                    defer.reject(reply);
                }
            } else {
                try {
                    defer.resolve(handler(reply));
                } catch (err) {
                    defer.reject(err);
                }
            }
        });
        const msg = container || this;
        this.manager.mgrLogger.debug("requestAndHandle: msg=%s", msg);
        if (dest instanceof Path) {
            if (dest.asArray()[0] !== this.manager.getNodeId()) {
                throw new Error("request: Path[0] is not myself");
            }
            msg.forward(dest);
        } else {
            // RawConnection or PeerConnection
            msg.beforeSend();
            dest.send(msg);
        }
        return defer.promise;
    }

    public async request(
        dest: PeerConnection | RawConnection | Path,
        container?: Message
    ): Promise<U> {
        return this.requestAndHandle(dest, container, (reply) => reply);
    }
}

export abstract class ReplyMessage<
    T extends RequestMessage<T, U>,
    U extends ReplyMessage<T, U>
> extends Message {
    // "req" points to the corresponding request message
    @transient
    public req?: T;
    protected reqMsgId: number;

    constructor(req: T) {
        super(req.manager, req.source ? req.source.optimize() : undefined);
        this.reqMsgId = req.getMsgId();
    }

    public getSpec(): MessageSpec {
        return {
            noAck: true,
        };
    }

    public onReceive(): void {
        const req = this.manager._lookupRequestMessage(this.reqMsgId);
        if (req) {
            this.req = req as T;
            this.manager.mgrLogger.debug(
                "%s.onReceive: reqMsgId=%d, req=%s",
                this.constructor.name,
                this.reqMsgId,
                req
            );
            this.req._gotReply(this); // request is destroyed here
        } else {
            this.manager.mgrLogger.info(
                "%s.onReceive: reqMsgId=%d, request not found (OK if sent via multiple paths)",
                this.constructor.name,
                this.reqMsgId
            );
        }
    }
}

@serializable
export class Ack extends Message {
    public ackReplyId: number;
    constructor(manager: Manager, ackRequestId: number) {
        super(manager);
        this.ackReplyId = ackRequestId;
    }

    public getSpec(): MessageSpec {
        return {
            noAck: true,
            noSequence: true,
        };
    }

    public toString(): string {
        return `<Ack ackReplyId=${this.ackReplyId}, source=${this.source}, desination=${this.destination}>`;
    }

    public onReceive(): void {
        this.manager.handleAck(this);
    }
}

@serializable
export class NoNextHopNotify extends Message {
    constructor(
        manager: Manager,
        destination: Path,
        public unavailableLinkFrom: string,
        public unavailableLinkTo: string
    ) {
        super(manager, destination);
    }

    public getSpec(): MessageSpec {
        return {
            noAck: true,
            noSequence: true,
        };
    }

    public onReceive(): void {
        this.manager.removeDeadLink(
            this.unavailableLinkFrom,
            this.unavailableLinkTo
        );
    }
}

/**
 * A base class of connection request.
 * You have to define a subclass and implement {@code onReceive} to forward
 * this request to the node where you want to connect to.
 */
export abstract class ConnectionRequest extends RequestMessage<
    ConnectionRequest,
    ConnectionReply
> {
    // the PeerConnection ID on the connecting node
    public connectPeerConnectionId?: number;
    // the key of the connecting node
    public readonly connectKey: string;
    public readonly connectSpec: ConnectSpec;

    // fires when PeerConnection is established
    @transient
    private readonly connectPromise: Promise<PeerConnection>;

    @transient
    public peerConnection?: PeerConnection;

    // @serializable requires constructors be public
    public constructor(
        manager: Manager,
        localKey: string,
        connectOpts?: ConnectOptions
    ) {
        super(manager);
        this.connectKey = localKey;
        this.connectSpec = manager.getNodeSpec();
        if (connectOpts) {
            this.connectSpec.noRelay = connectOpts.noRelay;
            this.connectSpec.webrtcOnly = connectOpts.webrtcOnly;
        }
        this.connectPromise = manager._connect(this);
    }

    /**
     * Send this request to the specified destination and returns Promise<PeerConnection>.
     * If destination is omitted, this request is sent to myself (request.onReceive is called).
     * If this instance is piggy-backed in another message (container), you can specify the 2nd argument.
     * In this case, the container is sent instead of this instance.
     *
     * @param dest
     * @param container
     */
    public async connect(
        dest?: PeerConnection | RawConnection | Path | string,
        container?: Message
    ): Promise<PeerConnection> {
        const msg = container || this;
        if (dest) {
            if (typeof dest === "string") {
                // dest is URL
                const pc = await this.manager.connectPortal(dest);
                pc.send(msg);
                try {
                    return await this.getConnectPromise();
                } finally {
                    pc.close();
                }
            } else if (dest instanceof Path) {
                if (dest.asArray()[0] !== this.manager.getNodeId()) {
                    throw new Error("connect: Path[0] is not myself");
                }
                msg.forward(dest);
            } else {
                // PeerConnection or RawConnection
                dest.send(msg);
            }
        } else {
            msg.beforeSend();
            this.invokeOnReceive(this.connectKey);
        }
        return this.getConnectPromise();
    }

    public accept(
        localKey: string,
        opts?: AcceptOptions
    ): Promise<PeerConnection> {
        return this.manager._accept(localKey, this, opts);
    }

    public reject(reason: string): void {
        this.manager._reject(this, reason);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: ConnectionReply.name,
            noSequence: true,
        };
    }

    public bindPeerConnection(pc: PeerConnection): void {
        this.connectPeerConnectionId = pc.localConnId;
        this.peerConnection = pc;
    }

    public getConnectPromise(): Promise<PeerConnection> {
        return this.connectPromise;
    }

    public getPeerConnection(): PeerConnection {
        const pc = this.peerConnection;
        if (!pc) {
            throw new Error("setup is not called");
        }
        return pc;
    }

    public toString(): string {
        const name = this.constructor.name;
        return [
            `<${name} msgId=${this.msgId}`,
            `srcNodeId=${quote(this.srcNodeId)}`,
            `src=${this.source}`,
            `dest=${this.destination}`,
            `connSpec=${prettyPrint(this.connectSpec)}`,
            `connKey=${quote(this.connectKey)}`,
            `connPCID=${this.connectPeerConnectionId}>`,
        ].join(", ");
    }
}

@serializable
export class ConnectionReply extends ReplyMessage<
    ConnectionRequest,
    ConnectionReply
> {
    public readonly acceptPeerConnectionId?: number;
    public readonly acceptKey?: string;
    public readonly acceptSpec: NodeSpec;
    public readonly type: ConnectType;
    public readonly sdp?: string;
    public readonly rejectReason?: string; // used when type == ConnectType.REJECT
    // all paths that the accept node has
    public readonly acceptNodePaths?: Path[];

    constructor(
        manager: Manager,
        creq: ConnectionRequest,
        type: ConnectType.REJECT,
        pc: undefined,
        paths: undefined,
        sdp: undefined,
        rejectReason: string
    );

    constructor(
        manager: Manager,
        creq: ConnectionRequest,
        type: ConnectType.WEBRTC,
        pc: PeerConnection,
        paths: Path[],
        sdp: string
    );

    constructor(
        manager: Manager,
        creq: ConnectionRequest,
        type: ConnectType.FROM_YOU | ConnectType.RELAY | ConnectType.USE_THIS,
        pc: PeerConnection,
        paths: Path[],
        sdp: undefined
    );
    /**
     * constructor
     *
     * @param manager
     * @param creq
     * @param type
     * @param pc   PeerConnection or null when rejected
     * @param paths
     * @param sdp
     * @param rejectReason?
     */
    constructor(
        manager: Manager,
        creq: ConnectionRequest,
        type: ConnectType,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pc: PeerConnection | undefined,
        paths: Path[] | undefined,
        sdp: string | undefined,
        rejectReason?: string
    ) {
        super(creq);
        this.acceptPeerConnectionId = pc ? pc.localConnId : undefined;
        this.acceptKey = pc ? pc.getLocalKey() : undefined;
        this.sdp = sdp;
        this.acceptSpec = manager.getNodeSpec();
        this.type = type;
        this.acceptNodePaths = paths;
        this.rejectReason = rejectReason;
    }

    public getSpec(): MessageSpec {
        return {
            noSequence: true,
            noAck: true,
        };
    }

    public toString(): string {
        const name = this.constructor.name;
        return [
            `<${name} reqId=${this.reqMsgId}`,
            `srcNodeId=${this.srcNodeId}`,
            `dstNodeId=${this.destNodeId}`,
            `src=${this.source}`,
            `dst=${this.destination}`,
            `accSpec=${prettyPrint(this.acceptSpec)}`,
            `accKey="${this.acceptKey}"`,
            `accPCID=${this.acceptPeerConnectionId}`,
            `type=${ConnectType[this.type]}`,
            `sdp=${this.sdp ? "<SDP>" : "<empty>"}`,
            `accNodePaths=${prettyPrint(this.acceptNodePaths)}`,
            `rejectReason=${this.rejectReason}>`,
        ].join(", ");
    }
}

/**
 * destinationで指定された経路で転送され，最後のノードでacceptする
 */
@serializable
export class PathCReq extends ConnectionRequest {
    public onReceive(): void {
        this.accept("PathCReq.accept").catch(() => {
            /* empty */
        });
    }
}

/**
 * A message used to inform this PeerConnection is closed
 */
@serializable
export class ClosePeerConnection extends Message {
    constructor(
        manager: Manager,
        public errorConnectionId: number,
        public reason?: string
    ) {
        super(manager);
    }
    public onReceive(): void {
        const manager = this.manager;
        const pc = this.peerConnection;
        if (pc) {
            manager.mgrLogger.debug(
                "ClosePeerConnection.onReceive: reason=%s: %s",
                this.reason,
                pc
            );
            if (
                this.srcNodeId !== pc.getRemoteNodeId() ||
                this.errorConnectionId !== pc.remoteConnId
            ) {
                manager.mgrLogger.warn(
                    "ClosePeerConnection: wrong connection!: ClosePeerConnection is sent from %s (expect %s), errorPCID=%s (expect %s)",
                    this.srcNodeId,
                    pc.getRemoteNodeId,
                    this.errorConnectionId,
                    pc.remoteConnId
                );
            } else {
                pc.remoteClose();
            }
        } else {
            manager.mgrLogger.warn(
                "ClosePeerConnection.onReceive: reason=%s, no PeerConnection (PCID=%s)",
                this.reason,
                this.destination?.connId
            );
        }
    }
}

/**
 * A message used for probing a relayed path.
 */
@serializable
export class ProbePath extends RequestMessage<ProbePath, ProbePathReply> {
    public targetPeerConnectionId: number;

    constructor(manager: Manager, srcPc: PeerConnection) {
        super(manager);
        if (srcPc.remoteConnId) {
            this.targetPeerConnectionId = srcPc.remoteConnId;
        } else {
            throw new Error("should not happen");
        }
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: ProbePathReply.name,
        };
    }

    public toString(): string {
        return `<ProbePath srcNodeId=${this.srcNodeId}, dest=${this.destination}>`;
    }

    public onReceive(): void {
        const manager = this.manager;
        const pc = this.manager.getPeerConnection(this.targetPeerConnectionId);
        if (!pc) {
            manager.mgrLogger.debug("ProbePath.onReceive: no PeerConnection");
            return;
        }
        if (!this.source) {
            throw new Error("no this.source");
        }
        const path = new Path(
            this.source.optimize().asArray(),
            pc.remoteConnId
        );
        if (pc.isConnected()) {
            pc.addPath(path);
            manager.mgrLogger.debug(
                "ProbePath.onReceive: added %s: %s",
                path,
                pc
            );
        } else {
            pc.established(path);
            manager.mgrLogger.debug("ProbePath.onReceive: established: %s", pc);
        }
        const msg = new ProbePathReply(manager, this);
        this.sendReply(msg);
    }
}

@serializable
export class ProbePathReply extends ReplyMessage<ProbePath, ProbePathReply> {
    constructor(manager: Manager, req: ProbePath) {
        super(req);
    }

    public toString(): string {
        return `<ProbePathReply srcNodeId=${this.srcNodeId}, dest=${this.destination}>`;
    }
}

/**
 * A message used for obtaining all paths.
 */
@serializable
export class GetNeighbors extends RequestMessage<
    GetNeighbors,
    GetNeighborsReply
> {
    constructor(manager: Manager) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        // XXX: THINK!
        return {
            replyClassName: GetNeighborsReply.name,
            noAck: true,
        };
    }

    public onReceive(): void {
        const manager = this.manager;
        const paths = manager.getAllPaths();
        const reply = new GetNeighborsReply(manager, this, paths);
        this.sendReply(reply);
    }
}

@serializable
export class GetNeighborsReply extends ReplyMessage<
    GetNeighbors,
    GetNeighborsReply
> {
    constructor(manager: Manager, req: GetNeighbors, public paths: Path[]) {
        super(req);
    }
}

@serializable
export class GracefulCloseRawConnection extends Message {
    constructor(manager: Manager) {
        super(manager);
    }
    public getSpec(): MessageSpec {
        return {
            noAck: true,
        };
    }
    protected onReceive(): void {
        if (this.rawConnection) {
            this.rawConnection.handleGracefulClose();
        } else {
            this.manager.rawLogger.error(
                "GracefulClose is received but no this.rawConnection"
            );
        }
    }
}
