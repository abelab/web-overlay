import {
    generateRandomId,
    ArrayUtils,
    CustomError,
    Deferred,
    EquitySet,
    TimeoutDeferred,
} from "../utils";
import { Config, ManagerConfig, defaultConfig } from "./config";
import {
    Ack,
    AckStat,
    ConnectionReply,
    ConnectionRequest,
    Message,
    RequestMessage,
} from "./messages";
import { PeerConnection } from "./peerconnection";
import { RawConnection, RawConnectionType } from "./raw/raw";
import { Path } from "./path";
import { WsConnection } from "./raw/websocket";
import { LoopbackConnection } from "./raw/loopback";
import { Cleanable, Cleaner } from "./cleaner";
import { WebRTCConnection } from "./raw/webrtc";
import { Logger, LogSender } from "./logger";
import isNode = require("detect-node");

// setup UnhandledRejectionHandler for debugging
function setupUnhandledRejectionHandler(): void {
    const handler = (
        reason: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        promise: Promise<any>
    ): never => {
        console.warn("unhandledRejection!");
        console.warn("  reason=", reason);
        console.warn("  promise=", promise);
        throw new Error(
            "Unhandled Rejection at: Promise" + promise + "reason:" + reason
        );
    };
    if (typeof window === "object") {
        window.addEventListener("unhandledrejection", (event) => {
            handler(event.reason, event.promise);
        });
    } else if (isNode) {
        process.on("unhandledRejection", handler);
    }
}
setupUnhandledRejectionHandler();

export enum PeerConnectionState {
    /** waiting for ConnectionReply message */
    C_WAIT_CONNECTION_REPLY,
    /** waiting for establishing WebSocket connection (connect->accept) */
    C_WS_CONNECTING_DIRECT,
    /** waiting for establishing WebRTC connection */
    C_WAIT_ESTABLISH_WRTC,
    /** waiting for establishing relay connection */
    C_WAIT_ESTABLISH_RELAY,
    /** waiting for establishing WebSocket connection (accept->connect) */
    A_WS_CONNECTING_DIRECT,
    /** waiting for Hello message */
    A_WAIT_HELLO,
    /** waiting for establishing WebRTC connection */
    A_WAIT_ESTABLISH_WRTC,
    /** waiting for establishing relay connection */
    A_WAIT_RELAY,
    /** connected */
    CONNECTED,
    /** error state */
    ERROR,
    REJECTED,
    DISCONNECTED,
    DESTROYED,
}

export enum ConnectType {
    USE_THIS,
    FROM_YOU,
    WEBRTC,
    RELAY,
    REJECT,
}

/**
 * Connection Timed-out
 */
export class TimeoutError extends CustomError {}

/**
 * ReplyMessage is not received within {@link Config.REPLY_TIMEOUT}.
 */
export class ReplyTimeoutError extends TimeoutError {}

/**
 * Thrown when you send a message via disconnected PeerConnection
 */
export class NotConnectedError extends CustomError {}

/**
 * Thrown when you send a RequestMessage via a PeerConnection and waiting for a ReplyMessage,
 * and the PeerConnection is disconnected.
 */
export class DisconnectedError extends CustomError {}

/**
 * Connection request is rejected by remote node.
 * See {@link ConnectionRequest.reject}.
 */
export class RejectionError extends CustomError {}

export const ManagerRejectReasons = {
    CONSTRAINT: "CONSTRAINT CANNOT BE SATISFIED",
    NO_RELAY_IS_ON: "RELAY IS NECESSARY BUT noRelay IS SPECIFIED",
    ENABLE_RELAY_IS_OFF: "RELAY IS NECESSARY BUT and ENABLE_RELAY IS OFF",
};

export interface ConnectOptions {
    noRelay?: boolean;
    webrtcOnly?: boolean;
}

export interface AcceptOptions {
    webrtcOnly?: boolean;
}

export interface NodeSpec {
    webrtc?: boolean;
    serverUrl?: string;
}

export type ConnectSpec = NodeSpec & ConnectOptions;

export interface OngoingRequestInfo {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req: RequestMessage<any, any>;
    pc?: PeerConnection;
}

export interface PortalCacheInfo {
    earliestConnectionFailTime?: number /* Date */;
    lastConnectionFailTime?: number /* Date */;
    lastSuccessfulConnectionTime?: number /* Date */;
}

/**
 * Managerクラス
 */
