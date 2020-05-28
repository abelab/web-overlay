declare module "debug-level" {
    export = DebugStatic;
    class DebugStatic {
        constructor(namespace: string, opts?: DebugOpts);
        static options(opts?: DebugOpts): DebugOpts;
        static log(namespace: string): DebugStatic;
        fatal(message: string, ...args: any[]): void;
        error(message: string, ...args: any[]): void;
        warn(message: string, ...args: any[]): void;
        info(message: string, ...args: any[]): void;
        debug(message: string, ...args: any[]): void;
        log(message: string, ...args: any[]): void;
        enable(namespaces?: string): void;
        get enabled(): boolean;
        static logger(_?: any): (req: any, res: any) => void;
        // private API
        _log(level: string, args: any): any[];
        _formatArgs(level: string, _args: any[]): string;
        render(args: string | string[], level: string): void;
    }
    interface DebugOpts {
        level?: "FATAL" | "ERROR" | "WARN" | "INFO" | "DEBUG";
        json?: boolean;
        serverinfo?: boolean;
        hideDate?: boolean;
        colors?: boolean;
        stream?: any;
        formatters?: {
            [str: string]: (_: any) => string;
        };
        url?: string; // browser only
    }
}
