import * as SimplePeer from "simple-peer";
import { Callbacks, quote } from "../../utils";
import { Manager } from "../manager";
import { Message } from "../messages";
import { RawConnection, RawConnectionType } from "./raw";
import { serializable } from "../serialize";
import { Path } from "../path";
import getBrowserRTC = require("get-browser-rtc");

const isNode = import("detect-node");

/**
 * A message used for WebRTC-signaling
 */
@serializable
export class WebRTCSignal extends Message {
    public sdp: string;

    constructor(
        manager: Manager,
        destination: Path,
        public targetPeerConnectionId: number | undefined,
        sdp: string
    ) {
        super(manager, destination);
        this.sdp = sdp;
    }

    public toString(): string {
        return `[WebRTCSignal srcNodeId=${this.srcNodeId}, dest=${this.destination}, targetPCID=${this.targetPeerConnectionId}, sdp=...]`;
    }

    public onReceive(): void {
        const manager = this.manager;
        let raw: RawConnection | undefined;
        const logger = manager.rawLogger;
        if (this.targetPeerConnectionId !== undefined) {
            const pc = this.manager.getPeerConnection(
                this.targetPeerConnectionId
            );
            if (pc) {
                raw = pc.getRawConnection();
            }
        } else {
            // renegotiation case
            raw = this.rawConnection;
        }
        if (!raw) {
            logger.info(
                "WebRTCSignal.onReceive: RawConnection is unknown: %s",
                this
            );
            return;
        }
        if (!(raw instanceof WebRTCConnection)) {
            logger.error(
                "WebRTCSignal.onReceive: not WebRTCConnection: %s",
                this
            );
            return;
        }
        logger.debug("WebRTCSignal.onReceive: signal to %s", raw);
        raw.signaling(this.sdp);
    }
}

/**
 * 1本のWebRTCコネクションを表すクラス
 */
export class WebRTCConnection extends RawConnection {
    private readonly simplePeer: SimplePeer.Instance;
    private readonly _isInitiator: boolean;
    private readonly onSignal: (sdp: string, count: number) => void;
    private signalCount = 0;
    private readonly remoteIPs = new Set<string>();
    private streamListeners = new Callbacks<MediaStream>();

