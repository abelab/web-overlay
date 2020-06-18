/*
 * Simple unstructured overlay network for demonstrating Web-Overlay toolkit APIs.
 *
 * - This program runs on a Node.js and has a CUI interface.
 * - Try to keep at least UNODE_NUMBER_OF_CONNECTIONS connections.
 * - Supports random walking and flooding.
 *
 * Usage:
 *   % node unode.js my-url [introducer-url]
 * Example:
 *   To start the initial node listening on port 8000.
 *   % node unode.js http://localhost:8000
 *
 *   To start a non-initial node listening on port 8001.  http://localhost:8000 is used as an introducer.
 *   % node unode.js http://localhost:8001 http://localhost:8000
 *   You may join more nodes (change the port number of the first parameter).
 */

import {
    Cleanable,
    Cleaner,
    Logger,
    Manager,
    Message,
    RequestMessage,
    ReplyMessage,
    generateRandomId,
    RequestMessageSpec,
    EndOfReply,
    TimeoutError,
    Deferred,
} from "@web-overlay/manager/dist";
import {
    ArrayUtils,
    ConnectionRequest,
    PeerConnection,
    serializable,
} from "@web-overlay/manager/dist";
import { PortalManager, PortalManagerConfig } from "@web-overlay/portal/dist";
import * as readline from "readline";
import minimist = require("minimist");

export const UNODE_LOG_NAMESPACE = "web:unode";
export const UNODE_KEY = "unode-any";
export const UNODE_PROP_NAME = "unode";
export const UNODE_NUMBER_OF_CONNECTIONS = 3;
export const UNODE_CHECK_CONNECTION_PERIOD = 30 * 1000;
export const UNODE_DEFAULT_TTL = 3; // used for random walk and flooding

/**
 * This interface is used for expressing that messages have "unode" property.
 * See comments in {@link UNode.constructor}.
 */
export interface UNodeMessage {
    unode: UNode;
}

/**
 * A request message to establish a PeerConnection to a random node.
 * To establish a PeerConnection with another node, you have to define a subclass of ConnectionRequest.
 *
 * @serializable decorator registers this class to Manager as a serializable class.
 */
@serializable
export class ConnectWithRandomWalkRequest extends ConnectionRequest {
    // sequence of NodeIDs that forwards this message
    private readonly path: string[];
    private ttl: number;
    // NodeIDs to be excluded from the target node
    private excludeNodeIds: string[];
    constructor(manager: Manager, hops: number, excludeNodeIds: string[]) {
        // A PeerConnection has a local key and a remote key.  In this example,
        // UNODE_KEY is used for all keys.
        super(manager, UNODE_KEY);
        this.ttl = hops;
        this.excludeNodeIds = excludeNodeIds;
        this.path = [this.manager.getNodeId()];
    }

    /**
     * You must implement onReceive() method to define your routing algorithm of this message.
     * This method is called when this message is received.
     */
    protected async onReceive(): Promise<void> {
        /*
         * See comments in {@link UNode.constructor} about "this.unode".
         * When this message is sent with Manager.connectPortal(), this.unode is not initialized.
         */
        if (!this.unode) {
            this.unode = this.manager.getApp(
                UNODE_KEY,
                UNODE_PROP_NAME
            ) as UNode;
            if (!this.unode) {
                console.warn("onReceive: no app?");
                return;
            }
        }
        const logger = this.unode.logger;
        logger.debug("RandomWalk.onReceive(): hops=%d", this.ttl);
        this.ttl--;
        if (this.ttl > 0) {
            // Forward this request to a random connection.
            const p = this.unode.chooseRandomConnection(this.path);
            if (p) {
                this.path.push(this.manager.getNodeId());
                p.send(this);
                return;
            }
        }
        // This is the last node case.
        if (this.excludeNodeIds.indexOf(this.manager.getNodeId()) < 0) {
            // If the NodeID of this node is not included in excludeNodeIds.
            try {
                logger.debug("accept!");
                // Establish a connection with this node.  UNODE_KEY is the local key of this connection.
                const pc = await this.accept(UNODE_KEY);
                // Register this connection to the UNode.
                this.unode.setupConnection(pc);
                logger.debug("accepted: %s", pc);
                console.log("accepted connection from " + pc.getRemoteNodeId());
            } catch (err) {
                logger.debug("accept failed %s", err);
                // ignore
            }
        } else {
            logger.debug("reject");
            // Reject the connection request.
            this.reject("no candidate");
        }
    }
}
// This is to add "unode" property in ConnectWithRandomWalkRequest
export interface ConnectWithRandomWalkRequest extends UNodeMessage {}

@serializable
export class KeepAlive extends Message {
    constructor(manager: Manager) {
        super(manager);
    }
    protected onReceive(): void {
        // empty
    }
}

