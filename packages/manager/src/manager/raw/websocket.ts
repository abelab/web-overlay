import * as io from "socket.io-client";
import { Manager } from "../manager";
import { RawConnection, RawConnectionType } from "./raw";
import {
    Message,
    ReplyMessage,
    RequestMessage,
    RequestMessageSpec,
} from "../messages";
import { quote } from "../../utils";
import { serializable } from "../serialize";
import { override } from "core-decorators";

/**
 * A message to bind WebServerSocketConnection and PeerConnection at a portal node.
 */
@serializable
export class Hello extends RequestMessage<Hello, HelloReply> {
    public readonly networkId: string | undefined;

    constructor(manager: Manager, public url?: string) {
        super(manager);
        this.networkId = manager.networkId;
    }

    @override
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: HelloReply.name,
            noAck: true,
        };
    }

    public toString(): string {
        return `<Hello, srcNodeId=${this.srcNodeId}, url=${this.url}>`;
    }

    public onReceive(): void {
        const manager = this.manager;
        const logger = manager.rawLogger;
        const raw = this.rawConnection as WsConnection;
        const nodeId = this.srcNodeId as string;
        raw.setRemoteNodeId(nodeId);
        logger.debug("Hello.onReceive: %s", raw);
        const clientIP = this.rawConnection?.getRemoteIPAddress();
        const defer = this.manager.getHelloDefer(nodeId, false);
        if (!manager.networkId || manager.networkId === this.networkId) {
            if (defer) {
                defer.resolve(raw);
            }
            if (this.url) {
                manager.addPortalURL(this.url);
            }
            const reply = new HelloReply(
                this,
                "ok",
                manager.getNodeId(),
                manager.getPortalURLs(),
                clientIP
            );
            this.sendReply(reply);
        } else {
            if (defer) {
                defer.reject(new Error("networkID mismatch"));
            }
            const reply = new HelloReply(
                this,
                "networkId mismatch",
                manager.getNodeId(),
                [],
                undefined
            );
            this.sendReply(reply);
            raw.close();
        }
    }
}

@serializable
export class HelloReply extends ReplyMessage<Hello, HelloReply> {
    constructor(
        req: Hello,
        public readonly reply: string,
        public readonly nodeId: string,
        public readonly urls: string[],
        public readonly yourAddress: string | undefined
    ) {
        super(req);
    }
}

/**
 * Socket.IO client connection
 */
export class WsConnection extends RawConnection {
    // the URL of remote node
    protected readonly url: string;
    protected localWsId?: string; // socket.io's ID
    private socket?: SocketIOClient.Socket;
    public myAddress?: string;

    /**
     * 指定された NodeID あるいは URL と接続済みのRawConnectionがあれば，返す．
     * 存在しない場合，指定された URL と WebSocketコネクション確立を試み，接続試行中の RawConnection を返す．
     *
     * @param manager
     * @param url
     * @param nodeId
     * @return RawConnection
     */
    public static async getConnection(
        manager: Manager,
        url: string,
        nodeId?: string
    ): Promise<RawConnection> {
        const logger = manager.rawLogger;
        logger.debug(
            "WsConnection.getConnection, url=%s, nodeId=%s",
            url,
            nodeId
        );
        const raw = nodeId
            ? manager.getRawConnectionByNodeId(nodeId)
            : undefined;
        if (raw) {
            logger.debug("use existing WsConnection");
            await raw.promise;
            return raw;
        }
        const wsc = new WsConnection(manager, url);
        await wsc.connect();
        return wsc;
    }

    constructor(manager: Manager, url: string) {
        super(manager);
        this.url = url;
    }

    public getConnectionType(): RawConnectionType {
        return RawConnectionType.WebClientSocket;
    }

    /**
     * get remote URL
     * @returns {string}
     */
    public getRemoteUrl(): string {
        return this.url;
    }

