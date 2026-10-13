import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHARACTERS, PROPS } from './manifest.js';

// Loads the AI-generated GLBs listed in the manifest. Only files named in
// assets/models/index.json are requested (the dev server and the build
// generate that list from the folder), so a missing model costs nothing. A
// creature whose model is missing stands in as a plain block of its size, so
// the game still runs while models are being generated; the build refuses to
// package it that way.

// Decode textures embedded in a GLB straight from their bytes with
// createImageBitmap, instead of the loader's default blob: object URLs. A host
// page whose Content-Security-Policy forbids blob: would otherwise leave every
// generated model untextured (grey).
const FILTERS = {
  9728: THREE.NearestFilter,
  9729: THREE.LinearFilter,
  9984: THREE.NearestMipmapNearestFilter,
  9985: THREE.LinearMipmapNearestFilter,
  9986: THREE.NearestMipmapLinearFilter,
  9987: THREE.LinearMipmapLinearFilter,
};
const WRAPS = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };

class InlineTexturePlugin {
  constructor(parser) {
    this.parser = parser;
    this.name = 'demon_descent_inline_textures';
  }

  loadTexture(textureIndex) {
    if (typeof createImageBitmap === 'undefined') return null;
    const parser = this.parser;
    const json = parser.json;
    const textureDef = json.textures[textureIndex];
    const sourceDef = json.images?.[textureDef.source];
    if (!sourceDef || sourceDef.bufferView === undefined) return null;
    const key = `inline:${sourceDef.bufferView}:${textureDef.sampler}`;
    if (parser.textureCache[key]) return parser.textureCache[key];
    const promise = parser
      .getDependency('bufferView', sourceDef.bufferView)
      .then((buf) => createImageBitmap(new Blob([buf], { type: sourceDef.mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then((bitmap) => {
        const t = new THREE.Texture(bitmap);
        t.flipY = false;
        t.name = textureDef.name || sourceDef.name || '';
        const sampler = (json.samplers || [])[textureDef.sampler] || {};
        t.magFilter = FILTERS[sampler.magFilter] || THREE.LinearFilter;
        t.minFilter = FILTERS[sampler.minFilter] || THREE.LinearMipmapLinearFilter;
        t.wrapS = WRAPS[sampler.wrapS] || THREE.RepeatWrapping;
        t.wrapT = WRAPS[sampler.wrapT] || THREE.RepeatWrapping;
        t.generateMipmaps = t.minFilter !== THREE.NearestFilter && t.minFilter !== THREE.LinearFilter;
        t.needsUpdate = true;
        parser.associations.set(t, { textures: textureIndex });
        return t;
      })
      .catch((e) => {
        console.warn('Texture decode failed', e);
        return null;
      });
    parser.textureCache[key] = promise;
    return promise;
  }
}

const loader = new GLTFLoader();
loader.register((parser) => new InlineTexturePlugin(parser));
const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

// Package paths -> URLs (Project 0's p0.asset(); a page uses them as-is).
let resolveUrl = (p) => p;

async function loadIndex() {
  try {
    const res = await fetch(resolveUrl('assets/models/index.json'), { cache: 'no-store' });
    if (!res.ok) return new Set();
    const list = await res.json();
    return new Set(list.map((f) => `assets/models/${f}`));
  } catch {
    return new Set();
  }
}

// One request per file: the bosses share their model with a creature.
const loading = new Map();
function load(url, available) {
  if (!url || !available.has(url)) return Promise.resolve(null);
  if (!loading.has(url)) {
    loading.set(
      url,
      loader.loadAsync(resolveUrl(url)).catch((e) => {
        console.warn(`Could not load ${url}: ${e.message}`);
        return null;
      }),
    );
  }
  return loading.get(url);
}

function boundsOf(object) {
  object.updateMatrixWorld(true);
  return _box.setFromObject(object, true).clone();
}

// Clip slots and the names generators commonly give them.
const CLIP_PATTERNS = {
  idle: /idle|breath|stand/i,
  walk: /walk/i,
  run: /run|sprint|charge/i,
  attack: /attack|slash|swing|punch|strike|hit_?1|combo/i,
  hit: /hit|react|damage|hurt|flinch/i,
  death: /death|die|dying|dead/i,
};

function sortClips(animations, extra) {
  const clips = {};
  // Clips named exactly (the rig script's idle, walk, ..., and one per attack).
  for (const a of animations) clips[a.name] = a;
  for (const [slot, re] of Object.entries(CLIP_PATTERNS)) {
    const c = clips[slot] || animations.find((a) => re.test(a.name));
    if (c) clips[slot] = c;
  }
  // Single-clip files named in the manifest win for their slot.
  for (const [slot, clip] of Object.entries(extra)) if (clip) clips[slot] = clip;
  return clips;
}

export const Assets = {
  characters: new Map(),
  props: new Map(),
  loaded: [],

  async preload(onProgress, resolve = null) {
    if (resolve) resolveUrl = resolve;
    const available = await loadIndex();
    const jobs = [
      ...Object.entries(CHARACTERS).map(([id, e]) => () => this._loadCharacter(id, e, available)),
      ...Object.entries(PROPS)
        .filter(([, e]) => !e.lot)
        .map(([id, e]) => () => this._loadProp(id, e, available)),
    ];
    let done = 0;
    await Promise.all(jobs.map((j) => j().finally(() => onProgress?.(++done, jobs.length))));
    const missing = this.missingCharacters();
    if (missing.length) console.warn(`No generated model yet for: ${missing.join(', ')} (shown as blocks)`);
    return this.loaded;
  },

  hasCharacter(id) {
    return this.characters.has(id);
  },

  missingCharacters() {
    return Object.keys(CHARACTERS).filter((id) => !this.characters.has(id));
  },

  hasProp(id) {
    return this.props.has(id);
  },

  async _loadCharacter(id, entry, available) {
    const gltf = await load(entry.model, available);
    if (!gltf) return;
    const extra = {};
    // Clips saved as <id>-<clip>.glb (e.g. by `npm run zoodle -- pull`), plus
    // any the manifest names.
    const clipFiles = {};
    for (const slot of Object.keys(CLIP_PATTERNS)) clipFiles[slot] = `assets/models/${id}-${slot}.glb`;
    for (const [slot, url] of Object.entries({ ...clipFiles, ...(entry.animations || {}) })) {
      const a = await load(url, available);
      if (a?.animations.length) {
        extra[slot] = a.animations[0].clone();
        extra[slot].name = slot;
      }
    }
    const scene = gltf.scene;
    let skinned = false;
    let rig = null;
    scene.traverse((o) => {
      if (o.isSkinnedMesh) skinned = true;
      if (o.userData.rig) rig = o.userData.rig;
      // Generated materials come fully metallic (a metalness texture under a
      // factor of 1), which a torchlit cave with nothing to reflect renders
      // black. Creatures are skin, fur and cloth: matte.
      if (o.isMesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.metalnessMap = null;
          m.metalness = 0;
          m.roughnessMap = null;
          m.roughness = 0.9;
          m.needsUpdate = true;
        }
      }
    });
    const box = boundsOf(scene);
    const size = box.getSize(_v);
    const center = box.getCenter(_c);
    this.characters.set(id, {
      scene,
      skinned,
      rig,
      clips: sortClips(gltf.animations, extra),
      entry,
      unitScale: entry.height / Math.max(1e-3, size.y),
      offset: new THREE.Vector3(-center.x, -box.min.y, -center.z),
    });
    this.loaded.push(entry.model);
  },

  async _loadProp(id, entry, available) {
    const gltf = await load(entry.model, available);
    if (!gltf) return;
    const scene = gltf.scene;
    // Scenery is stone, bone and wood, and the weapons dull old iron: matte.
    {
      scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.metalnessMap = null;
          m.metalness = 0;
          // Their roughness maps are glossy for a studio: stone reads as wet metal.
          m.roughnessMap = null;
          m.roughness = 0.95;
          m.needsUpdate = true;
        }
      });
    }
    const holder = new THREE.Group();
    holder.add(scene);
    let box = boundsOf(holder);
    const size = box.getSize(_v);
    if (entry.weapon) {
      // Turn the longest axis upright, handle (the thinner end) down.
      if (size.x >= size.y && size.x >= size.z) scene.rotation.z = Math.PI / 2;
      else if (size.z >= size.y && size.z >= size.x) scene.rotation.x = -Math.PI / 2;
      box = boundsOf(holder);
      if (headIsDown(holder, box, entry.guard)) {
        scene.rotation.z += Math.PI;
        box = boundsOf(holder);
      }
    }
    const s = box.getSize(_v);
    const c = box.getCenter(_c);
    const unitScale = entry.size / Math.max(1e-3, s.y);
    // Weapons hang from the grip (a little above the bottom); props stand on 0.
    const base = entry.weapon ? box.min.y + s.y * 0.12 : box.min.y;
    this.props.set(id, { holder, entry, unitScale, offset: new THREE.Vector3(-c.x, -base, -c.z) });
    this.loaded.push(entry.model);
  },

