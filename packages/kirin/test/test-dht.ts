// eslint-disable no-constant-condition
import fs = require("fs");
import assert = require("assert");
import openpgp = require("openpgp");
import { Logger } from "@web-overlay/manager";
import {
    DdllNode,
    DhtManager,
    PStoreError,
    PSValue,
    PutOption,
    SignedPutOption,
} from "../dist";
import { TestBase } from "./common";
import { suite, test, timeout } from "mocha-typescript";
import { PStoreUtils } from "../dist/ddll/pstore-fs";

@suite
export class TestDhtBase extends TestBase {
    protected dhtNodes: DhtManager[] = [];

    private async prepareSimple(num: number): Promise<void> {
        DdllNode.PING_PERIOD = 0;
        await this.createManagers(num);
        for (let i = 0; i < num; i++) {
            await this.createDhtNode(i);
        }
    }

    private async prepareComplex(): Promise<void> {
        DdllNode.PING_PERIOD = 0;
        await this.createManagers(5);
        const FIRST_NODES = 1;
        // debug.disable();
        for (let i = 0; i < FIRST_NODES; i++) {
            await this.createDhtNode(i);
        }
        const options = await TestDhtBase.generateSignedPutOption("Alice");
        const putSrc = 0;
        // put with key "000", indexes 0, 1, 2
        await this.dhtNodes[putSrc].dhtPut("000", "Hello000", options);
        options.index = 1;
        await this.dhtNodes[putSrc].dhtPut("000", "Hello000-1", options);
        options.index = 2;
        await this.dhtNodes[putSrc].dhtPut("000", "Hello000-2", options);
        // put with key "1", index 0
        options.index = 0;
        await this.dhtNodes[putSrc].dhtPut("1", "Hello1", options);
        for (let i = FIRST_NODES; i < this.manager.length; i++) {
            await this.createDhtNode(i);
        }
    }

    private async createDhtNode(i: number) {
        this.dhtNodes[i] = new DhtManager();
        await this.dhtNodes[i].dhtJoin(
            this.manager[i],
            DdllNode,
            i === 0 ? undefined : this.url0
        );
        const ddll = this.dhtNodes[i].node;
        this.ddllNodes[i] = ddll;
        this.cleaner.push(() => ddll.destroy());
    }

    private static async generateSignedPutOption(
        name: string
    ): Promise<SignedPutOption> {
        const pgpoptions = {
            userIds: [{ name: name, email: name + "@example.com" }],
            numBits: 512, // RSA key size
            passphrase: name,
        };
        const keypair = await openpgp.generateKey(pgpoptions);
        return {
            armoredPrivateKey: keypair.privateKeyArmored,
            armoredPublicKey: keypair.publicKeyArmored,
            passphrase: name,
        };
    }

    private async testPut(
        key: string,
        value: PSValue,
        option: PutOption | SignedPutOption
    ): Promise<void> {
        const putSrc = 0;
        await this.prepareSimple(3);
        await this.dhtNodes[putSrc].dhtPut(key, value, option);
    }

    /*
     * Tests
     */

    @test(timeout(10000))
    public async testUint8Array(): Promise<void> {
        const option: PutOption = {};
        // debug.enable("ddll*,web*");
        const array = new Uint8Array([0, 1, 2, 3]);
        await this.testPut("000", array, option);
        return this.dhtNodes[0].dhtGet("000").then(
            (v) => {
                assert.deepStrictEqual(v, array);
            },
            (err) => {
                console.log("error: " + err.message);
                assert(false);
            }
        );
    }

    // test successful overwrite
    @test(timeout(10000))
    public async testOverwriteSuccess0(): Promise<void> {
        const option: PutOption = {};
        await this.testPut("000", "Hello000", option);
        await this.dhtNodes[0].dhtPut("000", "Hello111", option);
        return this.dhtNodes[0].dhtGet("000").then(
            (v) => {
                assert(v === "Hello111");
            },
            (err) => {
                console.log("error: " + err.message);
                assert(false);
            }
        );
    }

    // test unsuccessful overwrite
    @test(timeout(10000))
    public async testOverwriteFail0(): Promise<void> {
        const putSrc = 0;
        await this.prepareSimple(3);
        const option = await TestDhtBase.generateSignedPutOption("Alice");
        // Logger.enable("*");
        await this.dhtNodes[putSrc].dhtPut("000", "Hello000", option);
        const option2 = {};
        return this.dhtNodes[putSrc]
            .dhtPut("000", "Overwrite-test", option2)
            .then(() => {
                console.log("dhtPut succeeded unexpectedly");
                assert(false);
            })
            .catch((err) => {
                console.log("error: " + err.message);
                assert(err.message === PStoreError.OVERWRITE_FORBIDDEN);
            });
    }

    // test successful overwrite
    @test(timeout(10000))
    public async testOverwriteSuccess(): Promise<void> {
        const option = await TestDhtBase.generateSignedPutOption("Alice");
        await this.testPut("000", "Hello000", option);
        await this.dhtNodes[0].dhtPut("000", "Hello111", option);
        return this.dhtNodes[0].dhtGet("000").then(
            (v) => {
                assert(v === "Hello111");
            },
            (err) => {
                console.log("error: " + err.message);
                assert(false);
            }
        );
    }

