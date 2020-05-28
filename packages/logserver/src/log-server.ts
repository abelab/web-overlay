import * as socketIO from "socket.io";
import * as chalk from "chalk";
import Log = require("debug-level");
import {
    LogData,
    DEFAULT_LOG_SERVER_PORT,
    formatDate,
} from "@web-overlay/manager";

// original: debug-level utils.js
const COLORS = [
    "#0000FF",
    "#0033FF",
    "#0066FF",
    "#3333FF",
    "#3300FF",
    "#0000CC",
    "#0033CC",
    "#0066CC",
    "#3333CC",
    "#3300CC",
    "#000099",
    "#003399",
    "#333399",
    "#330099",
    "#000066",
    "#00FF00",
    "#00FF33",
    "#00FF66",
    "#00FF99",
    "#006633",
    "#00CC00",
    "#00CC33",
    "#00CC66",
    "#00CC99",
    "#006666",
    "#009900",
    "#009933",
    "#009966",
    "#009999",
    "#006600",
    "#00FFFF",
    "#00CCFF",
    "#00FFCC",
    "#00CCCC",
    "#33CCCC",
    "#FFFF00",
    "#FFFF33",
    "#FFCC33",
    "#FFCC66",
    "#FF9900",
    "#FF9933",
    "#FF6600",
    "#FF6633",
    "#FF0000",
    "#FF0033",
    "#FF3300",
    "#FF3300",
    "#FF3333",
    "#CC0000",
    "#CC0033",
    "#CC0066",
    "#FF0066",
    "#FF3366",
    "#FF00FF",
    "#FF33FF",
    "#CC00CC",
    "#990099",
    "#660066",
];

// original: debug-level utils.js
const LEVEL_COLORS: { [index: string]: string } = {
    LOG: "#999999",
    DEBUG: "#00CCCC" /* modified */,
    INFO: "#00CC00",
    WARN: "#CCCC00",
    ERROR: "#CC0000",
    FATAL: "#CC00CC",
};

function usage(): never {
    console.error(`Usage: node %s [-p port]`, process.argv[1]);
    process.exit(1);
}

let port = DEFAULT_LOG_SERVER_PORT;
if (process.argv.length !== 2) {
    if (process.argv.length !== 4 || process.argv[2] !== "-p") {
        usage();
    }
    port = parseInt(process.argv[3]);
    if (isNaN(port)) {
        usage();
    }
}

const log = new Log("logserver");

const io = socketIO(port, {
    serveClient: false,
    // below are engine.IO options
    pingInterval: 10000,
    pingTimeout: 5000,
    cookie: false,
});
// allow CORS
io.origins("*:*");

type LogDataWithIndex = LogData & { index: number };

const LOG_DELAY_TIME = 3000;
const logBuffer: LogDataWithIndex[] = [];

// store received logs in buffer and output after sorting
setInterval(() => {
    // scan logBuffer and output LogData whose time < Date.now() - LOG_DELAY_TIME
    const threshold = Date.now() - LOG_DELAY_TIME;
    let data;
    while ((data = logBuffer[0])) {
        if (data.time! < threshold) {
            logBuffer.shift();
            logger(data);
        } else {
            break;
        }
    }
    // renumber index
    logBuffer.forEach((data, index) => (data.index = index));
}, 1000);

io.sockets.on("connection", (sock: socketIO.Socket) => {
    log.debug("new connection: %s", sock);
    sock.on("log", (_json: string) => {
        log.debug("log %s", _json);
        const data: LogData = JSON.parse(_json);
        if (!data.time) {
            data.time = Date.now();
        }
        const last = logBuffer[logBuffer.length - 1];
        let index = 0;
        if (last) {
            index = last.index + 1;
        }
        const idata: LogDataWithIndex = { ...data, index: index };
        logBuffer.push(idata);
        logBuffer.sort((a, b) => {
            if (a.time! < b.time!) {
                return -1;
            } else if (a.time! > b.time!) {
                return 1;
            } else {
                // Array.sort may be an unstable sort...
                return a.index! - b.index!;
            }
        });
    });
    sock.on("disconnect", (reason: string) => {
        log.debug("closed: %s, %s", sock, reason);
    });
});

function hash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        hash = (hash << 5) - hash + c;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

function hashColor(str: string, isBackground = false): string {
    if (isBackground) {
        return chalk.bgHex(COLORS[Math.abs(hash(str)) % COLORS.length])(str);
    } else {
        return chalk.hex(COLORS[Math.abs(hash(str)) % COLORS.length])(str);
    }
}

function logger(obj: LogData): void {
    const dateString = formatDate(new Date(obj.time!));
    const nodeId = obj.nodeId || "";
    const key = obj.key || "";
    const level = obj.level || "";
    const namespace = obj.namespace || "";
    const msg = obj.msg || "";
    const colorNodeId = hashColor(nodeId, true);
    const colorLevel = LEVEL_COLORS[level]
        ? chalk.hex(LEVEL_COLORS[level])(level)
        : level;
    const colorNamespace = hashColor(namespace);
    const array = msg.split("\n");
    array.forEach((text) =>
        console.log(
            `${dateString}|${colorNodeId}|${key}|${colorLevel}|${colorNamespace}|${text}`
        )
    );
}

console.log("start web-overlay log server, listening on port:%d", port);
