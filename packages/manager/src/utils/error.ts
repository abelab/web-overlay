// Reference:
// https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
// https://qiita.com/Mizunashi_Mana/items/c533fbb51bfee491b0e7
import { serializable } from "../manager";

export class CustomError extends Error {
    constructor(message?: string) {
        super(message); // 'Error' breaks prototype chain here
        Object.setPrototypeOf(this, new.target.prototype); // restore prototype chain
        Object.defineProperty(this, "name", {
            get: () => this.constructor.name,
        });
        if (typeof Error.captureStackTrace === "function") {
            Error.captureStackTrace(this, this.constructor);
        } else {
            this.stack = new Error().stack;
        }
    }
}

/**
 * serializable Error.
 * (workaround for JSON.stringify(new Error('foo')) = {})
 */
@serializable
export class RemoteError {
    constructor(public message: string) {}

    public error(): Error {
        return new Error(this.message);
    }
}
