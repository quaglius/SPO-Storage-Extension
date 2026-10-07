/**
 * QuickXorHash — the content hash SharePoint/OneDrive expose as file.hashes.quickXorHash (Graph).
 * Port of Microsoft's reference implementation (160-bit, shift 11, length XOR-ed into the tail).
 * Used to prove that the bytes copied to Blob are exactly the bytes SharePoint holds.
 */
const WIDTH = 160;
const SHIFT = 11;
const BITS_IN_LAST_CELL = 32;
const MASK64 = (1n << 64n) - 1n;

export class QuickXorHash {
  private readonly data: bigint[] = [0n, 0n, 0n];
  private lengthSoFar = 0n;
  private shiftSoFar = 0;

  update(chunk: Uint8Array): this {
    const size = chunk.length;
    if (size === 0) return this;
    let vectorArrayIndex = Math.floor(this.shiftSoFar / 64);
    let vectorOffset = this.shiftSoFar % 64;
    const iterations = Math.min(size, WIDTH);
    for (let i = 0; i < iterations; i++) {
      const isLastCell = vectorArrayIndex === this.data.length - 1;
      const bitsInVectorCell = isLastCell ? BITS_IN_LAST_CELL : 64;
      let xored = 0;
      for (let j = i; j < size; j += WIDTH) xored ^= chunk[j];
      const x = BigInt(xored);
      if (vectorOffset <= bitsInVectorCell - 8) {
        this.data[vectorArrayIndex] = (this.data[vectorArrayIndex] ^ (x << BigInt(vectorOffset))) & MASK64;
      } else {
        const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
        const low = BigInt(bitsInVectorCell - vectorOffset);
        this.data[vectorArrayIndex] = (this.data[vectorArrayIndex] ^ (x << BigInt(vectorOffset))) & MASK64;
        this.data[index2] = (this.data[index2] ^ (x >> low)) & MASK64;
      }
      vectorOffset += SHIFT;
      while (vectorOffset >= bitsInVectorCell) {
        vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
        vectorOffset -= bitsInVectorCell;
      }
    }
    this.shiftSoFar = (this.shiftSoFar + SHIFT * (size % WIDTH)) % WIDTH;
    this.lengthSoFar += BigInt(size);
    return this;
  }

  digest(): Buffer {
    const out = Buffer.alloc(WIDTH / 8);
    out.writeBigUInt64LE(this.data[0], 0);
    out.writeBigUInt64LE(this.data[1], 8);
    const last = Buffer.alloc(8);
    last.writeBigUInt64LE(this.data[2], 0);
    last.copy(out, 16, 0, 4);
    const len = Buffer.alloc(8);
    len.writeBigInt64LE(this.lengthSoFar, 0);
    for (let i = 0; i < 8; i++) out[WIDTH / 8 - 8 + i] ^= len[i];
    return out;
  }

  digestBase64(): string {
    return this.digest().toString('base64');
  }
}
