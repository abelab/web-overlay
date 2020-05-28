import * as socketIO from "socket.io";
import {
    Manager,
    Message,
    RawConnection,
    RawConnectionType,
} from "../../manager";
import { quote } from "../../utils";

/**
 * Socket.IO server connection
 */
export class WsServerConnection extends RawConnection {
    private readonly localWsId: string;
    private readonly socket: socketIO.Socket;

    constructor(_manager: Manager, sock: socketIO.Socket) {
        super(_manager);
        this.socket = sock;
        this.localWsId = sock.id;
        sock.on("message", (_json: string) => {
            this.logger.newEvent("websocket-server: message");
            const msg: Message = JSON.parse(_json);
            super.receive(msg);
        });
        sock.on("disconnect", (reason: string) => {
            this.logger.newEvent(
                "websocket-server: disconnect: reason=%s",
                reason
            );
            if (reason !== "server namespace disconnect") {
                this.disconnected();
            }
        });
        this.connected();
    }

    public getConnectionType(): RawConnectionType {
        return RawConnectionType.WebServerSocket;
    }

    public toString(): string {
        // see https://stackoverflow.com/questions/6280818/socket-io-how-to-get-the-client-transport-type-on-the-serverside
        const transport = this.socket.conn?.transport?.name || "unknown";
        return [
            `Socket.IO(Server)[id=${this.id}`,
            `remNodeId=${quote(this.getRemoteNodeId())}`,
            // `WsId=${quote(this.localWsId)}`,
            `${["DISCONNECTED", "CONNECTED"][+this.isConnected()]}`,
            `transport=${transport}`,
            `graceClose=${this.isGracefullyClosed}`,
            `${this.formatIdleTime()}]`,
        ].join(", ");
    }

    public _sendRaw(_data: object): void {
        const json = JSON.stringify(_data);
        this.socket.send(json);
    }

    public destroy(): void {
        this.logger.debug("WsServerConnection.destroy: %s", this);
        this.socket.disconnect(true);
        super.destroy();
    }

    public getClientIPAddress(): string | undefined {
        return this.socket?.conn?.remoteAddress;
    }
}