    // test unsuccessful overwrite
    @test(timeout(10000))
    public async testOverwriteFail(): Promise<void> {
        const putSrc = 0;
        await this.prepareSimple(3);
        const option1 = {}; // no public key
        await this.dhtNodes[putSrc].dhtPut("000", "Hello000", option1);
        // public key
        const option2 = await TestDhtBase.generateSignedPutOption("Alice");
        await this.dhtNodes[putSrc].dhtPut("000", "Hello111", option2);
        return this.dhtNodes[putSrc]
            .dhtPut("000", "Hello222", option1)
            .then(() => {
                console.log("dhtPut succeeded unexpectedly");
                assert(false);
            })
            .catch((err) => {
                console.log("error: " + err.message);
                assert(err.message === PStoreError.OVERWRITE_FORBIDDEN);
            });
    }

    @test(timeout(10000))
    public async testReplica(): Promise<void> {
        const getSrc = 1;
        await this.prepareComplex();
        await this.ddllNodes[0].leave();
        return this.dhtNodes[getSrc].dhtGet("000").then(
            (v) => {
                console.log("value: " + v);
                assert.equal(v, "Hello000");
            },
            (err) => {
                console.log("error: " + err.message);
                assert(false);
            }
        );
    }

    @test(timeout(10000))
    public async testDhtGet(): Promise<void> {
        const getSrc = 1;
        return this.prepareComplex().then(() => {
            const p = this.dhtNodes[getSrc].dhtGetMulti("000", 0, 3);
            return p.then(
                (v) => {
                    assert(v[0] === "Hello000");
                    assert(v[1] === "Hello000-1");
                    assert(v[2] === "Hello000-2");
                },
                (err) => {
                    console.log("dhtGet() error: " + err);
                    assert(false);
                }
            );
        });
    }

    // public async testDhtJoin(): Promise<void> {
    //     this.manager0 = new PortalManager(
    //         TestBase.NETID,
    //         Math.random().toString(),
    //         this.url0
    //     );
    //     // this.url0 = "http://localhost:" + 8080;
    //     const j = DdllNode.dhtJoin(this.manager0);
    //     return j.then(
    //         () => {
    //             assert(true);
    //         },
    //         err => {
    //             assert(false);
    //         }
    //     );
    // }

    @test(timeout(10000))
    public async testOverwriteSignMismatch(): Promise<void> {
        await this.prepareSimple(3);
        const aliceOpts = await TestDhtBase.generateSignedPutOption("Alice");
        const putSrc = 1;
        await this.dhtNodes[putSrc].dhtPut("000", "Hello000", aliceOpts);
        const bobOpts = await TestDhtBase.generateSignedPutOption("Bob");
        return this.dhtNodes[putSrc]
            .dhtPut("000", "xyz", bobOpts)
            .then(() => {
                console.log("dhtPut succeeded (not expected): ");
                return Promise.reject();
            })
            .catch((err) => {
                console.log("dhtPut failed (as expected): ", err.message);
                assert(err.message === PStoreError.VERIFY_ERROR);
                return Promise.resolve();
            });
    }

    @test(timeout(10000))
    public async testCorruptedPubKey(): Promise<void> {
        await this.prepareSimple(3);
        const opt = await TestDhtBase.generateSignedPutOption("Alice");
        opt.armoredPublicKey = "xxx";
        const putSrc = 1;
        return this.dhtNodes[putSrc]
            .dhtPut("000", "Hello000", opt)
            .then(() => {
                assert(false);
            })
            .catch((err) => {
                console.log("got error (as expected)", err.message);
            });
    }

    @test(timeout(10000))
    public async testCorruptedPrivKey(): Promise<void> {
        await this.prepareSimple(3);
        const opt = await TestDhtBase.generateSignedPutOption("Alice");
        opt.armoredPrivateKey = "xxx";
        const putSrc = 1;
        return this.dhtNodes[putSrc]
            .dhtPut("000", "Hello000", opt)
            .then(() => {
                assert(false);
            })
            .catch((err) => {
                console.log("got error (as expected)", err.message);
            });
    }

    @test(timeout(10000))
    public async testFile(): Promise<void> {
        const filename = "node0.json";
        await this.prepareSimple(1);
        const opt = await TestDhtBase.generateSignedPutOption("Alice");
        const putSrc = 0;
        // Logger.enable("*");
        await this.dhtNodes[putSrc].dhtPut("000", "I'm Alice", opt);
        const opt2 = await TestDhtBase.generateSignedPutOption("Bob");
        await this.dhtNodes[putSrc].dhtPut("001", "I'm Bob", opt);
        // this.dhtNodes[putSrc].node.logger.log("PUT DONE");
        await PStoreUtils.saveToFile(this.dhtNodes[0].node, filename);
        this.cleaner.clean();
        await this.prepareSimple(1);
        await PStoreUtils.loadFromFile(this.dhtNodes[0].node, filename);
        await this.dhtNodes[putSrc]
            .dhtGet("000")
            .then((v) => {
                assert.strictEqual(v, "I'm Alice");
            })
            .catch((err) => {
                console.log("got error:", err);
                throw err;
            });
        fs.unlinkSync(filename);
    }
}
