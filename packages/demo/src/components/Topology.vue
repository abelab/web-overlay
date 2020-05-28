<template>
    <div class="topology">
        <h1>Topology</h1>
        <form @submit.prevent="getTopology">
            <button class="btn-square" type="submit">Get</button>
        </form>
        <svg :height="SVGSIZE" :width="SVGSIZE">
            <g
                :transform="
                    'translate(' + SVGSIZE / 2 + ',' + SVGSIZE / 2 + ')'
                "
            >
                <circle cx="0" cy="0" :r="RADIUS" stroke="black" fill="none" />
                <line
                    v-for="elem in lines"
                    :key="'line' + elem.key"
                    :x1="elem.x1"
                    :y1="elem.y1"
                    :x2="elem.x2"
                    :y2="elem.y2"
                    :class="elem.type"
                />
                <path v-for="elem in arcs" :d="elem" class="received" />
                <circle
                    v-for="elem in circles"
                    :key="'circ' + elem.key"
                    :cx="elem.cx"
                    :cy="elem.cy"
                    :r="elem.r"
                    :class="elem.class"
                />
                <text
                    v-for="elem in circles"
                    :key="'key' + elem.key"
                    :x="elem.cx"
                    :y="elem.cy"
                    dy="-10"
                    text-anchor="middle"
                    dominant-baseline="central"
                >
                    {{ elem.key }}
                </text>
                <text
                    v-for="elem in circles"
                    :key="'nodeId' + elem.key"
                    :x="elem.cx"
                    :y="elem.cy"
                    dy="10"
                    text-anchor="middle"
                    dominant-baseline="central"
                >
                    {{ elem.nodeId }}
                </text>
            </g>
            <text x="0" y="20" class="WebRTC">WebRTC</text>
            <text x="0" y="40" class="WebClientSocket">Socket.IO</text>
            <text x="0" y="60" class="relay">Relay</text>
        </svg>
        <table>
            <tr>
                <th>Key</th>
                <th>NodeId</th>
                <th>Type</th>
                <th>Paths</th>
                <!-- <th>Raws</th> -->
                <!-- <th>Platform</th> -->
                <th>Joined</th>
                <th>UA</th>
                <th>OS</th>
            </tr>
            <tr v-for="elem in info" v-bind:key="elem.key">
                <td>"{{ elem.key }}"</td>
                <td>{{ elem.nodeId }}</td>
                <td>{{ elem.type }}</td>
                <td>{{ elem.paths ? elem.paths.join(", ") : "N/A" }}</td>
                <!-- <td>{{ elem.raws ? elem.raws.join(", ") : "N/A" }}</td> -->
                <!-- <td>{{ elem.platform }}</td> -->
                <td>{{ elem.joinTime ? joinTime(elem.joinTime) : "N/A" }}</td>
                <td>{{ getUA(elem.platform) }}</td>
                <td>{{ getOS(elem.platform) }}</td>
            </tr>
        </table>
    </div>
</template>

<script lang="ts">
import { GetInfoReply, GetInfoRequest, InfoElement } from "@/common/topology";
import { Component, Prop, Vue } from "vue-property-decorator";
import {
    EndOfReply,
    Gaps,
    RawConnectionType,
    SimpleRange,
} from "@web-overlay/manager";
import { DdllNode } from "@web-overlay/kirin";
import { parseUserAgent } from "detect-browser";
import moment from "moment";

interface CircleElement {
    cx: number;
    cy: number;
    r: number;
    key: string;
    nodeId: string;
    theta: number;
    class: string;
}

interface RawLineElement {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    type: string;
}

@Component
export default class Topology extends Vue {
    @Prop() public ddllnode?: DdllNode;
    public readonly RADIUS = 200;
    public readonly SVGSIZE = this.RADIUS * 2 * 1.2;
    public info: Array<InfoElement> = [];
    public circles: Array<CircleElement> = [];
    public lines: Array<RawLineElement> = [];
    public arcs: Array<string> = [];

    public getTopology(): void {
        const node = this.ddllnode;
        if (!node || !node.isJoined()) {
            this.$swal({
                title: "Not joined!",
                icon: "error",
            });
            return;
        }
        this.$set(this, "info", []);
        this.$set(this, "lines", []);
        this.$set(this, "circles", []);
        this.$set(this, "arcs", []);
        this.info = [];
        let rep: GetInfoReply | undefined;
        const msg = new GetInfoRequest(node.manager);
        msg.onReply((reply) => {
            if (reply instanceof Error) {
                console.log("[Multicast Error: " + reply.toString() + "]");
                this.$swal({
                    title: "Multicast Error!",
                    icon: "error",
                    text: reply.toString(),
                });
            } else if (reply instanceof EndOfReply) {
                console.log("[Multicast Succeeded]");
                this.draw(rep, msg.getIncompleteRanges());
            } else {
                console.log("[Multicast got partial results]");
                rep = rep ? msg.reduce(rep, reply) : reply;
                this.draw(rep, msg.getIncompleteRanges());
            }
        });
        node.multicast(node.getKey(), node.getKey(), msg);
    }