/**
 * This class represents RandomWalk request message.
 */
@serializable
export class RandomWalk extends RequestMessage<RandomWalk, RandomWalkReply> {
    public readonly qid = generateRandomId();
    private readonly path: string[] = [];
    constructor(manager: Manager, public query: string, public hops: number) {
        super(manager);
    }
    /*
     * getSpec() defines the request.
     */
    public getSpec(): RequestMessageSpec {
        return {
            // replyClassName defines the class name of a reply message.
            // This information is used just for sanity checking.
            replyClassName: RandomWalkReply.name,
        };
    }
    /*
     * onReceive() defines handling this message.
     */
    protected onReceive(): void {
        /**
         * this.unode points to an instance of UNode in this node.
         * See comments in {@link UNode.constructor}.
         */
        const u = this.unode;
        u.logger.debug("RandomWalk.onReceive");
        // actually, checking querySeen is not necessary for RandomWalk because this.path
        if (u.querySeen.has(this.qid)) {
            return;
        }
        u.querySeen.add(this.qid);

        const val = u.resources.get(this.query);
        if (val) {
            // If this node has a matching entry (hit), send a reply.
            const reply = new RandomWalkReply(this, val);
            this.sendReply(reply);
        } else {
            if (this.hops > 0) {
                // Forward this request to a random connection.
                this.hops--;
                this.path.push(this.manager.getNodeId());
                const pc = u.chooseRandomConnection(this.path);
                if (pc) {
                    pc.send(this);
                    return;
                }
            }
            // Reached the last node without hit.  Send null as a reply.
            const reply = new RandomWalkReply(this, null);
            this.sendReply(reply);
        }
    }
}
export interface RandomWalk extends UNodeMessage {}

/**
 * This class represents Flooding reply message.
 */
@serializable
export class RandomWalkReply extends ReplyMessage<RandomWalk, RandomWalkReply> {
    constructor(req: RandomWalk, public val: string | null) {
        super(req);
    }
}

/*
 * This class represents Flooding request message.
 */
@serializable
export class Flooding extends RequestMessage<Flooding, FloodingReply> {
    public readonly qid = generateRandomId();
    private readonly path: string[] = [];
    constructor(manager: Manager, public query: string, public hops: number) {
        super(manager);
    }
    public getSpec(): RequestMessageSpec {
        return {
            replyClassName: FloodingReply.name,
            // to allow receiving multiple replies
            allowMultipleReply: true,
        };
    }
    protected onReceive(): void {
        const u = this.unode;
        u.logger.debug("Flooding.onReceive");
        if (u.querySeen.has(this.qid)) {
            return;
        }
        u.querySeen.add(this.qid);

        const val = u.resources.get(this.query);
        if (val) {
            const reply = new FloodingReply(this, val);
            this.sendReply(reply);
        }

        this.path.push(this.manager.getNodeId());
        if (this.hops > 0) {
            // Flood this request to other nodes
            this.hops--;
            u.connections.forEach((pc) => {
                if (this.path.indexOf(pc.getRemoteNodeId()) < 0) {
                    u.logger.debug("sent to %s", pc);
                    pc.send(this);
                }
            });
        }
    }
}
export interface Flooding extends UNodeMessage {}

@serializable
export class FloodingReply extends ReplyMessage<Flooding, FloodingReply> {
    constructor(req: Flooding, public val: string) {
        super(req);
    }
}

/*
 * This class represents a node in an overlay network.
 */
export class UNode implements Cleanable {
    public readonly manager: Manager; // Connection Manager
    public readonly logger: Logger;
    public cleaner: Cleaner;

    // connections to other nodes
    public connections: PeerConnection[] = [];
    // QIDs of messages received by flooding.  (expiration is unimplemented)
    public querySeen = new Set<string>();
    // key-value pairs
    public resources = new Map<string, string>();

    constructor(manager: Manager) {
        this.manager = manager;
        this.logger = this.manager.createLogger(UNODE_LOG_NAMESPACE);
        this.cleaner = new Cleaner(this.logger);
        // The meaning of the next line:
        //   When message M is received via a PeerConnection whose local key is UNODE_KEY,
        //   then M.UNODE_PROP_NAME is set to "this".
        this.manager.registerApp(UNODE_KEY, UNODE_PROP_NAME, this);
    }

    /**
     * Start as the initial node (the first in the overlay network).
     */
    public async startInitialNode(): Promise<void> {
        this.startTimer();
    }

