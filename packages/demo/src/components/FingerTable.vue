<template>
    <div class="fingertable">
        <h1>Finger Table</h1>
        <table>
            <tr>
                <th colspan="3">Backward Finger Table</th>
                <th rowspan="2">Level</th>
                <th colspan="3">Forward Finger Table</th>
            </tr>
            <tr>
                <th>Key</th>
                <th>PeerConnection ID</th>
                <th>State</th>
                <th>Key</th>
                <th>PeerConnection ID</th>
                <th>State</th>
            </tr>
            <tr v-for="i in length">
                <td>
                    {{
                        fingerTable[1][i - 1]
                            ? fingerTable[1][i - 1].getRemoteKey()
                            : "N/A"
                    }}
                </td>
                <td>
                    {{
                        fingerTable[1][i - 1]
                            ? fingerTable[1][i - 1].getLocalConnId()
                            : "N/A"
                    }}
                </td>
                <td>{{ renderPeerConnection(1, i - 1) }}</td>
                <td>{{ i - 1 }}</td>
                <td>
                    {{
                        fingerTable[0][i - 1]
                            ? fingerTable[0][i - 1].getRemoteKey()
                            : "N/A"
                    }}
                </td>
                <td>
                    {{
                        fingerTable[0][i - 1]
                            ? fingerTable[0][i - 1].getLocalConnId()
                            : "N/A"
                    }}
                </td>
                <td>{{ renderPeerConnection(0, i - 1) }}</td>
            </tr>
        </table>
    </div>
</template>

<script lang="ts">
import { Component, Prop, Vue } from "vue-property-decorator";
import { PeerConnection, PeerConnectionState } from "@web-overlay/manager";

@Component
export default class FingerTable extends Vue {
    @Prop() public fingerTable?: Array<Array<PeerConnection>>;

    public get length(): number {
        if (this.fingerTable?.length !== 2) {
            return 0;
        }
        return Math.max(this.fingerTable[0].length, this.fingerTable[1].length);
    }

    public renderPeerConnection(dir: number, level: number): string {
        if (!this.fingerTable) {
            return "";
        }
        const pc = this.fingerTable[dir][level];
        if (pc) {
            return PeerConnectionState[pc.getConnectionState()];
        } else {
            return "";
        }
    }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped></style>
