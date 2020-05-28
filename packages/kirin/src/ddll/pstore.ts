import openpgp = require("openpgp");
import b64 = require("base64-js");
import {
    CircularSpace,
    Deferred,
    Logger,
    Manager,
    Message,
    RemoteError,
    ReplyMessage,
    RequestMessage,
    RequestMessageSpec,
    RetriableError,
    serializable,
} from "@web-overlay/manager";
import { DdllNode } from "./ddll";
import { override } from "core-decorators";

export type PSKey = string;
export type PSValue =
    | boolean
    | string
    | number
    | boolean[]
    | string[]
    | number[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | any;

export type ValType = "Blob" | "Uint8Array";

export interface ValAndType {
    type?: ValType;
    value: PSValue;
}

export interface Val extends ValAndType {
    expire: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isBlob(obj: any): obj is Blob {
    if (typeof Blob === "undefined") {
        return false;
    }
    return obj instanceof Blob;
}

/**
 * used for in-memory storage.
 */
export interface PerKeyEnt {
    vals: Val[];
    pgpPubKey?: openpgp.key.Key;
}

export interface PerKeyEntWithKey extends PerKeyEnt {
    key: PSKey;
}

/**
 * used for transferring a replica.
 */
export interface SingleEnt {
    key: PSKey;
    index: number;
    value: PSValue;
    expire: number;
    armoredPubKey?: string;
}

export interface PutOption {
    index?: number;
    retentionPeriod?: number;
    noOverwrite?: boolean;
}

export interface SignedPutOption extends PutOption {
    armoredPublicKey: string;
    armoredPrivateKey: string;
    passphrase?: string;
}

export interface RemotePutOpt {
    type?: ValType;
    index: number;
    armoredPublicKey?: string;
    armoredSignature?: string;
    expire: number;
    noOverwrite?: boolean;
}

// type guard
const isSignedPut = (opt: PutOption): opt is SignedPutOption =>
    !!(opt as SignedPutOption).armoredPublicKey;

function showOnReceive(msg: Message & PSMessage): void {
    const name = msg.constructor.name;
    const manager = msg.manager;
    const logger = DdllNode.getLogger(manager, msg.pstore);
    logger.newEvent("[pstore] receive %s", name);
    logger.debug("%s", msg);
}

function prologue(
    msg: Message & PSMessage
): {
    name: string;
    manager: Manager;
    pstore?: PStoreIf;
    logger: Logger;
} {
    showOnReceive(msg);
    return {
        name: msg.constructor.name,
        manager: msg.manager,
        pstore: msg.pstore,
        logger: DdllNode.getLogger(msg.manager, msg.pstore),
    };
}

/*
 * Message Definitions
 */

interface PSMessage {
    pstore: PStoreIf;
}

@serializable
export class RawPut extends RequestMessage<RawPut, RawPutReply>
    implements PSMessage {
    constructor(
        manager: Manager,
        public readonly k: PSKey,
        public readonly v: PSValue,
        public readonly options: RemotePutOpt
    ) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return { replyClassName: RawPutReply.name };
    }

    public onReceive(): void {
        const { name, manager, pstore, logger } = prologue(this);
        if (!pstore) {
            logger.warn("no .pstore");
            return;
        }
        pstore.handlePut(this);
    }
}
export interface RawPut extends PSMessage {}

@serializable
export class RawPutReply extends ReplyMessage<RawPut, RawPutReply> {
    constructor(req: RawPut, public v: string | RemoteError) {
        super(req);
    }

    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface RawPutReply extends PSMessage {}

// this is required for unknown reason
serializable(RemoteError);

@serializable
export class RawGet extends RequestMessage<RawGet, RawGetReply> {
    constructor(
        manager: Manager,
        public readonly k: string,
        public readonly minindex: number,
        public readonly maxindex: number
    ) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return { replyClassName: RawGetReply.name };
    }

    public onReceive(): void {
        const { name, manager, pstore, logger } = prologue(this);
        if (!pstore) {
            logger.warn("no .pstore");
            return;
        }
        pstore.handleGet(this);
    }
}
export interface RawGet extends PSMessage {}

@serializable
export class RawGetReply extends ReplyMessage<RawGet, RawGetReply> {
    constructor(req: RawGet, public v: (ValAndType | null)[] | RemoteError) {
        super(req);
    }
    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface RawGetReply extends PSMessage {}

@serializable
export class RawGetReplica extends RequestMessage<
    RawGetReplica,
    RawGetReplicaReply
> {
    constructor(manager: Manager, public from: string, public to: string) {
        super(manager);
    }

    @override
    public getSpec(): RequestMessageSpec {
        return { replyClassName: RawGetReplicaReply.name };
    }

    public onReceive(): void {
        const { name, manager, pstore, logger } = prologue(this);
        if (!pstore) {
            logger.warn("no .pstore");
            return;
        }
        pstore.handleGetReplica(this);
    }

    public toString(): string {
        return `RawGetReplica[from=${this.from}, to=${this.to}]`;
    }
}
export interface RawGetReplica extends PSMessage {}

@serializable
export class RawGetReplicaReply extends ReplyMessage<
    RawGetReplica,
    RawGetReplicaReply
> {
    constructor(
        req: RawGetReplica,
        public entries: PerKeyEntWithKey[],
        public successors: string[],
        public error?: RemoteError
    ) {
        super(req);
    }

    public onReceive(): void {
        showOnReceive(this);
        super.onReceive();
    }
}
export interface RawGetReplicaReply extends PSMessage {}

@serializable
export class RawReplicate extends Message {
    constructor(
        manager: Manager,
        public entries: PerKeyEntWithKey[],
        public successors: string[]
    ) {
        super(manager);
    }

    public onReceive(): void {
        const { name, manager, pstore, logger } = prologue(this);
        if (!pstore) {
            logger.warn("no .pstore");
            return;
        }
        pstore.handleReplicate(this);
    }
}
export interface RawReplicate extends PSMessage {}

@serializable
export class RawReplicate1 extends Message {
    constructor(
        manager: Manager,
        public ent: SingleEnt,
        public sourceKey: string,
        public hops: number
    ) {
        super(manager);
    }

    public onReceive(): void {
        const { name, manager, pstore, logger } = prologue(this);
        if (!pstore) {
            logger.warn("no .pstore");
            return;
        }
        pstore.handleReplicate1(this);
    }
}
export interface RawReplicate1 extends PSMessage {}

/*
 * PStore implementation
 */

/**
 * interface for PStore
 */
export interface PStoreIf extends DdllNode {
    rawPut(
        k: PSKey,
        v: PSValue,
        option: PutOption | SignedPutOption
    ): Promise<void>;
    rawGet(k: PSKey, index?: number): Promise<PSValue | null>;
    rawGetMulti(
        k: PSKey,
        minIndex: number,
        maxIndex: number
    ): Promise<(PSValue | null)[]>;

    // for handling messages (internal)
    handlePut(msg: RawPut): Promise<void>;
    handleGet(msg: RawGet): void;
    handleGetReplica(msg: RawGetReplica): void;
    handleReplicate(msg: RawReplicate): void;
    handleReplicate1(msg: RawReplicate1): void;
    // for testing
    doReplication(): void;
    _getMap(): Map<string, PerKeyEnt>;
}

export enum PStoreError {
    NO_SUCH_KEY = "NO_SUCH_KEY",
    OVERWRITE_FORBIDDEN = "OVERWRITE_FORBIDDEN",
    VERIFY_ERROR = "VERIFY_ERROR",
    NOT_SIGNED = "NOT_SIGNED",
}

// number of replica, not including the original
export const NREPLICA = 2;
// replication period
export const PSTORE_REPLICATION_PERIOD = 60 * 1000;
/**
 * default retain time for an entry (10days)
 */
export const PSTORE_DEFAULT_RETENTION_PERIOD = 10 * 24 * 60 * 60;

// PStoreDdll = PStore + DdllNode
export class PStoreDdll extends DdllNode {}
export interface PStoreDdll extends DdllNode, PStoreIf {}

export function createPStoreClass(base: typeof DdllNode): typeof PStoreDdll {
    /*
     * PStore, a simple distributed storage without hashing
     */
    class PStoreInternal extends base implements PStoreDdll {
        public static readonly REPLICATION_TIMER_NAME =
            "PStore.replicationTimer";
        // must be consistent with PStoreMessage
        public static readonly PStoreName = "pstore";
        private pStore = new Map<string, PerKeyEnt>();

        constructor(key: string, manager: Manager) {
            super(key, manager);
            manager.registerApp(key, PStoreInternal.PStoreName, this);
            this.cleaner.push(() =>
                manager.unregisterApp(key, PStoreInternal.PStoreName)
            );
        }

        public _getMap(): Map<string, PerKeyEnt> {
            return this.pStore;
        }

        protected initAfterJoin(): void {
            super.initAfterJoin();
            this.startPeriodicReplication();
        }

        // @override
        protected async prepareForJoin(isRepair: boolean): Promise<void> {
            if (isRepair) {
                // XXX: THINK!  we have to copy entries...
                return;
            }
            // Get PStore entries from the left node
            try {
                await this.fetchPStoreEntries();
            } catch (err) {
                this.logger.debug(
                    "prepareForJoin: getPStoreEntries() failed: %s",
                    err
                );
                throw err;
            }
        }

        public async rawPut(
            k: PSKey,
            v: PSValue,
            option: PutOption | SignedPutOption
        ): Promise<void> {
            const defer = new Deferred<void>();
            let type: ValType | undefined;
            if (v instanceof Uint8Array) {
                ({ type, value: v } = PStoreInternal.convertTypedArray2String(
                    v
                ));
            } else if (isBlob(v)) {
                ({ type, value: v } = await PStoreInternal.convertBlob2String(
                    v
                ));
            }
            const retain = option.retentionPeriod
                ? option.retentionPeriod
                : PSTORE_DEFAULT_RETENTION_PERIOD;
            const opt: RemotePutOpt = {
                type: type,
                index: option.index ? option.index : 0,
                expire: Math.floor(Date.now() / 1000 + retain),
                noOverwrite: option.noOverwrite ? true : undefined,
            };
            if (isSignedPut(option)) {
                const privkey = option.armoredPrivateKey;
                const passphrase = option.passphrase;
                if (!privkey) {
                    throw new Error("no private key");
                }
                // generate a signature
                const keyresult = await openpgp.key.readArmored(privkey);
                if (keyresult.err && keyresult.err.length > 0) {
                    throw keyresult.err[0];
                }
                const privKeyObj = keyresult.keys[0];
                if (passphrase) {
                    await privKeyObj.decrypt(passphrase);
                }
                const pgpOption = {
                    detached: true,
                    message: PStoreInternal.createMessageForSigature(
                        k,
                        v,
                        opt.index
                    ),
                    armor: true,
                    privateKeys: [privKeyObj],
                };
                const result = await openpgp.sign(pgpOption);
                const armoredSignature = result.signature as string;
                opt.armoredPublicKey = option.armoredPublicKey;
                opt.armoredSignature = armoredSignature;
            }
            let reply: RawPutReply;
            try {
                const msg = new RawPut(this.manager, k, v, opt);
                reply = await this.unicastRequest(k, msg);
            } catch (err) {
                this.logger.debug("RawPut: got %s", err);
                throw err;
            }
            if (reply.v instanceof RemoteError) {
                this.logger.debug(
                    "RawPut: got remoteError: %s",
                    reply.v.message
                );
                throw reply.v.error();
            }
        }

        private static createMessageForSigature(
            key: PSKey,
            val: PSValue,
            index: number
        ): openpgp.message.Message {
            return openpgp.message.fromText(key + val + index);
        }

        public async rawGet(k: PSKey, index = 0): Promise<PSValue | null> {
            const result = (await this.rawGetMulti(
                k,
                index,
                index + 1
            )) as PSValue[];
            return result[0];
        }

        public async rawGetMulti(
            k: PSKey,
            minIndex: number,
            maxIndex: number
        ): Promise<(PSValue | null)[]> {
            let reply: RawGetReply;
            try {
                const msg = new RawGet(this.manager, k, minIndex, maxIndex);
                reply = await this.unicastRequest(k, msg);
            } catch (err) {
                this.logger.debug("rawGetMulti: got %s", err);
                throw err;
            }
            if (reply.v instanceof RemoteError) {
                throw reply.v.error();
            }
            const result: (PSValue | null)[] = [];
            for (const ent of reply.v) {
                if (!ent) {
                    result.push(null);
                } else {
                    let v = ent.value;
                    switch (ent.type) {
                        case "Blob":
                            v = PStoreInternal.convertString2Blob(v as string);
                            break;
                        case "Uint8Array":
                            v = PStoreInternal.convertString2Uint8Array(
                                v as string
                            );
                    }
                    result.push(v);
                }
            }
            return result;
        }

        /**
         * fetch all pstore entries from the left node by sending
         * a RawGetReplica message.
         */
        private async fetchPStoreEntries(): Promise<void> {
            let reply;
            try {
                const msg = new RawGetReplica(
                    this.manager,
                    this.getKey(),
                    this.right!.getRemoteKey()
                );
                reply = await msg.request(this.left!);
            } catch (err) {
                throw new RetriableError(err.message);
            }
            if (reply.error) {
                throw new RetriableError(reply.error.message);
            } else {
                this.pSuccessors = reply.successors;
                for (const ent of reply.entries) {
                    // we can delete ent.key
                    this.pStore.set(ent.key, ent);
                }
                this.dumpPStore();
            }
        }

        private startPeriodicReplication(): void {
            this.logger.debug("startPeriodicReplication");
            this.cleaner.startTimer(
                this.manager,
                PStoreInternal.REPLICATION_TIMER_NAME,
                PSTORE_REPLICATION_PERIOD,
                () => {
                    this.doReplication();
                    this.startPeriodicReplication();
                }
            );
        }

        // periodically called
        public doReplication(): void {
            this.logger.debug("doReplication");
            if (
                this.left!.getRemoteKey() === this.getKey() ||
                this.right!.getRemoteKey() === this.getKey()
            ) {
                // the last node ?
                return;
            }
            // adjust pSuccessors (remove keys between myself and right node)
            // if we have [0, 10, 20, 30, 40, 50] and current right key is 40,
            // new pSuccessors = [40, 50]
            this.pSuccessors[0] = this.right!.getRemoteKey();
            while (
                this.pSuccessors[1] !== undefined &&
                CircularSpace.isOrdered(
                    this.getKey(),
                    true,
                    this.pSuccessors[1],
                    this.pSuccessors[0],
                    true
                )
            ) {
                this.pSuccessors.splice(1, 1);
            }
            const scopy = this.pSuccessors.slice(0, NREPLICA);
            const limIndex = scopy.indexOf(this.left!.getRemoteKey());
            let limKey: string;
            if (limIndex >= 0) {
                // do not send a replica of the left node to the left node itself.
                // me = 0, tmp = [1 2 3], left = 2
                // => nSuccs = [0 1 2]
                limKey = this.left!.getRemoteKey();
                scopy.splice(limIndex + 1);
            } else {
                limKey = scopy[scopy.length - 1];
            }
            const nSuccs = [this.getKey(), ...scopy];
            this.logger.debug(
                "doReplication: send to left, range=[%s, %s), successors=%s",
                this.getKey(),
                limKey,
                nSuccs
            );
            // collect entries whose key is in [this.getKey(), limKey)
            const ents: PerKeyEntWithKey[] = [];
            for (const ent of this.pStore.entries()) {
                const k = ent[0];
                const v: PerKeyEnt = ent[1];
                if (
                    CircularSpace.isOrdered(
                        this.getKey(),
                        true,
                        k,
                        limKey,
                        false
                    )
                ) {
                    ents.push({
                        key: k,
                        vals: v.vals,
                        pgpPubKey: v.pgpPubKey,
                    });
                }
            }
            const msg = new RawReplicate(this.manager, ents, nSuccs);
            try {
                this.left!.send(msg);
            } catch (err) {
                this.logger.warn(
                    "send RawReplicate to left node failed: %s",
                    err
                );
                return;
            }
        }

        private async putEntry(msg: RawPut): Promise<void> {
            const ent: PerKeyEnt = this.pStore.get(msg.k) || {
                vals: [],
            };
            ent.vals[msg.options.index] = {
                type: msg.options.type,
                value: msg.v,
                expire: msg.options.expire,
            };
            if (!ent.pgpPubKey && msg.options.armoredPublicKey) {
                const keyresult = await openpgp.key.readArmored(
                    msg.options.armoredPublicKey
                );
                ent.pgpPubKey = keyresult.keys[0];
            }
            this.pStore.set(msg.k, ent);
        }

        public async handlePut(msg: RawPut): Promise<void> {
            const ent = this.pStore.get(msg.k);
            let reply: string | RemoteError;
            const verifyAndWrite = async (
                pgpPubKey: openpgp.key.Key
            ): Promise<string | RemoteError> => {
                return this.verifyRawPut(msg, pgpPubKey)
                    .then(async () => {
                        await this.putEntry(msg);
                        return "OK";
                    })
                    .catch((err) => {
                        return new RemoteError(err.message);
                    });
            };
            if (!ent || !ent.pgpPubKey) {
                if (msg.options.armoredPublicKey) {
                    const result = await openpgp.key.readArmored(
                        msg.options.armoredPublicKey
                    );
                    reply = await verifyAndWrite(result.keys[0]);
                } else if (
                    msg.options.noOverwrite &&
                    ent?.vals[msg.options.index]
                ) {
                    reply = new RemoteError(PStoreError.OVERWRITE_FORBIDDEN);
                } else {
                    this.putEntry(msg);
                    reply = "OK";
                }
            } else if (msg.options.armoredSignature) {
                reply = await verifyAndWrite(ent.pgpPubKey);
            } else {
                reply = new RemoteError(PStoreError.OVERWRITE_FORBIDDEN);
            }
            msg.sendReply(new RawPutReply(msg, reply));

            // make replica
            if (
                NREPLICA > 0 &&
                !(reply instanceof RemoteError) &&
                this.left!.getRemoteKey() !== this.getKey()
            ) {
                this.logger.debug("send a replica to the left node");
                const singleEnt: SingleEnt = {
                    key: msg.k,
                    index: msg.options.index,
                    value: msg.v,
                    expire: msg.options.expire,
                    armoredPubKey: msg.options.armoredPublicKey,
                };
                const rep1 = new RawReplicate1(
                    this.manager,
                    singleEnt,
                    this.getKey(),
                    NREPLICA
                );
                this.left!.send(rep1);
            }
        }

        private async verifyRawPut(
            msg: RawPut,
            pubkey: openpgp.key.Key
        ): Promise<void> {
            if (!msg.options.armoredSignature) {
                // bug?
                this.logger.debug("sign does not exist");
                throw new Error(PStoreError.NOT_SIGNED);
            }
            const pgpOptions = {
                message: PStoreInternal.createMessageForSigature(
                    msg.k,
                    msg.v,
                    msg.options.index
                ),
                publicKeys: pubkey,
                signature: await openpgp.signature.readArmored(
                    msg.options.armoredSignature
                ),
            };
            return openpgp
                .verify(pgpOptions)
                .then((verified) => {
                    const validity = verified.signatures[0].valid;
                    if (validity) {
                        return;
                    }
                    throw new Error(PStoreError.VERIFY_ERROR);
                })
                .catch((err) => {
                    this.logger.debug("verifyRawPut: verify error: %s", err);
                    throw new Error(PStoreError.VERIFY_ERROR);
                });
        }

        public handleGet(msg: RawGet): void {
            let reply;
            const ent = this.pStore.get(msg.k);
            if (ent) {
                const values: (ValAndType | null)[] = [];
                for (let i = msg.minindex; i < msg.maxindex; i++) {
                    let obj: ValAndType | null = null;
                    if (ent.vals[i]) {
                        obj = {
                            type: ent.vals[i].type,
                            value: ent.vals[i].value,
                        };
                    }
                    values.push(obj);
                }
                reply = new RawGetReply(msg, values);
            } else {
                reply = new RawGetReply(
                    msg,
                    new RemoteError(PStoreError.NO_SUCH_KEY)
                );
            }
            msg.sendReply(reply);
        }

        public handleGetReplica(msg: RawGetReplica): void {
            if (!this.right || msg.to !== this.right.getRemoteKey()) {
                const reply = new RawGetReplicaReply(
                    msg,
                    [],
                    [],
                    new RemoteError("right key mismatch")
                );
                msg.sendReply(reply);
                return;
            }

            const entries: PerKeyEntWithKey[] = [];
            for (const ent of this.pStore.entries()) {
                const k = ent[0];
                const v = ent[1];
                if (
                    CircularSpace.isOrdered(msg.from, true, k, msg.to, false) ||
                    CircularSpace.isOrdered(
                        msg.to,
                        true,
                        k,
                        this.pSuccessors[this.pSuccessors.length - 1],
                        false
                    )
                ) {
                    entries.push({
                        key: k,
                        vals: v.vals,
                        pgpPubKey: v.pgpPubKey,
                    });
                }
            }
            this.logger.debug("handleGetReplica: entries=%s", entries);
            const reply = new RawGetReplicaReply(
                msg,
                entries,
                this.pSuccessors
            );
            msg.sendReply(reply);
        }

        public handleReplicate(msg: RawReplicate): void {
            if (msg.successors[0] !== this.right!.getRemoteKey()) {
                this.logger.debug(
                    "handleReplicate: from not immediate right node"
                );
                return;
            }
            this.pSuccessors = msg.successors;
            // remove keys in [this.getKey(), this.pSuccessors[0])
            const s = this.pSuccessors[0];
            const e = this.getKey();
            for (const ent of this.pStore.entries()) {
                const k = ent[0];
                // [Me]...[Successor]...[k]
                if (CircularSpace.isOrdered(s, true, k, e, false)) {
                    this.pStore.delete(k);
                }
            }
            // and store data in the message
            for (const ent of msg.entries) {
                this.pStore.set(ent.key, ent);
                delete ent.key;
            }
            this.dumpPStore();
        }

        public async handleReplicate1(msg: RawReplicate1): Promise<void> {
            const ent = this.pStore.get(msg.ent.key) || { vals: [] };
            ent.vals[msg.ent.index] = {
                value: msg.ent.value,
                expire: msg.ent.expire,
            };
            if (msg.ent.armoredPubKey) {
                const result = await openpgp.key.readArmored(
                    msg.ent.armoredPubKey
                );
                // XXX: handle exception!
                ent.pgpPubKey = result.keys[0];
            }
            this.pStore.set(msg.ent.key, ent);
            msg.hops--;
            if (
                msg.hops > 0 &&
                CircularSpace.isOrdered(
                    msg.sourceKey,
                    false,
                    this.left!.getRemoteKey(),
                    this.getKey(),
                    false
                )
            ) {
                this.left!.send(msg);
            }
            this.dumpPStore();
        }

        public dumpPStore(): void {
            if (!this.logger.isEnabled()) {
                return;
            }
            this.logger.debug("pDump:pSuccessors=%s", this.pSuccessors);
            let m = "";
            for (const ent of this.pStore.entries()) {
                m = m + `{key=${ent[0]}, val=${JSON.stringify(ent[1])}}\n`;
            }
            this.logger.debug("pDump:pStore=%s", m);
        }

        private static async convertBlob2String(
            blob: any
        ): Promise<ValAndType> {
            if (isBlob(blob)) {
                const buf = await new Response(blob).arrayBuffer();
                const array = new Uint8Array(buf);
                return {
                    type: "Blob",
                    value:
                        (blob.type ? blob.type + "," : "") +
                        b64.fromByteArray(array),
                };
            }
            throw new Error("not blob");
        }

        private static convertString2Blob(s: string): Blob {
            const split = s.split(",");
            let type: string;
            if (split.length === 1) {
                type = "";
            } else if (split.length === 2) {
                type = split.shift() as string;
            } else {
                throw new Error("wrong format");
            }
            const u8array = b64.toByteArray(split[0]);
            return new Blob([u8array], {
                type: type,
            });
        }

        private static convertTypedArray2String(v: Uint8Array): ValAndType {
            if (!(v instanceof Uint8Array)) {
                throw new Error("not Uint8Array");
            }
            return {
                type: "Uint8Array",
                value: b64.fromByteArray(v),
            };
        }

        private static convertString2Uint8Array(s: string): Uint8Array {
            return b64.toByteArray(s);
        }
    }
    return PStoreInternal;
}
