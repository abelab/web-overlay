import * as assert from "assert";
import * as GraphLib from "graphlib";
import {
    ArrayUtils,
    Callbacks,
    ConcurrentExecutor,
    Deferred,
    GraphUtils,
    prettyPrint,
    quote,
} from "../utils";
import {
    AcceptOptions,
    ConnectType,
    DisconnectedError,
    Manager,
    ManagerRejectReasons,
    NotConnectedError,
    PeerConnectionState,
    RejectionError,
} from "./manager";
import {
    ClosePeerConnection,
    ConnectionReply,
    ConnectionRequest,
    GetNeighbors,
    Message,
    PathCReq,
    ProbePath,
} from "./messages";
import { RawConnection, RawConnectionType } from "./raw/raw";
import { Path } from "./path";
import { WebRTCConnection, WebRTCSignal } from "./raw/webrtc";
import { WsConnection } from "./raw/websocket";
import { Cleanable, Cleaner } from "./cleaner";
import { LoopbackConnection } from "./raw/loopback";
import { Logger } from "./logger";

/**
 * PeerConnectionクラス
 */
export class PeerConnection implements Cleanable {
    public static readonly RELAY_ESTABLISH_TIMER_NAME = "peerconnection.relay";
    public static readonly RELAY_MAINTENANCE_TIMER_NAME =
        "peerconnection.relayMaintenance";
    public static readonly EXPIRE_RECEIVED_IDS_TIMER_NAME =
        "peerconnection.expireReceived";
    public static readonly CHECK_EXPIRE_RECEIVED_IDS_PERIOD = 60 * 1000;
    public static readonly EXPIRE_RECEIVED_IDS_TIME = 120 * 1000;
    private readonly manager: Manager;
    private readonly logger: Logger;
    private remoteNodeId?: string;
    public localConnId!: number; // assigned by Manager#registerPeerConnection
    public remoteConnId?: number;
    private readonly localKey: string;
    // on the connect side, remoteKey is initially unknown and becomes ready
    // when PeerConnection is established.
    private remoteKey?: string;
    private _paths: Path[] = [];
    private rawConnection?: RawConnection;
    public readonly isConnectSide: boolean;
    private state = PeerConnectionState.DISCONNECTED;
    public readonly defer = new Deferred<this>();

    // to dedupe messages
    private receivedIds = new Map<number /*msgId*/, { recvTime: number }>();

    // メッセージシーケンスの順序通りに到着しないメッセージを蓄積するためのバッファ
    private msgStore = new Map<number, Message>();

    private _onDisconnect = new Callbacks();
    private connectStartTime = Date.now();
    private connectFinishTime?: number;

    private nextSequence = 1;
    private nextExpectedSequence = 1;
    public cleaner: Cleaner;

    /**
     * コンストラクタ
     * @param _manager
     * @param _localKey
     * @param isConnectSide
     */
    constructor(_manager: Manager, _localKey: string, isConnectSide: boolean) {
        this.manager = _manager;
        this.logger = _manager.mgrLogger;
        this.localKey = _localKey;
        this.isConnectSide = isConnectSide;
        this.cleaner = new Cleaner(_manager.mgrLogger, _manager.cleaner);
        _manager.registerPeerConnection(this);
        this.cleaner.push(() => {
            _manager.unregisterPeerConnection(this);
        });
        this.cleaner.startIntervalTimer(
            _manager,
            PeerConnection.EXPIRE_RECEIVED_IDS_TIMER_NAME,
            PeerConnection.CHECK_EXPIRE_RECEIVED_IDS_PERIOD,
            () => {
                const threshold =
                    Date.now() - PeerConnection.EXPIRE_RECEIVED_IDS_TIME;
                for (const ent of this.receivedIds.entries()) {
                    const [id, val] = ent;
                    if (val.recvTime < threshold) {
                        this.receivedIds.delete(id);
                    }
                }
            }
        );
    }

