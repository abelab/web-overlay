import * as jsSHA from "jssha";

import { Manager } from "@web-overlay/manager";
import { DdllNode } from "./ddll";
import {
    createPStoreClass,
    PStoreIf,
    PSValue,
    PutOption,
    SignedPutOption,
} from "./pstore";

export class DhtManager {
    private _node?: PStoreIf;

    public dhtJoin(
        manager: Manager,
        baseClass: typeof DdllNode,
        url?: string
    ): Promise<void> {
        const hashKey = DhtManager.hashKey(Math.random().toString());
        const clazz = createPStoreClass(baseClass);
        this._node = new clazz("DHT." + hashKey, manager);
        if (!url) {
            return this._node.initInitialNode();
        } else {
            return this._node.join(url);
        }
    }

    public dhtPut(
        key: string,
        value: PSValue,
        option: PutOption | SignedPutOption
    ): Promise<void> {
        if (!this._node) {
            throw new Error("dhtPut() is called before dhtJoin() is called");
        }
        return this._node.rawPut(DhtManager.hashKey(key), value, option);
    }

    public dhtGet(key: string, index = 0): Promise<PSValue | null> {
        if (!this._node) {
            throw new Error("dhtGet() is called before dhtJoin() is called");
        }
        return this._node.rawGet(DhtManager.hashKey(key), index);
    }

    public dhtGetMulti(
        key: string,
        minindex: number,
        maxindex: number
    ): Promise<(PSValue | null)[]> {
        if (!this._node) {
            throw new Error(
                "dhtGetMulti() is called before dhtJoin() is called"
            );
        }
        return this._node.rawGetMulti(
            DhtManager.hashKey(key),
            minindex,
            maxindex
        );
    }

    public static dhtGetDirect(
        node: PStoreIf,
        key: string,
        minidex = 0,
        maxindex = 1
    ): Promise<(PSValue | null)[]> {
        return node.rawGetMulti(DhtManager.hashKey(key), minidex, maxindex);
    }

    public get node(): PStoreIf {
        if (!this._node) {
            throw new Error("node() is called before dhtJoin() is called");
        }
        return this._node;
    }

    private static hashKey(key: string): string {
        const shaobj = new jsSHA("SHA-1", "TEXT");
        shaobj.update(key);
        return shaobj.getHash("HEX");
    }
}
