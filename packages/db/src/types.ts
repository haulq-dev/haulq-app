/**
 * Shared type utilities.
 */

/**
 * `Partial<T>`, but usable under `exactOptionalPropertyTypes`.
 *
 * The workspace runs with that flag on, which makes `?: string` and
 * `?: string | undefined` different types: the first says the key may be absent,
 * the second says it may also be present and undefined. Zod's `.optional()`
 * produces the second, and every route hands zod output straight to a
 * repository — so `Partial<T>` on a repository input rejects its only caller.
 *
 * Using this instead keeps the flag's benefit (a field cannot be *accidentally*
 * set to undefined) at the boundaries where it catches real mistakes, without
 * making the parse-then-persist path fight the type system at every call.
 */
export type Optional<T> = { [K in keyof T]?: T[K] | undefined };
