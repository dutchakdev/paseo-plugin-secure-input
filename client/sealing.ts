import { fromBase64Url } from "../shared/bytes";
import { buildAad, encodeValues, seal, type PayloadEntry, type SealedEnvelope } from "../shared/seal";
import type { RequestView } from "../shared/view";

/**
 * Seals the entries to the request's one-time key, bound to this request and to the digest of what it asked for. This
 * is the last place the values exist outside component state: what leaves is ciphertext. The bytes of the encoded
 * values are wiped as soon as they are sealed, whatever happens (the strings in the form cannot be wiped; they die with
 * the form, and its files' bytes are wiped when it closes). `null` when sealing is not possible, with nothing about
 * why: a library message is not ours to show, and none can hold a value. The encoder is a parameter so that a test can
 * look at the buffer it made.
 */
export function sealEntries(
  view: Pick<RequestView, "id" | "publicKey" | "requestDigest">,
  entries: readonly PayloadEntry[],
  encode: (entries: readonly PayloadEntry[]) => Uint8Array = encodeValues,
): SealedEnvelope | null {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = encode(entries);
    return seal(fromBase64Url(view.publicKey), plaintext, buildAad(view.id, view.requestDigest));
  } catch {
    return null;
  } finally {
    plaintext?.fill(0);
  }
}