    /**
     * @param manager     Manager
     * @param sdp         SDP (answer side) or undefined (offer side)
     * @param onSignal
     * @throws Error if webrtc is not supported
     */
    constructor(
        manager: Manager,
        sdp: string | undefined,
        onSignal: (data: string /*| null*/, count: number) => void
    ) {
        super(manager);
        this.onSignal = onSignal;
        this._isInitiator = !sdp;
        const option: SimplePeer.Options = {
            config: {
                iceServers: this.manager.config.STUN_SERVERS,
            },
            initiator: this._isInitiator,
            // workaround for addTrack does not work from non-initiator
            // https://github.com/feross/simple-peer/issues/95
            offerConstraints: {
                offerToReceiveAudio: !isNode && this._isInitiator,
                offerToReceiveVideo: !isNode && this._isInitiator,
            },
            trickle: this.manager.config.TRICKLE_ICE,
            wrtc: manager.config.WEBRTC_IMPL,
        };
        try {
            this.simplePeer = new SimplePeer(option);
        } catch (err) {
            this.promise.catch((err) => {
                /* ignore */
            });
            this.destroy();
            throw err;
        }
        this.simplePeer.on("signal", (sdp: string) => {
            this.logger.newEvent("webrtc: signal");
            if (this.isConnected()) {
                this.logger.debug("WebRTCConnection: renegotiation!");
                const msg = new WebRTCSignal(
                    this.manager,
                    this.getDirectPath(),
                    undefined,
                    sdp
                );
                msg.forward();
            } else {
                this.onSignal(sdp, this.signalCount++);
            }
        });
        this.simplePeer.on("close", () => {
            this.logger.newEvent("webrtc: close");
            this.disconnected();
        });
        this.simplePeer.on("connect", () => {
            this.logger.newEvent("webrtc: connect");
            this.connected();
        });
        this.simplePeer.on("error", (err) => {
            this.logger.newEvent("webrtc: error: " + err.toString());
            const remNodeId = this.getRemoteNodeId();
            if (remNodeId) {
                this.manager._registerIndirectNode(remNodeId);
            }
            this.connectFailed(new Error("WebRTC connection fails"));
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.simplePeer.on("data", (data: any) => {
            // this.logger.newEvent("webrtc: data");
            // this.logger.debug("got message: ", data);
            // "connect" よりも先に "data" が来ることがある
            if (!this.isConnected()) {
                this.connected();
            }
            const message: Message = JSON.parse(data);
            super.receive(message);
        });
        this.simplePeer.on("stream", (stream: MediaStream) => {
            this.logger.newEvent("webrtc: stream");
            this.streamListeners.invoke(stream);
        });
        if (sdp) {
            // on connect side, give sdp to simple-peer
            this.signaling(sdp);
        }
    }

    public getConnectionType(): RawConnectionType {
        return RawConnectionType.WebRTC;
    }

    public toString(): string {
        // depends on simple-peer internal
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = this.simplePeer as any;
        let remote = "unknown";
        if (p && p.remoteAddress && p.remotePort) {
            remote = `${p.remoteAddress}:${p.remotePort}`;
        }
        return [
            `WebRTC[id=${this.id}`,
            `remNodeId=${quote(this.getRemoteNodeId())}`,
            `${["DISCONNECTED", "CONNECTED"][+this.isConnected()]}`,
            `graceClose=${this.isGracefullyClosed}`,
            `remoteIP=${remote}`,
            `${this.formatIdleTime()}]`,
        ].join(", ");
    }

    public destroy(): void {
        if (this.simplePeer) {
            this.simplePeer.destroy();
        }
        super.destroy();
    }

    /**
     * simple peerのsignalメソッドにdataを渡す
     *
     * @param data
     */
    public signaling(data: string | SimplePeer.SignalData): void {
        // simple-peer dependent!!
        const sdata = data as SimplePeer.SignalData;
        if (sdata.candidate && sdata.candidate.candidate) {
            // this.logger.debug("ICE: candidate=", data.candidate.candidate);
            const ip = WebRTCConnection.getIpAddressFromCandidateAttribute(
                sdata.candidate.candidate
            );
            this.remoteIPs.add(ip);
        }
        this.simplePeer.signal(data);
    }

    private static getIpAddressFromCandidateAttribute(str: string): string {
        // candidate:1081113813 1 udp 2113937151 10.35.159.202 56667 typ host generation 0 ufrag /L8A network-cost 50
        const a = str.split(" ");
        const ip = a[4];
        return ip;
        /*
        const proto = a[2];
        const port = a[5];
        return `${proto}/${ip}/${port}`;
        */
    }

    protected _sendRaw(_data: Message): void {
        try {
            this.simplePeer.send(JSON.stringify(_data));
        } catch (err) {
            this.logger.warn("simplePeer.send throws %s", err);
        }
    }

    public isInitiator(): boolean {
        return this._isInitiator;
    }

    public static isWebRTCSupported(): boolean {
        return !!getBrowserRTC();
    }

    /*
     * Stream support
     */
    public addStreamListener(cb: (_: MediaStream) => void): void {
        this.streamListeners.addCallback(cb);
    }

    public addStream(stream: MediaStream): void {
        this.simplePeer.addStream(stream);
    }

    public removeStream(stream: MediaStream): void {
        this.simplePeer.removeStream(stream);
    }

    public addTrack(track: MediaStreamTrack, stream: MediaStream): void {
        this.simplePeer.addTrack(track, stream);
    }

    public removeTrack(track: MediaStreamTrack, stream: MediaStream): void {
        this.simplePeer.removeTrack(track, stream);
    }
}
