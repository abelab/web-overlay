import { AnyClass } from "./types";

/**
 * basic mixin function.
 *
 * @param derivedCtor
 * @param baseCtors
 */

export function applyMixins(
    derivedCtor: AnyClass,
    baseCtors: AnyClass[]
): void {
    baseCtors.forEach((baseCtor) => {
        Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {
            Object.defineProperty(
                derivedCtor.prototype,
                name,
                Object.getOwnPropertyDescriptor(
                    baseCtor.prototype,
                    name
                ) as PropertyKey
            );
        });
    });
}
