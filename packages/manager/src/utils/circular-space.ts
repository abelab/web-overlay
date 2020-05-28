export class CircularSpace {
    public static sortOnRing(base: string, array: string[]): string[] {
        return CircularSpace.sortCircular(base, array, (s) => s, false);
    }

    /**
     * Sort an array in a circular space.
     * The resulting array is sorted from BASE.
     * <ul>
     * <li>isBaseMaximum == false base=10, array=[10, 20, 30] -> return [10, 20, 30]
     * <li>isBaseMaximum == true, base=10, array=[10, 20, 30] -> return [20, 30, 10]
     * </ul>
     *
     * @param {string} base
     * @param {T[]} array
     * @param {(_: T) => string} mapper
     * @param {boolean} isBaseMaximum
     * @return {T[]}
     */
    public static sortCircular<T>(
        base: string,
        array: T[],
        mapper: (_: T) => string,
        isBaseMaximum: boolean
    ): T[] {
        let sorted = array.concat();
        sorted.sort((a0: T, b0: T) => {
            const a = mapper(a0);
            const b = mapper(b0);
            if (a === b) {
                return 0;
            }
            if (CircularSpace.isOrdered(base, true, a, b, true)) {
                return -1;
            }
            return 1;
        });
        if (isBaseMaximum && mapper(sorted[0]) === base) {
            const tmp = sorted[0];
            sorted = sorted.slice(1);
            sorted.push(tmp);
        }
        return sorted;
    }

    public static isOrderedInclusive(a: string, b: string, c: string): boolean {
        // a <= b <= c
        if (a <= b && b <= c) {
            return true;
        }
        // b <= c <= a
        if (b <= c && c <= a) {
            return true;
        }
        // c <= a <= b
        return c <= a && a <= b;
    }

    public static isOrdered(
        from: string,
        fromInclusive: boolean,
        val: string,
        to: string,
        toInclusive: boolean
    ): boolean {
        if (from === to) {
            return fromInclusive !== toInclusive || from === val;
        }
        let rc = CircularSpace.isOrderedInclusive(from, val, to);
        if (rc) {
            if (from === val) {
                rc = fromInclusive;
            }
        }
        if (rc) {
            if (val === to) {
                rc = toInclusive;
            }
        }
        return rc;
    }
}