    /**
     * Called from {@code ConnectionRequest.constructor} to establish a
     * PeerConnection.
     *
     * @param req
     */
    public doConnect(req: ConnectionRequest): void {
        if (this.getConnectionState() !== PeerConnectionState.DISCONNECTED) {
            throw new Error(
                "PeerConnectionState is " + this.getConnectionState()
            );
        }
        this.setState(PeerConnectionState.C_WAIT_CONNECTION_REPLY);
        req.onReply(async (reply) => {
            this.logger.debug("doConnect: got reply: %s", reply);
            if (reply instanceof Error) {
                this.notEstablished(reply);
                return;
            }
            this.remoteConnId = reply.acceptPeerConnectionId;
            if (reply.acceptKey !== undefined) {
                this.setRemoteKey(reply.acceptKey);
            }
            const remoteNodeId = reply.srcNodeId;
            if (!remoteNodeId) {
                this.logger.fatal("doConnect: no remoteNodeId! (maybe bug)");
                this.notEstablished(
                    new Error("no remoteNodeId is found in ConnectReply")
                );
                return;
            }
            if (!reply.source) {
                throw new Error("no reply.source");
            }
            switch (reply.type) {
                case ConnectType.USE_THIS: {
                    if (!reply.rawConnection) {
                        throw new Error("no reply.rawConnection");
                    }
                    this.bindRawConnection(reply.rawConnection);
                    this.established();
                    break;
                }
                case ConnectType.FROM_YOU: {
                    if (!reply.acceptSpec.serverUrl) {
                        this.logger.debug("doConnect: no serverUrl");
                        return;
                    }
                    this.setState(PeerConnectionState.C_WS_CONNECTING_DIRECT);
                    const promise = WsConnection.getConnection(
                        this.getManager(),
                        reply.acceptSpec.serverUrl,
                        remoteNodeId
                    );
                    this.postConnect(promise, remoteNodeId).catch(async () => {
                        // fallback to relay path
                        await this.initiateRelayPaths(reply);
                    });
                    break;
                }
                case ConnectType.WEBRTC: {
                    const raw = new WebRTCConnection(
                        this.getManager(),
                        reply.sdp,
                        (sdp: string, count: number): void => {
                            // SDPをaccept側に送り返す
                            // reply.sourceは，connect側から見た経路
                            // [connect] A -> B -> C [accept] の場合，
                            // [A, B, C] が格納されている
                            const dest = reply.source!.optimize();
                            this.logger.debug(
                                "doConnect: ***** count=%d, path=%s",
                                count,
                                dest
                            );
                            if (!this.manager.config.NO_WEBRTC_SIGNALING) {
                                const msg = new WebRTCSignal(
                                    this.getManager(),
                                    dest,
                                    reply.acceptPeerConnectionId,
                                    sdp
                                );
                                msg.forward();
                            }
                        }
                    );
                    raw.setRemoteNodeId(remoteNodeId);
                    // WebRTCSignal refers rawConnection so we have to bind raw before raw connection establishes
                    this.bindRawConnection(raw);
                    this.setState(PeerConnectionState.C_WAIT_ESTABLISH_WRTC);
                    this.postConnect(raw.promise, remoteNodeId).catch(
                        async (err) => {
                            if (
                                this.manager.config.ENABLE_RELAY &&
                                !req.connectSpec.noRelay
                            ) {
                                this.unbindRawConnection();
                                await this.initiateRelayPaths(reply);
                            } else {
                                this.notEstablished(err);
                            }
                        }
                    );
                    break;
                }
                case ConnectType.RELAY: {
                    if (!reply.srcNodeId) {
                        this.logger.debug("no srcNodeId");
                        return;
                    }
                    this.manager._registerIndirectNode(reply.srcNodeId);
                    await this.initiateRelayPaths(reply);
                    break;
                }
                case ConnectType.REJECT: {
                    const reason = reply.rejectReason || "unknown";
                    this.notEstablished(new RejectionError(reason));
                    break;
                }
                default: {
                    throw new Error("unknown type: " + reply.type);
                }
            }
        });
    }

    /**
     * Chain a common job to PROMISE that should be executed after a raw connection
     * is established or not established.
     *
     * @param promise
     * @param remoteNodeId
     * @return Promise
     */
    private postConnect(
        promise: Promise<RawConnection>,
        remoteNodeId: string
    ): Promise<RawConnection> {
        return promise
            .then((raw) => {
                this.logger.debug("postConnect: ok: %s", raw);
                this.bindRawConnection(raw);
                this.established();
                return raw;
            })
            .catch((err) => {
                this.logger.debug("postConnect: error: %s", err);
                this.unbindRawConnection();
                assert.strictEqual(this._paths.length, 0);
                throw err;
            });
    }

    public doAccept(creq: ConnectionRequest, opts?: AcceptOptions): void {
        try {
            this.doAccept0(creq, opts);
        } catch (err) {
            this.logger.info("doAccept: got %s", err);
            this.destroy();
            throw err;
        }
    }

