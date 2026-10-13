#!/usr/bin/env python3
# Re-encodes the PNG textures inside GLB files as JPEG (quality 88), which
# cuts a generated model to about half its size with no visible change in the
# torchlit caves. Run on the package copies (dist/*/assets/models), never on
# assets/models: `python3 scripts/shrink-textures.py dist/experience/assets/models`.
import io, json, struct, sys, os
from PIL import Image

def shrink(path):
    data = open(path, 'rb').read()
    jlen = struct.unpack_from('<I', data, 12)[0]
    j = json.loads(data[20:20 + jlen])
    boff = 20 + jlen + 8
    blen = struct.unpack_from('<I', data, 20 + jlen)[0]
    binc = data[boff:boff + blen]
    views = j['bufferViews']
    chunks = [binc[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']] for v in views]
    for im in j.get('images', []):
        if im.get('mimeType') != 'image/png' or 'bufferView' not in im:
            continue
        img = Image.open(io.BytesIO(chunks[im['bufferView']]))
        if img.mode in ('RGBA', 'LA', 'P'):
            img = img.convert('RGBA')
            if img.getextrema()[3][0] < 255:
                continue  # real transparency: keep the PNG
        out = io.BytesIO()
        img.convert('RGB').save(out, 'JPEG', quality=88)
        chunks[im['bufferView']] = out.getvalue()
        im['mimeType'] = 'image/jpeg'
    newbin = b''
    for v, c in zip(views, chunks):
        newbin += b'\0' * ((4 - len(newbin) % 4) % 4)
        v['byteOffset'] = len(newbin)
        v['byteLength'] = len(c)
        newbin += c
    newbin += b'\0' * ((4 - len(newbin) % 4) % 4)
    j['buffers'][0]['byteLength'] = len(newbin)
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(newbin)
    out = struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(newbin), 0x004E4942) + newbin
    open(path, 'wb').write(out)
    return len(data), len(out)

before = after = 0
for d in sys.argv[1:]:
    for f in sorted(os.listdir(d)):
        if f.endswith('.glb'):
            a, b = shrink(os.path.join(d, f))
            before += a; after += b
print(f'{before/1e6:.1f} MB -> {after/1e6:.1f} MB')
