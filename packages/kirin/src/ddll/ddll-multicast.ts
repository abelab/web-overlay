import {
    CircularSpace,
    EndOfReply,
    Gaps,
    Manager,
    PeerConnection,
    ReplyHandler,
    ReplyMessage,
    ReplyNotification,
    RequestMessage,
    RequestMessageSpec,
    serializable,
    SerializeUtils,
    SimpleRange,
    transient,
} from "@web-overlay/manager";
import { DdllNode } from "./ddll";
import { DdllMessage } from "./ddll-messages";
import { override } from "core-decorators";

/**
 * A base class of requests that are propagated via multicast.
 * You should define a subclass of this class to send multicast messages.
 */
export abstract class MulticastRequest<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends RequestMessage<T, U> implements DdllMessage {
    public static readonly EOR = new EndOfReply();
    @transient public gaps?: Gaps;
    // the range that the local node covers (temporarily used when this.onReceive() is called)
    @transient public from?: string;
    @transient public to?: string;
    @transient public numberOfRetransmission = 0;

    protected constructor(manager: Manager) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: "should be overridden",
            noReplyTimeout: true,
            noAck: true,
        };
    }

    /**
     * Reduce two return values into one.
     */
    public abstract reduce(a: U, b: U): U;

    /**
     * Setup a reply handler.
     * The handler receives 3 types of objects; U, Error, and EndOfReply.
     *
     * @param {(resp: (ReplyNotification | U)) => void} handler
     */
    public onReply(handler: (resp: U | ReplyNotification) => void): void;

    /**
     * Setup a reply handler.  Do not use this in MulticastRequest.
     *
     * @deprecated
     * @param {(resp: (Error | U)) => void} handler
     */
    public onReply(handler: (resp: U | Error) => void): void;
    public onReply(handler: ReplyHandler<U>): void {
        super.onReply(handler);
    }

    /**
     * Send a reply message toward the request sender node.
     *
     * @param msg
     */
    public sendReply(msg: U): void {
        this.checkReply(msg);
        const container = this.getContainer();
        const min = this.from!;
        const max = this.to!;
        const reply = new RQReply(container, [{ from: min, to: max }], msg);
        this.getContainer()._addReply(reply);
    }

    public getIncompleteRanges(): SimpleRange[] {
        return this.gaps?.toSimpleRanges() || [];
    }

    public isCompleted(): boolean {
        return this.gaps ? this.gaps.isEmpty() : false;
    }

    private getContainer(): RQRequest<T, U> {
        if (!this.container || !(this.container instanceof RQRequest)) {
            throw new Error(
                "this.container is null or not instance of RQReply"
            );
        }
        return this.container as RQRequest<T, U>;
    }
}
export interface MulticastRequest<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends DdllMessage {}

export class MulticastReply<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends ReplyMessage<T, U> {
    // empty
}

/**
 * @param <U> the type of reply value
 */
