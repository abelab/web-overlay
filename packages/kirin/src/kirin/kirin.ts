import { override } from "core-decorators";
import { DdllNode, Status } from "../ddll";
import {
    Callbacks,
    CircularSpace,
    Logger,
    Manager,
    PeerConnection,
    RejectionError,
} from "@web-overlay/manager";
import {
    FTUpdateCRequest,
    FTUpdateParams,
    KirinPeerConnectionClose,
} from "./kirin-messages";
import table = require("text-table");

// some enums
export enum Passive2 {
    DO_PASSIVE2,
    NO_PASSIVE2,
}
enum UpdateMode {
    INITIAL,
    PERIODIC,
}
export enum Direction {
    FORWARD,
    BACKWARD,
}

export const KirinRejectReasons = {
    CIRCULATED: "REJECT:CIRCULATED",
    NOT_CHANGED: "REJECT:NOT_CHANGED",
};

export class KirinNode extends DdllNode {
    public static readonly KIRIN_LOG_NAMESPACE = "web:kirin";
    public static readonly FT_UPDATE_TIMER_NAME = "KirinNode.ftUpdateTimer";
    // Passive Update2 を実行するかどうか
    public static readonly DO_PASSIVE_UPDATE2 = true;

    // finger table更新間隔 (0 ならば更新しない)
    public static readonly FT_UPDATE_PERIOD = 30 * 1000;

    // "kirin" must be consistent with KirinMessage
    public static readonly KirinName = "kirin";

    public readonly kLogger: Logger;

    // fingers[0] is FFT, fingers[1] is BFT
    public fingers: PeerConnection[][] = [[], []];
    public readonly oldConnectionsLocal = new Set<PeerConnection>();
    public readonly oldConnectionsRemote = new Set<PeerConnection>();
    public ftUpdateListeners = new Callbacks();
    public ftUpdateMode: UpdateMode = UpdateMode.INITIAL;

    constructor(key: string, manager: Manager) {
        super(key, manager);
        this.kLogger = manager.createLogger(KirinNode.KIRIN_LOG_NAMESPACE, key);
        this.manager.registerApp(this.key, KirinNode.KirinName, this);
        this.cleaner.push(() => {
            this.manager.unregisterApp(this.key, KirinNode.KirinName);
            this.fingers = [[], []];
        });
    }

    @override
    protected initAfterJoin(): void {
        super.initAfterJoin();
        // invoke listeners because we have at least level 0 finger table
        // (left and right links).
        this.ftUpdateListeners.invoke();
        if (this.right!.getRemoteKey() === this.key) {
            // I'm the first node
            this.schedPeriodicFTUpdate();
        } else {
            this.updateTable(Direction.FORWARD, 1);
            this.updateTable(Direction.BACKWARD, 1);
        }
    }

    private updateEnt(dir: Direction, lv: number, pc: PeerConnection): void {
        this.kLogger.debug(
            "FingerTable(%s, level %d) is updated!",
            Direction[dir],
            lv
        );
        const table = this.fingers[dir];
        this.disposeConnection(table[lv]);
        table[lv] = pc;
        this.ftUpdateListeners.invoke();
        this.showFingerTable();
    }

    // FFT[level]あるいはBFT[level]を返す
    private getEnt(dir: Direction, level: number): PeerConnection {
        if (level === 0) {
            return dir === Direction.FORWARD ? this.right! : this.left!;
        }
        return this.fingers[dir][level];
    }

    public getFFT(): PeerConnection[] {
        const table = this.fingers[Direction.FORWARD].concat();
        table[0] = this.right!;
        return table;
    }

    public getBFT(): PeerConnection[] {
        const table = this.fingers[Direction.BACKWARD].concat();
        table[0] = this.left!;
        return table;
    }

    /**
     * FFTとBFTからコネクションが確立されているエントリを集めた配列を返す．
     * 自ノードへのコネクションを含む．
     *
     * @returns {PeerConnection[]}
     */
    @override
    public getValidPeerConnections(): PeerConnection[] {
        let conns: PeerConnection[] = this.fingers[0].concat(this.fingers[1]);
        // this.right が suspicious ならば返却値から取り除く．
        // 取り除かない場合，DDLLの修復処理で，右ノードが故障していても RepairCReq を右ノードに送信するため，
        // 永遠に修復が完了しない．
        conns = conns.concat(this.left!, this.right!);
        conns = conns.filter(
            (con) =>
                con &&
                con.isConnected() &&
                !this.manager.isSuspiciousNode(con.getRemoteNodeId())
        );
        conns = conns.concat(/*this.right,*/ this.self);
        return conns;
    }

