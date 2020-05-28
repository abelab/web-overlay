/**
 * Interface used to transmit log messages to the log server.
 */
export interface LogData {
    nodeId?: string;
    key?: string;
    level?: string;
    namespace?: string;
    msg?: string;
    time?: number;
}