    public toString(): string {
        // see https://stackoverflow.com/questions/6280818/socket-io-how-to-get-the-client-transport-type-on-the-serverside
        const transport =
            (this.socket?.io as any)?.engine?.transport?.name || "unknown";

        return [
            `Socket.IO(Client)[id=${this.id}`,
            `remNodeId=${quote(this.getRemoteNodeId())}`,
            `url=${quote(this.url)}`,
            // `WsId=${quote(this.localWsId)}`,
            `${["DISCONNECTED", "CONNECTED"][+this.isConnected()]}`,
            `transport=${transport}`,
            `graceClose=${this.isGracefullyClosed}`,
            `myAddr=${this.myAddress}`,
            `${this.formatIdleTime()}]`,
        ].join(", ");
    }

    /**
     * Establish a Socket.IO connection (WsConnection) to the specified Socket.IO server.
     * When established, send Hello and wait for HelloReply.
     *
     * @return a promise that is completed when this connection is established
     */
    public connect(): Promise<RawConnection> {
        this.logger.debug(`WsConnection.connect: url=${this.url}`);
        let trans: string[];
        if (process.env.NODE_ENV === "test") {
            // disable "polling" on testing.
            // when "polling" is enabled, Node.js sometimes does not exit if we connect and disconnect Socket.io
            // connection very quickly (which is common in testing).
            trans = ["websocket"];
        } else {
            trans = ["polling", "websocket"];
        }
        this.socket = io(this.url, {
            // we do not use multiplexing of Socket.IO.
            multiplex: false,
            reconnection: false,
            timeout: this.manager.config.REPLY_TIMEOUT,
            transports: trans,
        });
        this.cleaner.push(() => {
            this.logger.debug("websocket: close!");
            this.socket?.close();
        });
        this.socket.on("connect", () => this.handleConnect());
        this.socket
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .on("connect_error", (err: any) => {
                this.logger.debug("socket.io: connect_error!: %s", err);
                this.connectFailed(
                    new Error("Socket.IO: connect error: " + this.url)
                );
            })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .on("connect_timeout", (err: any) => {
                this.logger.debug("socket.io: connect_timeout", err);
                this.connectFailed(
                    new Error("Socket.IO: connect timeout: " + this.url)
                );
            })
            .on("reconnect_failed", () => {
                this.logger.debug("socket.io: reconnect_failed");
            })
            .on("reconnect_attempt", () => {
                this.logger.debug("socket.io: reconnect_attempt");
            })
            .on("reconnecting", () => {
                this.logger.debug("socket.io: reconnecting");
            })
            .on("reconnect", () => {
                this.logger.debug("socket.io: reconnect");
            });
        return this.promise;
    }

    private async handleConnect(): Promise<void> {
        this.logger.newEvent("websocket established: " + this);
        // '/#' is required for socket.io 1.4.*
        this.localWsId = "/#" + this.socket!.id;
        this.socket!.on("message", (_json: string) => {
            this.logger.newEvent("websocket: message");
            const message: Message = JSON.parse(_json);
            // this.logger.debug("got message: " + prettyPrint(message));
            // this.logger.debug("raw: " + this);
            super.receive(message);
        });
        this.socket!.on("disconnect", (reason: string) => {
            this.logger.newEvent("websocket: disconnect: reason=%s", reason);
            if (reason !== "io client disconnect") {
                this.disconnected();
            }
        });
        let reply;
        try {
            const hello = new Hello(
                this.manager,
                this.manager.getNodeSpec().serverUrl
            );
            reply = await hello.request(this);
        } catch (err) {
            this.connectFailed(err);
            return;
        }
        this.myAddress = reply.yourAddress;
        if (reply.reply === "ok") {
            const nodeId = reply.nodeId;
            if (!nodeId) {
                throw new Error("should not happen");
            }
            this.setRemoteNodeId(nodeId);
            reply.urls.forEach((url) => this.manager.addPortalURL(url));
            this.connected();
        } else {
            this.connectFailed(new Error(reply.reply));
        }
    }

    /**
     * send a message over WebSocket connection
     *
     * @param _data message
     */
    protected _sendRaw(_data: object): void {
        if (!this.socket) {
            throw new Error("_sendRaw() before connected");
        }
        // Note that a Hello message is sent while not isConnected().
        // if (!this.isConnected()) {
        //     throw 'not connected ws server'
        // }
        const json = JSON.stringify(_data);
        this.socket.send(json);
    }
}
