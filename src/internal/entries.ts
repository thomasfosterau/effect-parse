/**
 * Building objects as `Object.fromEntries` does, without its array of
 * `[key, value]` pairs: the compilers use these when a parser maps a
 * repetition of pairs with `Object.fromEntries` (see `Parser.fromEntries`).
 */

import * as Predicate from "effect/Predicate"

/** The built-in `Object.fromEntries`, which compiled parsers recognize. */
export const fromEntries: <K extends PropertyKey, V>(entries: Iterable<readonly [K, V]>) => { [P in K]: V } =
  Object.fromEntries as any

const objectPrototype = Object.prototype
const hasOwn = objectPrototype.hasOwnProperty

/**
 * Whether `o[key] = value` on a new plain object creates the same property
 * as `Object.fromEntries` (a writable, enumerable, configurable data
 * property): `key` is a string that `Object.prototype` has no property for,
 * so there is no setter (`__proto__`) or read-only property to run into.
 */
export const isPlainKey = (key: unknown): key is string => Predicate.isString(key) && !hasOwn.call(objectPrototype, key)

const define = (o: object, key: unknown, value: unknown): void => {
  Object.defineProperty(o, key as PropertyKey, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * Adds an entry whose key is not plain to `o`, given the entries already
 * deferred. Keys that are objects may run code when converted to property
 * keys, which `Object.fromEntries` only does once every entry is parsed:
 * from the first such key on, entries are deferred to {@link flushEntries}.
 * Returns the deferred entries, if any.
 */
export const addEntry = (
  o: object,
  deferred: Array<unknown> | undefined,
  key: unknown,
  value: unknown
): Array<unknown> | undefined => {
  if (deferred === undefined && !Predicate.isObjectOrArray(key) && !Predicate.isFunction(key)) {
    define(o, key, value)
    return undefined
  }
  if (deferred === undefined) deferred = []
  deferred.push(key, value)
  return deferred
}

/** Adds the deferred entries of {@link addEntry} to `o`, in order. */
export const flushEntries = (o: object, deferred: ReadonlyArray<unknown>): void => {
  for (let i = 0; i < deferred.length; i += 2) define(o, deferred[i], deferred[i + 1])
}