    /**
     * Start as a non-initial node.
     */
    public async join(introducerURL: string): Promise<void> {
        const msg = new ConnectWithRandomWalkRequest(this.manager, 1, []);
        // Connect to introducerURL (with Socket.io), send msg and wait for establishing a connection.
        // In this case, connect with the introducer node because hops === 1.
        const introducerPC = await msg.connect(introducerURL);
        this.setupConnection(introducerPC);
        try {
            // Establish other connections
            await this.stayConnected();
            if (this.connections.length > UNODE_NUMBER_OF_CONNECTIONS) {
                // If we have sufficient connections, close the first connection.
                this.closeConnection(introducerPC);
            }
        } finally {
            this.startTimer();
        }
    }

    /**
     * Call {@link #stayConnected()} periodically.
     */
    private startTimer(): void {
        // Timers are provided in Cleaner class.
        this.cleaner.startIntervalTimer(
            this.manager,
            "unode-stay-connected",
            UNODE_CHECK_CONNECTION_PERIOD,
            async () => {
                await this.stayConnected();
            }
        );
    }

    private stayConnectedRunning = false;
    /**
     * Try to keep number of connections to other nodes.
     */
    private async stayConnected(): Promise<void> {
        if (this.stayConnectedRunning) {
            return;
        }
        this.stayConnectedRunning = true;
        // Send a keep-alive message to all connections so that they do not disconnect due to a long idle time.
        for (const pc of this.connections) {
            pc.send(new KeepAlive(this.manager));
        }
        const n = UNODE_NUMBER_OF_CONNECTIONS - this.connections.length;
        for (let i = 0; i < n; i++) {
            try {
                await this.connectRandomNode();
            } catch (err) {
                // ignore
            }
        }
        this.stayConnectedRunning = false;
    }

    /*
     * Connect to a random node.
     */
    private async connectRandomNode(): Promise<PeerConnection> {
        const firstHop = this.chooseRandomConnection();
        if (!firstHop) {
            throw new Error("no connection is available!");
        }
        this.logger.debug("connectRandomNode: first=%s", firstHop);
        // from 2 to 5 hops
        const hops = 2 + Math.floor(Math.random() * 4);
        const excludes = this.connections.map((pc) => pc.getRemoteNodeId());
        excludes.push(this.manager.getNodeId());
        const req = new ConnectWithRandomWalkRequest(
            this.manager,
            hops,
            excludes
        );
        try {
            const pc = await req.connect(firstHop);
            this.setupConnection(pc);
            this.logger.debug("connectRandomNode: connected %s", pc);
            console.log("connected to " + pc.getRemoteNodeId());
            return pc;
        } catch (err) {
            this.logger.debug("connectRandomNode: rejected");
            throw new Error("connect fails");
        }
    }

    public chooseRandomConnection(
        exclude?: string[]
    ): PeerConnection | undefined {
        let candidates = this.connections.filter((p) => p.isConnected());
        if (exclude) {
            candidates = candidates.filter(
                (p) => exclude.indexOf(p.getRemoteNodeId()) < 0
            );
        }
        if (candidates.length > 0) {
            return candidates[Math.floor(Math.random() * candidates.length)];
        }
        return undefined;
    }

    public setupConnection(pc: PeerConnection): void {
        this.connections.push(pc);
        pc.onDisconnect(() => {
            console.log("disconnected with " + pc.getRemoteNodeId());
            ArrayUtils.remove(this.connections, pc);
        });
    }

    private closeConnection(pc: PeerConnection): void {
        ArrayUtils.remove(this.connections, pc);
        pc.close();
    }

    public put(key: string, value: string): void {
        this.resources.set(key, value);
    }

    public async randomWalk(key: string, ttl: number): Promise<void> {
        const req = new RandomWalk(this.manager, key, ttl);
        const DEMONSTRATE_REQUEST = false;
        // Demonstrate 2 APIs
        if (!DEMONSTRATE_REQUEST) {
            // call RandomWalk.onReceive() and receive a reply via RandomWalk.onReply().
            const defer = new Deferred<void>();
            req.onReply((reply) => {
                if (reply instanceof Error) {
                    console.log("Error: " + reply);
                } else {
                    if (reply.val) {
                        console.log(
                            "Found value " +
                                reply.val +
                                " at " +
                                reply.srcNodeId +
                                " (path=" +
                                reply.source +
                                ")"
                        );
                    } else {
                        console.log(
                            "Not found. Reply came from " +
                                reply.srcNodeId +
                                " (path=" +
                                reply.source +
                                ")"
                        );
                    }
                }
                defer.resolve();
            });
            req.invokeOnReceive(UNODE_KEY);
            return defer.promise;
        } else {
            // use RandomWalk.request(), which is implemented in a super class
            // note that this code does not lookup at the local node.
            const first = this.chooseRandomConnection();
            if (first) {
                try {
                    const reply = await req.request(first); // return type is RandomWalkReply
                    if (reply.val) {
                        console.log(
                            "Found value " +
                                reply.val +
                                " at " +
                                reply.srcNodeId +
                                " (path=" +
                                reply.source +
                                ")"
                        );
                    } else {
                        console.log(
                            "Not found. Reply came from " +
                                reply.srcNodeId +
                                " (path=" +
                                reply.source +
                                ")"
                        );
                    }
                } catch (err) {
                    console.log("Error: " + err);
                }
            } else {
                console.log("No connection!");
            }
        }
    }

