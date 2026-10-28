// What the plugin needs from the host it runs in, and no promise that every host has it. The client project is checked
// without Node's types and without the DOM library, so the compiler is told about exactly the three globals that
// `shared/bytes.ts` uses. Whether they are there depends on the app that loads this code (Hermes on a phone, a browser
// engine on the desktop and the web): `crypto.getRandomValues` in particular is the host app's to provide.
//
// Its absence fails closed. Without it no key pair and no nonce can be drawn, `seal` throws `SealError("sealing failed")`,
// the form sends nothing and asks for «→» again, and the self-test on the settings screen reports that the app could
// not seal. There is no fallback to another source of randomness and none to plaintext.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  /** `ignoreBOM`: a byte order mark at the start is kept as the character U+FEFF, and not taken away (`client/file-entry.ts`). */
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

declare var crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
