// Vendored from https://github.com/denoland/std/blob/main/crypto/unstable_aes_gcm.ts
// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const OVERHEAD = NONCE_LENGTH + TAG_LENGTH;

/** Options for {@linkcode encryptAesGcm} and {@linkcode decryptAesGcm}. */
export interface AesGcmOptions {
  /** Additional authenticated data. Authenticated but not encrypted. */
  additionalData?: BufferSource;
}

/**
 * Encrypts plaintext using AES-GCM with a random 96-bit nonce.
 * Returns `nonce (12 bytes) || ciphertext || tag (16 bytes)`.
 */
export async function encryptAesGcm(
  key: CryptoKey,
  plaintext: BufferSource,
  options?: AesGcmOptions,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: nonce,
    tagLength: TAG_LENGTH * 8,
  };
  if (options?.additionalData !== undefined) {
    params.additionalData = options.additionalData;
  }

  const ciphertextAndTag = new Uint8Array(
    await crypto.subtle.encrypt(params, key, plaintext),
  );

  const result = new Uint8Array(NONCE_LENGTH + ciphertextAndTag.byteLength);
  result.set(nonce);
  result.set(ciphertextAndTag, NONCE_LENGTH);
  return result;
}

/**
 * Decrypts data produced by {@linkcode encryptAesGcm}.
 * Expects `nonce (12 B) || ciphertext || tag (16 B)`.
 */
export async function decryptAesGcm(
  key: CryptoKey,
  data: BufferSource,
  options?: AesGcmOptions,
): Promise<Uint8Array> {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

  if (bytes.byteLength < OVERHEAD) {
    throw new RangeError(
      `Data is too short: expected at least ${OVERHEAD} bytes, got ${bytes.byteLength}`,
    );
  }

  const nonce = bytes.subarray(0, NONCE_LENGTH);
  const ciphertextAndTag = bytes.subarray(NONCE_LENGTH);

  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: nonce,
    tagLength: TAG_LENGTH * 8,
  };
  if (options?.additionalData !== undefined) {
    params.additionalData = options.additionalData;
  }

  return new Uint8Array(
    await crypto.subtle.decrypt(params, key, ciphertextAndTag),
  );
}
