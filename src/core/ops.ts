/**
 * Canonical-buffer helpers shared by the window mirror and (later) the
 * editor adapters.
 *
 * ADR-010: the canonical buffer is held here as **UTF-8 bytes**
 * (`Uint8Array`, BOM stripped), mirroring the Rust registry exactly.
 * Transactions from the registry are byte-addressed, so applying them to the
 * byte array is exact; a display string is derived via `TextDecoder` and a
 * user edit is re-encoded to bytes before being turned into ops. UTF-16
 * concerns (CodeMirror) live at the editor adapter boundary, not here.
 */

export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode canonical bytes to a string (valid UTF-8 by construction). */
export function bytesToString(bytes: Uint8Array): string {
  return bytes.length === 0 ? "" : decoder.decode(bytes);
}

/** Encode a display string to canonical UTF-8 bytes. */
export function stringToBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export interface ByteOp {
  startByte: number;
  endByte: number;
  text: string;
}

/**
 * Apply byte ops to a byte buffer, validating boundaries (fail closed —
 * mirrors the Rust registry's validation so a stale/invalid update can never
 * corrupt a local mirror silently).
 */
export function applyOps(
  bytes: Uint8Array,
  ops: ByteOp[],
): { next: Uint8Array; ok: boolean; error?: string } {
  let cursor = 0;
  for (const op of ops) {
    if (
      op.startByte < cursor ||
      op.endByte < op.startByte ||
      op.endByte > bytes.length ||
      !isCharBoundary(bytes, op.startByte) ||
      !isCharBoundary(bytes, op.endByte)
    ) {
      return {
        next: bytes,
        ok: false,
        error: `invalid op [${op.startByte},${op.endByte}) on ${bytes.length} bytes`,
      };
    }
    cursor = op.endByte;
  }
  const pieces: Uint8Array[] = [];
  let pos = 0;
  for (const op of ops) {
    if (op.startByte > pos) {
      pieces.push(bytes.subarray(pos, op.startByte));
    }
    pieces.push(encoder.encode(op.text));
    pos = op.endByte;
  }
  if (pos < bytes.length) {
    pieces.push(bytes.subarray(pos));
  }
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const next = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) {
    next.set(p, off);
    off += p.length;
  }
  return { next, ok: true };
}

/** True when `off` is not in the middle of a UTF-8 sequence. */
export function isCharBoundary(bytes: Uint8Array, off: number): boolean {
  if (off < 0 || off > bytes.length) return false;
  if (off === bytes.length) return true;
  // A continuation byte is 10xxxxxx (0x80..0xBF).
  const b = bytes[off];
  return b !== undefined && (b & 0xc0) !== 0x80;
}

/**
 * Full-buffer replacement op (M1 textarea path). M3's CodeMirror adapter
 * replaces this with minimal diffed ops; the registry path is identical.
 */
export function fullReplaceOp(bytes: Uint8Array, text: string): ByteOp {
  return {
    startByte: 0,
    endByte: bytes.length,
    text,
  };
}
