// Signs releases and the published guide so the app accepts them (see
// src/signing.js). ECDSA P-256 / SHA-256 (ES256), node:crypto only.
//
// One-time setup, either:
//   a) Azure Key Vault (the private key never leaves the vault):
//        az keyvault key create --vault-name <vault> --name faic-signing --kty EC-HSM --curve P-256 --ops sign verify
//        az keyvault key download --vault-name <vault> --name faic-signing --encoding PEM --file faic-signing.pub.pem
//   b) A local key, kept outside the repository:
//        node scripts/sign.js keygen <path outside the repo>/faic-signing.pem
// then put the printed public key in TRUSTED_KEYS (src/signing.js):
//   node scripts/sign.js pubkey faic-signing.pub.pem
//
// Each release (after `npm run build`) and each guide change:
//   node scripts/sign.js release dist/ForeverAICompanion.exe --key <key.pem>     -> dist/ForeverAICompanion.exe.sig
//   node scripts/sign.js guide knowledge-builtin/wow-forever.md --key <key.pem>  -> knowledge-builtin/wow-forever.md.sig
//   (and the same for knowledge-builtin/wow-forever-topics.md when it changes)
// or with Key Vault:
//   node scripts/sign.js digest release dist/ForeverAICompanion.exe
//   az keyvault key sign --vault-name <vault> --name faic-signing --algorithm ES256 --digest <printed digest>
//   node scripts/sign.js attach release dist/ForeverAICompanion.exe <signature from az>
// (attach checks the signature against TRUSTED_KEYS, or against --pubkey <public.pem>.)
// Upload ForeverAICompanion.exe.sig with the exe to the GitHub release, and
// commit each guide's .sig next to it (the app reads both from GitHub).
// The release version signed is the one in src/app/controller.js unless
// --version is given; it must match the release tag.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { GUIDE_FILE, TOPICS_FILE } from '../src/guide.js';
import { ASSET_NAME } from '../src/updater.js';
import {
  GUIDE_CONTEXT, TRUSTED_KEYS, UPDATE_CONTEXT, decodeSignature, encodeSignature, guideFields, signedMessage, updateFields,
  verifySignature,
} from '../src/signing.js';

const REPO_DIR = path.resolve(ROOT, '..');

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(`Usage:
  node scripts/sign.js keygen <private-key.pem>
  node scripts/sign.js pubkey <public-or-private.pem>
  node scripts/sign.js release <exe> --key <private-key.pem> [--version X.Y.Z]
  node scripts/sign.js guide <wow-forever.md | wow-forever-topics.md> --key <private-key.pem>
  node scripts/sign.js digest release|guide <file> [--version X.Y.Z]
  node scripts/sign.js attach release|guide <file> <signature> [--version X.Y.Z] [--pubkey <public.pem>]`);
  process.exit(1);
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) usage(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

const appVersion = () => fs.readFileSync(path.join(ROOT, 'src', 'app', 'controller.js'), 'utf8').match(/VERSION = '([\d.]+)'/)[1];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const spkiBase64 = (key) => (key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key))
  .export({ type: 'spki', format: 'der' }).toString('base64');
const inside = (file, dir) => !path.relative(dir, path.resolve(file)).startsWith('..') && !path.isAbsolute(path.relative(dir, path.resolve(file)));

// What gets signed for `kind` ("release" | "guide") and that file.
function message(kind, file, version) {
  const bytes = fs.readFileSync(file);
  if (kind === 'release') {
    if (bytes.subarray(0, 2).toString('latin1') !== 'MZ') usage(`${file} is not a Windows program`);
    if (path.basename(file) !== ASSET_NAME) console.warn(`Warning: the app only downloads a release file named ${ASSET_NAME}.`);
    const fields = updateFields({ file: ASSET_NAME, version: version || appVersion(), size: bytes.length, sha256: sha256(bytes) });
    return { context: UPDATE_CONTEXT, fields };
  }
  if (kind === 'guide') {
    // The file name is signed too: a base guide signature can't pass for the topics file.
    let name = path.basename(file);
    if (name !== GUIDE_FILE && name !== TOPICS_FILE) {
      console.warn(`Warning: the app only downloads guides named ${GUIDE_FILE} and ${TOPICS_FILE}; signing it as ${GUIDE_FILE}.`);
      name = GUIDE_FILE;
    }
    return { context: GUIDE_CONTEXT, fields: guideFields({ file: name, sha256: sha256(bytes) }) };
  }
  return usage(`unknown kind "${kind}"`);
}

function writeSig(file, sig, { context, fields }, publicKeyB64) {
  const keys = publicKeyB64 ? [publicKeyB64] : TRUSTED_KEYS;
  if (!verifySignature(context, fields, encodeSignature(sig), keys)) {
    usage(publicKeyB64 ? 'the signature does not verify with that key' : 'the signature does not verify with any key in TRUSTED_KEYS (src/signing.js)');
  }
  const out = `${file}.sig`;
  fs.writeFileSync(out, encodeSignature(sig));
  console.log(`Signed ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`Wrote ${out}`);
  if (publicKeyB64 && !TRUSTED_KEYS.includes(publicKeyB64)) {
    console.warn('Warning: this key is not in TRUSTED_KEYS (src/signing.js): the app will not accept it yet.');
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const args = [...rest];
const keyFile = option(args, '--key');
const version = option(args, '--version');
const pubFile = option(args, '--pubkey');

if (cmd === 'keygen') {
  const out = args[0] || usage('where to write the private key?');
  if (inside(out, REPO_DIR)) usage('keep the private key outside the repository');
  if (fs.existsSync(out)) usage(`${out} already exists`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = out.replace(/(\.pem)?$/i, '.pub.pem');
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Private key: ${out} (keep it secret and backed up)`);
  console.log(`Public key:  ${pub}`);
  console.log(`Add to TRUSTED_KEYS in src/signing.js:\n  '${spkiBase64(publicKey)}',`);
} else if (cmd === 'pubkey') {
  const file = args[0] || usage('which key file?');
  console.log(spkiBase64(fs.readFileSync(file, 'utf8')));
} else if (cmd === 'release' || cmd === 'guide') {
  const file = args[0] || usage('which file?');
  if (!keyFile) usage('--key <private-key.pem> is required (or use digest/attach with Key Vault)');
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  const m = message(cmd, file, version);
  const sig = crypto.sign('sha256', signedMessage(m.context, m.fields), { key, dsaEncoding: 'ieee-p1363' });
  writeSig(file, sig, m, spkiBase64(key));
} else if (cmd === 'digest') {
  const [kind, file] = args;
  if (!file) usage('digest release|guide <file>');
  const m = message(kind, file, version);
  console.log(crypto.createHash('sha256').update(signedMessage(m.context, m.fields)).digest('base64'));
} else if (cmd === 'attach') {
  const [kind, file, signature] = args;
  if (!signature) usage('attach release|guide <file> <signature>');
  const sig = decodeSignature(signature);
  if (!sig) usage('the signature must be 64 bytes (r||s) in base64 or base64url, as az keyvault key sign returns it');
  writeSig(file, sig, message(kind, file, version), pubFile ? spkiBase64(fs.readFileSync(pubFile, 'utf8')) : null);
} else {
  usage(cmd ? `unknown command "${cmd}"` : null);
}
