import { randomBytes, toBase64Url, toHex } from "../../shared/bytes";
import { SecureInputError } from "../../shared/errors";
import { buildAad, digestHex, generateRequestKeyPair, open, type RequestKeyPair, type SealedEnvelope } from "../../shared/seal";

const probes = new Map<string, Uint8Array>();
const MAX_PROBES = 16;
/** What a self-test that cannot begin is refused with: the host gave no randomness for the probe's id or its key. Never the platform's own words. */
const CANNOT_START = "the self-test cannot be started";

/**
 * A throwaway key the app seals to. Proves the client bundle can run the same construction as the server.
 *
 * The id is drawn before the key is made, so that randomness which gives out between the two leaves no secret key
 * that nobody holds (a key pair that fails while it is derived wipes its own: `generateRequestKeyPair`), and nothing
 * can fail between making the key and keeping it. A host that gives no randomness is answered with a fixed refusal.
 */
export function beginSelfTest(): { probeId: string; publicKey: string } {
  let probeId: string;
  let keys: RequestKeyPair;
  try {
    probeId = `p_${toHex(randomBytes(8))}`;
    keys = generateRequestKeyPair();
  } catch {
    throw new SecureInputError("service_unavailable", CANNOT_START);
  }
  probes.set(probeId, keys.secretKey);
  if (probes.size > MAX_PROBES) {
    const oldest = probes.keys().next().value as string;
    probes.get(oldest)?.fill(0);
    probes.delete(oldest);
  }
  return { probeId, publicKey: toBase64Url(keys.publicKey) };
}

/** Wipes and forgets every open probe. Called when the plugin is disposed. */
export function clearSelfTests(): void {
  for (const secretKey of probes.values()) secretKey.fill(0);
  probes.clear();
}

/**
 * Opens what the app sealed to the probe's key and compares its digest. The payload is dummy data, and it is wiped
 * like a real one all the same, once it has been hashed: the self-test takes the path a value takes, to its end. The
 * opener is a parameter so that a test can look at the buffer it gave back.
 */
export function finishSelfTest(probeId: string, envelope: SealedEnvelope, digest: string, unseal: typeof open = open): { ok: boolean; bytes: number } {
  const secretKey = probes.get(probeId);
  probes.delete(probeId);
  if (!secretKey) return { ok: false, bytes: 0 };
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = unseal(secretKey, envelope, buildAad(probeId, "selftest"));
    return { ok: digestHex(plaintext) === digest, bytes: plaintext.length };
  } catch {
    return { ok: false, bytes: 0 };
  } finally {
    secretKey.fill(0);
    plaintext?.fill(0);
  }
}
