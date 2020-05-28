import { AnyClass, CustomError } from "../utils";

const serializableClassMap = new Map<string, AnyClass>();

/**
 * [@serializable] decorator.
 * @param clazz
 */
export function serializable<T extends AnyClass>(clazz: T): T {
    const name = clazz.prototype.name || clazz.prototype.constructor.name;
    // console.log("serializable is called for: " + name);
    if (SerializeUtils.getClass(name)) {
        throw new Error(`serializable class ${name} is already registered`);
    }
    clazz.prototype.toJSON = function (): T {
        // console.log(`${name}: toJSON is called: keys=${Object.keys(this)}`);
        const obj = Object.assign({}, this);
        obj.$class = name;
        if (this._transients) {
            // console.log(`${name}: _transients=${this._transients}`);
            for (const prop of this._transients) {
                delete obj[prop];
            }
        }
        // console.log(`${name}: modified obj keys=${Object.keys(obj)}`);
        return obj;
    };
    serializableClassMap.set(name, clazz);
    return clazz;
}

/**
 * [@transient] decorator.
 * @param target prototype
 * @param prop
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transient(target: any, prop: string): void {
    if (Object.prototype.hasOwnProperty.call(target, "_transients")) {
        // console.log("pushed: ", target, target._transients);
        target._transients.push(prop);
    } else {
        const base = target._transients || [];
        Object.defineProperty(target, "_transients", {
            value: base.concat(prop),
            enumerable: false,
        });
        // console.log("created: ", target, target._transients);
    }
    /*if (target._transients) {
        target._transients.push(prop);
        console.log("pushed: ", target, target._transients);
    } else {
        target._transients = [prop];
    }*/
}

export class ClassNotFoundException extends CustomError {
    public constructor(public className: string, message?: string) {
        super(message);
    }
}

export class PrototypeAlreadyRestoredException extends CustomError {
    public constructor(message?: string) {
        super(message);
    }
}

type hoge = {
    $class: string;
    $restored: boolean;
};
export abstract class SerializeUtils {
    public static readonly CLASSNAME_FIELD = "$class";

    public static getClass(name: string): AnyClass | undefined {
        return serializableClassMap.get(name);
    }

    /**
     * Recursively assign a prototype to object `obj', which is usually read from JSON.
     * If obj has $CLASSNAME_FIELD property, pickup a class from the field and
     * set the prototype to obj.
     * @param obj
     * @throws PrototypeAlreadyRestoredException
     * @throws ClassNotFoundException
     */
    public static restorePrototype<T>(obj: T): T {
        const o = (obj as unknown) as {
            $class?: string;
            $restored?: boolean;
        };
        if (o.$restored) {
            throw new PrototypeAlreadyRestoredException(
                "restorePrototype() is already called on this object"
            );
        }
        if (o.$class) {
            const clazz = SerializeUtils.getClass(o.$class);
            if (!clazz) {
                throw new ClassNotFoundException(o.$class);
            }
            Object.setPrototypeOf(obj, clazz.prototype);
            delete o.$class;
        }
        // do recursively
        Object.keys(obj).forEach((prop) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const v = (obj as any)[prop];
            if (typeof v === "object" && v) {
                if (Array.isArray(v)) {
                    v.forEach((elem) => {
                        if (typeof elem === "object" && elem) {
                            this.restorePrototype(elem);
                        }
                    });
                } else {
                    this.restorePrototype(v);
                }
            }
        });
        Object.defineProperty(obj, "$restored", {
            enumerable: false,
            value: true,
        });
        return obj;
    }

    /**
     * check if obj is @serializable
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public static isSerializable(obj: any | AnyClass): boolean {
        let name: string;
        if (typeof obj === "function") {
            name = obj.prototype.constructor.name;
        } else {
            name = obj.constructor.name;
        }
        return !!SerializeUtils.getClass(name);
    }

    public static clone<T>(obj: T): T {
        // honor @serializable
        const copy = JSON.parse(JSON.stringify(obj));
        Object.setPrototypeOf(copy, Object.getPrototypeOf(obj));
        return copy;
    }
}
