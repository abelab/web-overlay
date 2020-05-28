import { NETWORK_ID_KIRIN } from "@/common/networkId";
<template>
    <div class="ddll">
        <h1>Web-Overlay Demo</h1>
        <form @submit.prevent="joinLeave">
            <table>
                <tr>
                    <td>Network ID:</td>
                    <td>{{ networkId }}</td>
                </tr>
                <tr>
                    <td>Overlay:</td>
                    <td>{{ isKirin ? "Kirin" : "DDLL" }}</td>
                </tr>
                <tr>
                    <td>Introducer URL:</td>
                    <td><input type="text" v-model="introducerURL" /></td>
                </tr>
                <tr>
                    <td>Log Server URL:</td>
                    <td><input type="text" v-model="loggerURL" /></td>
                </tr>
                <tr>
                    <td>Key:</td>
                    <td>
                        <input
                            type="text"
                            v-model="key"
                            placeholder="Enter Unique Key"
                        />
                    </td>
                </tr>
            </table>
            <button
                :disabled="
                    (!isJoinable && !isLeavable) ||
                    key === '' ||
                    status === 'INS' ||
                    status === 'DEL'
                "
                class="btn-square"
                type="submit"
            >
                {{
                    status === "OUT"
                        ? "Join"
                        : status === "INS"
                        ? "Joining"
                        : status === "IN"
                        ? "Leave"
                        : status === "DEL"
                        ? "Leaving"
                        : "?"
                }}
            </button>
        </form>
        <table v-if="status !== 'OUT'">
            <tr>
                <th>DDLL State</th>
                <th>Left Key</th>
                <th>Right Key</th>
                <th>Left PCID</th>
                <th>Right PCID</th>
                <th>Left Seq.</th>
                <th>Right Seq.</th>
            </tr>
            <tr>
                <td>{{ status }}</td>
                <td>"{{ leftLink ? leftLink.getRemoteKey() : "N/A" }}"</td>
                <td>"{{ rightLink ? rightLink.getRemoteKey() : "N/A" }}"</td>
                <td>{{ leftLink ? leftLink.getLocalConnId() : "N/A" }}</td>
                <td>{{ rightLink ? rightLink.getLocalConnId() : "N/A" }}</td>
                <td>{{ leftSeq }}</td>
                <td>{{ rightSeq }}</td>
            </tr>
        </table>
        <div class="nav">
            <span v-if="isKirin">
                <a @click="pane = 'FingerTable'">Finger Table</a> |
            </span>
            <a @click="pane = 'Connections'">Connections</a> |
            <a @click="pane = 'Topology'">Topology</a> |
            <a @click="pane = 'Chat'">Chat</a> |
            <a @click="pane = 'About'">About</a>
        </div>
        <FingerTable
            v-if="pane === 'FingerTable'"
            :finger-table="fingerTable"
        />
        <Connections
            v-if="pane === 'Connections'"
            :raw-connections="rawConnections"
            :peer-connections="peerConnections"
            :indirect-nodes="indirectNodes"
            :suspicious-nodes="suspiciousNodes"
        />
        <keep-alive
            ><Topology v-if="pane === 'Topology'" :ddllnode="ddllnode"
        /></keep-alive>
        <keep-alive><Chat v-if="pane === 'Chat'" :app="chatApp" /></keep-alive>
        <About v-if="pane === 'About'" />
    </div>
</template>

<script lang="ts">
import { Component, Vue } from "vue-property-decorator";
import {
    Cleaner,
    keepAwakeSafari,
    Logger,
    Manager,
    ManagerConfig,
    PeerConnection,
    RawConnection,
} from "@web-overlay/manager";
import {
    createPStoreClass,
    DdllNode,
    KirinNode,
    PStoreDdll,
    Status,
} from "@web-overlay/kirin";
import Connections from "@/components/Connections.vue";
import Topology from "@/components/Topology.vue";
import Chat from "@/components/Chat.vue";
import About from "@/views/About.vue";
import FingerTable from "@/components/FingerTable.vue";
import { ChatApp } from "@/common/chat";

@Component({
    components: { FingerTable, Connections, Topology, Chat, About },
})
export default class Main extends Vue {
    public isKirin = false;
    public introducerURL =
        document.location.protocol + "//" + document.location.host;
    public loggerURL?: string;
    public networkId?: string;
    public key = "";
    public manager?: Manager;
    public ddllnode: DdllNode | null = null;
    public kirinnode: KirinNode | null = null;
    public pStoreNode: PStoreDdll | null = null;
    public isJoinable = false;
    public isLeavable = false;
    public leftLink: PeerConnection | null = null;
    public rightLink: PeerConnection | null = null;
    public leftSeq = "";
    public rightSeq = "";
    public status = Status[Status.OUT];
    public pane = "";
    public peerConnections: Array<PeerConnection> = [];
    public rawConnections: Array<RawConnection> = [];
    public indirectNodes: Array<string> = [];
    public suspiciousNodes: Array<string> = [];
    public fingerTable: Array<Array<PeerConnection>> = [[], []];
    public logger = new Logger("GUI", "GUI", "");
    public remoteConfig?: ManagerConfig;
    protected cleaner?: Cleaner;
    public chatApp?: ChatApp;