export class Manager implements Cleanable {
    public readonly config: Config;
    public appLoggers = new Map<string /* App Name */, Logger>();
    private readonly logSender?: LogSender;
    public readonly mgrLogger: Logger;
    public readonly rawLogger: Logger;
    public readonly networkId?: string;
    private readonly nodeId: string;
    public readonly isWebRTCSupported = WebRTCConnection.isWebRTCSupported();

    // mapping from a key to an object whose property is set by registerApp().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private apps = new Map<string, any>();

    public isMuted = false;

    private loopbackConnection?: LoopbackConnection;
    public readonly peerConnections: PeerConnection[] = [];
    private nextConnId = 0; // for PeerConnection
    private readonly rawConnections: RawConnection[] = [];
    private nextRawId = 0; // for RawConnection

    // nodeId -> RawConnection
    private readonly nodeIdConnections = new Map<string, RawConnection>();

    // nodes that we could not established a direct connection to
    private indirectNodes = new Set<string>();

    // nodes that are likely failed
    private readonly suspiciousNodes = new Set<string>();

    public nextMsgId = Math.floor(Math.random() * 65536);
    public nextAckId = Math.floor(Math.random() * 65536);

    // Hello受信でcompleteする．keyはNodeID
    private readonly helloDefers = new Map<
        string /* nodeID */,
        Deferred<RawConnection>
    >();

    // ongoing requests
    public readonly ongoingRequests = new Map<
        number /* msgId */,
        OngoingRequestInfo
    >();

    // ack management
    public readonly unAckedMessages = new Map<
        number /* ackRequestId */,
        AckStat
    >();

    // URL of portal nodes
    protected readonly portalCache = new Map<
        string /* URL */,
        PortalCacheInfo
    >();
    public static readonly PORTAL_CACHE_EXPIRE_TIME = 60 * 60 * 1000;
    public readonly cleaner: Cleaner;

    /**
     * constructor
     *
     * @param conf         configuration
     */
    constructor(conf?: ManagerConfig) {
        this.config = Object.assign({}, defaultConfig);
        if (conf) {
            Object.assign(this.config, conf);
        }
        this.nodeId = conf?.NODE_ID || generateRandomId();
        if (this.config.LOG_SERVER_URL) {
            this.logSender = new LogSender(
                this.nodeId,
                this.config.LOG_SERVER_URL
            );
        }
        const debug = process?.env?.DEBUG || this.config.DEBUG;
        if (debug) {
            Logger.enable(debug);
        }
        this.networkId = conf?.NETWORK_ID;
        this.mgrLogger = this.createLogger("web:general");
        this.rawLogger = this.createLogger("web:raw");
        this.cleaner = new Cleaner(this.mgrLogger);
        this.cleaner.push(() => {
            this.mgrLogger.destroy();
            this.rawLogger.destroy();
            this.logSender?.destroy();
        });
        this.mgrLogger.info("Manager started: %s", this.getAgentString());
        if (!isNode && !this.isWebRTCSupported) {
            this.mgrLogger.warn("This browser does not support WebRTC!");
        }
    }

