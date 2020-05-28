/**
 * An implementation of ring-based overlay network.
 *
 * This implementation uses DDLL algorithm for maintaining distributed doubly linked lists.
 *
 * @author Kota Abe and Li Jiaoke
 */

import {
    Callbacks,
    CircularSpace,
    Cleanable,
    Cleaner,
    Deferred,
    DisconnectedError,
    Gaps,
    Logger,
    Manager,
    Message,
    PeerConnection,
    RawConnectionType,
    RejectionError,
    ReplyMessage,
    ReplyTimeoutError,
    RequestMessage,
    RetriableError,
    serializable,
    SerializeUtils,
    StreamingReplyHandler,
    TraceLog,
} from "@web-overlay/manager";
import {
    ForwardToPredecessor,
    GetRight,
    JoinLeftCReq,
    JoinRightCReq,
    KeyBasedCReq,
    Ping,
    SetL,
    SetRJoin,
    SetRLeave,
    SetRLeaveReply,
    Unicast,
} from "./ddll-messages";
import { MulticastReply, MulticastRequest, RQRequest } from "./ddll-multicast";

// DDLL node status
export enum Status {
    OUT,
    INS,
    IN,
    DEL,
}

/*
 * RepairStatus transition chart
 *
 * WAIT_PERIOD ←--------------+
 *     | timeout/send ping    |
 *     ↓                      | recv Pong
 *  WAIT_PONG ----------------+
 *     | timeout/connect with RepairCReq
 *     ↓
 *  WAIT_CONNECT -----error----> WAIT_CONNECT
 *     | connect/send GetRight
 *     ↓
 *  WAIT_RIGHTREPLY ---error---> WAIT_CONNECT
 *     | recv GetRightReply/send SetRJoin
 *     ↓
 *  WAIT_ACK ---------error----> WAIT_CONNECT
 *     | recv SetRAck
 *     ↓
 *  WAIT_PERIOD
 */
export enum RepairStatus {
    /* 次のping送信を待っている状態 */
    WAIT_PERIOD,
    /* pingを送信してpong受信を待っている状態 */
    WAIT_PONG,
    /* connectを実行した後コネクション確立を待っている状態 */
    WAIT_CONNECT,
    /* GetRight送信の後，GetRightReply応答を待っている状態 */
    WAIT_RIGHTREPLY,
    /* RightInfoを受信し，SetRJoinを送信した状態 */
    WAIT_ACK,
}
/**
 * DDLL's link sequence number.
 * this class is immutable.
 */
@serializable
export class LinkSeq {
    // recovery sequence number
    private readonly recoveryNumber: number;
    // sequence number
    private readonly sequenceNumber: number;

    constructor(recoveryNumber: number, sequenceNumber: number) {
        this.recoveryNumber = recoveryNumber;
        this.sequenceNumber = sequenceNumber;
    }

    public nextFix(): LinkSeq {
        return new LinkSeq(this.recoveryNumber + 1, 0);
    }

    public next(): LinkSeq {
        return new LinkSeq(this.recoveryNumber, this.sequenceNumber + 1);
    }

    public compareTo(o: LinkSeq): number {
        if (this.recoveryNumber < o.recoveryNumber) {
            return -1;
        }
        if (this.recoveryNumber > o.recoveryNumber) {
            return 1;
        }
        if (this.sequenceNumber < o.sequenceNumber) {
            return -1;
        }
        if (this.sequenceNumber > o.sequenceNumber) {
            return 1;
        }
        return 0;
    }

    public toString(): string {
        return `(${this.recoveryNumber}, ${this.sequenceNumber})`;
    }
}

export const DdllRejectReasons = {
    // == ManagerRejectReasons.CONSTRAINT
    CONSTRAINT: "CONSTRAINT CANNOT BE SATISFIED",
    DUPLICATED_KEY: "DUPLICATED_KEY",
    NO_EXACT_KEY: "NO_EXACT_KEY_MATCH",
    AVOID_SINGLETON: "SINGLETON",
};

/****************************************************************
 * DdllNode
 ****************************************************************/

export class DdllNode implements Cleanable {
    public static readonly DDLL_LOG_NAMESPACE = "web:ddll";
    public static readonly RECOVERY_RETRY_PERIOD = 1000;
    public static readonly PING_TIMER_NAME = "DdllNode.pingTimer";

    // must be consistent with DdllMessage interface
    public static readonly DdllName = "ddll";

