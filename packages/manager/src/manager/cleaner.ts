import { Manager } from "./manager";
import { ArrayUtils, Deferred } from "../utils";
import { Logger } from "./logger";

export interface Cleanable {
    cleaner: Cleaner;
    destroy(): void;
}

export class Cleaner {
    private timers: Map<string, NodeJS.Timer> = new Map();
    protected _cleaner: (() => void)[] = [];
    private cleaned = false;
    private logger: Logger;

    constructor(logger: Logger, parent?: Cleaner) {
        if (!logger) {
            throw new Error("no logger!");
        }
        this.logger = logger;
        if (parent) {
            const cleanjob = (): void => this.clean();
            parent.push(cleanjob);
            this.push(() => {
                parent.remove(cleanjob);
            });
        }
    }

    public toString(): string {
        return `Cleaner[${this._cleaner.length} on stack, ${this.timers.size} in timers]`;
    }

    public addChild(child: Cleanable): void {
        const cleanjob = (): void => child.destroy();
        // when parent(this) is cleaned, clean the child
        this.push(cleanjob);
        // when child is cleaned, remove parent's entry
        child.cleaner.push(() => {
            this.remove(cleanjob);
        });
    }

    public push(func: () => void): void {
        this._cleaner.push(func);
    }

    public remove(func: () => void): void {
        ArrayUtils.remove(this._cleaner, func);
    }

    public clean(): void {
        this.cleaned = true;
        for (const [key, id] of this.timers.entries()) {
            this.timers.delete(key);
            clearTimeout(id);
        }
        let job;
        while ((job = this._cleaner.pop())) {
            job();
        }
    }

    public startTimer(
        manager: Manager,
        name: string,
        delay: number,
        job: () => void
    ): void {
        this.cancelTimer(name);
        if (this.cleaned) {
            return;
        }
        if (delay > 0) {
            const expectTime = Date.now() + delay;
            const id = setTimeout(() => {
                this.logger.newEvent("timer " + name);
                const diff = Date.now() - expectTime;
                if (diff > 2000) {
                    this.logger.info("timer delayed %d msec", diff);
                }
                this.timers.delete(name);
                job();
            }, delay);
            this.timers.set(name, id);
        }
    }

    public startIntervalTimer(
        manager: Manager,
        name: string,
        delay: number,
        job: () => void
    ): void {
        this.cancelTimer(name);
        if (this.cleaned) {
            return;
        }
        if (delay > 0) {
            const id = setInterval(() => {
                this.logger.newEvent("interval timer (%s)", name);
                job();
            }, delay);
            this.timers.set(name, id);
        }
    }

    private delayCount = 0;
    public async delay(manager: Manager, time: number): Promise<void> {
        if (time < 0) {
            return;
        }
        const defer = new Deferred<void>();
        this.startTimer(
            manager,
            "manager.delay" + this.delayCount++,
            time,
            () => defer.resolve()
        );
        await defer.promise;
    }

    public cancelTimer(name: string): void {
        const oldTimer = this.timers.get(name);
        if (oldTimer) {
            this.timers.delete(name);
            clearTimeout(oldTimer);
        }
    }
}