    /**
     * Read ConnectionRequest and do accept side procedure to establish
     * PeerConnection.
     *
     * @param creq
     * @param opts
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private doAccept0(creq: ConnectionRequest, opts?: AcceptOptions): void {
        if (this.getConnectionState() !== PeerConnectionState.DISCONNECTED) {
            throw new Error(
                "PeerConnectionState is " + this.getConnectionState()
            );
        }
        // this.logger.debug("doAccept: req: " + request);
        if (!creq.srcNodeId) {
            this.logger.debug("doAccept: no srcNodeId");
            return;
        }
        const remoteNodeId = creq.srcNodeId;
        this.remoteKey = creq.connectKey;
        this.remoteConnId = creq.connectPeerConnectionId;

        const direct = this.manager.getRawConnectionByNodeId(remoteNodeId);
        const webrtcOnly = creq.connectSpec.webrtcOnly || !!opts?.webrtcOnly;
        const isIndirect = this.manager._isIndirectNode(remoteNodeId);
        this.logger.debug(
            "direct=%s, indirect=%s, webrtcOnly=%s",
            direct,
            isIndirect,
            webrtcOnly
        );
        if (webrtcOnly) {
            if (direct instanceof WebRTCConnection) {
                this.postConnect(Promise.resolve(direct), remoteNodeId)
                    .then(() => {
                        this.sendReplyUseThis(creq);
                    })
                    .catch(() => {
                        // should not happen
                        this.sendReplyReject(
                            creq,
                            ManagerRejectReasons.CONSTRAINT
                        );
                    });
                return;
            }
            if (creq.connectSpec.webrtc && this.manager.getNodeSpec().webrtc) {
                this.connectWebRTC(creq);
            } else {
                this.sendReplyReject(creq, ManagerRejectReasons.CONSTRAINT);
            }
            return;
        }
        if (direct) {
            this.logger.debug("doAccept: already have direct connection");
            this.postConnect(Promise.resolve(direct), remoteNodeId)
                .then(() => {
                    this.sendReplyUseThis(creq);
                })
                .catch(() => {
                    this.sendReplyRelay(creq);
                });
            return;
        }
        // we have to establish a new connection
        if (isIndirect && creq.connectSpec.noRelay) {
            this.sendReplyReject(creq, ManagerRejectReasons.NO_RELAY_IS_ON);
            return;
        }
        if (isIndirect || this.manager.config.ALWAYS_RELAY) {
            this.sendReplyRelay(creq);
            return;
        }
        const remoteUrl = creq.connectSpec.serverUrl;
        if (!remoteUrl && !this.manager.getNodeSpec().serverUrl) {
            if (creq.connectSpec.webrtc && this.manager.getNodeSpec().webrtc) {
                this.connectWebRTC(creq);
                return;
            }
            if (!this.manager.config.ENABLE_RELAY) {
                this.sendReplyReject(
                    creq,
                    ManagerRejectReasons.ENABLE_RELAY_IS_OFF
                );
                return;
            }
            this.sendReplyRelay(creq);
            return;
        }

        if (remoteUrl) {
            // connect websocket from this node
            this.logger.debug(
                "doAccept: try to establish a WebSocket connection from local to remote"
            );
            this.setState(PeerConnectionState.A_WS_CONNECTING_DIRECT);
            const promise = WsConnection.getConnection(this.manager, remoteUrl);
            this.postConnect(promise, remoteNodeId)
                .then(() => {
                    this.sendReplyUseThis(creq);
                })
                .catch(() => {
                    this.sendReplyRelay(creq);
                });
            return;
        }
        if (this.manager.getNodeSpec().serverUrl) {
            // connect websocket from remote node
            /*
             *    A                            B (this)
             * Manager.connect()
             * create PeerConnection
             *    .......ConnectionRequest.......>
             *                             Manager.accept()
             *                           create PeerConnection
             *    <...ConnectionReply(FROM_YOU)...
             *                              A_WAIT_HELLO
             *                           create HelloDefer
             *    =====WebSocket Connection======>
             * create WsClientConnection
             *                          create WsServerConnection
             *    -----------Hello(A)------------>
             *                            resolve HelloDefer
             *                                CONNECTED
             *    <----------HelloReply-----------
             * CONNECTED
             */
            this.logger.debug(
                "doAccept: establish WebSocket from remote to local"
            );
            this.setState(PeerConnectionState.A_WAIT_HELLO);
            const msg = new ConnectionReply(
                this.getManager(),
                creq,
                ConnectType.FROM_YOU,
                this,
                this.manager.getAllPaths(),
                undefined
            );
            msg.forward();
            // wait for receiving Hello from the remote node.
            const deferred = this.manager.createHelloDefer(remoteNodeId);
            this.postConnect(deferred.promise, remoteNodeId).catch((err) => {
                this.logger.debug("doAccept: error in waiting Hello: %s", err);
                // wait for ProbePath from the remote node
                this.startRelayEstablishTimer();
            });
            return;
        }
        throw new Error("should not happen");
    }

    private sendReplyRelay(creq: ConnectionRequest): void {
        if (!creq.srcNodeId) {
            this.logger.warn("no srcNodeId");
            return;
        }
        this.manager._registerIndirectNode(creq.srcNodeId);
        if (creq.connectSpec.noRelay) {
            this.sendReplyReject(creq, ManagerRejectReasons.NO_RELAY_IS_ON);
            return;
        }
        const msg = new ConnectionReply(
            this.getManager(),
            creq,
            ConnectType.RELAY,
            this,
            this.manager.getAllPaths(),
            undefined
        );
        this.setState(PeerConnectionState.A_WAIT_RELAY);
        creq.sendReply(msg);
        this.startRelayEstablishTimer();
    }

    private sendReplyReject(creq: ConnectionRequest, message: string): void {
        const msg = new ConnectionReply(
            this.getManager(),
            creq,
            ConnectType.REJECT,
            undefined,
            undefined,
            undefined,
            message
        );
        creq.sendReply(msg);
        this.destroy();
    }

    private connectWebRTC(creq: ConnectionRequest): void {
        const manager = this.getManager();
        const remoteNodeId = creq.srcNodeId as string;
        this.logger.debug("doAccept: try to establish a WebRTC connection");
        let raw: WebRTCConnection;
        try {
            raw = new WebRTCConnection(
                manager,
                undefined,
                (sdp: string, count: number): void => {
                    this.logger.debug(
                        "doAccept: ************** signal count=%d",
                        count
                    );
                    if (count === 0) {
                        const msg = new ConnectionReply(
                            manager,
                            creq,
                            ConnectType.WEBRTC,
                            this,
                            manager.getAllPaths(),
                            sdp
                        );
                        msg.forward();
                    } else if (!manager.config.NO_WEBRTC_SIGNALING) {
                        const msg = new WebRTCSignal(
                            manager,
                            creq.source!.optimize(),
                            creq.connectPeerConnectionId,
                            sdp
                        );
                        msg.forward();
                    }
                }
            );
        } catch (err) {
            this.logger.info("connectWebRTC: got %s. fallback to relay.", err);
            this.sendReplyRelay(creq);
            return;
        }
        raw.setRemoteNodeId(remoteNodeId);
        // WebRTCSignal uses .rawConnection so we have to bind raw before raw connection establishes
        this.bindRawConnection(raw);
        this.setState(PeerConnectionState.A_WAIT_ESTABLISH_WRTC);
        this.postConnect(raw.promise, remoteNodeId).catch((err) => {
            if (!manager.config.ENABLE_RELAY) {
                this.notEstablished(err);
                return;
            }
            // wait for establishing relay connection from remote node
            if (
                this.getConnectionState() ===
                PeerConnectionState.A_WAIT_ESTABLISH_WRTC
            ) {
                // XXX: catchよりもProbeメッセージ受信の方が先の可能性がある
                this.setState(PeerConnectionState.A_WAIT_RELAY);
                this.startRelayEstablishTimer();
            }
        });
    }

    /**
     * Start a relay connection establishment timer.
     */
    private startRelayEstablishTimer(): void {
        this.logger.debug("startRelayEstablishTimer");
        this.cleaner.startTimer(
            this.manager,
            PeerConnection.RELAY_ESTABLISH_TIMER_NAME,
            this.manager.config.RELAY_CONNECTION_TIMEOUT,
            () => {
                this.defer.reject(new Error("relay connection timeout"));
                this.destroy();
            }
        );
    }

    /**
     * Establish relay paths
     * @param {ConnectionReply} reply
     */
    private async initiateRelayPaths(reply: ConnectionReply): Promise<void> {
        this.logger.debug("initiateRelayPaths: %s", reply.source);
        this.setState(PeerConnectionState.C_WAIT_ESTABLISH_RELAY);
        let paths: Path[] = [];
        paths = paths.concat(reply.acceptNodePaths || []);
        paths = paths.concat(this.manager.getAllPaths());
        paths = paths.concat(reply.source!.getPathWithoutConnId());
        const established = new Path(
            reply.source!.asArray(),
            reply.acceptPeerConnectionId
        );
        await this.establishRelayPaths([established], paths);
    }

    /*
     * Relay Path Establishment Sequence Overview:
     * Situation:
     * - B has a direct connection with R2.
     * - A knows that B can be reached via R1.
     *
     *    A       R1      R2       B
     *                     ========= (existing connection between B and R2)
     *    -------->----------------> GetNeighbors
     *    <-------<----------------- GetNeighborsReply (B has "B-R2"!)
     *    -------->----------------> PathCReq (A->R1->B->R2)
     *                     <--------
     *                     --------> ConnectionReply
     *    <-------<-----------------
     *    ******************         Establish RawConnection
     *    ----------------->         Hello (if WebSocket)
     *    <-----------------         HelloReply (if WebSocket)
     *    ----------------->-------> ProbePath (B learns Path[B->R2->A])
     *    <----------------<-------- PathProbeReply
     * (A learns Path[A->R2->B])
     */
    /**
     * Relay Pathを確立する．
     * 目的ノードは established[0].destNodeId
     * 前提: allPaths は established のすべての要素を含む．
     *
     * @param {Path[]} established 既に確立しているPathの配列
     * @param {Path[]} allPaths 収集したすべてのPathの配列
     * @return {Promise<void>}
     */
    private async establishRelayPaths(
        established: Path[],
        allPaths: Path[]
    ): Promise<void> {
        const { debug } = this.logger.getTraceLogger("estRelay");
        debug(
            "start: current=%s, established=%s, allPaths=%s",
            this,
            established,
            allPaths
        );
        const dest = established[0];
        const toDestPath = dest.asArray();
        const maxPathLength = toDestPath.length - 1;
        const g = this.getGraph(allPaths);

        // compute the top 6 shortest paths from me to the destination node
        const topKs = this.computeTopKShortestPaths(g, dest.destNodeId, 6);
        debug("top-k=%j", topKs);

        const exec = new ConcurrentExecutor<Path>(
            this.manager.config.MINIMUM_RELAY_PATHS,
            3,
            this.logger
        );

        // try to get MINIMUM_RELAY_PATHS paths, increasing the path length from
        // me to the destination from 2.
        // the resulting paths are stored in "exec" (ConcurrentExecutor).
        outer: for (let h = 2; h <= maxPathLength; h++) {
            // let's check established paths first
            const est = established.filter((r) => r.asArray().length === h + 1);
            if (this.isConnected()) {
                debug(" add %s, which are established.", est);
                est.forEach((p) => exec.addValue(p));
            } else {
                // send ProbePath along with r
                for (const r of est) {
                    debug(" try %s", r);
                    await exec.executeAsync(() => this.probeRelayPath(r));
                }
            }
            while (exec.worthWaiting()) {
                debug(" waiting...%s", exec);
                await exec.waitAny();
            }
            if (exec.isSatisfied()) {
                debug(" satisfied(1)");
                break;
            }
            // try without new connections
            // hpaths は topKs の中で距離 = h のパス
            const hpaths = topKs.filter((p) => p.length === h + 1);
            debug("hpaths (paths in top-k whose length=%d): %j", h, hpaths);
            for (const p of hpaths) {
                const path = new Path(p, dest.connId);
                if (established.find((r) => r.isEqualPath(path))) {
                    debug(" already established, skip: %s", path);
                    continue;
                }
                debug(" try %s", path);
                await exec.executeAsync(() => this.probeRelayPath(path));
                while (exec.worthWaiting()) {
                    debug(" waiting: %s", exec);
                    await exec.waitAny();
                }
                if (exec.isSatisfied()) {
                    break outer;
                }
            }
            while (exec.worthWaiting()) {
                debug(" waiting: %s", exec);
                await exec.waitAny();
            }
            if (exec.isSatisfied()) {
                break;
            }
            debug(" not satisfied.");
            // 既存の経路では距離 h 以下のパスが MINIMUM_PATHS 個に満たない．
            // 目的ノードから h - 1 ホップのノード（中継ノード）に直接コネクションを確立し，
            // 中継ノードから目的ノードまで接続する経路を作る．
            // try new connection to establish h-length paths
            // npaths: [目的ノードから h - 1 hop 離れたノード(中継ノード)までの経路]の配列
            {
                const npaths: string[][] = GraphUtils.getPathsToDistantNode(
                    g,
                    dest.destNodeId,
                    h - 1
                );
                debug(
                    "npaths (paths whose length=%d from dest node): %j",
                    h - 1,
                    npaths
                );
                // 中継ノードに既に直接コネクションを確立している場合を取り除き，また最適化する．
                const dst2relays: string[][] = npaths
                    .filter((p) => {
                        const last = p[p.length - 1];
                        return (
                            !g.hasEdge(this.manager.getNodeId(), last) &&
                            last !== this.manager.getNodeId()
                        );
                    })
                    .map((p) => Path.optimizePath(p));
                debug("dst2relays (filtered npaths): %j", dst2relays);
                // src2relays: [自ノードから中継ノードまでのパス]の配列
                const src2relays: string[][] = dst2relays.map((p) =>
                    toDestPath.concat(p.slice(1))
                );
                debug(
                    "src2relays (paths to the relay candidate node): %j",
                    src2relays
                );
                if (src2relays.length === 0) {
                    continue;
                }

                // try to establish a sufficient number of Paths
                for (let i = 0; i < src2relays.length; i++) {
                    const src2relay = src2relays[i];
                    const dst2relay = dst2relays[i];
                    await exec.executeAsync(() =>
                        this.tryEstablishRelayPath(
                            src2relay,
                            dst2relay,
                            dest.connId!
                        )
                    );
                    while (exec.worthWaiting()) {
                        await exec.waitAny();
                    }
                }
            }
        } /* outer */
        debug("exit outer loop. waiting...");
        await exec.waitAll();
        const results = Path.sortByScore(exec.getResults());
        debug("results=%s", results);
        if (results.length === 0) {
            this.notEstablished(new Error("no relay path is found"));
            return;
        }
        if (this.state === PeerConnectionState.DESTROYED) {
            debug("establishRelayPaths: already destroyed!: %s", this);
            return;
        }
        if (!this.isConnected()) {
            // relay path(s) established
            this.established(results[0]);
            results.slice(1).forEach((path) => this.addPath(path));
        } else {
            this.setPaths(results); // replace
        }
        debug("completed: %s", this);
    }

    private async tryEstablishRelayPath(
        src2relay: string[],
        dst2relay: string[],
        destConnId: number
    ): Promise<Path> {
        // 中継ノードとPeerConnectionが確立したら，目的ノードにProbeメッセージを送信する
        // 自ノード -> 中継ノード -> ... -> 目的ノード
        const src2dst = [this.getManager().getNodeId()].concat(
            dst2relay.reverse()
        );
        const msg = new PathCReq(this.manager, this.localKey, {
            noRelay: true,
        });
        try {
            const pc = await msg.connect(new Path(src2relay));
            this.logger.debug("connection to a relay node established: %s", pc);
            pc.close();
            this.logger.debug("probe %s", src2dst);
            const path = new Path(src2dst, destConnId);
            return await this.probeRelayPath(path);
        } catch (err) {
            this.logger.info(
                "establishing a relay connection failed (%s): %s",
                src2relay,
                err
            );
            throw err;
        }
    }

    private startRelayMaintenanceTask(isInitial: boolean): void {
        const delay =
            this.manager.config.RELAY_PATH_MAINTENANCE_PERIOD *
            (!isInitial || this.isConnectSide ? 1.0 : 0.5);
        this.cleaner.startTimer(
            this.manager,
            PeerConnection.RELAY_MAINTENANCE_TIMER_NAME,
            delay,
            () => {
                try {
                    this.maintainRelayPaths();
                } finally {
                    this.startRelayMaintenanceTask(false);
                }
            }
        );
    }

    /**
     * 引数のPath配列からグラフを得る．
     *
     * @param {Path[]} allPaths
     * @return {module:graphlib.Graph}
     */
    private getGraph(allPaths: Path[]): GraphLib.Graph {
        this.logger.debug("allPaths=%s", allPaths);
        const g = new GraphLib.Graph({ directed: false });
        allPaths.forEach((path) => {
            path.getEdgeSequence().forEach((edge) => {
                // this.logger.debug("setEdge: ", JSON.stringify(edge));
                g.setEdge(edge);
            });
        });
        this.logger.debug("g=%j", GraphLib.json.write(g));
        return g;
    }

    /**
     * グラフg上で，自ノードからdestNodeIdで指定される目的ノードまでの最短パスのトップk個を返す．
     * @param {module:graphlib.Graph} g グラフ
     * @param {string} destNodeId 目的ノード
     * @param {number} k 個数
     * @return {string[][]}
     */
    private computeTopKShortestPaths(
        g: GraphLib.Graph,
        destNodeId: string,
        k: number
    ): string[][] {
        const src = this.manager.getNodeId();
        return GraphUtils.computeShortestK(g, src, destNodeId, k);
    }

    /**
     * Send a ProbePath message along with PATH.
     * Returns a promise that is resolved on receiving a ProbePathReply.
     *
     * @param {Path} path
     */
    private async probeRelayPath(path: Path): Promise<Path> {
        try {
            const msg = new ProbePath(this.getManager(), this);
            await msg.request(path);
            return path;
        } catch (err) {
            this.logger.debug("probeRelayPath: %s failed: %s", path, err);
            throw err;
        }
    }

    private async maintainRelayPaths(): Promise<void> {
        this.logger.debug("maintainRelayPaths: %s", this);
        // start house keeping tasks

        /*
         * Send GetNeighbors to the remote node using ALL paths and obtain replies.
         */
        // 有効な自ノードから相手ノードへの経路
        const validPaths: Path[] = [];
        const promises: Promise<Path[]>[] = [];
        this._paths.forEach((path, i) => {
            const req = new GetNeighbors(this.manager);
            promises[i] = req.request(path).then(
                (reply) => {
                    validPaths.push(path);
                    return reply.paths;
                },
                (err) => {
                    this.logger.debug("req.forward() failed: %s", err);
                    return [];
                }
            );
        });
        // 相手ノードから収集した，相手ノードが持つ経路
        let remotePaths: Path[] = [];
        try {
            const results = await Promise.all(promises);
            results.forEach((paths) => {
                remotePaths = remotePaths.concat(paths);
            });
        } catch (err) {
            throw new Error("should not happen");
        }
        const lost = this._paths.filter((r) => validPaths.indexOf(r) < 0);
        if (lost.length > 0) {
            this.logger.debug("unreachable paths: %s", lost);
        }
        if (remotePaths.length === 0) {
            // no response!
            this.logger.debug(
                "maintainRelayPaths: no path is collected from %s",
                this.getRemoteNodeId()
            );
            this.destroy();
            return;
        }
        this.logger.debug(
            "maintainRelayPaths: valid=%s, collected=%s",
            validPaths,
            remotePaths
        );
        const allPaths = this.manager
            .getAllPaths()
            .filter((r) => r.destNodeId !== this.getRemoteNodeId())
            .concat(validPaths)
            .concat(remotePaths);
        return this.establishRelayPaths(validPaths, allPaths);
    }

    /**
     * called when a PeerConnection is established
     *
     * @param {Path} path?  relay path to destination node (when omitted, RawConnection is established)
     */
    public established(path?: Path): void {
        this.setState(PeerConnectionState.CONNECTED);
        if (path === undefined) {
            // direct connection case
            const raw = this.rawConnection; // should have been set by bindRawConnection
            if (!raw) {
                throw new Error("raw is null");
            }
            path = raw.getDirectPath(this.remoteConnId);
        } else {
            // we are using relay path.
            this.startRelayMaintenanceTask(true);
        }
        this.remoteNodeId = path.destNodeId;
        this.addPath(path);
        this.cleaner.cancelTimer(PeerConnection.RELAY_ESTABLISH_TIMER_NAME);
        this.connectFinishTime = Date.now();
        const time = this.connectFinishTime - this.connectStartTime;
        this.logger.debug(
            "PeerConnection established, time=%d, %s",
            time,
            this
        );
        this.defer.resolve(this);
    }

    private notEstablished(err: Error): void {
        if (err instanceof RejectionError) {
            this.setState(PeerConnectionState.REJECTED);
        } else {
            this.setState(PeerConnectionState.ERROR);
        }
        this.connectFinishTime = Date.now();
        const time = this.connectFinishTime - this.connectStartTime;
        this.logger.info(
            "PeerConnection could not be established, time=%d, %s, %s",
            time,
            err,
            this
        );
        this.destroy();
        this.defer.reject(err);
    }

    /**
     * bind a direct RawConnection to this PeerConnection
     * @param {RawConnection} raw
     */
    public bindRawConnection(raw: RawConnection): void {
        this.rawConnection = raw;
    }

    public unbindRawConnection(): void {
        this.rawConnection = undefined;
    }

    public addPath(path: Path): void {
        this._paths.push(path);
    }

    public setPaths(paths: Path[]): void {
        this._paths = paths;
    }

    public get paths(): Path[] {
        return this._paths.concat();
    }

    /**
     * called in the following cases:
     * - raw connection disconnects (trigger is undefined)
     * - a node in the path becomes suspicious (trigger is message)
     * - PathUnavailableNotify is received (trigger is the message that caused
     *   receiving PathUnavailableNotify)
     * - ack timeout (trigger is the RequestMessage)
     *
     * @param path
     */
    public removePath(path: Path): void {
        this.logger.debug("removePath: %s from %s", path, this);
        ArrayUtils.remove(this._paths, path);
        if (this._paths.length === 0) {
            this.logger.debug("no path is left");
            this.remoteClose(new Error("No path is left"));
        }
    }

    public close(): void {
        this.logger.debug("close: %s", this);
        if (this.state !== PeerConnectionState.DESTROYED) {
            if (
                this.remoteConnId !== undefined &&
                !(this.getRawConnection() instanceof LoopbackConnection)
            ) {
                this.send(
                    new ClosePeerConnection(this.manager, this.localConnId)
                );
            }
            this.unbindRawConnection();
            this.destroy();
        }
    }

    /**
     * called when ClosePeerConnection is received
     */
    public remoteClose(err?: Error): void {
        this.logger.debug("remoteClose: err=%s", err);
        this.destroy();
    }

    /**
     * register a callback that is executed on disconnection.
     * @param cb callback
     */
    public onDisconnect(cb: () => void): void {
        this._onDisconnect.addCallback(cb);
    }

    private sendReplyUseThis(request: ConnectionRequest): void {
        const reply = new ConnectionReply(
            this.getManager(),
            request,
            ConnectType.USE_THIS,
            this,
            this.manager.getAllPaths(),
            undefined
        );
        // rewrite the default destination
        reply.destination = new Path(
            [this.manager.getNodeId(), request.source!.destNodeId],
            request.source!.connId
        );
        this.send(reply);
    }

    public setState(_state: PeerConnectionState): void {
        const ostate = this.state;
        this.state = _state;
        this.logger.debug(
            "PeerConnection.setState: %s -> %s: %s",
            PeerConnectionState[ostate],
            PeerConnectionState[this.state],
            this
        );
        if (
            ostate === PeerConnectionState.DESTROYED &&
            _state !== PeerConnectionState.DESTROYED
        ) {
            this.logger.fatal("PeerConnection.setSate: revived!: %s", this);
        }
    }

    public getConnectionState(): PeerConnectionState {
        return this.state;
    }

    public toString(): string {
        return [
            `PeerConnection[LCID=${this.localConnId}`,
            `remNodeId=${quote(this.getRemoteNodeId())}`,
            `RCID=${this.remoteConnId}`,
            `LocKey=${quote(this.localKey)}`,
            `RemKey=${quote(this.remoteKey)}`,
            `${PeerConnectionState[this.state]}`,
            `paths=${prettyPrint(this._paths)}`,
            `initiator=${this.isConnectSide}]`,
        ].join(", ");
    }

    public destroy(): void {
        this.logger.debug("PeerConnection.destroy: %s", this);
        this.unbindRawConnection();
        this.state = PeerConnectionState.DESTROYED;
        for (const reqinfo of this.manager.ongoingRequests.values()) {
            if (reqinfo.pc === this) {
                reqinfo.req.destroy();
                reqinfo.req.fail(
                    new DisconnectedError("PeerConnection is destroyed")
                );
            }
        }
        this._onDisconnect.invoke();
        this.cleaner.clean();
    }

    /**
     * コネクションが接続しているかを判定する．
     * 接続中の場合や切断された場合は false を返す．
     *
     * @returns {boolean} 接続していればtrue
     */
    public isConnected(): boolean {
        return this.state === PeerConnectionState.CONNECTED;
    }

    public getRemoteNodeId(): string {
        return this.remoteNodeId || "?";
    }

    /**
     * Get the remote key
     * @returns {string}
     */
    public getRemoteKey(): string {
        if (!this.remoteKey) {
            throw new Error(
                "remoteKey is unknown, maybe because PeerConnection has not been established"
            );
        }
        return this.remoteKey;
    }

    public getLocalKey(): string {
        return this.localKey;
    }

    public setRemoteKey(_remoteKey: string): void {
        this.remoteKey = _remoteKey;
    }

    public getManager(): Manager {
        return this.manager;
    }

    public getRawConnection(): RawConnection | undefined {
        return this.rawConnection;
    }

    public getLocalConnId(): number {
        return this.localConnId;
    }

    public getConnectionType(): RawConnectionType {
        if (!this.isConnected()) {
            return RawConnectionType.NotConnected;
        }
        if (!this.rawConnection) {
            return RawConnectionType.Relay;
        }
        return this.rawConnection.getConnectionType();
    }

    public getEstablishedTime(): number | undefined {
        return this.connectFinishTime;
    }

    /**
     * messageを送信する．
     * message.destinationがnon-nullならば，このPeerConnectionインスタンスに関わらず，
     * 指定された経路で送信する．message.destinationがnullならば，このPeerConnection
     * インスタンスが示す相手ノードに送る．
     * 送信する前に，message.beforeSend()が呼ばれる．
     *
     * 受け取ったmessageを再度送信すること（転送）は可能である．
     *
     * @param {Message} msg
     */
    public send(msg: Message): void {
        if (msg.manager !== this.manager) {
            throw new Error("wrong manager!");
        }
        if (!this.isConnected()) {
            this.logger.debug(`PeerConnection.send: NOT CONNECTED!: ${this}`);
            throw new NotConnectedError();
        }
        // this.logger.debug("PeerConnection.send: " + msg);
        // TODO: sequence number feature is buggy now
        const ENABLE_SEQUENCE_NUMBER = false;
        if (ENABLE_SEQUENCE_NUMBER && !msg.getSpec().noSequence) {
            // assign a message sequence number
            msg.sequence = this.nextSequence++;
        }
        if (!msg.source) {
            msg.initSource(this);
        }
        let paths: Path[];
        if (msg.destination) {
            paths = [msg.destination];
        } else {
            paths = this._paths;
        }
        this.logger.debug(
            `PeerConnection.send: seq=${msg.sequence}, ${msg}, ${this}`
        );
        msg.beforeSend(this);
        // すべての経路でメッセージを送る
        // XXX: 時間差で送るべき?
        for (const path of paths) {
            this.logger.debug(`PeerConnection.send: path=${path}`);
            msg.destination = path;
            const raw = this.manager.getRawConnectionByNodeId(
                path.nextHop(this.manager)
            );
            if (!raw) {
                this.logger.warn(
                    "PeerConnection.send: no rawConnection for " +
                        msg.destination
                );
            } else {
                raw.send(msg);
            }
        }
        // XXX: workaround: to allow messages to be sent to multiple PeerConnections.
        msg.destination = undefined;
    }

    /*
     * If the message has sequence number, order it.
     */
    public onReceive(msg: Message): void {
        // TODO: we have to increment this.nextExpectedSequence even if the message already has been received!
        // relay connection redundantly sends messages so we have to dedupe them
        if (this.receivedIds.get(msg.msgId)) {
            this.logger.debug(
                "PeerConnection.onReceive: already received: msgId=%s",
                msg.msgId
            );
            return;
        }
        this.receivedIds.set(msg.msgId, { recvTime: Date.now() });
        this.logger.debug("PeerConnection.onReceive: msgId=%s", msg.msgId);
        if (msg.sequence === undefined || msg.sequence === null) {
            // this.logger.debug("onReceive: message has no sequence: ", msg);
            this.manager.receive(msg);
            return;
        }
        if (msg.sequence === this.nextExpectedSequence) {
            this.nextExpectedSequence++;
            this.manager.receive(msg);
            for (;;) {
                const m = this.msgStore.get(this.nextExpectedSequence);
                if (m) {
                    this.logger.debug(
                        "onReceive: exec previously received:",
                        msg
                    );
                    this.msgStore.delete(this.nextExpectedSequence);
                    this.nextExpectedSequence++;
                    this.manager.receive(m);
                } else {
                    break;
                }
            }
        } else if (msg.sequence < this.nextExpectedSequence) {
            // drop
            this.logger.debug(
                "onReceive: duplicated seq %d (msg.sequence) < %d (expectedSequence)",
                msg.sequence,
                this.nextExpectedSequence
            );
        } else {
            this.logger.info(
                "onReceive: seq skip %d (msg.sequence) > %d (expectedSequence)",
                msg.sequence,
                this.nextExpectedSequence
            );
            this.msgStore.set(msg.sequence, msg);
        }
    }

    /*
     * Stream support
     */

    public addStream(stream: MediaStream): void {
        const wrtc = this.getWebRTCConnection();
        wrtc.addStream(stream);
    }

    public removeStream(stream: MediaStream): void {
        const wrtc = this.getWebRTCConnection();
        wrtc.removeStream(stream);
    }

    public addTrack(track: MediaStreamTrack, stream: MediaStream): void {
        const wrtc = this.getWebRTCConnection();
        wrtc.addTrack(track, stream);
    }

    public removeTrack(track: MediaStreamTrack, stream: MediaStream): void {
        const wrtc = this.getWebRTCConnection();
        wrtc.removeTrack(track, stream);
    }

    public addStreamListener(callback: (_: MediaStream) => void): void {
        const wrtc = this.getWebRTCConnection();
        wrtc.addStreamListener(callback);
    }

    private getWebRTCConnection(): WebRTCConnection {
        if (!this.isConnected()) {
            throw new Error("not connected");
        }
        if (!this.rawConnection) {
            throw new Error("no direct connection");
        }
        if (!(this.rawConnection instanceof WebRTCConnection)) {
            throw new Error("not WebRTC connection");
        }
        return this.rawConnection;
    }
}