    // number of retries of join and leave
    public static readonly NUMBER_OF_RETRY = 10;
    public static PING_PERIOD = 5 * 1000;

    public readonly manager: Manager;
    public readonly logger: Logger;
    public readonly self: PeerConnection; // loopback connection
    private _joinTime?: number;

    // variables for DDLL algorithm
    public readonly key: string;
    private _right?: PeerConnection;
    private _left?: PeerConnection;
    public lseq = new LinkSeq(0, 0);
    public rseq = this.lseq;
    private _status = Status.OUT;

    public leaveDefer?: Deferred<void>;
    private _repairStatus = RepairStatus.WAIT_PERIOD;
    private repairPromise: Promise<void> | null = null;
    protected destroyed = false;
    public cleaner: Cleaner;

    private statusChangeListeners = new Callbacks<Status>();
    private rightNodeChangeListeners = new Callbacks<PeerConnection>();
    private leftNodeChangeListeners = new Callbacks<PeerConnection>();

    // a successor list.
    // pSuccessors = [successor, successor's successor, ...]
    // pSuccessors[NREPLICA]: the max key of the replica that this node stores.
    // XXX: should be moved to pstore.ts
    protected pSuccessors: string[] = [];

    /**
     * create a DDLL node instance.
     *
     * @param key  the key of the node
     * @param manager WebRTC-Manager
     */
    constructor(key: string, manager: Manager) {
        this.logger = manager.createLogger(DdllNode.DDLL_LOG_NAMESPACE, key);
        this.cleaner = new Cleaner(this.logger);
        this.key = key;
        this.manager = manager;
        manager.cleaner.addChild(this);
        this.self = this.manager.connectLoopback(key);
        this.manager.registerApp(this.key, DdllNode.DdllName, this);
        this.cleaner.push(() => {
            this.self.close();
            this.manager.unregisterApp(this.key, DdllNode.DdllName);
            this.logger.destroy();
        });
    }

    public static getInsertedDdllNodes(manager: Manager): DdllNode[] {
        return manager
            .getApps<DdllNode>(DdllNode.DdllName)
            .filter((n) => n.isJoined());
    }

    public static getDdllNode(
        manager: Manager,
        key: string
    ): DdllNode | undefined {
        return manager.getApp(key, DdllNode.DdllName);
    }

    public get left(): PeerConnection | undefined {
        return this._left;
    }

    public set left(pc: PeerConnection | undefined) {
        if (pc === undefined) {
            throw new Error("pc should not be undefined");
        }
        this._left = pc;
        this.leftNodeChangeListeners.invoke(pc);
    }

    public get right(): PeerConnection | undefined {
        return this._right;
    }

    public set right(pc: PeerConnection | undefined) {
        if (pc === undefined) {
            throw new Error("pc should not be undefined");
        }
        this._right = pc;
        this.rightNodeChangeListeners.invoke(pc);
    }

    public get joinTime(): number | undefined {
        return this._joinTime;
    }

    public initInitialNode(): Promise<void> {
        this.logger.debug("DdllNode.initInitialNode");
        if (this.status !== Status.OUT) {
            throw new Error(
                "ddll.initInitialNode: status is not OUT (" +
                    Status[this.status] +
                    ")"
            );
        }
        this.rseq = this.lseq = new LinkSeq(0, 0);
        // establish left and right connections for myself
        this.logger.debug("this.key: " + this.key);
        const url = this.manager.getNodeSpec().serverUrl;
        if (!url) {
            throw new Error("initInitialNode: the node has no URL");
        }
        // this.left と this.right に同じ PeerConnection のインスタンスを代入している．
        // ノードがSetRJoinメッセージを受信したときに this.rightをcloseしないため，this.leftが切断される心配は無用．
        const pc = this.manager.connectLoopback(this.key);
        this.left = pc;
        this.right = pc;
        this.status = Status.IN;
        this.pSuccessors.push(this.getKey());
        this.initAfterJoin();
        this._joinTime = Date.now();
        return Promise.resolve();
    }

    /**
     * subclass may override this method
     */
    protected initAfterJoin(): void {
        this.schedulePing();
    }

