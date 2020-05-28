import { ArrayUtils } from "./misc-utils";

export class Callbacks<T = never, U = never, V = never, W = never> {
    private callbacks: ((...args: any[]) => void)[] = [];
    public addCallback(func: (t: T, u: U, v: V, w: W) => void): void {
        this.callbacks.push(func);
    }
    public removeCallback(func: () => void): void {
        ArrayUtils.remove(this.callbacks, func);
    }
    public invoke(t?: T, u?: U, v?: V, w?: W): void {
        this.callbacks.forEach((cb) => {
            setTimeout(() => {
                cb(t, u, v, w);
            }, 0);
        });
    }
    public invokeAndClear(t: T, u: U, v: V, w: W): void {
        this.invoke(t, u, v, w);
        this.callbacks = [];
    }
    public toString() {
        return `Callbacks(${this.callbacks.length} items)`;
    }
}
