/* eslint @typescript-eslint/no-explicit-any: 0 */

import DebugLevel = require("debug-level");
import isNode = require("detect-node");
import * as io from "socket.io-client";
import { ArrayUtils, formatDate, generateRandomId } from "../utils/";
import { LogData } from "./logData";

/*
 * Global variables
 */
const startTime = Date.now();

DebugLevel.options({
    formatters: {
        S: (arg): string => String(arg),
    },
});

export type TraceLog = (format: string, ...args: any[]) => void;

export class Logger {
    private static enabled: string | undefined = undefined;
    private readonly nodeId: string;
    private readonly key: string;
    private readonly namespace: string;
    private readonly debugLevel: DebugLevel;
    private static readonly loggers: Logger[] = [];
    private static renderMap: { [key: string]: typeof console.error } = {
        FATAL: console.error,
        ERROR: console.error,
        WARN: console.warn,
        INFO: console.info,
        DEBUG: console.log,
        LOG: console.log,
    };
    // LogSender instance is per Manager
    private static logSender = new Map<string /*nodeId*/, LogSender>();

    constructor(nodeId: string, namespace: string, key: string, url?: string) {
        this.nodeId = nodeId;
        this.namespace = namespace;
        this.key = key;
        this.debugLevel = new DebugLevel(namespace);
        let sender: LogSender | undefined;
        if (url) {
            sender = Logger.logSender.get(nodeId) || new LogSender(nodeId, url);
            Logger.logSender.set(nodeId, sender);
        }
        const supportColor = DebugLevel.options().colors;
        if (!isNode) {
            // rewrite internal _log function
            this.debugLevel._log = (level: string, args: any) => {
                const self = this.debugLevel as any;
                self._diff();
                const _args = self._formatArgs(level, args);
                if (!sender) {
                    self.render(_args, level);
                } else {
                    const o = self._formatJson(level, args);
                    // const str = self.formatter.format(o)[0];
                    sender.sendLog(level, namespace, o.msg);
                }
                return [];
            };
            // rewrite internal render function
            this.debugLevel.render = (str: string[], level: string): void => {
                const func = Logger.renderMap[level] || console.log;
                if (supportColor && str[1]) {
                    // If using dark theme, default DEBUG color is hard to see
                    str[1] = str[1].replace("#0000CC", "#00CCCC");
                }
                func(...str);
            };
        } else {
            this.debugLevel.render = (str: string, level: string): void => {
                str += "\n";
                if (!sender) {
                    process.stderr.write(str);
                } else {
                    // delete ANSI color sequence
                    // eslint-disable-next-line no-control-regex
                    const s = str.replace(/\x1b\[[^m]*m/g, "");
                    sender.sendLog(level, namespace, s);
                }
            };
        }
        Logger.loggers.push(this);
        if (Logger.enabled) {
            this.debugLevel.enable(Logger.enabled);
        }
    }

    public static enable(namespaces: string): void {
        Logger.enabled = namespaces;
        Logger.loggers.forEach((log) => {
            log.debugLevel.enable(namespaces);
        });
    }

    public static disable() {
        Logger.enable("DEBUG:-*");
    }

    public isEnabled(): boolean {
        return this.debugLevel.enabled;
    }

    public destroy(): void {
        ArrayUtils.remove(Logger.loggers, this);
    }

    public fatal(format: string, ...args: any): void {
        this.debugLevel.fatal(this.fmt(format), ...args);
    }

    public error(format: string, ...args: any): void {
        this.debugLevel.error(this.fmt(format), ...args);
    }

    public warn(format: string, ...args: any): void {
        this.debugLevel.warn(this.fmt(format), ...args);
    }

    public info(format: string, ...args: any): void {
        this.debugLevel.info(this.fmt(format), ...args);
    }

    public debug(format: string, ...args: any): void {
        this.debugLevel.debug(this.fmt(format), ...args);
    }

    private fmt(format: string): string {
        return this.prefix() + format.replace(/%s/g, "%S");
    }

    private prefix(): string {
        return (
            "|" + this.nodeId + "|" + this.key + "|" + this.dateString() + "|"
        );
    }

    private dateString(): string {
        const diff = Date.now() - startTime;
        return `${formatDate()}(${diff})`;
    }

    public log(..._message: any[]): void {
        if (!this.isEnabled()) {
            return;
        }
        const message =
            this.prefix() + _message.map((o) => Logger.stringify(o)).join("");
        this.debugLevel.log(message);
    }

    private static stringify(o: any): string {
        if (o === undefined) {
            return "undefined";
        }
        if (o === null) {
            return "null";
        }
        return o.toString();
    }

    public newEvent(format: string, ...args: any[]): void {
        const W = 80;
        const bar = (h: string): string =>
            `== [${h}] ` + "=".repeat(Math.max(W - 6 - h.length, 10));
        this.debug(bar(format), ...args);
    }

    public getTraceLogger(
        prefix: string
    ): { debug: TraceLog; info: TraceLog; newEvent: TraceLog } {
        const traceId = generateRandomId();
        const debug = (format: string, ...args: any[]): void => {
            this.debug(`${prefix}(%s): ` + format, traceId, ...args);
        };
        const info = (format: string, ...args: any[]): void => {
            this.info(`${prefix}(%s): ` + format, traceId, ...args);
        };
        const newEvent = (format: string, ...args: any[]): void => {
            this.newEvent(`${prefix}(%s): ` + format, traceId, ...args);
        };
        return { debug, info, newEvent };
    }
}

type State = "go" | "stop";

export class LogSender {
    // max lines to be stored while disconnected with log server
    public static readonly MAX_BUFFERED_LINES = 3000;
    private socket: SocketIOClient.Socket;
    private state: State = "stop";
    private lost = 0;
    private buffer: LogData[] = [];
    private nodeId: string;

