#!/usr/bin/env node

import { generateRandomId, Logger, Manager } from "@web-overlay/manager";
import {
    PortalManager,
    PortalManagerConfig,
} from "@web-overlay/manager/dist/portal";
import {
    createPStoreClass,
    DdllNode,
    KirinNode,
    PStoreDdll,
} from "@web-overlay/kirin";
import * as path from "path";
import * as readline from "readline";
import { GetInfoRequest } from "../common/topology";
import { ChatApp } from "../common/chat";
import { config, Config } from "node-config-ts";
import fetch from "node-fetch";

const logger = new Logger("CUI", "CUI", "");

logger.debug("CONFIGURATION: %J", config);

export class Main {
    private commandMap: { [key: string]: (_: string[]) => void } = {
        status: () => this.status(),
        leave: () => this.leave(),
        quit: () => this.quit(),
        enable: (args: string[]) => this.enable(args),
        disable: () => this.disable(),
    };
    private dummy = GetInfoRequest; // force loading

    public node?: DdllNode;
    private readonly factory: (key: string, manager: Manager) => PStoreDdll;
    public chatApp?: ChatApp;

    constructor(factory: (key: string, manager: Manager) => PStoreDdll) {
        this.factory = factory;
    }

    public static usage(): void {
        console.error(`\
Usage:
- Create config/deployment/CONFIG.json (where CONFIG is an arbitrary name)
- Run "env DEPLOYMENT=CONFIG node ${process.argv[1]}"
- You can override CONFIG.json by command line: "env DEPLOYMENT=CONFIG node ${process.argv[1]} --KEY=ABC"`);
    }

