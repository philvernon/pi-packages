export type MessagePackValue =
  | null
  | boolean
  | number
  | string
  | Buffer
  | MessagePackValue[]
  | { [key: string]: MessagePackValue };

export interface MessagePackDecodeResult {
  value: MessagePackValue;
  offset: number;
}

/** Minimal MessagePack codec for the Neovim RPC values this extension uses. */
export function encode(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.from([0xc0]);
  if (value === false) return Buffer.from([0xc2]);
  if (value === true) return Buffer.from([0xc3]);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    if (value >= 0 && value < 128) return Buffer.from([value]);
    if (value >= -32 && value < 0) return Buffer.from([0x100 + value]);
    if (value >= 0 && value < 256) return Buffer.from([0xcc, value]);
    if (value >= -128 && value < 128) return Buffer.from([0xd0, value & 255]);
    if (value >= 0 && value < 65536) {
      const buffer = Buffer.alloc(3);
      buffer[0] = 0xcd;
      buffer.writeUInt16BE(value, 1);
      return buffer;
    }
    if (value >= -32768 && value < 32768) {
      const buffer = Buffer.alloc(3);
      buffer[0] = 0xd1;
      buffer.writeInt16BE(value, 1);
      return buffer;
    }
    if (value >= 0 && value <= 0xffffffff) {
      const buffer = Buffer.alloc(5);
      buffer[0] = 0xce;
      buffer.writeUInt32BE(value, 1);
      return buffer;
    }
    const buffer = Buffer.alloc(9);
    buffer[0] = 0xd3;
    buffer.writeBigInt64BE(BigInt(value), 1);
    return buffer;
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    const length = bytes.length;
    if (length < 32)
      return Buffer.concat([Buffer.from([0xa0 | length]), bytes]);
    if (length < 256)
      return Buffer.concat([Buffer.from([0xd9, length]), bytes]);
    if (length < 65536) {
      const header = Buffer.alloc(3);
      header[0] = 0xda;
      header.writeUInt16BE(length, 1);
      return Buffer.concat([header, bytes]);
    }
    const header = Buffer.alloc(5);
    header[0] = 0xdb;
    header.writeUInt32BE(length, 1);
    return Buffer.concat([header, bytes]);
  }
  if (Array.isArray(value)) {
    const length = value.length;
    let header: Buffer;
    if (length < 16) {
      header = Buffer.from([0x90 | length]);
    } else if (length < 65536) {
      header = Buffer.alloc(3);
      header[0] = 0xdc;
      header.writeUInt16BE(length, 1);
    } else {
      header = Buffer.alloc(5);
      header[0] = 0xdd;
      header.writeUInt32BE(length, 1);
    }
    return Buffer.concat([header, ...value.map(encode)]);
  }
  if (typeof value === "object") {
    const pairs: [string, unknown][] = Object.entries(value);
    const length = pairs.length;
    let header: Buffer;
    if (length < 16) {
      header = Buffer.from([0x80 | length]);
    } else if (length < 65536) {
      header = Buffer.alloc(3);
      header[0] = 0xde;
      header.writeUInt16BE(length, 1);
    } else {
      header = Buffer.alloc(5);
      header[0] = 0xdf;
      header.writeUInt32BE(length, 1);
    }
    return Buffer.concat([
      header,
      ...pairs.flatMap(([key, entry]) => [encode(key), encode(entry)]),
    ]);
  }
  throw new TypeError("Cannot MessagePack encode " + typeof value);
}

export function decode(buffer: Buffer, offset = 0): MessagePackDecodeResult {
  let cursor = offset;

  function take(length: number): number {
    if (cursor + length > buffer.length) {
      throw new RangeError("incomplete MessagePack");
    }
    const start = cursor;
    cursor += length;
    return start;
  }

  function readString(length: number): string {
    const start = take(length);
    return buffer.subarray(start, start + length).toString("utf8");
  }

  function readArray(length: number): MessagePackValue[] {
    const array: MessagePackValue[] = [];
    for (let index = 0; index < length; index++) {
      const part = decode(buffer, cursor);
      cursor = part.offset;
      array.push(part.value);
    }
    return array;
  }

  function readMap(length: number): Record<string, MessagePackValue> {
    const object: Record<string, MessagePackValue> = {};
    for (let index = 0; index < length; index++) {
      const key = decode(buffer, cursor);
      cursor = key.offset;
      const entry = decode(buffer, cursor);
      cursor = entry.offset;
      object[String(key.value)] = entry.value;
    }
    return object;
  }

  const head = buffer[take(1)];
  let value: MessagePackValue;
  if (head <= 0x7f) value = head;
  else if (head >= 0xe0) value = head - 256;
  else if ((head & 0xe0) === 0xa0) value = readString(head & 31);
  else if ((head & 0xf0) === 0x90) value = readArray(head & 15);
  else if ((head & 0xf0) === 0x80) value = readMap(head & 15);
  else {
    switch (head) {
      case 0xc0:
        value = null;
        break;
      case 0xc2:
        value = false;
        break;
      case 0xc3:
        value = true;
        break;
      case 0xcc:
        value = buffer.readUInt8(take(1));
        break;
      case 0xcd:
        value = buffer.readUInt16BE(take(2));
        break;
      case 0xce:
        value = buffer.readUInt32BE(take(4));
        break;
      case 0xcf:
        value = Number(buffer.readBigUInt64BE(take(8)));
        break;
      case 0xd0:
        value = buffer.readInt8(take(1));
        break;
      case 0xd1:
        value = buffer.readInt16BE(take(2));
        break;
      case 0xd2:
        value = buffer.readInt32BE(take(4));
        break;
      case 0xd3:
        value = Number(buffer.readBigInt64BE(take(8)));
        break;
      case 0xca:
        value = buffer.readFloatBE(take(4));
        break;
      case 0xcb:
        value = buffer.readDoubleBE(take(8));
        break;
      case 0xd9:
        value = readString(buffer.readUInt8(take(1)));
        break;
      case 0xda:
        value = readString(buffer.readUInt16BE(take(2)));
        break;
      case 0xdb:
        value = readString(buffer.readUInt32BE(take(4)));
        break;
      case 0xdc:
        value = readArray(buffer.readUInt16BE(take(2)));
        break;
      case 0xdd:
        value = readArray(buffer.readUInt32BE(take(4)));
        break;
      case 0xde:
        value = readMap(buffer.readUInt16BE(take(2)));
        break;
      case 0xdf:
        value = readMap(buffer.readUInt32BE(take(4)));
        break;
      case 0xc4: {
        const length = buffer.readUInt8(take(1));
        const start = take(length);
        value = buffer.subarray(start, start + length);
        break;
      }
      case 0xc5: {
        const length = buffer.readUInt16BE(take(2));
        const start = take(length);
        value = buffer.subarray(start, start + length);
        break;
      }
      case 0xc6: {
        const length = buffer.readUInt32BE(take(4));
        const start = take(length);
        value = buffer.subarray(start, start + length);
        break;
      }
      case 0xc7:
      case 0xc8:
      case 0xc9:
      case 0xd4:
      case 0xd5:
      case 0xd6:
      case 0xd7:
      case 0xd8:
        throw new Error("Unsupported MessagePack extension type");
      default:
        throw new Error("Unsupported MessagePack code " + head.toString(16));
    }
  }
  return { value, offset: cursor };
}
