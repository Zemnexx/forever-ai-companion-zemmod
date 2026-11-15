// Signatures for what the app downloads and then trusts: its own updates
// (ForeverAICompanion.exe) and the WoW Forever guide that goes into the AI's
// instructions. A GitHub digest only proves the file is the one on GitHub;
// a signature proves the project's key holder published it.
//
// ECDSA P-256 with SHA-256 (ES256, signature as 64 bytes r||s), verified with
// node:crypto only. The private key can live in Azure Key Vault (an ES256 key
// that never leaves the vault) or in a local PEM file: see scripts/sign.js.
import crypto from 'node:crypto';

// Public keys allowed to sign releases and guides: base64 of the DER
// SubjectPublicKeyInfo (`node scripts/sign.js pubkey <public.pem>` prints it).
// Several keys allow rotating to a new one. While this list is empty nothing
// downloaded is trusted: the app does not update itself and keeps the guide
// built into it.
export const TRUSTED_KEYS = [];

export const UPDATE_CONTEXT = 'ForeverAICompanion update v1';
export const GUIDE_CONTEXT = 'ForeverAICompanion guide v1';
export const MAX_SIGNATURE_BYTES = 4096;

// The exact bytes that are signed: a context line (so an update signature can
// never pass as a guide signature, or the other way round), then name=value
// lines. Values must not contain line breaks.
export function signedMessage(context, fields) {
  const lines = [context];
  for (const [k, v] of Object.entries(fields)) {
    const value = String(v);
    if (/[\r\n]/.test(value) || /[\r\n=]/.test(k)) throw new Error(`invalid signed field ${k}`);
    lines.push(`${k}=${value}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// The .sig file: base64 (or base64url, as Key Vault returns it) of r||s.
export function decodeSignature(text) {
  const s = String(text || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const sig = Buffer.from(s, 'base64');
  return sig.length === 64 ? sig : null;
}

export function encodeSignature(sig) {
  return `${Buffer.from(sig).toString('base64')}\n`;
}

const keyCache = new Map();
export function publicKey(b64) {
  if (!keyCache.has(b64)) {
    let key = null;
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' });
      if (k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1') key = k;
    } catch { /* not a key */ }
    keyCache.set(b64, key);
  }
  return keyCache.get(b64);
}

// True when `signature` was made over (context, fields) by one of `keys`.
export function verifySignature(context, fields, signature, keys = TRUSTED_KEYS) {
  const sig = decodeSignature(signature);
  if (!sig || !keys?.length) return false;
  const msg = signedMessage(context, fields);
  return keys.some((b64) => {
    const key = publicKey(b64);
    if (!key) return false;
    try {
      return crypto.verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      return false;
    }
  });
}

// What the signer signs. Updates: the exe's name, the release version it is
// published as (no passing an old build off as a new one), its size and SHA-256.
export const updateFields = ({ file, version, size, sha256 }) => ({ file, version: String(version).replace(/^v/i, ''), size, sha256: String(sha256).toLowerCase() });
// Guides: the file name and its SHA-256 (its date is inside the signed text).
export const guideFields = ({ file, sha256 }) => ({ file, sha256: String(sha256).toLowerCase() });

// Reads a small response body, refusing anything larger than `max` bytes.
export async function readSmall(res, max = MAX_SIGNATURE_BYTES) {
  const declared = Number(res.headers?.get?.('content-length')) || 0;
  if (declared > max) throw new Error('signature file too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('signature file too large');
  return buf.toString('utf8');
}