    public async join(url?: string): Promise<void> {
        if (this.destroyed) {
            throw new Error("already destroyed");
        }
        let lastError: Error | undefined;
        for (let i = 0; i < DdllNode.NUMBER_OF_RETRY; i++) {
            if (i !== 0) {
                this.logger.info("join: retry: %d", i);
            }
            try {
                return await this.join0(url);
            } catch (err) {
                lastError = err;
                if (!(err instanceof RetriableError)) {
                    this.logger.warn("join: got non-retriable error: %s", err);
                    throw err;
                }
                // retry after some random time
                if (i !== DdllNode.NUMBER_OF_RETRY) {
                    await this.exponentialDelay(i);
                }
            }
        }
        throw lastError;
    }

    private async join0(url?: string): Promise<void> {
        this.logger.info("join0: key=%s", this.key);
        if (this.status !== Status.OUT) {
            throw new Error(
                "join0: status is not OUT (" + Status[this.status] + ")"
            );
        }
        const introducer = url || this.self;
        this.rseq = this.lseq = new LinkSeq(0, 0);
        try {
            await this.join1(introducer, false);
            this._joinTime = Date.now();
            return;
        } catch (err) {
            this.logger.info("join0: join1 failed: %s", err);
            this.status = Status.OUT;
            throw err;
        }
    }

    private async repair(trigger: string): Promise<void> {
        if (this.repairPromise) {
            this.logger.debug("repair: already repairing!");
            return this.repairPromise;
        }
        const beforeLeft = this.left;
        const beforeRight = this.right;
        this.logger.info(
            'repair: recovery start, triggered by "%s", current state=%s',
            trigger,
            this
        );
        let introducer = this.self;
        const defer = new Deferred<void>();
        this.repairPromise = defer.promise;
        // a portal node can be singleton
        let allowSingleton = !!this.manager.getNodeSpec().serverUrl;
        const start = Date.now();
        let attempts = 0;
        const loop = true;
        while (loop) {
            this.logger.debug(
                "repair: try to rejoin, introducer=%s, allowSingleton=%s",
                introducer,
                allowSingleton
            );
            try {
                attempts++;
                await this.join1(introducer, true, allowSingleton);
                this.safeClose(introducer);
                this.repairPromise = null;
                defer.resolve();
                let leftText, rightText;
                if (this.left?.getRemoteKey() === beforeLeft?.getRemoteKey()) {
                    leftText = `left key is not changed (${this.left?.getRemoteKey()})`;
                } else {
                    leftText = `left key is changed: ${beforeLeft?.getRemoteKey()} -> ${this.left?.getRemoteKey()}`;
                }
                if (
                    this.right?.getRemoteKey() === beforeRight?.getRemoteKey()
                ) {
                    rightText = `right key is not changed (${this.right?.getRemoteKey()})`;
                } else {
                    rightText = `right key is changed: ${beforeRight?.getRemoteKey()} -> ${this.right?.getRemoteKey()}`;
                }
                this.logger.info(
                    'repair: RECOVERY COMPLETED: after %d attempt(s), took %d msec, %s, %s, %s (triggered by "%s")',
                    attempts,
                    Date.now() - start,
                    leftText,
                    rightText,
                    this,
                    trigger
                );
                return;
            } catch (err) {
                this.safeClose(introducer);
                if (
                    err instanceof RejectionError &&
                    err.message === DdllRejectReasons.AVOID_SINGLETON
                ) {
                    this.logger.info(
                        "repair: alone? recover with stock portals"
                    );
                    try {
                        introducer = await this.manager.connectAnyPortal();
                        this.logger.debug("repair: retry with %s", introducer);
                    } catch (err) {
                        this.logger.info(
                            "repair: no portal node! permit singleton and retry!"
                        );
                        allowSingleton = true;
                        introducer = this.self;
                    }
                } else {
                    this.logger.debug("repair: failed. retry later");
                    introducer = this.self;
                    await this.cleaner.delay(
                        this.manager,
                        DdllNode.RECOVERY_RETRY_PERIOD
                    );
                }
            }
        }
    }

