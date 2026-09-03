/**
 * Keccak-256 (Ethereums variant, padding 0x01 — inte NIST SHA3:s 0x06).
 *
 * Node har ingen inbyggd keccak och den behövs på två ställen: för att räkna
 * ut event-topics och för att hitta lagringsplatsen för ett mapping-värde vid
 * state override i säljsimuleringen. Implementationen använder BigInt-lanes;
 * långsammare än en 32-bitarsvariant men kort nog att granska, och den körs
 * bara ett fåtal gånger per token.
 */

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const RHO = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }

    let last = A[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const tmp = A[j];
      A[j] = rotl(last, RHO[i]);
      last = tmp;
    }

    for (let y = 0; y < 25; y += 5) {
      const t = [A[y], A[y + 1], A[y + 2], A[y + 3], A[y + 4]];
      for (let x = 0; x < 5; x++) A[y + x] = t[x] ^ (~t[(x + 1) % 5] & MASK & t[(x + 2) % 5]);
    }

    A[0] ^= RC[round];
  }
}

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array} 32 bytes
 */
export function keccak256(input) {
  const rate = 136; // 1088 bitar
  const A = new Array(25).fill(0n);

  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      // Lanes är little-endian.
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export const toHex = (bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** keccak256 över en hex-sträng (med eller utan 0x-prefix). */
export function keccak256Hex(hex) {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return toHex(keccak256(bytes));
}

/** keccak256 över en UTF-8-sträng, t.ex. för att räkna ut en event-topic. */
export const keccak256Utf8 = (text) => toHex(keccak256(new TextEncoder().encode(text)));