    constructor() {
        super();
    }

    public async mounted(): Promise<void> {
        const config = await this.fetchConfig();
        this.remoteConfig = config;
        this.isKirin = (config as any).OVERLAY === "kirin";
        this.networkId = config.NETWORK_ID || "unknown";
        this.loggerURL = config.LOG_SERVER_URL;
        this.isJoinable = true;
    }

    private async fetchConfig(): Promise<ManagerConfig> {
        const url = `${document.location.protocol}//${document.location.host}/config.js`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error("fetch failed");
        }
        const config = (await response.json()) as ManagerConfig;
        console.log("JSON=", JSON.stringify(config));
        return config;
    }

    public async joinLeave(): Promise<void> {
        if (this.isJoinable) {
            if (this.key === "") {
                return;
            }
            keepAwakeSafari();
            this.isJoinable = false;
            this.cleaner = new Cleaner(this.logger);
            this.manager = new Manager(this.remoteConfig);
            let ddllnode: DdllNode;
            if (this.isKirin) {
                const clazz = createPStoreClass(KirinNode);
                const kirinnode = (new clazz(
                    this.key,
                    this.manager
                ) as unknown) as KirinNode;
                this.kirinnode = kirinnode;
                ddllnode = kirinnode;
            } else {
                const clazz = createPStoreClass(DdllNode);
                ddllnode = new clazz(this.key, this.manager);
            }
            this.pStoreNode = ddllnode as PStoreDdll;
            this.$set(this, "ddllnode", ddllnode);
            this.cleaner.startIntervalTimer(
                this.manager,
                "ddllvue.connectionObserveTimer",
                1000,
                () => {
                    const pcs = this.manager?.getPeerConnections();
                    this.$set(this, "peerConnections", pcs);
                    const raws = this.manager?.getRawConnections();
                    this.$set(this, "rawConnections", raws);
                    this.$set(this, "leftSeq", ddllnode?.lseq?.toString());
                    this.$set(this, "rightSeq", ddllnode?.rseq?.toString());
                    this.$set(this, "rightSeq", ddllnode?.rseq?.toString());
                    this.$set(
                        this,
                        "indirectNodes",
                        this.manager?.getIndirectNodes()
                    );
                    this.$set(
                        this,
                        "suspiciousNodes",
                        this.manager?.getSuspiciousNodes()
                    );
                }
            );
            this.manager.cleaner.push(() => {
                this.$set(this, "peerConnections", []);
                this.$set(this, "rawConnections", []);
            });
            ddllnode.addStatusChangeListener((status) => {
                this.$set(this, "status", Status[status]);
            });
            const leftRightSetter = (name: string) => (pc: PeerConnection) => {
                this.$set(this, name, pc);
            };
            ddllnode.addLeftNodeChangeListener(leftRightSetter("leftLink"));
            ddllnode.addRightNodeChangeListener(leftRightSetter("rightLink"));
            leftRightSetter("leftLink")(ddllnode.left!);
            leftRightSetter("rightLink")(ddllnode.right!);
            if (this.isKirin) {
                const fingerTableSetter = (): void => {
                    const ffts = this.kirinnode?.getFFT();
                    const bfts = this.kirinnode?.getBFT();
                    this.$set(this, "fingerTable", [ffts, bfts]);
                };
                this.kirinnode?.addFingertableUpdateListeners(
                    fingerTableSetter
                );
                fingerTableSetter();
            }
            try {
                await ddllnode.join(this.introducerURL);
                this.chatApp = new ChatApp(ddllnode);
                this.isLeavable = true;
                this.$swal({
                    title: "joined!",
                });
            } catch (err) {
                console.warn("join got: ", err);
                await this.manager?.destroy();
                this.cleaner.clean();
                this.isJoinable = true;
                this.$swal({
                    title: "join failed!",
                    icon: "error",
                    text: err.message,
                });
            }
        } else if (this.isLeavable) {
            this.isLeavable = false;
            await this.ddllnode?.leave();
            this.leftLink = this.rightLink = null;
            this.leftSeq = this.rightSeq = "";
            this.status = Status[Status.OUT];
            this.fingerTable = [[], []];
            await this.manager?.destroy();
            this.cleaner!.clean();
            this.isJoinable = true;
        }
    }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
input {
    width: 20em;
}
.nav {
    background-color: #afeeee;
}
</style>
