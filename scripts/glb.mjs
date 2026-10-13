// Minimal GLB reading and writing for the build scripts (rig.mjs): enough of
// glTF 2.0 to take a static Zoodle export apart and write it back with a
// skeleton, skin weights and clips. No dependencies beyond Node.

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file');
  let off = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

// An accessor as a plain typed array (de-interleaved; normalized integers
// become floats).
export function readAccessor({ json, bin }, index) {
  const a = json.accessors[index];
  const n = COMPONENTS[a.type];
  const T = TYPED[a.componentType];
  const bv = json.bufferViews[a.bufferView];
  const size = T.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || n * size;
  const base = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const view = new DataView(bin.buffer);
  const out = a.normalized ? new Float32Array(a.count * n) : new T(a.count * n);
  const get = {
    5120: (o) => view.getInt8(o),
    5121: (o) => view.getUint8(o),
    5122: (o) => view.getInt16(o, true),
    5123: (o) => view.getUint16(o, true),
    5125: (o) => view.getUint32(o, true),
    5126: (o) => view.getFloat32(o, true),
  }[a.componentType];
  const k = a.normalized ? 1 / NORMALIZE[a.componentType] : 1;
  for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = get(base + i * stride + c * size) * k;
  return out;
}

export function bufferViewBytes({ json, bin }, index) {
  const bv = json.bufferViews[index];
  return bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
}

// Collects buffer views and accessors into one binary chunk.
export class GlbBuilder {
  constructor() {
    this.json = { asset: { version: '2.0' }, accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    this.parts = [];
    this.length = 0;
  }

  view(bytes, target) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(Buffer.alloc(pad));
      this.length += pad;
    }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.parts.push(buf);
    const bv = { buffer: 0, byteOffset: this.length, byteLength: buf.length };
    if (target) bv.target = target;
    this.length += buf.length;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }

  // `array` is a typed array; `type` 'SCALAR' | 'VEC2' ...; min/max are added
  // for POSITION and animation inputs (the spec requires them there).
  accessor(array, type, { target, minmax = false, normalized = false } = {}) {
    const n = COMPONENTS[type];
    const componentType = Number(Object.entries(TYPED).find(([, T]) => array instanceof T)[0]);
    const acc = { bufferView: this.view(array, target), componentType, count: array.length / n, type };
    if (normalized) acc.normalized = true;
    if (minmax) {
      const min = new Array(n).fill(Infinity);
      const max = new Array(n).fill(-Infinity);
      for (let i = 0; i < array.length; i++) {
        const c = i % n;
        if (array[i] < min[c]) min[c] = array[i];
        if (array[i] > max[c]) max[c] = array[i];
      }
      acc.min = min;
      acc.max = max;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  toBuffer() {
    const binLen = Math.ceil(this.length / 4) * 4;
    const bin = Buffer.concat([...this.parts, Buffer.alloc(binLen - this.length)]);
    this.json.buffers[0].byteLength = binLen;
    let text = Buffer.from(JSON.stringify(this.json), 'utf8');
    const jsonLen = Math.ceil(text.length / 4) * 4;
    text = Buffer.concat([text, Buffer.alloc(jsonLen - text.length, 0x20)]);
    const out = Buffer.alloc(12 + 8 + jsonLen + 8 + binLen);
    out.writeUInt32LE(0x46546c67, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(out.length, 8);
    out.writeUInt32LE(jsonLen, 12);
    out.writeUInt32LE(CHUNK_JSON, 16);
    text.copy(out, 20);
    out.writeUInt32LE(binLen, 20 + jsonLen);
    out.writeUInt32LE(CHUNK_BIN, 24 + jsonLen);
    bin.copy(out, 28 + jsonLen);
    return out;
  }
}
