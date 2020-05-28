import {
    Manager,
    Path,
    RawConnectionType,
    RequestMessageSpec,
    serializable,
} from "@web-overlay/manager";
import { MulticastReply, MulticastRequest } from "@web-overlay/kirin";

interface RawInfo {
    nodeId: string;
    type: RawConnectionType;
}

export interface InfoElement {
    key: string;
    nodeId: string;
    type: string;
    platform: string;
    paths: Path[];
    raws: RawInfo[];
    joinTime: number;
}

@serializable
export class GetInfoRequest extends MulticastRequest<
    GetInfoRequest,
    GetInfoReply
> {
    constructor(manager: Manager) {
        super(manager);
    }

    public getSpec(): RequestMessageSpec {
        return { ...super.getSpec(), replyClassName: GetInfoReply.name };
    }

    public onReceive(): void {
        const info: InfoElement = {
            key: this.ddll.getKey(),
            nodeId: this.manager.getNodeId(),
            platform: this.manager.getAgentString(),
            type: this.manager.getNodeSpec().serverUrl
                ? "Portal(" + this.manager.getNodeSpec().serverUrl + ")"
                : "Browser",
            paths: this.manager.getAllPaths(),
            raws: this.manager
                .getRawConnections()
                .filter((raw) => {
                    const dest = raw.getRemoteNodeId();
                    return (
                        raw.isConnected() &&
                        dest &&
                        dest !== this.manager.getNodeId()
                    );
                })
                .map((raw) => {
                    return {
                        nodeId: raw.getRemoteNodeId(),
                        type: raw.getConnectionType(),
                    } as RawInfo;
                }),
            joinTime: this.ddll.joinTime || 0,
        };
        const reply = new GetInfoReply(this, [info]);
        this.sendReply(reply);
    }
    public reduce(a: GetInfoReply, b: GetInfoReply): GetInfoReply {
        return new GetInfoReply(this, a.info.concat(b.info));
    }
}

@serializable
export class GetInfoReply extends MulticastReply<GetInfoRequest, GetInfoReply> {
    constructor(req: GetInfoRequest, public info: InfoElement[]) {
        super(req);
    }
}
