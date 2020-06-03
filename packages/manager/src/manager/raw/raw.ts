import { Deferred } from "../../utils";
import { Manager, TimeoutError } from "../manager";
import { Logger } from "../logger";
import {
    ClosePeerConnection,
    GracefulCloseRawConnection,
    Message,
    NoNextHopNotify,
} from "../messages";
import { PeerConnection } from "../peerconnection";
import { ClassNotFoundException, SerializeUtils } from "../serialize";
import { Path } from "../path";
import { Cleanable, Cleaner } from "../cleaner";

export enum RawConnectionType {
    NotConnected,
    Relay,
    Loopback,
    WebServerSocket,
    WebClientSocket,
    WebRTC,
}

/**
 * A class that represents a raw connection such as WebRTC and WebSocket.
 */
export abstract class RawConnection implements Cleanable {
    public static readonly CONNECT_TIMER_NAME = "raw-connect";
    public static readonly IDLE_TIMER_NAME = "raw-idle";
    public static readonly GRACE_CLOSE_DELAY_TIMER_NAME = "grace-delay";
    public id?: number; // filled by Manager.registerRawConnection()
    protected isGracefullyClosed = false;
    private _isConnected = false;
    protected onceConnected = false;
    private readonly _manager: Manager;
    protected readonly logger: Logger;
    private remoteNodeId: string | undefined;
    // completes when connection is ready
    private readonly connectDefer = new Deferred<RawConnection /*this*/>();
    protected lastUsed = Date.now();
    // messages that are sent during silent mode
    private readonly unsentMessages: Message[] = [];
    public readonly cleaner: Cleaner;

    /**
     * constructor
     * @param _manager
     */
    protected constructor(_manager: Manager) {
        this._manager = _manager;
        this.logger = _manager.rawLogger;
        this.cleaner = new Cleaner(this.logger);
        _manager.registerRawConnection(this);

        // this timer is canceled when connection is established
        this.cleaner.startTimer(
            _manager,
            RawConnection.CONNECT_TIMER_NAME,
            this.manager.config.MAX_RAWCONNECTION_ESTABLISH_TIME,
            () => {
                this.logger.info("raw timeout: %s", this);
                this.connectFailed(
                    new TimeoutError(
                        `rawConnection establishment timeout (${this})`
                    )
                );
            }
        );
    }

    public abstract getConnectionType(): RawConnectionType;

    protected connected(): void {
        this.cleaner.cancelTimer(RawConnection.CONNECT_TIMER_NAME);
        this.onceConnected = this._isConnected = true;
        this.resetIdleTimer();
        this.connectDefer.resolve(this);
    }

    protected connectFailed(err: Error): void {
        this._isConnected = false;
        this.connectDefer.reject(err);
        this.destroy();
    }

    public get promise(): Promise<RawConnection> {
        return this.connectDefer.promise;
    }

    protected resetIdleTimer(): void {
        this.lastUsed = Date.now();
        if (this.getConnectionType() !== RawConnectionType.Loopback) {
            this.cleaner.startTimer(
                this.manager,
                RawConnection.IDLE_TIMER_NAME,
                this.manager.config.MAX_IDLE_TIME_BEFORE_RAW_CLOSE,
                () => {
                    this.logger.debug("close by idle: %s", this);
                    this.close();
                }
            );
        }
    }

    public setRemoteNodeId(nodeId: string): void {
        this.remoteNodeId = nodeId;
        this.manager.registerRawConnection(this);
    }

    public getRemoteNodeId(): string | undefined {
        return this.remoteNodeId;
    }

    public get manager(): Manager {
        return this._manager;
    }

    public isConnected(): boolean {
        return this._isConnected;
    }

    public isAvailable(): boolean {
        return this.isConnected() && !this.isGracefullyClosed;
    }

    public getDirectPath(remoteConnId?: number): Path {
        const remid = this.getRemoteNodeId();
        if (!remid) {
            throw new Error("remoteNodeId is unset: " + this);
        }
        return new Path([this.manager.getNodeId(), remid], remoteConnId);
    }

    /**
     * send a message.
     * @param msg
     */
    public send(msg: Message): void {
        this.resetIdleTimer();
        if (!msg.source) {
            msg.initSource();
        }
        msg.prepareForAck(this);
        if (
            this.manager.isMuted &&
            this.remoteNodeId !== this.manager.getNodeId()
        ) {
            this.logger.info("RawConnection.send: not send (muted): %s", msg);
            this.unsentMessages.push(msg);
        } else {
            this.logger.debug("RawConnection.send: send %s via %s", msg, this);
            this._sendRaw(msg);
        }
    }