    private async join1(
        introducer: PeerConnection | string,
        isRepair: boolean,
        allowSingleton = false
    ): Promise<void> {
        const { debug, info, newEvent } = this.logger.getTraceLogger("join1");
        if (isRepair) {
            this.repairStatus = RepairStatus.WAIT_CONNECT;
        } else {
            this.status = Status.INS;
        }
        const joinLeft = new JoinLeftCReq(
            this.manager,
            this.key,
            isRepair,
            allowSingleton
        );
        let pLeft: PeerConnection;
        try {
            const container = new ForwardToPredecessor(
                this.manager,
                this.key,
                joinLeft
            );
            debug(
                "send ForwardToPredecessor and wait for connection, joinLeft=%s",
                joinLeft
            );
            pLeft = await joinLeft.connect(introducer, container);
            this.cleaner.addChild(pLeft);
        } catch (err) {
            info("joinLeft.connect failed: %s", err);
            joinLeft.destroy();
            if (
                err instanceof ReplyTimeoutError ||
                err instanceof DisconnectedError
            ) {
                throw new RetriableError(err.message);
            }
            throw err;
        }
        newEvent("left connection is established: %s", pLeft);
        let rightKeyOfLeftNode: string;
        let needRightConnection = false;
        let needSetL = false;
        if (!isRepair) {
            needSetL = needRightConnection = true;
            rightKeyOfLeftNode = "dummy"; // to eliminate invalid warning
        } else {
            // repair case
            if (pLeft.getRemoteKey() === this.getKey()) {
                info("join complete: I'm singleton!");
                this.safeClose(this.left);
                this.safeClose(this.right);
                this.safeClose(pLeft);
                this.left = this.manager.connectLoopback(this.key);
                this.right = this.left;
                this.lseq = this.lseq.nextFix();
                this.rseq = this.lseq;
                this.monitorLeftLink();
                this.schedulePing();
                return;
            }
            this.repairStatus = RepairStatus.WAIT_RIGHTREPLY;
            try {
                debug("send GetRight");
                const req = new GetRight(this.manager);
                rightKeyOfLeftNode = (await req.request(pLeft)).key;
            } catch (err) {
                info("reply for GetRight (outer): %s", err);
                this.safeClose(pLeft);
                throw err;
            }
            newEvent('got right: "%s"', rightKeyOfLeftNode);
            // Case 1:
            // LEFT ----------------> RIGHT1
            //      FIXING_NODE -----------> RIGHT2
            // Case 1':
            // LEFT ----------------> RIGHT1
            //      FIXING_NODE ----> RIGHT2
            // Case 2:
            // LEFT --------------------------> RIGHT1
            //      FIXING_NODE ----> RIGHT2
            // Case 3 (RIGHT1 failure case)
            // LEFT ----> RIGHT1
            //                   FIXING_NODE ----> RIGHT2
            //
            // connect to RIGHT1 only in case 1.
            // but send SetL both in cases 1 and 1'.
            debug(
                "join for repair: left's right=%s, current my right=%s",
                rightKeyOfLeftNode,
                this.right?.getRemoteKey()
            );
            if (
                CircularSpace.isOrdered(
                    this.getKey() /* FIXING_NODE */,
                    false,
                    rightKeyOfLeftNode /* RIGHT1 */,
                    this.right!.getRemoteKey() /* RIGHT2 */,
                    true
                )
            ) {
                needSetL = needRightConnection = true;
            }
        }
        let pRight: PeerConnection | undefined;
        if (needRightConnection) {
            try {
                debug("send JoinRightCReq");
                pRight = await new JoinRightCReq(
                    this.manager,
                    this.key
                ).connect(pLeft);
                this.cleaner.addChild(pRight);
            } catch (err) {
                this.safeClose(pLeft);
                throw err;
            }
            newEvent("right connection is established: %s", pRight);
            rightKeyOfLeftNode = pRight.getRemoteKey();
        }

        debug(
            "left=%s, left's right=%s",
            pLeft.getRemoteKey(),
            rightKeyOfLeftNode
        );
        if (
            isRepair /* NOTE! */ ||
            pLeft.getRemoteKey() === rightKeyOfLeftNode ||
            CircularSpace.isOrdered(
                pLeft.getRemoteKey(),
                false,
                this.getKey(),
                rightKeyOfLeftNode,
                false
            )
        ) {
            this.safeClose(this.left);
            this.left = pLeft;
            if (pRight) {
                this.safeClose(this.right);
                this.right = pRight;
            }

            // perform a job such as copying replicas
            debug("wait for prepareForJoin");
            await this.prepareForJoin(isRepair);

            if (isRepair) {
                this.lseq = this.lseq.nextFix();
                this.repairStatus = RepairStatus.WAIT_ACK;
            } else {
                this.status = Status.INS;
            }
            try {
                return await this.sendSetRJoin(
                    rightKeyOfLeftNode,
                    needSetL,
                    debug,
                    info
                );
            } catch (err) {
                if (!isRepair) {
                    this.status = Status.OUT;
                }
                throw err;
            }
        } else {
            // N0, N30の間にN10, N20が並行して挿入する場合を考える．
            // N10が先に挿入された場合，N20の右コネクションはN10からJoinRightCReqによってN20に転送され，
            // N30の右コネクションがN20になる場合がある．この場合はjoin失敗とする．
            info("connected in wrong position");
            this.safeClose(pLeft);
            this.safeClose(pRight);
            throw new RetriableError("connected in wrong position");
        }
    }

