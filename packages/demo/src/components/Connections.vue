<template>
    <div class="connections">
        <h1>Connections</h1>
        <h2>PeerConnections</h2>
        <table>
            <tr>
                <th>Local PeerConnection ID</th>
                <th>Remote NodeId</th>
                <th>Remote PCID</th>
                <th>Local Key</th>
                <th>Remote Key</th>
                <th>State</th>
                <th>Paths</th>
                <th>Initiator?</th>
            </tr>
            <tr
                v-for="pc in getPeerConnections"
                v-bind:key="pc.getLocalConnId()"
            >
                <td>{{ pc.getLocalConnId() }}</td>
                <td>{{ pc.getRemoteNodeId() }}</td>
                <td>{{ pc.remoteConnId }}</td>
                <td>"{{ pc.getLocalKey() }}"</td>
                <td>"{{ safeRemoteKey(pc) }}"</td>
                <td>{{ toStringPeerConnectionState(pc) }}</td>
                <td>{{ pc.paths.join(", ") }}</td>
                <td>{{ pc.isConnectSide }}</td>
            </tr>
        </table>
        <h2>RawConnections</h2>
        <table>
            <tr>
                <th>RawConnection ID</th>
                <th>Remote NodeId</th>
                <!-- <th>Type</th> -->
                <th>Detail</th>
            </tr>
            <tr v-for="raw in getRawConnections" v-bind:key="raw.id">
                <td>{{ raw.id }}</td>
                <td>{{ raw.getRemoteNodeId() }}</td>
                <!-- <td>{{ toStringRawConnectionState(raw) }}</td> -->
                <td>{{ raw.toString() }}</td>
            </tr>
        </table>
        <h2>Indirect Nodes</h2>
        {{ indirectNodes }}
        <h2>Suspicious Nodes</h2>
        {{ suspiciousNodes }}
    </div>
</template>

<script lang="ts">
import { Component, Prop, Vue } from "vue-property-decorator";
import {
    PeerConnection,
    PeerConnectionState,
    RawConnection,
    RawConnectionType,
} from "@web-overlay/manager";

@Component
export default class Connections extends Vue {
    @Prop() public peerConnections?: Array<PeerConnection>;
    @Prop() public rawConnections?: Array<RawConnection>;
    @Prop() public indirectNodes?: Array<string>;
    @Prop() public suspiciousNodes?: Array<string>;

    public get getPeerConnections(): Array<PeerConnection> {
        return this.peerConnections || [];
    }

    public get getRawConnections(): Array<RawConnection> {
        return this.rawConnections || [];
    }

    public safeRemoteKey(pc: PeerConnection): string {
        try {
            return pc.getRemoteKey();
        } catch (err) {
            return "N/A";
        }
    }

    public toStringPeerConnectionState(pc: PeerConnection) {
        return PeerConnectionState[pc.getConnectionState()];
    }

    public toStringRawConnectionState(raw: RawConnection) {
        return RawConnectionType[raw.getConnectionType()];
    }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped></style>