    /**
     * Register an application.
     * When a message is received, prop is set to the message instance whose value is app.
     *
     * @param {string} key
     * @param {string} prop
     * @param app
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public registerApp(key: string, prop: string, app: any): void {
        this.mgrLogger.debug("registerApp: %s, %s", key, prop);
        const obj = this.apps.get(key) || {};
        if (obj[prop]) {
            throw new Error(`${prop} is already registered`);
        }
        obj[prop] = app;
        this.apps.set(key, obj);
    }

    public unregisterApp(key: string, prop: string): void {
        const obj = this.apps.get(key);
        this.mgrLogger.debug(
            "unregisterApp: key=%s, prop=%s, obj.keys=%s",
            key,
            prop,
            [...Object.keys(obj)]
        );
        if (!obj || !obj[prop]) {
            this.mgrLogger.debug(
                `neither key ${key} nor ${prop} is registered`
            );
            return;
        }
        delete obj[prop];
        if (Object.keys(obj).length === 0) {
            this.apps.delete(key);
        }
    }

    public getApp<T>(key: string, prop: string): T | undefined {
        const obj = this.apps.get(key);
        return obj ? obj[prop] : undefined;
    }

    public getApps<T>(prop: string): T[] {
        const rc = [...this.apps.values()]
            .map((obj) => obj[prop])
            .filter((app) => app !== undefined);
        return rc;
    }

    /**
     * Establish a WebSocket to a portal node specified by {@code url} and
     * construct a PeerConnection over it.
     *
     * Note that:
     * - You do not have to call {@code Manager.accept()} on the remote node.
     * - The returned PeerConnection has no local and remote keys (undefined).
     *
     * @param url
     * @returns {Promise<PeerConnection>}
     */
    public async connectPortal(url: string): Promise<PeerConnection> {
        const dummyKey = "$connectPortal";
        const pc = new PeerConnection(this, dummyKey, true);
        pc.setRemoteKey(dummyKey);
        pc.setState(PeerConnectionState.C_WS_CONNECTING_DIRECT);
        try {
            const raw = await WsConnection.getConnection(this, url);
            this.mgrLogger.debug("connectPortal: raw=%s", raw);
            pc.bindRawConnection(raw);
            pc.established();
            this.addPortalURL(url, {
                lastSuccessfulConnectionTime: Date.now(),
            });
            return pc;
        } catch (err) {
            pc.setState(PeerConnectionState.ERROR);
            pc.destroy();
            const obj = this.portalCache.get(url) || {};
            const now = Date.now();
            obj.lastConnectionFailTime = now;
            obj.earliestConnectionFailTime =
                obj.earliestConnectionFailTime || now;
            if (
                obj.earliestConnectionFailTime +
                    Manager.PORTAL_CACHE_EXPIRE_TIME <
                now
            ) {
                this.portalCache.delete(url);
                this.mgrLogger.debug(
                    "connectPortal: %s is purged from portalCache",
                    url
                );
            } else {
                this.addPortalURL(url, obj);
            }
            throw err;
        }
    }

    /**
     * Connect to myself.
     *
     * @param localKey  this key is also used as remote key.
     */
    public connectLoopback(localKey: string): PeerConnection {
        const pc = new PeerConnection(this, localKey, true);
        pc.remoteConnId = pc.localConnId;
        pc.setRemoteKey(localKey);
        if (!this.loopbackConnection) {
            this.loopbackConnection = new LoopbackConnection(this);
        }
        pc.bindRawConnection(this.loopbackConnection);
        pc.established();
        this.mgrLogger.debug("connectLoopback: %s", pc);
        return pc;
    }

    /**
     * Start to establish a PeerConnection with some node.
     *
     * @param creq
     */
    public _connect(creq: ConnectionRequest): Promise<PeerConnection> {
        const pc = new PeerConnection(this, creq.connectKey, true);
        creq.bindPeerConnection(pc);
        this.mgrLogger.debug("manager.connect(): new PC=%s", pc);
        pc.doConnect(creq);
        return pc.defer.promise;
    }

    /**
     * try to establish a PeerConnection with the sender of ConnectionRequest.
     * XXX: need a method to allow caller to call cleaner.addChild(peerConnection)
     * before connection establishes.
     *
     * @param localKey
     * @param creq
     * @param opts
     */
    public _accept(
        localKey: string,
        creq: ConnectionRequest,
        opts?: AcceptOptions
    ): Promise<PeerConnection> {
        this.mgrLogger.debug("manager.accept(): %s", creq);
        const pc = new PeerConnection(this, localKey, false);
        pc.setRemoteKey(creq.connectKey);
        try {
            pc.doAccept(creq, opts);
        } catch (err) {
            pc.defer.reject(err);
        }
        return pc.defer.then(
            () => {
                this.mgrLogger.debug("accept: established: %s", pc);
                return pc;
            },
            (err) => {
                this.mgrLogger.info("accept: not established: %s", err);
                throw err;
            }
        );
    }

    /**
     * PeerConnectionの確立を拒否する．
     * connect側では，Promiseがrejectされ，RejectErrorが返る．
     * RejectError.reasonは引数で与えた原因．
     *
     * @param _connRequest
     * @param reason rejectした原因
     */
    public _reject(_connRequest: ConnectionRequest, reason: string): void {
        this.mgrLogger.debug("manager.reject(): %s", _connRequest);
        const reply = new ConnectionReply(
            this,
            _connRequest,
            ConnectType.REJECT,
            undefined,
            undefined,
            undefined,
            reason
        );
        _connRequest.sendReply(reply);
    }

    /**
     * destroy this manager instance.
     */
    public destroy(): void {
        this.mgrLogger.debug("destroy()");
        // this order is important because cleaner code may call unregisterApp().
        this.cleaner.clean();
        this.apps.clear();
    }

