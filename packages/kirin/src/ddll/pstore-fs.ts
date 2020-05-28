/*
 * this file is for Node.js only.
 */

import fs = require("fs");
import openpgp = require("openpgp");
import { Deferred } from "@web-overlay/manager";
import { PerKeyEnt, PStoreIf } from "./pstore";

export class PStoreUtils {
    public static saveToFile(
        pstore: PStoreIf,
        pathname: string
    ): Promise<void> {
        const pmap = pstore._getMap();
        const prom = new Deferred<void>();
        // pstore.logger.log("keys=", [...map.keys()]);
        const array = [...pmap];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const str = JSON.stringify(array, (key: string, value: any) => {
            if (key === "pgpPubKey") {
                const pubkey = value as openpgp.key.Key;
                return pubkey.armor();
            } else {
                return value;
            }
        });
        fs.writeFile(pathname, str, (err) => {
            if (err) {
                prom.reject(err);
            } else {
                prom.resolve();
            }
        });
        return prom.promise;
    }

    public static loadFromFile(
        pstore: PStoreIf,
        pathname: string
    ): Promise<void> {
        const prom = new Deferred<void>();
        fs.readFile(pathname, async (err, data) => {
            if (err) {
                prom.reject(err);
                return;
            }
            const pmap = pstore._getMap();
            const obj = JSON.parse(data.toString());
            const map = new Map<string, PerKeyEnt>(obj);
            for (const [key, pkent] of map) {
                if (typeof pkent.pgpPubKey === "string") {
                    const keyresult = await openpgp.key.readArmored(
                        pkent.pgpPubKey
                    );
                    pkent.pgpPubKey = keyresult.keys[0];
                }
                pmap.set(key, pkent);
            }
            // pstore.logger.log("loadFromFile: map=", JSON.stringify([...pmap]));
            prom.resolve();
        });
        return prom.promise;
    }
}
