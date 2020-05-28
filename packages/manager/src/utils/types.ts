/**
 * a type to represent a class that is a subclass of <T>
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Class<T> = { new (...args: any[]): T };

/**
 * a type to represent an any class
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClass = Class<any>;