    constructor(nodeId: string, url: string) {
        this.nodeId = nodeId;
        const socket = (this.socket = io(url, {
            reconnectionDelayMax: 60 * 1000,
        }));
        socket.on("connect", () => {
            this.state = "go";
            this.flush();
        });
        socket.on("disconnect", () => {
            this.state = "stop";
        });
        socket.on("reconnect", () => {
            this.state = "go";
            this.flush();
        });
    }

    public sendLog(level: string, namespace: string, str: string): void {
        let data: LogData;
        let split;
        if ((split = str.match(/[^|]*\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)/))) {
            // LEVEL NAMESPACE  |NodeID|key|time|msg...|
            // LEVEL NAMESPACE line2     (2nd line if any)
            const [_, nodeId, key, time, text1] = split;
            let text = text1;
            const array = str.split("\n");
            array.shift(); // drop 1st line
            let line: string | undefined;
            while ((line = array.shift())) {
                let split2;
                if ((split2 = line.match(/\s*(\S+)\s+(\S+)\s(.*)/))) {
                    const [_, level, namespace, text2] = split2;
                    text += "\n" + text2;
                }
            }
            // const stime = time.replace(/\(.*\)/, "");
            // stime is "HH:MM:DD.MSEC"
            data = {
                time: Date.now(),
                nodeId: nodeId,
                key: key,
                level: level,
                namespace: namespace,
                msg: text,
            };
        } else {
            data = {
                time: Date.now(),
                namespace: namespace,
                level: level,
                msg: str,
            };
        }
        // console.warn(data);
        switch (this.state) {
            case "go":
                this.socket.emit("log", JSON.stringify(data));
                break;
            case "stop":
                this.buffer.push(data);
                while (this.buffer.length > LogSender.MAX_BUFFERED_LINES) {
                    this.buffer.shift();
                    this.lost++;
                }
                break;
        }
    }

    private flush(): void {
        let data: LogData | undefined;
        if (this.lost > 0) {
            data = {
                time: Date.now(),
                nodeId: this.nodeId,
                msg: `[[${this.lost} messages are dropped]]`,
            };
            this.buffer.unshift(data);
        }
        while ((data = this.buffer.shift())) {
            this.socket.emit("log", JSON.stringify(data));
        }
        this.lost = 0;
    }
}