    public static async start(): Promise<Main> {
        if (!config.MY_URL && !config.INTRODUCER_URL) {
            console.error(
                "at least either MY_URL or INTRODUCER_URL must be specified"
            );
            Main.usage();
            process.exit(1);
        }
        if (config.MY_URL === config.INTRODUCER_URL) {
            console.error("MY_URL should not be INTRODUCER_URL");
            Main.usage();
            process.exit(1);
        }
        if (typeof config.KEY !== "string") {
            if (config.KEY === null || config.KEY === undefined) {
                console.error("KEY is missing");
                process.exit(1);
            }
            config.KEY = String(config.KEY);
        }

        let conf: Config;
        if (!config.INTRODUCER_URL) {
            console.log("Run as the initial portal node");
            config.OVERLAY = config.OVERLAY || "kirin";
            if (config.OVERLAY !== "kirin" && config.OVERLAY !== "ddll") {
                console.error('OVERLAY must be either "kirin" or "ddll"');
                Main.usage();
                process.exit(1);
            }
            config.NETWORK_ID =
                config.NETWORK_ID || "NET-" + generateRandomId();
            conf = config;
        } else {
            if (config.MY_URL) {
                console.log("Run as an non-initial portal node");
            } else {
                console.log("Run as an non-portal node");
            }

            // delete null properties so that Object.assign overrides them
            for (const key of Object.keys(config)) {
                if (
                    (config as any)[key] === null ||
                    (config as any)[key] === undefined
                ) {
                    delete (config as any)[key];
                }
            }
            delete config.OVERLAY; // use remote config
            delete config.NETWORK_ID; // use remote config

            // fetch remote configuration
            if (config.INTRODUCER_URL.slice(-1) === "/") {
                config.INTRODUCER_URL = config.INTRODUCER_URL.substr(
                    0,
                    config.INTRODUCER_URL.length - 1
                );
            }
            const url = config.INTRODUCER_URL + "/config.js";
            console.error("Fetching configuration from " + url + " ...");
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const remoteConfig: Partial<PortalManagerConfig> = await response.json();
                    conf = Object.assign(remoteConfig, config);
                    logger.debug("RemoteConfig: %J", remoteConfig);
                    logger.debug("Final Config: %J", conf);
                } else {
                    console.error("fetch failed");
                    process.exit(1);
                }
            } catch (err) {
                console.error("fetching from " + url + " failed: " + err);
                process.exit(1);
            }
        }
        console.log("- NETWORK_ID: " + conf.NETWORK_ID);
        console.log("- LOG_SERVER_URL: " + conf.LOG_SERVER_URL);
        console.log("- OVERLAY: " + conf.OVERLAY);
        console.log("- MY_URL: " + conf.MY_URL);
        console.log("- DEBUG: " + conf.DEBUG);

        const main = new Main((key, manager) => {
            let clazz;
            const isKirin = conf.OVERLAY === "kirin";
            if (isKirin) {
                clazz = createPStoreClass(KirinNode);
            } else {
                clazz = createPStoreClass(DdllNode);
            }
            return new clazz(key, manager);
        });

        if (conf.MY_URL) {
            const httpDir = path.resolve(__dirname, "../../dist");
            console.log("- HTTP ROOT: " + httpDir);
            conf.HTTP_SERVER_ROOT_DIR = httpDir;
            const manager = await main.joinPortal(conf);
            console.log(
                `started: NodeId=${manager.getNodeId()}, URL=${conf.MY_URL}`
            );
        } else {
            if (!conf.INTRODUCER_URL) {
                console.error("no INTRODUCER_URL is specified");
                process.exit(1);
            }
            const manager = await main.joinNonPortal(conf);
            console.log(`started: NodeId=${manager.getNodeId()}`);
        }
        return main;
    }

    public async joinPortal(conf: Config): Promise<PortalManager> {
        let manager: PortalManager;
        if (!conf.MY_URL) {
            throw new Error("MY_URL is not set");
        }
        try {
            manager = new PortalManager(conf as PortalManagerConfig);
        } catch (err) {
            console.error("got error when creating PortalManager: ", err);
            process.exit(1);
        }
        console.log("starting portal node...");
        try {
            await manager.start();
        } catch (err) {
            console.error(`starting portal failed: ${err}`);
            process.exit(1);
        }
        await this.join(conf.KEY, manager, conf.INTRODUCER_URL);
        return manager;
    }

    public async joinNonPortal(conf: Config): Promise<Manager> {
        const manager = new Manager(conf);
        await this.join(conf.KEY, manager, conf.INTRODUCER_URL);
        return manager;
    }

    private async join(
        key: string,
        manager: Manager,
        introducerURL: string | undefined
    ): Promise<void> {
        this.node = this.factory(key, manager);
        if (!introducerURL) {
            try {
                await this.node.initInitialNode();
                console.log("initInitialNode succeeded");
            } catch (err) {
                console.log("initInitialNode failed", err.toString());
                return;
            }
        } else {
            console.log("joining...");
            try {
                await this.node.join(introducerURL);
                console.log("joined!");
            } catch (err) {
                console.log("join failed: ", err.toString());
                throw err;
            }
        }
        this.node.addLeftNodeChangeListener((pc) =>
            console.log(`DDLL: left link is changed: ${pc}`)
        );
        this.node.addRightNodeChangeListener((pc) =>
            console.log(`DDLL: right link is changed: ${pc}`)
        );
        this.chatApp = new ChatApp(this.node);
    }

    public startCUI(): void {
        console.warn("Command list:", Object.keys(this.commandMap).join(", "));
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.setPrompt("Prompt> ");
        rl.prompt();
        rl.on("SIGINT", () => {
            console.warn("interrupted!");
            process.exit(0);
        });
        rl.on("SIGCONT", () => {
            rl.prompt();
        });
        rl.on("line", (input) => {
            if (/^\s*$/.test(input)) {
                rl.prompt();
                return;
            }
            const args = input.split(/\s+/);
            const cmd = args.shift();
            if (cmd && cmd in this.commandMap) {
                this.commandMap[cmd](args);
            } else {
                console.warn("unknown command");
            }
            rl.prompt();
        });
    }

    public status(): void {
        console.log(this.node!.toString());
        if (this.node instanceof KirinNode) {
            console.log(this.node.prettyPrintFingerTable());
        }
        console.log(this.node!.manager.getManagerInfoString());
    }

    public leave(): void {
        this.node!.leave()
            .then(() => {
                console.log("leave succeeded");
            })
            .catch((err) => {
                console.log("leave failed: " + err.toString());
            });
    }

    public quit(): void {
        console.log("bye!");
        process.exit(0);
    }

    public enable(args: string[]): void {
        if (args.length === 0) {
            Logger.enable("*");
        } else {
            Logger.enable(args[0]);
        }
    }

    public disable(): void {
        Logger.disable();
    }
}

Main.start()
    .then((main) => {
        if (!config.NO_CUI) {
            main.startCUI();
        }
    })
    .catch((err) => {
        console.error("start node failed: ", err.message);
        console.error(err);
        process.exit(1);
    });