    private draw(
        rep: GetInfoReply | undefined,
        incompletes: SimpleRange[]
    ): void {
        if (!rep || rep.info.length === 0) {
            return;
        }
        const info: Array<InfoElement> = rep.info.concat(); // copy
        const key = this.ddllnode!.getKey();
        const filled = new Gaps(key, key); // reply received ranges
        incompletes.forEach((range) => filled.remove(range));
        console.warn("filled=", filled);
        filled.toRanges().forEach((range) => {
            if (!info.find((ent) => ent.key === range.to)) {
                console.warn("not found=", range);
                info.push({
                    key: range.to,
                    nodeId: "?",
                    platform: "?",
                    paths: [],
                    raws: [],
                    type: "ghost",
                    joinTime: 0,
                });
            }
        });

        info.sort((a, b) => {
            if (a.key < b.key) {
                return -1;
            }
            if (a.key > b.key) {
                return 1;
            }
            return 0;
        });

        const nodeId2InfoMap = new Map<string, InfoElement>();
        info.forEach((elem) => {
            nodeId2InfoMap.set(elem.key, elem);
        });
        const n = info.length;
        const step = (Math.PI * 2) / n;
        const circElems: Array<CircleElement> = [];
        const nodeId2circMap = new Map<string, CircleElement>();
        const key2circMap = new Map<string, CircleElement>();
        const R = this.RADIUS;
        for (
            let i = 0, theta = -Math.PI / 2.0;
            i < info.length;
            i++, theta += step
        ) {
            const node = info[i];
            const x = R * Math.cos(theta);
            const y = R * Math.sin(theta);
            const elem = {
                cx: x,
                cy: y,
                r: 30,
                key: node.key,
                nodeId: node.nodeId,
                theta: theta,
                class: this.getCircleClass(node),
            };
            circElems.push(elem);
            nodeId2circMap.set(node.nodeId, elem);
            key2circMap.set(node.key, elem);
        }
        const lines: Array<RawLineElement> = [];
        info.forEach((elem) => {
            const from = nodeId2circMap.get(elem.nodeId);
            if (from) {
                const x1 = from.cx;
                const y1 = from.cy;
                elem.raws.forEach((raw) => {
                    const to = nodeId2circMap.get(raw.nodeId);
                    if (to) {
                        lines.push({
                            x1: x1,
                            y1: y1,
                            x2: to.cx,
                            y2: to.cy,
                            type: RawConnectionType[raw.type],
                        });
                    }
                });
                elem.paths.forEach((path) => {
                    // draw relay path only
                    if (path.asArray().length > 2) {
                        const to = nodeId2circMap.get(path.destNodeId);
                        if (to && from.key <= to.key) {
                            // draw one direction only to draw dashed lines cleanly
                            lines.push({
                                x1: x1,
                                y1: y1,
                                x2: to.cx,
                                y2: to.cy,
                                type: "relay",
                            });
                        }
                    }
                });
            }
        });
        // compute arcs of received ranges
        const arcs: string[] = [];
        filled.toRanges().forEach((range) => {
            const from = key2circMap.get(range.from);
            const to = key2circMap.get(range.to);
            if (from && to) {
                let s;
                if (from === to) {
                    const ox = R * Math.cos(from.theta + Math.PI);
                    const oy = R * Math.sin(from.theta + Math.PI);
                    // prettier-ignore
                    s = [
                        "M", from.cx, from.cy,
                        "A", R, R, 0, 0, 1, ox, oy,
                        "M", ox, oy,
                        "A", R, R, 0, 0, 1, from.cx, from.cy
                    ].join(" ");
                } else {
                    const angle =
                        (to.theta - from.theta + 4 * Math.PI) % (2 * Math.PI);
                    // prettier-ignore
                    s = [
                        "M", from.cx, from.cy,
                        "A", R, R, 0, angle > Math.PI ? 1 : 0, 1, to.cx, to.cy
                    ].join(" ");
                }
                arcs.push(s);
            }
        });
        this.$set(this, "info", info);
        this.$set(this, "lines", lines);
        this.$set(this, "circles", circElems);
        this.$set(this, "arcs", arcs);
    }

    public getCircleClass(elem: InfoElement): string {
        if (elem.type === "ghost") {
            return "ghost";
        }
        if (
            this.ddllnode &&
            elem.nodeId === this.ddllnode.manager.getNodeId()
        ) {
            return "me";
        }
        return "other";
    }

    public joinTime(time: number): string {
        return moment(time).format();
    }

    public getUA(ua: string): string {
        let m;
        if ((m = ua.match(/^node v(.*),(.*)/i))) {
            return `node ${m[1]}`;
        }
        const d = parseUserAgent(ua);
        return d ? `${d.name} ${d.version}` : "?";
    }

    public getOS(ua: string): string {
        let m;
        if ((m = ua.match(/^node v(.*),\s*(.*)/i))) {
            if (m[2] === "darwin") {
                return "Mac OS";
            }
            return m[2];
        }
        const d = parseUserAgent(ua);
        return d?.os || "?";
    }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
svg line {
    stroke-width: 3;
    stroke: black;
}
svg .other {
    fill: yellow;
}
svg .me {
    fill: orange;
}
svg .ghost {
    fill: #c0c0c0;
}
svg .WebServerSocket {
    stroke: #668ad8;
}
svg .WebClientSocket {
    stroke: #668ad8;
}
svg .WebRTC {
    stroke: #9900dd;
}
svg .relay {
    stroke-width: 1px;
    stroke: #cccccc;
    stroke-dasharray: 10;
}
svg .received {
    stroke: orange;
    stroke-width: 3px;
    fill: none;
    stroke-opacity: 0.6;
}
</style>