    private async sendSetRJoin(
        rightKeyOfLeftNode: string,
        needSetL: boolean,
        debug: TraceLog,
        info: TraceLog
    ): Promise<void> {
        debug("send SetRJoin");
        const req = new SetRJoin(this.manager, rightKeyOfLeftNode, this.lseq);
        /*
         * We have to use requestAndHandle() (rather than request()) here because we have to process
         * SetRJoinReply message before processing subsequent ForwardToPredecessor message.
         * Promise does not preserve execution order.
         */
        return req.requestAndHandle(
            this.left!,
            undefined,
            (reply) => {
                switch (reply.type) {
                    case "ack":
                        this.status = Status.IN;
                        if (needSetL) {
                            if (!reply.rnewseq) {
                                throw new Error("no reply.rnewseq");
                            }
                            this.rseq = reply.rnewseq;
                            this.right!.send(new SetL(this.manager, this.rseq));
                        }
                        this.pSuccessors.push(this.getKey());
                        this.initAfterJoin();
                        this.monitorLeftLink();
                        info(
                            "join complete: %s, left=%s, right=%s",
                            this,
                            this.left,
                            this.right
                        );
                        return;
                    case "nak":
                        info("join failed: SetRNak received");
                        throw new RetriableError("SetRNak");
                    default:
                        throw new Error("SetRJoinReply: unknown type");
                }
            },
            (err) => {
                throw new RetriableError(err.message);
            }
        );
    }

    /**
     * subclass may override this method.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected async prepareForJoin(isRepair: boolean): Promise<void> {
        return;
    }

    public async leave(): Promise<void> {
        for (let i = 0; i < DdllNode.NUMBER_OF_RETRY; i++) {
            if (i !== 0) {
                this.logger.info("leave: retry: %d", i);
            }
            try {
                await this.leave0();
                this.logger.debug("leave: finished");
                return;
            } catch (err) {
                this.logger.debug("leave: got %s", err);
                if (!(err instanceof RetriableError)) {
                    this.logger.info(
                        "leave: got non-retriable error, treated as success."
                    );
                    this.destroy();
                    return;
                }
                if (i < DdllNode.NUMBER_OF_RETRY - 1) {
                    await this.exponentialDelay(i);
                }
            }
        }
        this.destroy();
    }

    private async leave0(): Promise<void> {
        this.logger.debug("leave0");
        if (this.status !== Status.IN) {
            throw new Error(
                "leave: status is not IN (" + Status[this.status] + ")"
            );
        }
        if (this.repairPromise) {
            this.logger.info("leave0: wait for repair completion");
            const MAX_RECOVERY_WAIT_TIME = 10000;
            const timeout = new Promise((resolve, _) =>
                setTimeout(() => resolve("timeout"), MAX_RECOVERY_WAIT_TIME)
            );
            try {
                const result = await Promise.race([
                    this.repairPromise,
                    timeout,
                ]);
                if (result === "timeout") {
                    throw new Error("timeout");
                }
            } catch (err) {
                this.logger.info("leave0: repair failed: %s", err);
                throw new Error("left link is broken and repair failed");
            }
        }
        if (this.key === this.right!.getRemoteKey()) {
            // last node case
            this.destroy();
            return;
        }
        this.status = Status.DEL;
        // this defer is rejected if we receive a SetL message
        this.leaveDefer = new Deferred<void>();
        const req = new SetRLeave(
            this.manager,
            this.key,
            this.rseq.next(),
            this.right!.getRemoteKey()
        );
        // eslint-disable-next-line no-useless-catch
        let reply: SetRLeaveReply | void;
        try {
            reply = await Promise.race([
                req.request(this.left!),
                this.leaveDefer.promise,
            ]);
        } catch (err) {
            this.logger.debug("leave0: got %s", err);
            throw err;
        } finally {
            this.leaveDefer.resolve();
            this.leaveDefer = undefined;
        }
        this.logger.debug("leave0: got %s", reply);
        if (!(reply instanceof SetRLeaveReply)) {
            throw new Error("leave0: wrong result (should not happen");
        }
        switch (reply.type) {
            case "ack":
                this.destroy();
                break;
            case "nak":
                this.status = Status.IN;
                this.logger.info("leave0: received SetRNak");
                throw new RetriableError("SetRNak");
            default:
                throw new Error("leave0: unknown type");
        }
    }

    /**
     * destroy this instance without executing the leaving procedure
     */
    public destroy(): void {
        this.logger.debug("destroy() starts");
        this.status = Status.OUT;
        if (this.leaveDefer) {
            this.leaveDefer.resolve();
        }
        this.cleaner.clean();
        this.destroyed = true;
        this.logger.debug("destroy() ends");
    }