  // A fresh, normalized copy of a character: { inner, model, clips, entry }.
  // `rootScale` is the scale the game will put on the parent (bosses), so the
  // final height still matches the manifest.
  instantiateCharacter(id, rootScale = 1) {
    const a = this.characters.get(id);
    if (!a) return missingCharacter(id, rootScale);
    const model = a.skinned ? cloneSkinned(a.scene) : a.scene.clone(true);
    model.position.copy(a.offset);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = !o.isSkinnedMesh;
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      // A boss sharing a creature's model is told apart by its colour.
      if (a.entry.tint) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.color.multiply(new THREE.Color(...a.entry.tint));
    });
    const inner = new THREE.Group();
    inner.add(model);
    inner.scale.setScalar(a.unitScale / rootScale);
    inner.rotation.y = a.entry.yaw || 0;
    return { inner, model, clips: a.clips, rig: a.rig, entry: a.entry, height: a.entry.height / rootScale, unit: a.unitScale / rootScale };
  },

  // A normalized copy of a prop. Materials are shared unless `own` is set.
  instanceProp(id, { own = false } = {}) {
    const p = this.props.get(id);
    if (!p) return null;
    const copy = p.holder.clone(true);
    if (own) {
      copy.traverse((o) => {
        if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      });
    }
    const g = new THREE.Group();
    copy.position.copy(p.offset);
    g.add(copy);
    g.scale.setScalar(p.unitScale);
    return g;
  },

  // One geometry + material for InstancedMesh use (cave rocks). Meshes are
  // baked into prop space and merged.
  propGeometry(id) {
    const p = this.props.get(id);
    if (!p) return null;
    if (p.merged) return p.merged;
    const holder = this.instanceProp(id);
    holder.updateMatrixWorld(true);
    const geos = [];
    let material = null;
    holder.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      geos.push(g.index ? g.toNonIndexed() : g);
      material ??= Array.isArray(o.material) ? o.material[0] : o.material;
    });
    if (!geos.length) return null;
    const geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos) || geos[0];
    p.merged = { geometry, material };
    return p.merged;
  },
};

