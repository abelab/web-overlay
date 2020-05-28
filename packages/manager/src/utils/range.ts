import { CircularSpace } from "./circular-space";

/**
 * a simple range class that does not support openness
 * (open ends or closed ends).
 * [x, x) is treated as a whole range [-∞, +∞].
 *
 */
export class SimpleRange {
    public readonly from: string;
    public readonly to: string;

    constructor(from: string, to: string) {
        this.from = from;
        this.to = to;
    }

    public toString(): string {
        return `[${this.from}, ${this.to})`;
    }

    public contains(keyOrRange: string | SimpleRange): boolean {
        if (typeof keyOrRange === "string") {
            const key = keyOrRange;
            return CircularSpace.isOrdered(
                this.from,
                true,
                key,
                this.to,
                false
            );
        }
        return this.containsRange(keyOrRange);
    }

    // another ⊆ this
    private containsRange(another: SimpleRange): boolean {
        if (this.isWhole()) {
            return true;
        }
        if (another.isWhole()) {
            return false;
        }
        return (
            this.contains(another.from) &&
            this.containsExInc(another.to) &&
            // exclude cases such as:
            //      this:  [=========)
            //   another: ====)   [====
            !another.contains(this.to)
        );
    }

    // key ∈ (from, to]
    public containsExInc(key: string): boolean {
        return CircularSpace.isOrdered(this.from, false, key, this.to, true);
    }

    public hasIntersection(r: SimpleRange): boolean {
        return (
            this.contains(r.from) ||
            this.containsExInc(r.to) ||
            r.contains(this.from) ||
            r.containsExInc(this.to)
        );
    }

    public isWhole(): boolean {
        return this.from === this.to;
    }

    public retain(r: SimpleRange, removed: SimpleRange[]): SimpleRange[] {
        const retains: SimpleRange[] = [];
        if (r.isWhole()) {
            removed.push(this);
            return retains;
        }
        if (!this.hasIntersection(r)) {
            retains.push(this);
            return retains;
        }
        // this: [             ]
        // r:    ......[........
        const min = this.contains(r.from) ? r.from : this.from;
        const max = this.contains(r.to) ? r.to : this.to;
        if (
            CircularSpace.isOrdered(this.from, true, min, max, true) &&
            this.from !== max
        ) {
            // this: [             ]
            // r:    ....[....]....
            if (this.isWhole()) {
                // simplify the results
                this.addIfNotPoint(retains, max, min);
            } else {
                this.addIfNotPoint(retains, this.from, min);
                this.addIfNotPoint(retains, max, this.to);
            }
            this.addIfNotPoint(removed, min, max);
        } else {
            // this: [             ]
            // r:    ....]    [....
            this.addIfNotPoint(retains, max, min);
            if (this.isWhole()) {
                // simplify the results
                this.addIfNotPoint(removed, min, max);
            } else {
                this.addIfNotPoint(removed, this.from, max);
                this.addIfNotPoint(removed, min, this.to);
            }
        }
        return retains;
    }

    private addIfNotPoint(list: SimpleRange[], min: string, max: string): void {
        if (min !== max) {
            list.push(new SimpleRange(min, max));
        }
    }
}

export class Gaps {
    private readonly from: string;
    private readonly to: string;
    private readonly gaps: SimpleRange[] = [];

    constructor(from: string, to: string) {
        this.gaps = [new SimpleRange(from, to)];
        this.from = from;
        this.to = to;
    }

    // find the gap that contains range.from
    public remove(range: SimpleRange): void {
        const gapIndex = this.gaps.findIndex(
            (e) => e && e.contains(range.from)
        );
        if (gapIndex === -1) {
            // logger.info("no gap instance: {} in {}", range.from, this);
            return;
        }
        const gap = this.gaps[gapIndex];
        // delete the range r from gaps
        this.gaps.splice(gapIndex, 1);
        const retains = gap.retain(range, []);
        // add the remaining ranges to gaps
        retains.forEach((p) => {
            this.gaps.push(p);
        });
    }

    public isEmpty(): boolean {
        return this.gaps.length === 0;
    }

    public getInverted(): Gaps {
        const inverted = new Gaps(this.from, this.to);
        this.gaps.forEach((g) => {
            inverted.remove(g);
        });
        return inverted;
    }

    public toSimpleRanges(): SimpleRange[] {
        return this.gaps.concat();
    }

    public toRanges(): { from: string; to: string }[] {
        return this.gaps.map((s) => {
            return { from: s.from, to: s.to };
        });
    }

    public toString(): string {
        return `Gaps[${this.gaps}]`;
    }
}
