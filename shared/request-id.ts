/**
 * The shape of the id the registry gives a request: `r_` and 128 random bits in hex. It lives in `shared/` so the
 * card contract and the outbox can check an id without importing the registry. `server/core/registry.ts` generates
 * ids of this shape (`r_${randomBytes(16).toString("hex")}`).
 *
 * It is the pattern of the ids the registry gives, and so of what is stored and shown: the input of a tool or of an RPC
 * that names a request, and the drop store that makes a directory of the id, hold an id to it.
 */
export const REQUEST_ID_PATTERN = /^r_[0-9a-f]{32}$/;