// A creature without its generated model yet: a flat grey block of its size
// (segmented, so it still bends), never shipped.
const missingMat = new THREE.MeshStandardMaterial({ color: 0x5a4d57, roughness: 0.8, emissive: 0x000000 });
function missingCharacter(id, rootScale) {
  const entry = CHARACTERS[id];
  const H = entry.height;
  const geo = entry.body === 'beast' ? new THREE.BoxGeometry(0.4 * H, H, 1.5 * H, 1, 8, 4) : new THREE.BoxGeometry(0.45 * H, H, 0.3 * H, 1, 8, 1);
  geo.translate(0, H / 2, 0);
  const model = new THREE.Mesh(geo, missingMat.clone());
  model.name = `missing:${id}`;
  const inner = new THREE.Group();
  inner.add(model);
  inner.scale.setScalar(1 / rootScale);
  return { inner, model, clips: {}, entry, height: H / rootScale };
}

// Which end of an upright weapon is the head? An axe or a mace is widest at
// its head; a sword is widest at its cross-guard, which sits next to the grip,
// so its blade is the end farther from the widest point (`guard`).
function headIsDown(holder, box, guard) {
  const h = box.max.y - box.min.y;
  const bins = new Float32Array(20);
  const v = new THREE.Vector3();
  holder.updateMatrixWorld(true);
  holder.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const b = Math.min(19, Math.floor(((v.y - box.min.y) / h) * 20));
      bins[b] = Math.max(bins[b], Math.hypot(v.x, v.z));
    }
  });
  let widest = 0;
  for (let b = 1; b < 20; b++) if (bins[b] > bins[widest]) widest = b;
  const widestHigh = widest >= 10;
  return guard ? widestHigh : !widestHigh;
}