    public getKey(): string {
        return this.key;
    }

    public isResponsible(target: string): boolean {
        return CircularSpace.isOrdered(
            this.key,
            true,
            target,
            this.right!.getRemoteKey(),
            false
        );
    }

    public safeClose(pc?: PeerConnection): void {
        if (pc && pc !== this.self) {
            pc.close();
        }
    }

    /**
     * @returns {PeerConnection[]}
     */
    public getValidPeerConnections(): PeerConnection[] {
        if (!this.isJoined()) {
            return [];
        }
        return [this.left, this.self, this.right].filter((pc, index, self) => {
            return pc && pc.isConnected() && self.indexOf(pc) === index;
        }) as PeerConnection[];
    }

    /**
     *
     * @param {Manager} manager
     * @param {string} key
     * @param {boolean} allowEquals if true, a DdllNode whose key is the same
     *     to KEY is treated as the closest one.
     * @return PeerConnection
     */
    public static getClosestPrecedingConnection(
        manager: Manager,
        key: string,
        allowEquals = true
    ): PeerConnection | undefined {
        const logger = this.getLogger(manager);
        logger.debug(
            "getClosestPredecessorConnection: %s",
            manager.getApps<DdllNode>(DdllNode.DdllName)
        );

        const nodes = DdllNode.getInsertedDdllNodes(manager);
        if (nodes.length > 0) {
            const pcs = nodes.map((n) =>
                n.getClosestPrecedingConnection(key, allowEquals)
            );
            // log.debug("pcs=%s", pcs);
            const sorted = CircularSpace.sortCircular(
                key,
                pcs,
                (ent) => ent.getRemoteKey(),
                allowEquals
            );
            logger.debug("sorted=%s", sorted);
            return sorted[sorted.length - 1]; // returns undefined if sorted is empty
        }
        logger.warn("getClosestPrecedingConnection: no inserted DdllNode!");
        return undefined;
    }

    /**
     * keyと等しいか，keyの左側で最もkeyに近いノードへのコネクションを返す．
     * @param key
     * @param allowEquals
     * @returns {PeerConnection}
     */
    public getClosestPrecedingConnection(
        key: string,
        allowEquals = true
    ): PeerConnection {
        const valids = this.getValidPeerConnections();
        const sorted = CircularSpace.sortCircular(
            key,
            valids,
            (n) => n.getRemoteKey(),
            allowEquals
        );
        // this.logger.debug("getClosestPredecessorConnection: sorted=%s", sorted);
        // this.logger.log("valids=", valids);
        // key=20 -> sorted = [20, 10, 0, 30] (if allowEquals)
        // key=20 -> sorted = [10, 0, 30, 20] (if not allowEquals)
        sorted.reverse();
        // this.logger.log("sorted.reversed=", sorted);
        // ... N2 ... N1 ... key
        const node = sorted.find(
            (n) =>
                n.isConnected() &&
                !this.manager.isSuspiciousNode(n.getRemoteNodeId())
        );
        if (node) {
            this.logger.debug(
                "getClosestPrecedingConnection: return: %s",
                node
            );
            return node;
        }
        throw new Error("getClosestPrecedingConnection: no valid ent!");
    }

    public addRightNodeChangeListener(cb: (pc: PeerConnection) => void): void {
        this.rightNodeChangeListeners.addCallback(cb);
    }

    public addLeftNodeChangeListener(cb: (pc: PeerConnection) => void): void {
        this.leftNodeChangeListeners.addCallback(cb);
    }

    /**
     * send a message to a specified node.
     * the receiving node satisfies (destKey ∈ [localKey, rightKey)).
     *
     * @param destKey
     * @param msg
     */
    public unicast(destKey: string, msg: Message): void {
        if (!SerializeUtils.isSerializable(msg)) {
            throw new Error("message is not @serializable");
        }
        msg.piggybacked();
        this.logger.debug("unicast: payload=%s", msg);
        this.self.send(new Unicast(this.manager, destKey, msg));
    }