    public prettyPrintFingerTable(): string {
        const fft = this.getFFT();
        const bft = this.getBFT();
        const t = [];
        t.push(["BFT(key)", "BFT(PCID)", "LEVEL", "FFT(key)", "FFT(PCID)"]);
        for (let i = 0; i < Math.max(fft.length, bft.length); i++) {
            const line = [];
            if (bft[i]) {
                line.push(
                    `"${bft[i].getRemoteKey()}"`,
                    bft[i].getLocalConnId()
                );
            } else {
                line.push("", "");
            }
            line.push(i);
            if (fft[i]) {
                line.push(
                    `"${fft[i].getRemoteKey()}"`,
                    fft[i].getLocalConnId()
                );
            } else {
                line.push("", "");
            }
            t.push(line);
        }
        return table(t, {
            hsep: "|",
            align: ["c", "r", "r", "c", "r"],
        });
    }

    public showFingerTable(): void {
        if (this.kLogger.isEnabled()) {
            this.kLogger.info("\n%s", this.prettyPrintFingerTable());
        }
    }

    /**
     * update finger table at level lv
     * @param dir Forward for FFT, Backward for BFT
     * @param lv the level to update
     */
    private updateTable(dir: Direction, lv: number): void {
        this.kLogger.debug(
            "kirin.updateTable: dir=%s, level=%d",
            Direction[dir],
            lv
        );
        if (this.status !== Status.IN) {
            this.kLogger.debug("kirin.updateTable: not inserted, stop.");
            return;
        }
        if (lv <= 0) {
            throw new Error("lv <= 0!");
        }
        const curPC = this.getEnt(dir, lv);
        const curKey =
            curPC && curPC.isConnected() ? curPC.getRemoteKey() : null;
        const params: FTUpdateParams = {
            sourceKey: curKey,
            direction: dir,
            distance: 1 << lv,
            level: lv,
            type:
                dir === Direction.FORWARD &&
                this.ftUpdateMode === UpdateMode.INITIAL
                    ? Passive2.DO_PASSIVE2
                    : Passive2.NO_PASSIVE2,
        };
        const msg = new FTUpdateCRequest(this.manager, this.key, params);
        this.cleaner.addChild(msg.getPeerConnection());
        msg.connect()
            .then((pc) => {
                this.kLogger.newEvent("kirin.updateTable: connected");
                this.updateEnt(dir, lv, pc);
                if (
                    dir === Direction.BACKWARD ||
                    this.ftUpdateMode === UpdateMode.INITIAL
                ) {
                    this.updateTable(dir, lv + 1);
                } else {
                    this.cleaner.startTimer(
                        this.manager,
                        KirinNode.FT_UPDATE_TIMER_NAME,
                        KirinNode.FT_UPDATE_PERIOD,
                        () => {
                            this.updateTable(Direction.FORWARD, lv + 1);
                        }
                    );
                }
            })
            .catch((exc) => {
                if (exc instanceof RejectionError) {
                    this.kLogger.newEvent(
                        `kirin.updateTable: rejected (${Direction[dir]}, level ${lv}): reason=${exc.message}`
                    );
                    if (exc.message === KirinRejectReasons.CIRCULATED) {
                        if (dir === Direction.FORWARD) {
                            // trim the finger tables to size "lv"
                            for (let d = 0; d < 2; d++) {
                                for (
                                    let j = lv;
                                    j < this.fingers[d].length;
                                    j++
                                ) {
                                    this.disposeConnection(this.fingers[d][j]);
                                }
                                this.fingers[d].splice(
                                    lv,
                                    this.fingers[d].length
                                );
                            }
                            if (this.kLogger.isEnabled()) {
                                this.showFingerTable();
                                this.kLogger.info(
                                    "\n%s",
                                    this.manager.getManagerInfoString()
                                );
                            }
                            this.ftUpdateMode = UpdateMode.PERIODIC;
                            this.schedPeriodicFTUpdate();
                        }
                        this.ftUpdateListeners.invoke();
                        this.showFingerTable();
                        return;
                    } else if (exc.message === KirinRejectReasons.NOT_CHANGED) {
                        this.updateTable(dir, lv + 1);
                    } else {
                        this.updateTable(dir, lv);
                    }
                } else {
                    const delay = 2000;
                    this.kLogger.newEvent(
                        "kirin.updateTable: connect failed: %s, retry %dmsec later",
                        exc,
                        delay
                    );
                    this.cleaner.delay(this.manager, delay).then(() => {
                        this.updateTable(dir, lv);
                    });
                }
            });
    }

    public addFingertableUpdateListeners(cb: () => void): void {
        this.ftUpdateListeners.addCallback(cb);
    }

    private schedPeriodicFTUpdate(): void {
        this.cleaner.startTimer(
            this.manager,
            KirinNode.FT_UPDATE_TIMER_NAME,
            KirinNode.FT_UPDATE_PERIOD,
            () => {
                this.updateTable(Direction.FORWARD, 1);
            }
        );
    }

