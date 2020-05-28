import { Manager } from "../manager";
import { Message } from "../messages";
import { RawConnection, RawConnectionType } from "./raw";
import { override } from "core-decorators";
/*
 * We have used setTimeout(job, 0) for sending loopback message but it was turned out
 * that job execution is sometimes very delayed in Safari.  So, we use this package.
 */
require("setimmediate");

/**
 * 常に自ノードと接続している RawConnection
 */
export class LoopbackConnection extends RawConnection {
    public constructor(manager: Manager) {
        super(manager);
        this.setRemoteNodeId(manager.getNodeId());
        manager.registerRawConnection(this);
        this.connected();
    }

    public getConnectionType(): RawConnectionType {
        return RawConnectionType.Loopback;
    }

    protected _sendRaw(data: Message): void {
        this.lastUsed = Date.now();
        const copy: Message = JSON.parse(JSON.stringify(data));
        setImmediate(() => {
            this.logger.newEvent("loopback: sendRaw");
            super.receive(copy);
        });
    }

    @override
    protected resetIdleTimer(): void {
        return;
    }

    public close(): void {
        this.manager.mgrLogger.warn("Loopback connection is closed!");
        console.warn(new Error("stacktrace"));
        return; // do not call super.close()
    }

    public toString(): string {
        return `Loopback[id=${this.id}, ${this.formatIdleTime()}]`;
    }
}
