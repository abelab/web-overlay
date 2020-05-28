/* eslint @typescript-eslint/no-explicit-any: 0 */

import { TimeoutError } from "../manager";
import { CustomError } from "./error";
import { Logger } from "../manager/logger";

export class RetriableError extends CustomError {}

/**
 * @deprecated
 * @param fn
 * @param maxTry
 */
export function retryPromise<T>(
    fn: (numberOfRetriesLeft: number) => Promise<T>,
    maxTry: number
): Promise<T> {
    return new Promise<T>((resolve, reject): void => {
        const operation = (count: number): void => {
            fn(count)
                .then((str) => {
                    resolve(str);
                })
                .catch((err) => {
                    count--;
                    // console.log(`retryPromise: got ${err} (${count} left)`);
                    if (err instanceof RetriableError && count > 0) {
                        operation(count);
                    } else {
                        reject(err);
                    }
                });
        };
        operation(maxTry);
    });
}

/**
 * simple Deferred implementation
 */
export class Deferred<T> implements PromiseLike<T> {
    private static nextSeq = 0;
    private seq = Deferred.nextSeq++;
    private readonly _resolve: (val?: T | PromiseLike<T>) => void;
    private readonly _reject: (reason?: any) => void;
    public readonly promise: Promise<T>;
    constructor() {
        let res: any;
        let rej: any;
        this.promise = new Promise((r, j): void => {
            res = r;
            rej = j;
        });
        this._resolve = res;
        this._reject = rej;
        this.promise["toString"] = this.toString;
    }

    public then<TResult1 = T, TResult2 = never>(
        onfulfilled?:
            | ((value: T) => TResult1 | PromiseLike<TResult1>)
            | undefined
            | null,
        onrejected?:
            | ((reason: any) => TResult2 | PromiseLike<TResult2>)
            | undefined
            | null
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onfulfilled, onrejected);
    }

    public catch<TResult = never>(
        onrejected?:
            | ((reason: any) => TResult | PromiseLike<TResult>)
            | undefined
            | null
    ): Promise<T | TResult> {
        return this.promise.catch(onrejected);
    }

    public resolve(value?: T | PromiseLike<T>): void {
        return this._resolve(value);
    }

    public reject(reason?: any): void {
        return this._reject(reason);
    }

    public toString(): string {
        return "[Deferred" + this.seq + "]";
    }
}

export class TimeoutDeferred<T> extends Deferred<T> {
    constructor(timeout: number, errorString = "timeout") {
        super();
        const timer = setTimeout(() => {
            this.reject(new TimeoutError(errorString));
        }, timeout);
        this.then(
            () => {
                clearTimeout(timer);
            },
            () => {
                clearTimeout(timer);
            }
        );
    }
}

export class ConcurrentExecutor<T> {
    private readonly maxConcurrencty: number;
    private readonly satisfaction: number;
    // 成功した値の配列
    private readonly values: T[] = [];
    // 現在進行中の処理を待ち合わせるためのDeferred
    private readonly synch: Deferred<T>[] = [];
    private logger?: Logger;

    constructor(satisfaction: number, maxConcurrency: number, logger?: Logger) {
        if (satisfaction <= 0) {
            throw new Error("satisfaction should be > 0");
        }
        if (maxConcurrency < 1) {
            throw new Error("maxConcurrency should be >= 1");
        }
        this.satisfaction = satisfaction;
        this.maxConcurrencty = maxConcurrency;
        this.logger = logger;
    }
    public addValue(value: T): void {
        this.values.push(value);
    }
    public getResults(): T[] {
        return this.values.slice();
    }
    public isSatisfied(): boolean {
        return this.numberOfCompletedJobs() >= this.satisfaction;
    }
    public worthWaiting(): boolean {
        return (
            !this.isSatisfied() &&
            this.numberOfCompletedJobs() + this.numberOfExecutingJobs() >=
                this.satisfaction
        );
    }
    public waitAll(): Promise<void> {
        return Promise.all(this.synch.map((defer) => defer.promise)).then(
            () => {
                this.logger?.debug("waitAll: resolved");
                return;
            },
            () => {
                this.logger?.debug("waitAll: rejected");
                return;
            }
        );
    }
    public waitAny(): Promise<void> {
        return Promise.race(this.synch.map((defer) => defer.promise)).then(
            () => {
                this.logger?.debug("waitAny: resolved");
                return;
            },
            () => {
                this.logger?.debug("waitAny: rejected");
                return;
            }
        );
    }
    /**
     * @deprecated
     * Execute a job.
     * The job takes single {@link Deferred} and must resolve or reject it when finish.
     * @return {Promise<void>} a Promise that is resolved when another job can be executed.
     */
    public execute(job: (_: Deferred<T>) => void): Promise<void> {
        const d = new Deferred<T>();
        this.synch.push(d);
        const jobResult = new Deferred<T>();
        jobResult.then(
            (val) => {
                this.values.push(val);
                const index = this.synch.indexOf(d);
                this.synch.splice(index, 1);
                d.resolve(val);
            },
            (err) => {
                this.logger?.warn(
                    "ConcurrentExecutor.execute(): job error: %s",
                    err
                );
                const index = this.synch.indexOf(d);
                this.synch.splice(index, 1);
                d.reject(err);
            }
        );
        try {
            job(jobResult);
        } catch (err) {
            jobResult.reject(err);
        }
        if (this.numberOfExecutingJobs() < this.maxConcurrencty) {
            return Promise.resolve();
        }
        return this.waitAll();
    }
    /**
     * Execute a job.
     * The job takes single {@link Deferred} and must resolve or reject it when finish.
     * @return {Promise<void>} a Promise that is resolved when another job can be executed.
     */
    public executeAsync(job: () => Promise<T>): Promise<void> {
        const d = new Deferred<T>();
        this.synch.push(d);
        let promise;
        try {
            promise = job();
        } catch (err) {
            promise = Promise.reject(err);
        }
        promise.then(
            (val) => {
                this.logger?.debug(
                    "ConcurrentExecutor.executeAsync(): job returns: %s",
                    val
                );
                this.values.push(val);
                const index = this.synch.indexOf(d);
                this.synch.splice(index, 1);
                d.resolve(val);
            },
            (err) => {
                this.logger?.warn(
                    "ConcurrentExecutor.executeAsync(): job error: %s",
                    err
                );
                const index = this.synch.indexOf(d);
                this.synch.splice(index, 1);
                d.reject(err);
            }
        );
        if (this.numberOfExecutingJobs() < this.maxConcurrencty) {
            return Promise.resolve();
        }
        return this.waitAll();
    }
    public numberOfCompletedJobs(): number {
        return this.values.length;
    }
    public numberOfExecutingJobs(): number {
        return this.synch.length;
    }
    public toString(): string {
        return `ConcurrentExecutor(completed=${this.numberOfCompletedJobs()}, executing=${this.numberOfExecutingJobs()})`;
    }
}