    public flushUnsentMessage(): void {
        while (this.unsentMessages.length > 0) {
            const msg = this.unsentMessages.shift();
            if (msg) {
                this._sendRaw(msg);
            }
        }
    }

    protected abstract _sendRaw(data: object): void;

    // subclasses call this method when a message is received
    protected receive(message: Message): void {
        // reset the connection idle timer
        this.resetIdleTimer();
        let msg: Message;
        try {
            msg = SerializeUtils.restorePrototype(message);
            msg.afterRestore(this.manager);
        } catch (e) {
            if (e instanceof ClassNotFoundException) {
                this.logger.warn(
                    "RawMessage.onReceive: ignore unknown class message: %s, %j",
                    e.className,
                    message
                );
                return;
            }
            throw e;
        }
        msg.updateSource();
        msg.rawConnection = this;
        this.logger.debug("RawConnection.onReceive: %s via %s", message, this);
        msg.sendAckIfNecessary(this);
        if (msg.destNodeId && msg.destNodeId !== this.manager.getNodeId()) {
            // this message is not sent to me.
            // forward along with message.destination
            msg.forward();
            return;
        }
        let pc: PeerConnection | undefined = undefined;
        if (msg.destination) {
            const cid = msg.destination.connId;
            if (cid !== null && cid !== undefined) {
                pc = this.manager.peerConnections[cid];
                if (!pc) {
                    this.logger.warn(
                        "No target PeerConnection (PCID=%s): %s",
                        cid,
                        msg
                    );
                    if (!(msg instanceof ClosePeerConnection)) {
                        const close = new ClosePeerConnection(
                            this.manager,
                            cid,
                            `No target PeerConnection (${cid}), cause=${msg}`
                        );
                        close.forward(msg.source);
                    }
                    return;
                }
            }
        }
        msg.peerConnection = pc;
        // to make possible to resend this message
        msg.destination = undefined;

        if (pc) {
            // this.manager.logger.log("has PeerConnection");
            pc.onReceive(msg);
        } else {
            // this.manager.logger.log("has no PeerConnection");
            this.manager.receive(message);
        }
    }

    public handleGracefulClose(): void {
        this.isGracefullyClosed = true;
        // make sure this connection is not used any more
        this.manager.unregisterRawConnection(this);
    }

    /**
     * subclasses calls this when RawConnection is closed.
     */
    protected disconnected(): void {
        if (this.onceConnected && !this.isGracefullyClosed) {
            const remoteNodeId = this.getRemoteNodeId();
            if (remoteNodeId) {
                this.manager._registerSuspiciousNode(remoteNodeId);
            }
        }
        this.destroy();
    }

    /**
     * gracefully close the rawConnection.
     */
    public close(): void {
        const msg = new GracefulCloseRawConnection(this.manager);
        this.send(msg);
        this.isGracefullyClosed = true;
        // delay actual close to make sure that GracefulClose is received
        // in prior to "disconnect" event
        this.manager.cleaner.startTimer(
            this.manager,
            RawConnection.GRACE_CLOSE_DELAY_TIMER_NAME,
            100,
            () => this.destroy()
        );
    }

    public destroy(): void {
        this.logger.debug("raw.destroy: %s", this);
        this._isConnected = false;
        this.connectDefer.reject(new Error("RawConnection is destroyed"));

        // destroy affected PeerConnections
        const remoteNodeId = this.getRemoteNodeId();
        if (
            remoteNodeId &&
            this.manager.getNodeId() !== remoteNodeId // XXX: not to close Loopback connection!
        ) {
            this.manager.removeDeadLink(this.manager.getNodeId(), remoteNodeId);
        }

        // Clean Ack-waiters
        const notifySent = new Set<string>();
        for (const ackStat of this.manager.unAckedMessages.values()) {
            if (ackStat.destRaw !== this) {
                continue;
            }
            const msg = ackStat.message;
            if (
                remoteNodeId &&
                !notifySent.has(remoteNodeId) &&
                msg.srcNodeId !== this.manager.getNodeId() &&
                msg.source
            ) {
                const notify = new NoNextHopNotify(
                    this.manager,
                    msg.source,
                    this.manager.getNodeId(),
                    remoteNodeId
                );
                notify.forward();
                notifySent.add(remoteNodeId);
            }
            ackStat.destroy();
        }

        this.unsentMessages.splice(0, this.unsentMessages.length);
        this.cleaner.clean();
    }

    public getRemoteIPAddress(): string | undefined {
        return undefined;
    }

    protected formatIdleTime(): string {
        return `idle=${(Date.now() - this.lastUsed)
            .toString()
            .padStart(5, "0")}`;
    }
}