    /*
     * RequestMessage and AckMessage handling
     */
    public _registerRequestMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req: RequestMessage<any, any>,
        pc?: PeerConnection
    ): void {
        // n.logger.log("registerRequestMessage: ", ev.getMsgId());
        if (req.isRequestingNode) {
            this.ongoingRequests.set(req.getMsgId(), {
                req: req,
                pc: pc,
            });
            req.cleaner.push(() => {
                this._unregisterRequestMessage(req.getMsgId());
            });
        }
    }

    public _unregisterRequestMessage(
        msgId: number
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): RequestMessage<any, any> | undefined {
        const ev = this.ongoingRequests.get(msgId);
        if (ev) {
            // n.logger.log("removeRequestMessage: ", id);
            this.ongoingRequests.delete(msgId);
            return ev.req;
        }
        return undefined;
    }

    public _lookupRequestMessage(
        msgId: number
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): RequestMessage<any, any> | undefined {
        const ent = this.ongoingRequests.get(msgId);
        return ent ? ent.req : undefined;
    }

    public handleAck(ack: Ack): void {
        const ackStat = this.unAckedMessages.get(ack.ackReplyId);
        if (!ackStat) {
            this.mgrLogger.debug(
                "no Message found, ackReplyId=%s",
                ack.ackReplyId
            );
            return;
        }
        ackStat.message.ackReceived(ackStat);
    }

    /*
     * Connection registration / unregistration
     */

    public registerPeerConnection(pc: PeerConnection): void {
        pc.localConnId = this.nextConnId++;
        this.peerConnections[pc.getLocalConnId()] = pc;
    }

    public unregisterPeerConnection(pc: PeerConnection): void {
        delete this.peerConnections[pc.getLocalConnId()];
    }

    public registerRawConnection(raw: RawConnection): void {
        if (raw.id === undefined) {
            raw.id = this.nextRawId++;
            this.rawConnections[raw.id] = raw;
            raw.cleaner.push(() => this.unregisterRawConnection(raw));
        }
        const remNodeId = raw.getRemoteNodeId();
        if (
            remNodeId &&
            // do not register raw other than LoopbackConnection for myself
            (remNodeId !== this.getNodeId() ||
                raw.getConnectionType() === RawConnectionType.Loopback)
        ) {
            this.nodeIdConnections.set(remNodeId, raw);
        }
        this.mgrLogger.debug(
            "nodeIdConnections.keys=%s",
            ...this.nodeIdConnections.keys()
        );
    }

    public unregisterRawConnection(raw: RawConnection): void {
        if (raw.id !== undefined) {
            delete this.rawConnections[raw.id];
        }
        const remNodeId = raw.getRemoteNodeId();
        if (remNodeId) {
            this.nodeIdConnections.delete(remNodeId);
        }
    }

    /**
     * Remove paths from PeerConnections that contains a link [fromNodeId->toNodeId].
     *
     * @param fromNodeId
     * @param toNodeId
     */
    public removeDeadLink(fromNodeId: string, toNodeId: string): void {
        // XXX: to prevent destroying PeerConnection that is trying a relay path...
        const maybeTryingRelay = (pc: PeerConnection): boolean => {
            const s = pc.getConnectionState();
            return (
                s === PeerConnectionState.A_WAIT_ESTABLISH_WRTC ||
                s === PeerConnectionState.C_WAIT_ESTABLISH_WRTC
            );
        };
        // invalidate PeerConnection if it contains the dead link in its path.
        this.getPeerConnections().forEach((pc) => {
            pc.paths.forEach((path) => {
                const ind = ArrayUtils.find(path.asArray(), [
                    fromNodeId,
                    toNodeId,
                ]);
                if (ind >= 0 && !maybeTryingRelay(pc)) {
                    pc.removePath(path);
                }
            });
        });
    }

    /*
     * Getters
     */

    public getNodeId(): string {
        return this.nodeId;
    }

    // overridden by a subclass
    public getNodeSpec(): NodeSpec {
        return {
            webrtc: this.isWebRTCSupported,
        };
    }

    public getRawConnectionByConnId(connID: number): RawConnection {
        return this.rawConnections[connID];
    }

    public getRawConnectionByNodeId(nodeId: string): RawConnection | undefined {
        return this.rawConnections.find((raw) => {
            return raw && raw.getRemoteNodeId() === nodeId && raw.isAvailable();
        });
    }

    /**
     * get all RawConnection(s)
     *
     * @returns {RawConnection[]}
     */
    public getRawConnections(): RawConnection[] {
        return this.rawConnections.filter((raw) => !!raw);
    }

    /**
     * 指定したconnIdのPeerConnectionを取得
     * @param _connId
     * @returns {PeerConnection}
     */
    public getPeerConnection(_connId: number): PeerConnection | undefined {
        return this.peerConnections[_connId];
    }

    /**
     * すべての PeerConnection を配列で返す．
     *
     * @returns {PeerConnection[]}
     */
    public getPeerConnections(): PeerConnection[] {
        return this.peerConnections.filter((pc) => !!pc);
    }

    // TODO: consider suspicious?
    public getAllPaths(): Path[] {
        const set: EquitySet<Path> = new EquitySet((r1, r2): boolean => {
            return r1.isEqualPath(r2);
        });
        this.peerConnections.forEach((pc) => {
            pc.paths.forEach((path) => {
                set.add(path.getPathWithoutConnId());
            });
        });
        this.rawConnections.forEach((raw) => {
            if (raw.isConnected() && raw.getRemoteNodeId()) {
                set.add(raw.getDirectPath());
            }
        });
        return Array.from(set);
    }

    /*
     * Hello Defer
     */
    public createHelloDefer(nodeId: string): Deferred<RawConnection> {
        return this.getHelloDefer(nodeId, true) as Deferred<RawConnection>;
    }

    public getHelloDefer(
        nodeId: string,
        doCreate: boolean
    ): Deferred<RawConnection> | undefined {
        let defer = this.helloDefers.get(nodeId);
        if (defer) {
            return defer;
        }
        if (doCreate) {
            defer = new TimeoutDeferred(
                this.config.MAX_RAWCONNECTION_ESTABLISH_TIME
            );
            defer.promise.then(
                () => this.removeHelloDefer(nodeId),
                () => this.removeHelloDefer(nodeId)
            );
            this.helloDefers.set(nodeId, defer);
            return defer;
        }
        return undefined;
    }

    public removeHelloDefer(nodeId: string): void {
        this.helloDefers.delete(nodeId);
    }

    /**
     * handle a message that is received via RawConnection.
     *
     * @param {Message} msg
     */
    public receive(msg: Message): void {
        // this.logger.debug("Manager.receive: ", msg);
        msg.isReceived = true;
        // source node is no longer suspicious
        const src = msg.srcNodeId;
        if (src) {
            this.suspiciousNodes.delete(src);
        }
        const pc = msg.peerConnection;
        msg.invokeOnReceive(pc?.getLocalKey());
    }

    public setAutomaticProps(key: string, msg: Message) {
        const obj = this.apps.get(key);
        if (obj) {
            Object.keys(obj).forEach((prop) => {
                Object.defineProperty(msg, prop, {
                    enumerable: false,
                    configurable: true,
                    value: obj[prop],
                });
            });
        }
    }

    /**
     * Register a node that cannot be connected directly with WebRTC
     *
     * @param nodeId
     */
    public _registerIndirectNode(nodeId: string): void {
        if (nodeId === this.nodeId) {
            return;
        }
        this.indirectNodes.add(nodeId);
        this.cleaner.startTimer(
            this,
            "expireIndirect:" + nodeId,
            this.config.INDIRECT_NODE_EXPIRATION_TIME,
            () => {
                this.indirectNodes.delete(nodeId);
            }
        );
    }

    public getIndirectNodes(): string[] {
        return [...this.indirectNodes.values()];
    }

    public _isIndirectNode(nodeId: string): boolean {
        return this.indirectNodes.has(nodeId);
    }

    /*
     * Suspicious nodes (possibly failed nodes) handling
     */
    public _registerSuspiciousNode(nodeId: string): void {
        if (nodeId === this.nodeId) {
            return;
        }
        this.suspiciousNodes.add(nodeId);
        this.mgrLogger.debug(
            "_registerSuspiciousNode: add %s: %s",
            nodeId,
            this.getSuspiciousNodes()
        );
        this.cleaner.startTimer(
            this,
            "expireSuspicious:" + nodeId,
            this.config.SUSPICIOUS_NODE_EXPIRATION_TIME,
            () => {
                this.suspiciousNodes.delete(nodeId);
            }
        );
    }

    public getSuspiciousNodes(): string[] {
        return [...this.suspiciousNodes.values()];
    }

    public isSuspiciousNode(nodeId: string): boolean {
        return this.suspiciousNodes.has(nodeId);
    }

    // XXX: it's better to check the validity of given URLs
    public addPortalURL(url: string, opt?: PortalCacheInfo): void {
        // we do not want my URL in portalCache
        if (this.getNodeSpec().serverUrl === url) {
            return;
        }
        opt = opt || {};
        this.portalCache.set(url, opt);
        this.mgrLogger.debug("addPortalURL: url=%s, opt=%j", url, opt);
        this.mgrLogger.debug(
            "addPortalURL: current set={%s}",
            this.getPortalURLs()
        );
    }

    public deletePortalURL(url: string): void {
        this.portalCache.delete(url);
    }

    public getPortalURLs(): string[] {
        return [...this.portalCache.keys()];
    }

    /**
     * Connect to any portal node.
     *
     * @throws Error if no portal is available
     */
    public async connectAnyPortal(): Promise<PeerConnection> {
        const { debug, info } = this.mgrLogger.getTraceLogger(
            "connectAnyPortal"
        );
        debug("portalCache=%s", this.getPortalURLs());
        while (this.portalCache.size > 0) {
            // sort by latest connection success date
            const entries = [...this.portalCache.entries()];
            const now = Date.now();
            /*
             * EARLIEST_FAIL         LAST_FAIL    NOW             NEXT_TRY
             *      |-------- T ---------|---------- T*FACTOR -------->
             *                                     |-------- t ------->
             */
            const FACTOR = 1.2;
            const compute = (p: PortalCacheInfo): number => {
                const e = p.earliestConnectionFailTime;
                if (!e) {
                    return 0;
                }
                const l = p.lastConnectionFailTime || e;
                return Math.min(
                    Math.max(l + (l - e) * FACTOR - now, 3000),
                    30 * 1000
                );
            };
            entries.sort((a, b) => {
                const aTime = compute(a[1]);
                const bTime = compute(b[1]);
                return aTime - bTime; // if A = 10 and B = 20 then prefer A
            });
            const [url, ent] = entries[0];
            const delay = compute(ent);
            debug("next url=%s, ent=%j, delay=%d (msec)", url, ent, delay);
            if (delay > 0) {
                await this.cleaner.delay(this, delay);
            }
            try {
                debug("trying %s", url);
                const pc = await this.connectPortal(url);
                info("connected %s", pc);
                return pc;
            } catch (err) {
                info("got %s", err);
            }
        }
        info("no portal node is available");
        throw new Error("no portal node is available");
    }

    public getAgentString(): string {
        let ag: string;
        if (isNode) {
            ag = process.release?.name || "node";
            ag += " " + process.version;
            ag += ", " + process.platform;
        } else {
            ag = navigator?.userAgent || "unknownBrowser";
        }
        return ag;
    }

    /*
     * Debugging
     */
    /**
     * disable outgoing messages (for simulating failures)
     */
    public mute(): void {
        this.isMuted = true;
        this.mgrLogger.debug("mute");
    }

    /**
     * enable outgoing messages (for simulating failures)
     */
    public unmute(): void {
        this.isMuted = false;
        this.mgrLogger.debug("unmute");
        this.rawConnections.forEach((raw) => {
            raw.flushUnsentMessage();
        });
    }

    public dumpConnections(): void {
        console.log(this.getManagerInfoString());
    }

    public dumpConnectionsToLog(): void {
        this.mgrLogger.debug("%s", this.getManagerInfoString());
    }

    public getManagerInfoString(): string {
        const W = 80;
        const bar = (h: string): string =>
            `-- ${h} ` + "-".repeat(Math.max(W - 4 - h.length, 10));
        return [
            bar("PeerConnections"),
            this.peerConnections
                .filter((pc) => !!pc)
                .map((pc) => `  [${pc.localConnId}] ${pc}`)
                .join("\n"),
            bar("RawConnections"),
            this.rawConnections
                .filter((raw) => !!raw)
                .map((raw) => `  [${raw.id}] ${raw}`)
                .join("\n"),
            bar("Indirect Nodes"),
            `${[...this.indirectNodes.values()]}`,
            bar("Suspicious Nodes"),
            `${[...this.suspiciousNodes.values()]}`,
            "-".repeat(W),
        ].join("\n");
    }

    public createLogger(nameSpace: string, additionalPrefix?: string): Logger {
        return new Logger(
            this.nodeId,
            nameSpace,
            additionalPrefix || "",
            this.logSender
        );
    }

    public getLogger(loggerId: string): Logger {
        let logger = this.appLoggers.get(loggerId);
        if (!logger) {
            logger = this.createLogger(loggerId, "static");
            this.appLoggers.set(loggerId, logger);
        }
        return logger;
    }
}
