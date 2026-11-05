/**
 * Building objects as `Object.fromEntries` does, without its array of
 * `[key, value]` pairs: the compilers use these when a parser maps a
 * repetition of pairs with `Object.fromEntries` (see `Parser.fromEntries`).
 */

import * as Predicate from "effect/Predicate"

type FromEntries = <K extends PropertyKey, V>(entries: Iterable<readonly [K, V]>) => { [P in K]: V }

/** The built-in `Object.fromEntries`, which compiled parsers recognize. */
// SAFETY: `Object.fromEntries` gives each `[key, value]` entry an own
// property `key` holding `value`, so entries keyed by `K` build `{ [P in K]: V }`
export const fromEntries: FromEntries = Object.fromEntries as FromEntries

const objectPrototype = Object.prototype

/**
 * Whether `o[key] = value` on a new plain object creates the same property
 * as `Object.fromEntries` (a writable, enumerable, configurable data
 * property): `key` is a string that `Object.prototype` has no property for,
 * so there is no setter (`__proto__`) or read-only property to run into.
 */
export const isPlainKey = (key: unknown): key is string =>
  Predicate.isString(key) && !Object.hasOwn(objectPrototype, key)

const define = (o: object, key: unknown, value: unknown): void => {
  // SAFETY: `Object.defineProperty` converts any key to a property key
  // (ToPropertyKey), as `Object.fromEntries` does; its `PropertyKey`
  // parameter type is narrower than what it accepts
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
