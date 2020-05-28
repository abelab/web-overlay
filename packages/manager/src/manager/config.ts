export interface LocalConfig {
    NODE_ID: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WEBRTC_IMPL: any;
}

export interface NetworkConfig {
    NETWORK_ID: string | undefined;
    ACK_TIMEOUT: number;
    REPLY_TIMEOUT: number;
    MAX_IDLE_TIME_BEFORE_RAW_CLOSE: number;
    MAX_RAWCONNECTION_ESTABLISH_TIME: number;
    SUSPICIOUS_NODE_EXPIRATION_TIME: number;

    // Relay Connections
    ENABLE_RELAY: boolean;
    ALWAYS_RELAY: boolean;
    RELAY_CONNECTION_TIMEOUT: number;
    RELAY_PATH_MAINTENANCE_PERIOD: number;
    MINIMUM_RELAY_PATHS: number;
    INDIRECT_NODE_EXPIRATION_TIME: number;

    // WebRTC
    STUN_SERVERS: { urls: string }[];
    TRICKLE_ICE: boolean;
    NO_WEBRTC_SIGNALING: boolean;

    // Debugging
    // we use "debug-level" package
    DEBUG?: string;
    LOG_SERVER_URL?: string;
}

export type Config = LocalConfig & NetworkConfig;
export type ManagerConfig = Partial<Config>;

export const defaultConfig: Config = {
    NODE_ID: undefined,
    NETWORK_ID: undefined,
    ACK_TIMEOUT: 5000,
    // sometimes it takes long time to receive ConnectionReply
    REPLY_TIMEOUT: 6000,
    MAX_IDLE_TIME_BEFORE_RAW_CLOSE: 120 * 1000,
    MAX_RAWCONNECTION_ESTABLISH_TIME: 6 * 1000,
    SUSPICIOUS_NODE_EXPIRATION_TIME: 120 * 1000,

    ENABLE_RELAY: true,
    ALWAYS_RELAY: false,
    // because the timing of receiving WebRTC connection failure may differ
    // at both end nodes, we have to give sufficient time to the accept node
    // for receiving ProbePath message.
    RELAY_CONNECTION_TIMEOUT: 15 * 1000,
    RELAY_PATH_MAINTENANCE_PERIOD: 30 * 1000,
    MINIMUM_RELAY_PATHS: 3,

    STUN_SERVERS: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        // Firefox complains "Using more than two STUN/TURN servers slows down discovery"
        // { urls: "stun:stun2.l.google.com:19302" },
        // { urls: "stun:stun3.l.google.com:19302" },
        // { urls: "stun:stun4.l.google.com:19302" }
    ],
    // if you disable trickle ICE, probably you must increase REPLY_TIMEOUT
    // because sometimes full ICE requires long time (5 sec or so).
    TRICKLE_ICE: true,
    NO_WEBRTC_SIGNALING: false,
    INDIRECT_NODE_EXPIRATION_TIME: 5 * 60 * 1000,
    WEBRTC_IMPL: undefined,

    DEBUG: "WARN:*",
    LOG_SERVER_URL: undefined,
};

export const DEFAULT_LOG_SERVER_PORT = 8801;
