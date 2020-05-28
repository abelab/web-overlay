/*
 * utility classes
 */
import { SerializeUtils } from "../manager";

export class EquitySet<T> extends Set<T> {
    private readonly comparator: (v1: T, v2: T) => boolean;
    constructor(tester: (v1: T, v2: T) => boolean) {
        super();
        this.comparator = tester;
    }

    public add(value: T): this {
        if (this.has(value)) {
            return this;
        }
        return super.add(value);
    }

    public has(value: T): boolean {
        // console.log("has " + value);
        let rc = super.has(value);
        if (!rc) {
            super.forEach((val) => {
                if (this.comparator(val, value)) {
                    rc = true;
                }
            });
        }
        // console.log("return ", rc);
        return rc;
    }
}

export class ArraySet<T> extends EquitySet<T[]> {
    constructor(comparator?: (v1: T, v2: T) => boolean) {
        super((v1: T[], v2: T[]) => {
            if (v1.length !== v2.length) {
                return false;
            }
            for (let i = 0; i < v1.length; i++) {
                const rc = comparator
                    ? comparator(v1[i], v2[i])
                    : v1[i] === v2[i];
                if (!rc) {
                    return false;
                }
            }
            return true;
        });
    }
}

export class ArrayUtils {
    public static equals<T extends string | number>(a1: T[], a2: T[]): boolean {
        if (a1.length !== a2.length) {
            return false;
        }
        for (let i = 0; i < a1.length; i++) {
            if (a1[i] !== a2[i]) {
                return false;
            }
        }
        return true;
    }

    public static intersects<T>(a1: T[], a2: T[]): T[] {
        const rc: T[] = [];
        a1.forEach((item) => {
            if (a2.indexOf(item) >= 0) {
                rc.push(item);
            }
        });
        return rc;
    }

    public static subtract<T>(a1: T[], a2: T[]): T[] {
        const rc: T[] = [];
        a1.forEach((item) => {
            if (a2.indexOf(item) < 0) {
                rc.push(item);
            }
        });
        return rc;
    }

    public static remove<T>(array: T[], remove: T): boolean {
        let rc = false;
        for (;;) {
            const index = array.indexOf(remove);
            if (index < 0) {
                break;
            }
            array.splice(index, 1);
            rc = true;
        }
        return rc;
    }

    public static find<T>(a1: T[], a2: T[]): number {
        for (let i = 0; i <= a1.length - a2.length; i++) {
            if (a2.every((val, j) => val === a1[i + j])) {
                return i;
            }
        }
        return -1;
    }
}

export function quote(s: string | undefined | null): string {
    if (s === null) {
        return "null";
    }
    if (s === undefined) {
        return "undef";
    }
    return '"' + s + '"';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prettyPrint(obj: any): string {
    if (obj === null) {
        return "null";
    }
    switch (typeof obj) {
        case "undefined":
            return "undef";
        case "function":
            return "func";
        case "symbol":
            return "symbol";
        case "number":
        case "boolean":
        case "bigint":
            return obj.toString();
        case "string":
            return '"' + obj + '"';
        case "object":
            if (Array.isArray(obj)) {
                return "[" + obj.map((val) => val.toString()).join(", ") + "]";
            } else if (obj.prototype) {
                return obj.toString();
            } else {
                return "{" + prettyPrintObj(obj) + "}";
            }
        default:
            throw new Error("unknown type: " + typeof obj);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prettyPrintObj(obj: any): string {
    const tmp: string[] = [];
    const clazz = obj[SerializeUtils.CLASSNAME_FIELD];
    if (clazz) {
        const copy = Object.assign({}, obj);
        delete copy[SerializeUtils.CLASSNAME_FIELD];
        return "<" + clazz + "> " + prettyPrintObj(copy);
    }
    Object.keys(obj).forEach((key) => {
        let text = key + "=";
        const val = obj[key];
        const type = typeof val;
        switch (type) {
            case "undefined":
                text += "=undef";
                break;
            case "number":
                text += val;
                break;
            case "string":
                text += '"' + val + '"';
                break;
            case "boolean":
                if (val) {
                    text = key;
                } else {
                    text = "~" + key;
                }
                break;
            case "object":
                text += prettyPrint(val);
                break;
            default:
                text += type;
                break;
        }
        tmp.push(text);
    });
    return tmp.join(", ");
}

export function sleep(time: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}
