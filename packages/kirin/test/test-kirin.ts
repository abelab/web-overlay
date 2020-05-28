import { suite, test, timeout } from "mocha-typescript";
import { createPStoreClass, KirinNode, PStoreIf } from "../dist";
import {
    applyMixins,
    Logger,
    Manager,
    sleep,
} from "@web-overlay/manager";
import * as base from "./common";

class KirinOverride {
    public createNode(key: string, manager: Manager): PStoreIf {
        const clazz = createPStoreClass(KirinNode);
        return new clazz(key, manager);
    }
}

@suite
class KirinFingerTable extends base.TestBase {
    // @test(timeout(70000))
    public async testFingerTable(): Promise<void> {
        // Logger.enable("*");
        return super.testDrive(7, async () => {
            const period = KirinNode.FT_UPDATE_PERIOD;
            await sleep(period * 4);
            for (const n of this.ddllNodes) {
                ((n as unknown) as KirinNode).showFingerTable();
            }
        });
    }
}
applyMixins(KirinFingerTable, [KirinOverride]);