    public async flooding(key: string, ttl: number): Promise<void> {
        const defer = new Deferred<void>();
        const req = new Flooding(this.manager, key, ttl);
        req.onStreamingReply((reply) => {
            this.logger.debug("flooding: GOT REPLY: %s", reply);
            if (reply instanceof EndOfReply) {
                // this does not happen because we do not send EndOfReply
                defer.resolve();
            } else if (reply instanceof TimeoutError) {
                console.log("Query Timeout");
                defer.resolve();
            } else if (reply instanceof Error) {
                console.log("Error: " + reply);
            } else if (reply instanceof FloodingReply) {
                console.log(
                    "Found value " +
                        reply.val +
                        " at " +
                        reply.srcNodeId +
                        " (path=" +
                        reply.source +
                        ")"
                );
            } else {
                console.log("Unexpected reply: " + reply);
            }
        });
        req.invokeOnReceive(UNODE_KEY);
        await defer.promise;
    }

    public destroy(): void {
        this.cleaner.clean();
    }
}

export class App {
    private unode?: UNode;

    public usage(): void {
        console.log(
            "Command Line Usage:\n" +
                "status              -- show connections\n" +
                "put key value       -- store a key-value pair in this node\n" +
                "rw [--ttl=N] key    -- search key by single random walk\n" +
                "flood [--ttl=N] key -- search key by flooding"
        );
    }

    public async main(myURL: string, introducerURL?: string): Promise<void> {
        // Manager configuration parameters
        const conf: PortalManagerConfig = {
            // The URL of this node
            MY_URL: myURL,
            // NETWORK_ID is used for isolating overlays of unrelated applications
            NETWORK_ID: "unstructured",
            // The URL of a log server
            //LOG_SERVER_URL: "http://localhost:8801"
        };
        // Logger.enable("DEBUG:web:*"); // or, set environment variable as DEBUG=web:*
        // Initialize Connection Manager
        const manager = await new PortalManager(conf).start();
        this.unode = new UNode(manager);
        try {
            if (introducerURL) {
                await this.unode.join(introducerURL);
            } else {
                await this.unode.startInitialNode();
            }
            console.log(
                "Started: NodeID=" + manager.getNodeId(),
                ", URL=" + manager.getNodeSpec().serverUrl
            );
            this.usage();
            this.startCUI();
        } catch (err) {
            manager.destroy();
            throw new Error("start node failed: " + err);
        }
    }

    public startCUI(): void {
        const unode = this.unode!;
        const prompt = unode.manager.getNodeId() + "> ";
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: prompt,
        });
        rl.prompt();
        rl.on("SIGINT", () => {
            console.warn("interrupted!");
            process.exit(0);
        });
        rl.on("SIGCONT", () => {
            rl.prompt();
        });
        rl.on("line", async (input: string) => {
            input = input.trim();
            if (/^\s*$/.test(input)) {
                rl.prompt();
                return;
            }
            let args = input.split(/\s+/);
            const cmd = args.shift();
            const parsed = minimist(args);
            args = parsed._;
            if (cmd === "status") {
                unode.connections.forEach((pc) => {
                    console.log(pc.toString());
                });
            } else if (cmd === "put" && args.length === 2) {
                unode.put(args[0], args[1]);
            } else if ((cmd === "rw" || cmd === "flood") && args.length === 1) {
                const ttl = !isNaN(parseInt(parsed.ttl))
                    ? parseInt(parsed.ttl)
                    : UNODE_DEFAULT_TTL;
                console.log("TTL=" + ttl);
                if (cmd === "rw") {
                    await unode.randomWalk(args[0], ttl);
                } else {
                    await unode.flooding(args[0], ttl);
                }
            } else {
                this.usage();
            }
            rl.prompt();
        });
        rl.on("close", () => {
            unode.destroy();
            process.exit(0);
        });
    }
}

process.argv.shift();
process.argv.shift();
if (process.argv.length === 1 || process.argv.length === 2) {
    // Note that if process.argv.length === 1, process.argv[1] is undefined.
    const app = new App();
    app.main(process.argv[0], process.argv[1]).catch((err) => {
        console.log(err);
    });
} else {
    console.log("Usage: node unode.js my-url [introducer-url]");
}
