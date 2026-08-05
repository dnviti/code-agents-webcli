/**
 * Encryption for secrets that live next to the database.
 *
 * Everything stored here is encrypted at rest with AES-256-GCM. The envelope
 * carries its own key id so rotation is a matter of reading with one key and
 * re-encrypting with another; the consumer never sees the raw key.
 *
 * Production deployments should pass a key through `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY`
 * or `--encryption-key`; a supplied key is held in memory only and is never
 * written to the database beside the ciphertext it protects. If no key is
 * supplied, the ring generates one and stores it in `app_settings` so
 * development keeps working, and logs a warning because the key then lives
 * beside the ciphertext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export interface KeyRingSettings {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export interface EncryptionKeyRingOptions {
  settings: KeyRingSettings;
  /**
   * A 32-byte key in base64 or hex, from `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY`
   * or `--encryption-key`. Overrides the stored key and is never persisted.
   */
  key?: string | null;
  /** A stable id for the supplied key; defaults to a hash of it. */
  kid?: string;
  /** Where warnings go. */
  warn?: (...args: unknown[]) => void;
}

interface KeyRecord {
  id: string;
  key: Buffer;
}

interface Envelope {
  v: number;
  kid: string;
  iv: string;
  tag: string;
  data: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const CURRENT_VERSION = 1;
const ACTIVE_KEY_SETTING = 'deploy.encryptionKeyId';
const KEY_SETTING_PREFIX = 'deploy.encryptionKeys.';

export class EncryptionKeyRing {
  private readonly settings: KeyRingSettings;
  private readonly warn: (...args: unknown[]) => void;
  private active: KeyRecord;
  /** Keys seen this process, by id. A supplied key lives here and nowhere else. */
  private readonly known = new Map<string, Buffer>();

  constructor(options: EncryptionKeyRingOptions) {
    this.settings = options.settings;
    this.warn = options.warn || ((...args) => { console.warn(...args); });

    if (options.key) {
      const parsed = parseKeyMaterial(options.key);
      this.active = {
        id: options.kid || keyIdFor(parsed),
        key: parsed,
      };
      this.known.set(this.active.id, parsed);
      // Deliberately not persisted, and the stored active id is left alone:
      // the whole point of supplying a key is that the database alone cannot
      // decrypt what it holds. Envelopes written under a previously generated
      // key still decrypt, because those keys remain in app_settings.
      return;
    }

    const loaded = this.loadActiveKey();
    if (loaded) {
      this.active = loaded;
      this.known.set(loaded.id, loaded.key);
      return;
    }

    const generated = generateKey();
    this.active = generated;
    this.known.set(generated.id, generated.key);
    this.saveKey(generated);
    this.settings.setSetting(ACTIVE_KEY_SETTING, generated.id);
    this.warn(
      'encryption: no CODE_AGENTS_WEBCLI_ENCRYPTION_KEY supplied; a dev-grade key was '
      + 'generated and stored in app_settings. In production this puts the key next to '
      + 'the ciphertext — pass a key via the environment or CLI instead.',
    );
  }

  /** The id of the key currently used for new ciphertext. */
  activeKeyId(): string {
    return this.active.id;
  }

  /** Encrypt a string; returns a compact base64-encoded envelope. */
  encrypt(plaintext: string): string {
    return this.encryptBuffer(Buffer.from(plaintext, 'utf8'));
  }

  /** Decrypt a compact base64-encoded envelope. */
  decrypt(envelopeBase64: string): string {
    return this.decryptBuffer(envelopeBase64).toString('utf8');
  }

  /** Encrypt raw bytes; returns a compact base64-encoded envelope. */
  encryptBuffer(plaintext: Buffer): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.active.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: Envelope = {
      v: CURRENT_VERSION,
      kid: this.active.id,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };

    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  }

  /** Decrypt raw bytes from a compact base64-encoded envelope. */
  decryptBuffer(envelopeBase64: string): Buffer {
    const envelope = parseEnvelope(envelopeBase64);
    const key = this.known.get(envelope.kid) || this.loadKey(envelope.kid).key;

    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const data = Buffer.from(envelope.data, 'base64');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      throw new Error('encryption: decrypt failed (wrong key or corrupt envelope)');
    }
  }

  /** Re-encrypt an envelope with the currently active key. */
  reEncrypt(envelopeBase64: string): string {
    const plaintext = this.decrypt(envelopeBase64);
    return this.encrypt(plaintext);
  }

  private loadActiveKey(): KeyRecord | null {
    const activeId = this.settings.getSetting(ACTIVE_KEY_SETTING);
    if (!activeId) {
      return null;
    }
    return this.loadKey(activeId);
  }

  private loadKey(id: string): KeyRecord {
    const raw = this.settings.getSetting(`${KEY_SETTING_PREFIX}${id}`);
    if (!raw) {
      throw new Error(`encryption: key ${id} not found in settings`);
    }
    let record: { key: string; createdAt?: string };
    try {
      record = JSON.parse(raw) as { key: string; createdAt?: string };
    } catch {
      throw new Error(`encryption: corrupt key record ${id}`);
    }
    const key = parseKeyMaterial(record.key);
    this.known.set(id, key);
    return { id, key };
  }

  private saveKey(record: KeyRecord): void {
    this.settings.setSetting(
      `${KEY_SETTING_PREFIX}${record.id}`,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        key: record.key.toString('base64'),
      }),
    );
  }
}

function generateKey(): KeyRecord {
  return {
    id: randomUUID(),
    key: randomBytes(32),
  };
}

/**
 * A short, deterministic identifier for a provided key. A hash, never a slice
 * of the key itself: the id rides in every envelope, and a slice would hand
 * out key material one ciphertext at a time.
 */
function keyIdFor(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 12);
}

function parseEnvelope(envelopeBase64: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(envelopeBase64, 'base64').toString('utf8'));
  } catch {
    throw new Error('encryption: invalid envelope');
  }

  const env = parsed as Partial<Envelope>;
  if (
    env.v !== CURRENT_VERSION
    || typeof env.kid !== 'string'
    || typeof env.iv !== 'string'
    || typeof env.tag !== 'string'
    || typeof env.data !== 'string'
  ) {
    throw new Error('encryption: malformed envelope');
  }
  return env as Envelope;
}

function parseKeyMaterial(input: string): Buffer {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    throw new Error('encryption: empty key material');
  }

  // 64 hex characters = 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Base64 decoding never throws — it skips what it cannot read — so the
  // length check below is the real validation.
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== 32) {
    throw new Error(`encryption: key must be 32 bytes (got ${decoded.length})`);
  }
  return decoded;
}

/** Validate CLI/environment key material before opening the installation DB. */
export function validateEncryptionKeyMaterial(input: string): void {
  parseKeyMaterial(input);
}