    public handleCReq(req: FTUpdateCRequest): void {
        const h = "handleCReq";
        const manager = this.manager;
        const params = req.params;
        if (params.level <= 0) {
            throw new Error("param.level <= 0!");
        }
        if (params.distance === 0) {
            if (params.sourceKey === this.getKey()) {
                this.kLogger.debug("distance=0 (NOT_CHANGED)");
                req.reject(KirinRejectReasons.NOT_CHANGED);
                return;
            }
            this.kLogger.debug("distance=0 (accept)");
            const promise = manager._accept(this.getKey(), req);
            promise
                .then((pc) => {
                    this.kLogger.newEvent(
                        "%s: established (accept): %s",
                        h,
                        pc
                    );
                    this.cleaner.addChild(pc);
                    // Passive Update 1
                    this.updateEnt(1 - params.direction, params.level, pc);
                })
                .catch((err) => {
                    this.kLogger.newEvent("%s: accept failed: %s", h, err);
                });
            return;
        }

        // If we are in the half way to the destination, perform PassiveUpdate2
        if (
            KirinNode.DO_PASSIVE_UPDATE2 &&
            params.type === Passive2.DO_PASSIVE2 &&
            params.distance === (1 << params.level) / 2
        ) {
            const plevel = params.level;
            const curPC = this.getEnt(Direction.BACKWARD, plevel);
            const curKey =
                curPC && curPC.isConnected() ? curPC.getRemoteKey() : null;
            const phint: FTUpdateParams = {
                sourceKey: curKey,
                direction: Direction.BACKWARD,
                distance: 1 << plevel,
                level: plevel,
                type: Passive2.NO_PASSIVE2,
            };
            const msg = new FTUpdateCRequest(manager, this.key, phint);
            msg.connect()
                .then((pc) => {
                    this.kLogger.newEvent("%s: connected (passive2)", h);
                    this.cleaner.addChild(pc);
                    this.updateEnt(Direction.BACKWARD, plevel, pc);
                })
                .catch((exc) => {
                    this.kLogger.info(
                        "%s: connect() for passive2 failed (%s, ignored)",
                        h,
                        exc
                    );
                });
        }

        // Forward!
        /*
         * param.level = 3, param.distance = 8
         *  -> forward level = 2
         * param.level = 3, (remaining) param.distance = 4
         *  -> forward level = 2
         * forward level = min(log2(distance), level - 1)
         */
        let forwardLevel = Math.min(
            Math.floor(Math.log2(params.distance)),
            params.level - 1
        );
        let next: PeerConnection | undefined;
        for (; forwardLevel >= 0; forwardLevel--) {
            const n = this.getEnt(params.direction, forwardLevel);
            this.kLogger.debug("level %d, testing %s", forwardLevel, n);
            if (n && n.isConnected()) {
                next = n;
                break;
            }
        }
        if (!next) {
            this.kLogger.warn("%s: NO CONNECTION IS AVAILABLE TO FORWARD", h);
            return;
        }
        // 一周の条件
        //   FFT更新の場合 next ∈ [from, this]
        //   BFT更新の場合 next ∈ [this, from]
        if (
            (params.direction === Direction.FORWARD &&
                CircularSpace.isOrdered(
                    req.connectKey,
                    true,
                    next.getRemoteKey(),
                    this.key,
                    true
                )) ||
            (params.direction === Direction.BACKWARD &&
                CircularSpace.isOrdered(
                    this.key,
                    true,
                    next.getRemoteKey(),
                    req.connectKey,
                    true
                ))
        ) {
            this.kLogger.debug("circulated");
            req.reject(KirinRejectReasons.CIRCULATED);
            return;
        }
        params.distance -= 1 << forwardLevel;
        this.kLogger.debug(
            "send req to key (%s), dir=%s, ftlevel=%d, remainDist=%d",
            next.getRemoteKey(),
            Direction[params.direction],
            forwardLevel,
            params.distance
        );
        next.send(req);
    }

    private disposeConnection(pc: PeerConnection): void {
        if (pc && pc.isConnected()) {
            if (this.oldConnectionsRemote.has(pc)) {
                this.kLogger.debug("disposeConnection: close: %s", pc);
                this.safeClose(pc);
                this.oldConnectionsRemote.delete(pc);
            } else {
                this.kLogger.debug("disposeConnection: add: %s", pc);
                this.oldConnectionsLocal.add(pc);
                pc.send(new KirinPeerConnectionClose(this.manager));
            }
        }
    }

    public static getKirinLogger(manager: Manager, node?: KirinNode): Logger {
        if (node) {
            return node.kLogger;
        }
        return manager.getLogger(KirinNode.KIRIN_LOG_NAMESPACE);
    }
}