@serializable
export class RQRequest<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends RequestMessage<RQRequest<T, U>, RQReply<T, U>>
    implements DdllMessage {
    public static readonly FLUSH_TIMER_NAME = "RQRequest.flushTimer";
    @transient public startTime?: number;
    @transient protected gaps?: Gaps;
    @transient protected storedRanges: { from: string; to: string }[] = [];
    // null is used as a filler, undefined is used as "not yet received"
    @transient protected replyValue: U | null | undefined;
    @transient private finished = false;
    @transient private onceFlushed = false;
    constructor(
        ddll: DdllNode,
        public minKey: string,
        public maxKey: string,
        public payload: MulticastRequest<T, U>
    ) {
        super(ddll.manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: RQReply.name,
            allowMultipleReply: true,
            // noAck: true
        };
    }

    public startMulticast(ddll: DdllNode): void {
        this.startTime = Date.now();
        this.getSpec = (): RequestMessageSpec => {
            return {
                replyClassName: RQReply.name,
                allowMultipleReply: true,
                noReplyTimeout: true,
            };
        };
        this.onReply((reply) => {
            ddll.logger.debug(
                "%s.onReply is called: reply=%s",
                this.constructor.name,
                reply
            );
            if (reply instanceof Error) {
                this.payload.fail(reply);
                return;
            }
            if (this.finished) {
                return;
            }
            reply.ranges.forEach((range) => {
                this.payload.gaps?.remove(
                    new SimpleRange(range.from, range.to)
                );
            });
            if (reply.value !== null) {
                this.payload._gotReply(reply.value);
            }
            if (this.isCompleted()) {
                this.finish(MulticastRequest.EOR);
            }
        });
        this.peerConnection = ddll.self;
        this.beforeSend(this.peerConnection);
        this.manager.receive(this);
    }

    public onReceive(): void {
        // this.payload.initFromContainer(this);
        this.payload.afterRestore(this.manager);
        this.storedRanges = [];

        /*
         * Algorithm overview:
         * E = 自ノードの経路表で，相手のキーがマルチキャストの範囲内に入っているエントリ
         * if E is empty
         *   minkeyへ最も近いノードにmsgを送る
         *   return
         * 範囲を E のエントリで分割する
         * E = {e1, e2} の場合
         *    min     e1      e2     max
         * S = [  s1  )[  s2  )[  s3  )
         * 分割した各範囲の担当ノードを決める
         *   s1の担当ノードはminkeyに最も近いpredecessor
         *   s2の担当ノードはe1のノード
         *   s3の担当ノードはe2のノード
         * 各担当ノードにMulticastメッセージを送る (範囲は修正)
         */
        const minkey = this.minKey;
        const maxkey = this.maxKey;

        const ddllnodes = DdllNode.getInsertedDdllNodes(this.manager);
        if (!ddllnodes) {
            DdllNode.getLogger(this.manager).warn(
                "%s.onReceive: no inserted DdllNode",
                this.constructor.name
            );
            return;
        }
        const remoteKeys = ddllnodes
            .map((node) => node.getValidPeerConnections())
            .reduce((acc, pcs) => acc.concat(pcs), []) // flatten
            .map((pc) => pc.getRemoteKey())
            .filter((key, index, self) => self.indexOf(key) === index);
        const inKeys = remoteKeys.filter((key) =>
            CircularSpace.isOrdered(minkey, true, key, maxkey, false)
        );
        const sortedInKeys = CircularSpace.sortOnRing(minkey, inKeys);

        const frags: {
            min: string;
            max: string;
            delegateKey: string;
            pc?: PeerConnection;
        }[] = [];
        //   [min ... s0 ... s1 ... max)
        // closest    s0     s1
        if (sortedInKeys.length === 0 || sortedInKeys[0] !== minkey) {
            const closest = DdllNode.getClosestPrecedingConnection(
                this.manager,
                minkey,
                true
            );
            if (!closest) {
                throw new Error("should not happen");
            }
            frags.push({
                min: minkey,
                max: sortedInKeys.length === 0 ? maxkey : sortedInKeys[0],
                delegateKey: closest.getRemoteKey(),
            });
        }
        sortedInKeys.map((key, index) => {
            frags.push({
                min: key,
                max:
                    index < sortedInKeys.length - 1
                        ? sortedInKeys[index + 1]
                        : maxkey,
                delegateKey: key,
            });
        });
        // frags.delegate から PeerConnection を割り当てる
        const pcMap = new Map<string, PeerConnection>();
        ddllnodes
            .map((node) => node.getValidPeerConnections())
            .reduce((acc, pcs) => acc.concat(pcs), []) // flatten
            .forEach((pc) => {
                pcMap.set(pc.getRemoteKey(), pc);
            });
        frags.forEach((frag) => {
            frag.pc = pcMap.get(frag.delegateKey);
        });
        this.ddll.logger.debug("received %s", this);
        this.ddll.logger.debug("- sortedInKeys=%s", sortedInKeys);
        frags.forEach((frag) => {
            this.ddll.logger.debug(
                "- frag min=%s, max=%s, dkey=%s",
                frag.min,
                frag.max,
                frag.delegateKey
            );
        });
        // forward to children
        this.cleaner.startTimer(
            this.manager,
            RQRequest.FLUSH_TIMER_NAME,
            1000,
            () => {
                if (!this.onceFlushed) {
                    this.flush();
                }
            }
        );

        this.gaps = new Gaps(this.minKey, this.maxKey);
        frags.forEach((frag) => {
            if (!frag.pc) {
                throw new Error("should not happen");
            }
            if (frag.pc.getRemoteNodeId() === this.manager.getNodeId()) {
                // local node case!
                if (
                    CircularSpace.isOrdered(
                        frag.min,
                        true,
                        frag.delegateKey,
                        frag.max,
                        false
                    )
                ) {
                    // clone this.appRequest
                    const copy = SerializeUtils.clone(this.payload);
                    copy.initFromContainer(this);
                    // assign to copy.peerConnection a proper PeerConnection
                    const node = DdllNode.getDdllNode(
                        this.manager,
                        frag.delegateKey
                    );
                    if (!node) {
                        throw new Error("shouldn't happen");
                    }
                    copy.peerConnection = node.self;
                    // keep the sub-range for replying
                    copy.from = frag.min;
                    copy.to = frag.max;
                    this.ddll.logger.debug(
                        "call local receive: pc=%s",
                        copy.peerConnection
                    );
                    this.manager.receive(copy);
                    // we expect that this.appRequest.sendReply() is called
                } else {
                    this.ddll.logger.debug("LEFT-EDGE FRAGMENT");
                    const reply = new RQReply(
                        this,
                        [{ from: frag.min, to: frag.max }],
                        null /* as a filler */
                    );
                    this._addReply(reply);
                }
            } else {
                const childGaps = new Gaps(frag.min, frag.max);
                const child = new RQRequest(
                    this.ddll,
                    frag.min,
                    frag.max,
                    this.payload
                );
                this.ddll.logger.debug("child=%s", child);
                child.onReply((reply) => {
                    if (reply instanceof Error) {
                        this.ddll.logger.info("RQRequest fail: ", reply);
                        if (this.isRequestingNode) {
                            this.finish(reply);
                        }
                        return;
                    }
                    if (reply instanceof RQReply) {
                        reply.ranges.forEach((rep) => {
                            childGaps.remove(new SimpleRange(rep.from, rep.to));
                        });
                        if (childGaps.isEmpty()) {
                            child.destroy();
                        }
                        this._addReply(reply);
                    } else {
                        this.ddll.logger.debug("got %s", reply);
                    }
                });
                frag.pc.send(child);
            }
        });
    }

    public _addReply(reply: RQReply<T, U>): void {
        this.ddll.logger.debug(
            "%s._addReply: %s",
            this.constructor.name,
            reply
        );
        reply.ranges.forEach((rep) => {
            this.gaps!.remove(new SimpleRange(rep.from, rep.to));
            this.storedRanges.push(rep);
        });
        this.ddll.logger.debug("Gaps=%s", this.gaps);
        if (!this.replyValue) {
            this.replyValue = reply.value; // possibly null (as filler)
        } else if (this.replyValue && reply.value) {
            this.replyValue = this.payload.reduce(this.replyValue, reply.value);
        }
        if (this.isRequestingNode || this.isCompleted() || this.onceFlushed) {
            this.flush();
        }
    }

    private flush(): void {
        this.ddll.logger.debug("%s.flush", this.constructor.name);
        this.onceFlushed = true;
        if (this.replyValue === undefined) {
            return;
        }
        const reply = new RQReply(this, this.storedRanges, this.replyValue);
        if (this.isRequestingNode) {
            this._gotReply(reply);
        } else {
            this.sendReply(reply);
        }
        this.replyValue = undefined;
        this.storedRanges = [];
        if (this.isCompleted()) {
            this.destroy();
        } else {
            this.ddll.logger.debug(
                "(incomplete) %s",
                this.getIncompleteReplyRanges()
            );
        }
    }

    private finish(notification: ReplyNotification): void {
        if (!this.finished) {
            this.finished = true;
            this.payload._gotReply(notification);
            this.destroy();
            const elapsed = Date.now() - this.startTime!;
            this.ddll.logger.debug("multicast finished: time=%d", elapsed);
        }
    }

    public isCompleted(): boolean {
        return this.gaps!.isEmpty();
    }

    public getIncompleteReplyRanges(): SimpleRange[] {
        return this.gaps!.toSimpleRanges();
    }

    public toString(): string {
        return `<RQRequest msgId=${this.msgId}, min=${this.minKey}, max=${this.maxKey}>`;
    }
}
export interface RQRequest<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends DdllMessage {}

@serializable
export class RQReply<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends ReplyMessage<RQRequest<T, U>, RQReply<T, U>> implements DdllMessage {
    constructor(
        req: RQRequest<T, U>,
        public ranges: {
            from: string;
            to: string;
        }[],
        public value: U | null
    ) {
        super(req);
    }
}
export interface RQReply<
    T extends MulticastRequest<T, U>,
    U extends MulticastReply<T, U>
> extends DdllMessage {}
