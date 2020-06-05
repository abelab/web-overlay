import { override } from "core-decorators";
import * as fs from "fs";
import * as http from "http";
import * as nodeStatic from "node-static";
import * as socketIO from "socket.io";
import * as URL from "url";
import {
    Manager,
    NodeSpec,
    ManagerConfig,
    Deferred,
} from "@web-overlay/manager";
import { WsServerConnection } from "./raw/websocketserver";
import { Socket } from "net";

export type PortalManagerConfigAdd = {
    // Portal Node
    MY_URL: string;
    HTTP_SERVER_ROOT_DIR?: string;
};

export type PortalManagerConfig = ManagerConfig & PortalManagerConfigAdd;

const PrivateConfigKeys = [
    "KEY",
    "MY_URL",
    "HTTP_SERVER_ROOT_DIR",
    "NODE_ID",
    "WEBRTC_IMPL",
];

/**
 * WebRTC-Manager for Node.js.  This manager can run as a "portal node".
 */
export class PortalManager extends Manager {
    private readonly url: string;
    private io: socketIO.Server | undefined;
    private port: number;
    private httpServer: http.Server | undefined;
    public static TestURL = "http://$TEST";

    constructor(conf: PortalManagerConfig) {
        super(conf);
        const url = (this.config as PortalManagerConfig).MY_URL;
        if (!url) {
            throw new Error("MY_URL is not specified in conf");
        }
        const urlObj = URL.parse(url);
        if (urlObj.protocol !== "http:") {
            throw new Error("only http protocol is supported");
        }
        this.url = url;
        this.port = urlObj.port ? parseInt(urlObj.port) : 80;
    }

    public async start(): Promise<this> {
        const dir = (this.config as PortalManagerConfig).HTTP_SERVER_ROOT_DIR;
        if (this.url === PortalManager.TestURL) {
            this.httpServer = await this.startServer(9999, dir);
        } else {
            this.httpServer = await this.startServer(this.port, dir);
            await this.checkServer();
        }
        return this;
    }

    @override
    public getNodeSpec(): NodeSpec {
        return {
            serverUrl: this.url,
        };
    }

    private getConfigForExport(): Partial<PortalManagerConfig> {
        const conf: any = {};
        Object.assign(conf, this.config);
        for (const key of PrivateConfigKeys) {
            delete conf[key];
        }
        return conf as Partial<PortalManagerConfig>;
    }

    /**
     * start a http server
     *
     * @param port web server port number
     * @param dir directory to serve (for web server)
     */
    private async startServer(
        port: number,
        dir?: string
    ): Promise<http.Server> {
        let fileserver: nodeStatic.Server;
        if (dir) {
            const stat = fs.lstatSync(dir);
            if (!stat.isDirectory()) {
                throw new Error(`${dir} is not directory`);
            }
            fileserver = new nodeStatic.Server(dir);
        }
        this.mgrLogger.debug("Portal.startServer: port=%d", port);

        const defer = new Deferred<void>();
        const httpserver = http
            .createServer(
                (req: http.IncomingMessage, res: http.ServerResponse) => {
                    req.addListener("end", () => {
                        if (req.method === "GET" && req.url === "/config.js") {
                            res.writeHead(200, {
                                "Content-Type": "text/plain; charset=utf-8",
                            });
                            res.write(
                                JSON.stringify(this.getConfigForExport())
                            );
                            res.end();
                        } else if (fileserver) {
                            fileserver.serve(req, res);
                        } else {
                            res.writeHead(404, "out of service");
                            res.end();
                        }
                    }).resume();
                }
            )
            .listen(port);
        httpserver.on("listening", () => defer.resolve());
        httpserver.on("error", (err) => defer.reject(err));
        httpserver.on("connection", (socket: Socket) => {
            this.cleaner.push(() => {
                this.rawLogger.debug("server: socket.destroy!");
                socket.destroy();
            });
        });
        this.cleaner.push(() => {
            httpserver.unref();
            httpserver.close();
        });
        await defer.promise;

        // attach a WebSocket server
        this.io = socketIO(httpserver);
        // allow CORS
        this.io.origins("*:*");
        this.cleaner.push(() => this.io?.close());
        this.io.sockets.on("connection", (socket: socketIO.Socket) => {
            if (this.io) {
                this.mgrLogger.newEvent("new connection");
                const raw = new WsServerConnection(this, socket);
                this.mgrLogger.debug("new connection: %s", raw);
            }
        });
        return httpserver;
    }

    private async checkServer(): Promise<void> {
        this.mgrLogger.debug("checkServer: %s", this.url);
        const defer = new Deferred<void>();
        let pc;
        try {
            pc = await this.connectPortal(this.url);
        } catch (err) {
            this.mgrLogger.info("checkServer failed: %s", err);
            throw new Error("could not connect to my URL: " + this.url);
        }
        if (pc.getRemoteNodeId() !== this.getNodeId()) {
            this.mgrLogger.info(
                "checkServer failed: connected to unexpected node: %s",
                pc.getRemoteNodeId()
            );
            pc.close();
            defer.reject(
                new Error(
                    `my URL is wrong: connected to (${pc.getRemoteNodeId()}). `
                )
            );
        } else {
            const raw = pc.getRawConnection();
            pc.close();
            raw?.close(); // should be graceful
            defer.resolve();
        }
        await defer.promise;
        this.mgrLogger.debug("checkServer OK");
    }
}