    public async unicastRequest<
        T extends RequestMessage<T, U>,
        U extends ReplyMessage<T, U>
    >(destKey: string, msg: RequestMessage<T, U>): Promise<U> {
        if (!SerializeUtils.isSerializable(msg)) {
            throw new Error("message is not @serializable");
        }
        this.logger.debug("unicastRequest: payload=%s", msg);
        const MAX_ITER = 10;
        let lastError;
        for (let i = 0; i < MAX_ITER; i++) {
            this.logger.debug("unicastRequest: iteration %d", i);
            msg.piggybacked();
            try {
                const req = new Unicast(this.manager, destKey, msg);
                return await msg.request(this.self, req);
            } catch (err) {
                this.logger.debug("unicastRequest: got %s", err);
                lastError = err;
                if (
                    !(
                        err instanceof ReplyTimeoutError ||
                        err instanceof DisconnectedError
                    )
                ) {
                    throw err;
                }
            }
        }
        throw lastError;
    }

    /**
     * multicast a message in the range of [minKey, maxKey)
     *
     * @param {string} minKey
     * @param {string} maxKey
     * @param {Message} payload
     */
    public multicast<
        T extends MulticastRequest<T, U>,
        U extends MulticastReply<T, U>
    >(minKey: string, maxKey: string, payload: MulticastRequest<T, U>): void {
        if (!SerializeUtils.isSerializable(payload)) {
            throw new Error("message is not @serializable");
        }
        this.logger.debug(
            "start multicast(minKey=%s, maxKey=%s)",
            minKey,
            maxKey
        );
        payload.piggybacked();
        payload.from = minKey;
        payload.to = maxKey;
        payload.gaps = new Gaps(minKey, maxKey);
        this.multicast0(minKey, maxKey, payload);
    }

    private multicast0<
        T extends MulticastRequest<T, U>,
        U extends MulticastReply<T, U>
    >(minKey: string, maxKey: string, payload: MulticastRequest<T, U>): void {
        const userHandler:
            | StreamingReplyHandler<U>
            | undefined = payload._onReply as StreamingReplyHandler<U>;
        if (!userHandler) {
            throw new Error(
                `${payload.constructor.name}.onReply has not been called`
            );
        }

        const copy = SerializeUtils.clone(payload);
        copy.afterRestore(this.manager);
        copy.gaps = payload.gaps; // !!!
        copy.onReply((reply) => {
            this.logger.debug("multicast0: got %s for %s", reply, req);
            if (
                reply instanceof ReplyTimeoutError ||
                reply instanceof DisconnectedError
            ) {
                req.getIncompleteReplyRanges().forEach((range) => {
                    this.logger.debug("retransmit %s", range);
                    payload.numberOfRetransmission++;
                    this.multicast0(range.from, range.to, payload);
                });
            } else {
                userHandler(reply);
            }
        });
        const req = new RQRequest(this, minKey, maxKey, copy);
        this.logger.debug("multicast0: req=%s", req);
        req.startMulticast(this);
    }

    /**
     * Establish a PeerConnection with a node that is specified by a key.
     *
     * @param {string} destKey
     * @param {{exactKey?: boolean, webrtcOnly?: boolean}} constraint
     * @return {Promise<PeerConnection>}
     */
    public connect(
        destKey: string,
        constraint: {
            exactKey?: boolean;
            webrtcOnly?: boolean;
        }
    ): Promise<PeerConnection> {
        if (constraint.webrtcOnly && !this.manager.getNodeSpec().webrtc) {
            throw new RejectionError(DdllRejectReasons.CONSTRAINT);
        }
        const msg = new KeyBasedCReq(
            this.manager,
            this.getKey(),
            destKey,
            constraint
        );
        this.self.send(msg);
        return msg.getConnectPromise().then((pc) => {
            if (
                constraint.webrtcOnly &&
                pc.getConnectionType() !== RawConnectionType.WebRTC
            ) {
                this.safeClose(pc);
                throw new Error("NOT_WEBRTC_CONNECTION");
            }
            return pc;
        });
    }

    public toString(): string {
        const lkey = this.left ? this.left.getRemoteKey() : "undef";
        const rkey = this.right ? this.right.getRemoteKey() : "undef";
        return (
            `[DdllNode key="${this.key}", ${
                Status[this._status]
            }, lkey="${lkey}", rkey="${rkey}"` +
            `, lseq=${this.lseq}, rseq=${this.rseq}, ${
                RepairStatus[this.repairStatus]
            }]`
        );
    }

    public get status(): Status {
        return this._status;
    }

    public set status(s: Status) {
        if (this._status !== s) {
            this._status = s;
            this.logger.debug("status is changed to %s", Status[s]);
            this.statusChangeListeners.invoke(s);
        }
    }

    public isJoined(): boolean {
        return this.status === Status.IN || this.status === Status.DEL;
    }

    public addStatusChangeListener(cb: (_: Status) => void): void {
        this.statusChangeListeners.addCallback(cb);
    }

    /*
     * Repair the ring
     */

    public get repairStatus(): RepairStatus {
        return this._repairStatus;
    }

    public set repairStatus(s: RepairStatus) {
        this._repairStatus = s;
        this.logger.debug("RepairStatus is changed to %s", RepairStatus[s]);
    }

    /*
     * setup onDisconnect handler for the current left link.
     * when the left link is disconnected, repair immediately.
     */
    public monitorLeftLink(): void {
        const leftLink = this.left;
        this.left!.onDisconnect(() => {
            if (!this.isJoined()) {
                return;
            }
            if (this.left !== leftLink) {
                this.logger.debug(
                    "monitorLeftLink: disconnected stale left link: " + leftLink
                );
                return;
            }
            this.logger.info(
                "monitorLeftLink: left link disconnected: %s, %s",
                this.left,
                this
            );
            this.repair("left link disconnect").catch(() => {
                /* empty */
            });
        });
    }

    public schedulePing(): void {
        this.repairStatus = RepairStatus.WAIT_PERIOD;
        this.cleaner.startTimer(
            this.manager,
            DdllNode.PING_TIMER_NAME,
            DdllNode.PING_PERIOD,
            () => {
                this.sendPingAndRepair().catch(() => {
                    /* empty */
                });
            }
        );
    }

    // public for testing
    public async sendPingAndRepair(): Promise<void> {
        this.cleaner.cancelTimer(DdllNode.PING_TIMER_NAME);
        const curLeft = this.left!;
        if (!curLeft.isConnected()) {
            this.logger.debug(
                "sendPing: left link is disconnected: %s, repairPromise is %s",
                this.left,
                this.repairPromise ? "non-null" : "null"
            );
            if (!this.repairPromise) {
                // should this happen?
                await this.repair("sendPing found left link is disconnected");
            } else {
                this.schedulePing();
            }
            return;
        }
        let reply;
        let msg = "";
        let repair = false;
        try {
            this.repairStatus = RepairStatus.WAIT_PONG;
            const ping = new Ping(this.manager, curLeft.getRemoteKey());
            reply = await ping.request(curLeft);
            if (this.left !== curLeft) {
                msg = "left link has been changed after sending ping";
                repair = false;
            } else if (this.repairStatus !== RepairStatus.WAIT_PONG) {
                msg = "not WAIT_PONG";
                repair = false;
            } else if (
                reply.leftSucc === undefined ||
                reply.rseq === undefined
            ) {
                msg = "left node returns strange Pong";
                repair = true;
            } else if (
                reply.leftSucc !== this.key ||
                reply.rseq.compareTo(this.lseq) !== 0
            ) {
                msg = "found inconsistency with left node";
                repair = true;
            }
        } catch (err) {
            msg = `Ping failed (${err.message})`;
            repair = true;
        }
        if (repair) {
            this.logger.info("sendPing: %s", msg);
            this.safeClose(curLeft);
            await this.repair(msg);
        } else {
            this.logger.debug("sendPing: pong ok");
            this.schedulePing();
        }
    }

    public static getLogger(manager: Manager, node?: DdllNode): Logger {
        if (node) {
            return node.logger;
        }
        return manager.getLogger(DdllNode.DDLL_LOG_NAMESPACE);
    }

    /**
     * sleep exponential-increasing random time.
     *
     * i = 0: (delay is uniformly random in) [50, 100).
     * i = 1: [75, 150).
     * i = 2: [112, 225).
     */
    private async exponentialDelay(i: number): Promise<void> {
        const max = 100 * 1.5 ** i;
        const delay = ((1 + Math.random()) * max) / 2;
        await this.cleaner.delay(this.manager, delay);
    }
}
