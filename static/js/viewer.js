/* 3-D Minecraft structure viewer. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MC = window.MC;
const $ = (id) => document.getElementById(id);

const stage = $('stageWrap');
const canvas = $('viewport');
const viewerShell = $('viewerShell');
const viewerMain = $('viewerMain');

const FILE_URL = stage.dataset.fileUrl;
const FILE_NAME = stage.dataset.fileName || 'structure';
const FILE_SIZE = Number(stage.dataset.fileSize) || 0;
const ORIGIN_SIZE = (stage.dataset.originSize || '')
  .split(',')
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0);

const els = {
  loading: $('loadingOverlay'),
  loadingTitle: $('loadingTitle'),
  loadingText: $('loadingText'),
  loadBar: $('loadBar'),
  stepEngine: $('stepEngine'),
  stepFile: $('stepFile'),
  stepMesh: $('stepMesh'),
  error: $('errorOverlay'),
  errorText: $('errorText'),
  engineStatus: $('engineStatus'),
  engineStatusText: $('engineStatusText'),
  stageChip: $('stageChip'),
  stageChipText: $('stageChipText'),
  slice: $('sliceSlider'),
  sliceValue: $('sliceValue'),
  infoSize: $('infoSize'),
  infoOrigin: $('infoOrigin'),
  infoBlocks: $('infoBlocks'),
  infoPalette: $('infoPalette'),
  infoMesh: $('infoMesh'),
  infoRegions: $('infoRegions'),
  missingNote: $('missingNote'),
  missingText: $('missingText'),
  gridToggle: $('gridToggle'),
  rotateToggle: $('rotateToggle'),
  lodValue: $('lodValue'),
  qualityValue: $('qualityValue'),
  scaleBar: $('scaleBar'),
  scaleLine: $('scaleLine'),
  scaleText: $('scaleText'),
};

const IS_MOBILE = window.matchMedia('(max-width: 900px)').matches;

const state = {
  worker: null,
  workerReady: false,
  readyPromise: null,
  readyResolve: null,
  readyReject: null,
  seq: 0,
  hasFile: false,
  loading: false,
  lod: 1,
  quality: IS_MOBILE ? 'mid' : 'high',
  gridVisible: true,
  pendingFit: true,
  fitSize: 1,
  fitCenter: new THREE.Vector3(),
  sliceMax: 0,
  sliceOriginY: 0,
  sliceBusy: false,
  sliceQueued: null,
  sliceGroup: null,
  meshGroup: null,
  atlas: null,
  atlasT: null,
  texturesPromise: null,
  matOpaque: null,
  matTrans: null,
  matSliceOpaque: null,
  matSliceTrans: null,
  lastBounds: null,
  info: null,
};

let scene;
let camera;
let renderer;
let controls;
let sun;
let gridGroup;
let clipPlane;
let creepTimer = null;
let creepValue = 0;
let creepTarget = 0;
let frame = 0;
let needsRender = true;

/* Allow ?lod=1|2|4|8 for direct links to a lighter preview. */
const lodParam = Number(new URLSearchParams(location.search).get('lod'));
const autoLod = Number(stage.dataset.defaultLod) || 1;
let autoLodNotified = false;
if ([1, 2, 4, 8].includes(lodParam)) {
  state.lod = lodParam;
} else if ([1, 2, 4, 8].includes(autoLod)) {
  state.lod = autoLod;
}

/* ------------------------------------------------------------------ utils */
function setBar(pct) {
  creepValue = Math.max(creepValue, pct);
  if (els.loadBar) els.loadBar.style.width = Math.min(100, creepValue) + '%';
}

function startCreep(target) {
  creepTarget = target;
  clearInterval(creepTimer);
  creepTimer = setInterval(() => {
    if (creepValue >= creepTarget) return;
    setBar(Math.min(creepTarget, creepValue + 0.45));
  }, 420);
}

function stopCreep() {
  clearInterval(creepTimer);
  creepTimer = null;
}

function loadingStep(active) {
  const order = ['engine', 'file', 'mesh'];
  const index = order.indexOf(active);
  order.forEach((name, i) => {
    const el = els['step' + name.charAt(0).toUpperCase() + name.slice(1)];
    if (!el) return;
    el.classList.toggle('active', i === index);
    el.classList.toggle('done', i < index);
  });
}

function showLoading(title, text, pct) {
  if (els.loading) els.loading.classList.remove('hidden');
  if (els.error) els.error.hidden = true;
  if (els.loadingTitle) els.loadingTitle.textContent = title;
  if (els.loadingText) els.loadingText.textContent = text;
  if (typeof pct === 'number') setBar(pct);
  state.loading = true;
  setEngineStatus('处理中', 'busy');
}

function hideLoading() {
  state.loading = false;
  stopCreep();
  if (els.loading) els.loading.classList.add('hidden');
}

function showError(message) {
  state.loading = false;
  stopCreep();
  if (els.loading) els.loading.classList.add('hidden');
  if (els.error) els.error.hidden = false;
  if (els.errorText) els.errorText.textContent = message || '文件可能已损坏，或使用了不受支持的格式。';
  setEngineStatus('解析失败', 'error');
  if (els.stageChipText) els.stageChipText.textContent = '解析失败';
}

function setEngineStatus(text, kind) {
  if (!els.engineStatus) return;
  els.engineStatus.className = 'engine-status' + (kind ? ' ' + kind : '');
  if (els.engineStatusText) els.engineStatusText.textContent = text;
}

function prettyBlockName(name) {
  return String(name || '')
    .replace(/^minecraft:/, '')
    .replace(/\[.*$/, '')
    .replace(/_/g, ' ');
}

function formatCount(n) {
  n = Number(n) || 0;
  if (n < 10000) return n.toLocaleString('zh-CN');
  if (n < 100000000) return (n / 10000).toFixed(n < 100000 ? 1 : 0) + ' 万';
  return (n / 100000000).toFixed(1) + ' 亿';
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/* ------------------------------------------------------------------ scene */
function initScene() {
  scene = new THREE.Scene();
  const bg = cssColor('--stage-bg', '#e7edf6');
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 1000, 4000);

  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 8000);
  camera.rotation.order = 'YXZ';

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.autoRotateSpeed = 1.1;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.minDistance = 0.5;
  controls.maxDistance = 20000;
  controls.target.set(0, 0, 0);
  controls.addEventListener('change', () => { needsRender = true; });

  try {
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: !IS_MOBILE,
      powerPreference: 'high-performance'
    });
  } catch (err) {
    showError('浏览器无法创建 WebGL 上下文，请开启硬件加速后重试。');
    throw err;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = !IS_MOBILE;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), Infinity);

  scene.add(new THREE.AmbientLight(0xffffff, 0.42));
  scene.add(new THREE.HemisphereLight(0xfff5e8, 0x817a95, 0.85));
  sun = new THREE.DirectionalLight(0xfff0d8, 1.95);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  gridGroup = new THREE.Group();
  scene.add(gridGroup);

  setQuality(state.quality, false);

  const resize = () => {
    if (!renderer) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    needsRender = true;
  };
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();
}

function fitLights() {
  if (!sun || !state.lastBounds) return;
  const center = state.fitCenter;
  const size = Math.max(state.fitSize, 1);
  sun.position.set(
    center.x + size * 0.95,
    center.y + size * 1.35,
    center.z + size * 0.8
  );
  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();
  const cam = sun.shadow.camera;
  cam.left = -size * 0.95;
  cam.right = size * 0.95;
  cam.top = size * 0.95;
  cam.bottom = -size * 0.95;
  cam.near = Math.max(0.05, size * 0.05);
  cam.far = size * 4.5;
  cam.updateProjectionMatrix();
  sun.shadow.mapSize.set(size > 160 ? 2048 : 1024, size > 160 ? 2048 : 1024);
  scene.fog.near = size * 2.8;
  scene.fog.far = size * 7.5;
  renderer.shadowMap.needsUpdate = true;
}

function fitCamera() {
  if (!state.hasFile && !state.info) return;
  const center = state.fitCenter;
  const size = Math.max(state.fitSize, 1);
  // Portrait phones have a much narrower horizontal field of view. Pull the
  // camera back so the whole structure is visible instead of filling/clipping.
  const aspect = Math.max(0.35, camera.aspect || 1);
  const distanceScale = aspect < 1 ? Math.min(2.4, 1 / aspect) : 1;
  const fit = size * distanceScale;
  camera.position.set(
    center.x + fit * 0.95,
    center.y + fit * 0.72,
    center.z + fit * 1.05
  );
  camera.near = Math.max(0.01, size * 0.0015);
  camera.far = Math.max(200, size * 90);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = Math.max(0.5, size * 0.02);
  controls.maxDistance = Math.max(50, size * 20);
  controls.update();
  renderer.shadowMap.needsUpdate = true;
  needsRender = true;
}

function rebuildGrid(mn, mx) {
  if (!gridGroup) return;
  while (gridGroup.children.length) {
    const child = gridGroup.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
  const center = new THREE.Vector3(
    (mn.x + mx.x) / 2,
    mn.y,
    (mn.z + mx.z) / 2
  );
  const span = Math.max(mx.x - mn.x, mx.z - mn.z, 16);
  const gridSize = Math.min(4000, Math.max(64, Math.ceil((span * 1.5) / 16) * 16));
  const divisions = Math.min(250, Math.max(4, Math.round(gridSize / 16)));
  const grid = new THREE.GridHelper(
    gridSize,
    divisions,
    new THREE.Color(cssColor('--stage-grid-strong', '#71819c')),
    new THREE.Color(cssColor('--stage-grid', '#9aa7bd'))
  );
  grid.material.transparent = true;
  grid.material.opacity = 0.38;
  grid.material.depthWrite = false;
  grid.position.set(center.x, mn.y - 0.02, center.z);
  grid.visible = state.gridVisible;
  gridGroup.add(grid);

  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(gridSize * 1.7, gridSize * 1.7),
    new THREE.ShadowMaterial({ opacity: 0.16, color: 0x16121c })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.set(center.x, mn.y - 0.035, center.z);
  shadowPlane.receiveShadow = true;
  shadowPlane.visible = state.gridVisible;
  shadowPlane.userData.isGround = true;
  gridGroup.add(shadowPlane);
  gridGroup.visible = state.gridVisible;
}

function updateStageChip() {
  if (!els.stageChipText) return;
  const tris = state.info ? Math.round(state.info.ic / 3) : 0;
  els.stageChipText.textContent =
    '就绪 · ' + formatCount(tris) + ' 三角面 · LOD ×' + state.lod;
}

/* --------------------------------------------------------------- textures */
function loadTexture(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const texture = new THREE.Texture(img);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      resolve(texture);
    };
    img.onerror = () => reject(new Error('材质图集加载失败：' + url));
    img.src = url;
  });
}

function ensureTextures() {
  if (state.texturesPromise) return state.texturesPromise;
  state.texturesPromise = Promise.all([
    loadTexture('/static/gen/atlas.png'),
    loadTexture('/static/gen/atlas_t.png')
  ]).then(([atlas, atlasT]) => {
    state.atlas = atlas;
    state.atlasT = atlasT;
    state.matOpaque = new THREE.MeshLambertMaterial({
      map: atlas,
      vertexColors: true,
      side: THREE.FrontSide,
      transparent: false,
      alphaTest: 0.5,
      depthWrite: true,
      clippingPlanes: [clipPlane],
      clipShadows: true
    });
    state.matOpaque.userData.shared = true;
    state.matTrans = new THREE.MeshLambertMaterial({
      map: atlasT,
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      clippingPlanes: [clipPlane],
      clipShadows: true
    });
    state.matTrans.userData.shared = true;
    state.matSliceOpaque = new THREE.MeshLambertMaterial({
      map: atlas,
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: false,
      alphaTest: 0.5,
      depthWrite: true
    });
    state.matSliceOpaque.userData.shared = true;
    state.matSliceTrans = new THREE.MeshLambertMaterial({
      map: atlasT,
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false
    });
    state.matSliceTrans.userData.shared = true;
    return [atlas, atlasT];
  }).catch((err) => {
    state.texturesPromise = null;
    throw err;
  });
  return state.texturesPromise;
}

/* --------------------------------------------------------------- geometry */
function bakedGeometry(part) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
  if (part.rgb && part.rgb.length) {
    geometry.setAttribute('color', new THREE.BufferAttribute(part.rgb, 3));
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(part.nrm, 3));
  geometry.setIndex(new THREE.BufferAttribute(part.idx, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function disposeGroup(group) {
  if (!group) return;
  scene.remove(group);
  group.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (object.material && !object.material.userData.shared) object.material.dispose();
  });
}

function buildBakedMeshes(data) {
  disposeGroup(state.meshGroup);
  state.meshGroup = new THREE.Group();
  scene.add(state.meshGroup);
  if (data.opaque && data.opaque.vc > 0) {
    const mesh = new THREE.Mesh(bakedGeometry(data.opaque), state.matOpaque);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    state.meshGroup.add(mesh);
  }
  if (data.trans && data.trans.vc > 0) {
    const mesh = new THREE.Mesh(bakedGeometry(data.trans), state.matTrans);
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    state.meshGroup.add(mesh);
  }
}

const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1]
];

function isTransparentBlock(name) {
  return /(water|glass|leaves|ice|lava|slime|honey|vine|flowing|kelp|seagrass)/i.test(name);
}

function paletteColor(name, rgb) {
  let color = new THREE.Color(rgb[0] || 0.7, rgb[1] || 0.7, rgb[2] || 0.7);
  if (/leaves|vine/.test(name)) color = new THREE.Color(0.34, 0.68, 0.3);
  else if (/grass_block/.test(name)) color = new THREE.Color(0.45, 0.72, 0.32);
  return color;
}

function buildPaletteMeshes(data) {
  disposeGroup(state.meshGroup);
  state.meshGroup = new THREE.Group();
  scene.add(state.meshGroup);
  const pos = data.pos;
  const uv = data.uv;
  const merged = data.merged || [];
  const names = data.names || [];
  const palRgb = data.palRgb || [];

  for (const entry of merged) {
    const materialIndex = entry[0];
    const face = entry[1];
    const indices = entry[2];
    if (!indices || indices.length === 0) continue;
    const remap = new Map();
    const positions = [];
    const uvs = [];
    const normals = [];
    const outIndices = [];
    const normal = FACE_NORMALS[face] || FACE_NORMALS[2];
    for (let i = 0; i < indices.length; i++) {
      const old = indices[i];
      if (!remap.has(old)) {
        remap.set(old, positions.length / 3);
        positions.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
        uvs.push(uv[old * 2], uv[old * 2 + 1]);
        normals.push(normal[0], normal[1], normal[2]);
      }
      outIndices.push(remap.get(old));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(outIndices);
    geometry.computeBoundingSphere();

    const name = names[materialIndex] || '';
    const color = paletteColor(name, [
      palRgb[materialIndex * 3],
      palRgb[materialIndex * 3 + 1],
      palRgb[materialIndex * 3 + 2]
    ]);
    const transparent = isTransparentBlock(name);
    const material = new THREE.MeshLambertMaterial({
      color: color,
      side: THREE.DoubleSide,
      transparent: transparent,
      opacity: transparent ? (/leaves/.test(name) ? 0.92 : 0.68) : 1,
      depthWrite: !transparent,
      clippingPlanes: [clipPlane],
      clipShadows: true
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = !transparent;
    mesh.receiveShadow = true;
    state.meshGroup.add(mesh);
  }
}

/* ---------------------------------------------------------------- slicing */
function removeSlice() {
  needsRender = true;
  if (state.sliceGroup) {
    disposeGroup(state.sliceGroup);
    state.sliceGroup = null;
    renderer.shadowMap.needsUpdate = true;
  }
}

function buildSlice(data) {
  removeSlice();
  if (!data) return;
  if (!data.bake) {
    if (!data.vc || !data.ic) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.col, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.idx, 1));
    geometry.computeVertexNormals();
    const group = new THREE.Group();
    group.position.y = -0.02;
    group.add(new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    ));
    scene.add(group);
    state.sliceGroup = group;
    renderer.shadowMap.needsUpdate = true;
    return;
  }
  if ((!data.opaque || data.opaque.vc <= 0) && (!data.trans || data.trans.vc <= 0)) {
    return;
  }
  if (!state.matSliceOpaque || !state.matSliceTrans) return;
  const group = new THREE.Group();
  group.position.y = -0.02;
  if (data.opaque && data.opaque.vc > 0) {
    group.add(new THREE.Mesh(bakedGeometry(data.opaque), state.matSliceOpaque));
  }
  if (data.trans && data.trans.vc > 0) {
    const mesh = new THREE.Mesh(bakedGeometry(data.trans), state.matSliceTrans);
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  scene.add(group);
  state.sliceGroup = group;
  renderer.shadowMap.needsUpdate = true;
  needsRender = true;
}

function updateSliceFill() {
  if (!els.slice) return;
  const max = Math.max(1, Number(els.slice.max) || 1);
  const level = Number(els.slice.value) || 0;
  els.slice.style.setProperty('--fill', (level / max) * 100 + '%');
}

function applySlice() {
  if (!els.slice || !state.hasFile) return;
  const max = Number(els.slice.max) || 0;
  const level = Math.min(Number(els.slice.value) || 0, max);
  updateSliceFill();
  if (level >= max || max <= 0) {
    clipPlane.constant = Infinity;
    if (els.sliceValue) els.sliceValue.textContent = '完整';
    removeSlice();
    state.sliceQueued = null;
    return;
  }
  clipPlane.constant = level - 0.01;
  needsRender = true;
  if (els.sliceValue) {
    els.sliceValue.textContent = 'Y = ' + (state.sliceOriginY + level * state.lod);
  }
  requestSlice(level);
  renderer.shadowMap.needsUpdate = true;
}

function requestSlice(level) {
  if (!state.hasFile || !state.workerReady) return;
  if (level <= 0 || level >= state.sliceMax) {
    removeSlice();
    return;
  }
  if (state.sliceBusy) {
    state.sliceQueued = level;
    return;
  }
  state.sliceBusy = true;
  state.worker.postMessage({ type: 'slice', level: level });
}

function onSliceMessage(data) {
  state.sliceBusy = false;
  const current = Number(els.slice.value) || 0;
  if (data.level !== current) {
    state.sliceQueued = null;
    if (current > 0 && current < state.sliceMax) requestSlice(current);
    return;
  }
  buildSlice(data);
  if (state.sliceQueued !== null && state.sliceQueued !== current) {
    const queued = state.sliceQueued;
    state.sliceQueued = null;
    requestSlice(queued);
  }
}

/* ------------------------------------------------------------------- load */
function setLoadingStep(name) {
  const map = { engine: 'engine', file: 'file', mesh: 'mesh' };
  loadingStep(map[name]);
}

function waitForWorker() {
  if (state.workerReady) return Promise.resolve();
  if (!state.readyPromise) {
    state.readyPromise = new Promise((resolve, reject) => {
      state.readyResolve = resolve;
      state.readyReject = reject;
      setTimeout(() => {
        if (!state.workerReady) reject(new Error('解析引擎加载超时，请刷新页面重试。'));
      }, 90000);
    });
  }
  return state.readyPromise;
}

function initWorker() {
  if (!window.Worker) {
    showError('当前浏览器不支持 Web Worker，无法解析结构文件。');
    return;
  }
  const worker = new Worker('/static/js/sv-worker.js');
  state.worker = worker;
  worker.onmessage = onWorkerMessage;
  worker.onerror = (event) => {
    const message = event && event.message ? event.message : '解析线程异常';
    if (!state.workerReady && state.readyReject) state.readyReject(new Error(message));
    worker.terminate();
    showError('解析线程异常：' + message);
  };
}

async function fetchFile() {
  let response;
  try {
    response = await fetch(FILE_URL, { credentials: 'same-origin', cache: 'no-store' });
  } catch (err) {
    throw new Error('无法读取文件，请检查网络连接。');
  }
  if (!response.ok) {
    throw new Error('无法读取文件（HTTP ' + response.status + '）。');
  }
  const total = Number(response.headers.get('content-length')) || FILE_SIZE || 0;
  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        setBar(10 + Math.min(1, received / total) * 22);
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  return new Uint8Array(await response.arrayBuffer());
}

function startParse(bytes, reuse) {
  state.seq += 1;
  const seq = state.seq;
  state.loading = true;
  state.hasFile = false;
  if (!reuse) state.pendingFit = true;
  removeSlice();
  clipPlane.constant = Infinity;
  if (els.slice) {
    els.slice.disabled = true;
    els.slice.value = els.slice.max;
  }
  if (els.sliceValue) els.sliceValue.textContent = '完整';
  showLoading(
    reuse ? '正在重建网格' : '正在加载解析资源',
    reuse ? '使用 LOD ×' + state.lod + ' 重新生成几何…' : '首次加载需载入压缩后的解析核心与材质（约 1.5 MB），请稍候…',
    reuse ? 62 : 34
  );
  setLoadingStep('mesh');
  startCreep(reuse ? 88 : 82);
  const payload = {
    type: 'load',
    name: FILE_NAME,
    bytes: reuse ? null : bytes,
    lod: state.lod,
    reuse: !!reuse,
    tex: 1,
    chk: 0,
    seq: seq
  };
  if (reuse) {
    state.worker.postMessage(payload);
  } else {
    state.worker.postMessage(payload, [bytes.buffer]);
  }
}

async function boot() {
  setLoadingStep('engine');
  showLoading('正在加载 3D 引擎', '载入解析核心与材质图集…', 6);
  state.readyPromise = new Promise((resolve, reject) => {
    state.readyResolve = resolve;
    state.readyReject = reject;
  });
  setTimeout(() => {
    if (!state.workerReady && state.readyReject) {
      state.readyReject(new Error('解析引擎加载超时，请刷新页面重试。'));
    }
  }, 90000);
  ensureTextures().catch(() => { /* reported later if baked geometry is used */ });

  try {
    const bytesPromise = fetchFile();
    await waitForWorker();
    setLoadingStep('file');
    showLoading('正在读取结构文件', '载入 ' + FILE_NAME, 26);
    const bytes = await bytesPromise;
    setBar(30);
    startParse(bytes, false);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

async function onGeometry(data) {
  if (data.seq !== state.seq) return;
  stopCreep();
  setBar(93);
  if (!data.vc || !data.ic) {
    showError('结构为空，或当前 LOD 下没有可渲染的方块。请尝试更低的 LOD。');
    return;
  }
  try {
    if (data.bake) {
      showLoading('正在应用材质', '加载方块材质图集…', 95);
      await ensureTextures();
    }
    if (data.bake) buildBakedMeshes(data);
    else buildPaletteMeshes(data);

    state.info = data;
    const info6 = data.info6 || [0, 0, 0, 0, 0, 0];
    const mn = new THREE.Vector3(data.mn[0], data.mn[1], data.mn[2]);
    const mx = new THREE.Vector3(data.mx[0], data.mx[1], data.mx[2]);
    state.lastBounds = { mn: mn, mx: mx };
    state.fitSize = Math.max(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z, 1);
    state.fitCenter.set((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, (mn.z + mx.z) / 2);
    state.hasFile = true;

    updateInfo(data);
    setupSlice(data, info6, mx, mn);
    rebuildGrid(mn, mx);
    fitLights();
    if (state.pendingFit) {
      fitCamera();
      state.pendingFit = false;
    }
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    needsRender = false;
    updateStageChip();
    setEngineStatus('就绪 · LOD ×' + state.lod, 'ready');
    setBar(100);
    hideLoading();
    updateScale();
    if (state.lod > 1 && !autoLodNotified && !lodParam) {
      autoLodNotified = true;
      if (window.MC) {
        window.MC.snack(
          '大型结构已自动使用 LOD ×' + state.lod + '，可在右侧切换清晰度。',
          '',
          6500
        );
      }
    }
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

function setupSlice(data, info6, mx, mn) {
  state.sliceMax = Math.max(0, Math.round(mx.y - mn.y));
  state.sliceOriginY = info6 && info6.length > 1 ? info6[1] : Math.round(mn.y);
  if (!els.slice) return;
  els.slice.min = '0';
  els.slice.max = String(Math.max(1, state.sliceMax));
  els.slice.value = String(Math.max(1, state.sliceMax));
  els.slice.disabled = state.sliceMax <= 0;
  els.slice.style.setProperty('--fill', '100%');
  if (els.sliceValue) els.sliceValue.textContent = '完整';
  clipPlane.constant = Infinity;
  removeSlice();
  state.sliceBusy = false;
  state.sliceQueued = null;
}

function updateInfo(data) {
  const info6 = data.info6 || [0, 0, 0, 0, 0, 0];
  const dims = ORIGIN_SIZE.length === 3 ? ORIGIN_SIZE : [info6[3], info6[4], info6[5]];
  if (els.infoSize) {
    els.infoSize.textContent = dims.join(' × ');
    els.infoSize.title = state.lod > 1 ? '原始结构尺寸（当前 LOD ×' + state.lod + '）' : '结构尺寸';
  }
  if (els.infoOrigin) els.infoOrigin.textContent = info6[0] + ', ' + info6[1] + ', ' + info6[2];
  if (els.infoBlocks) {
    els.infoBlocks.textContent = formatCount(data.blocksNonair) + ' / ' + formatCount(data.blocksTotal);
  }
  if (els.infoPalette) els.infoPalette.textContent = (data.paletteSize || 0) + ' 种';
  if (els.infoMesh) els.infoMesh.textContent = formatCount(Math.round(data.ic / 3));
  if (els.infoRegions) {
    els.infoRegions.textContent = data.regions > 1 ? data.regions + '（仅第 1 个）' : String(data.regions || 1);
  }
  if (data.missingKeys && data.missingKeys.length) {
    const total = data.missingKeys.reduce((sum, item) => sum + (item.count || 0), 0);
    if (els.missingNote) {
      els.missingNote.hidden = false;
      if (els.missingText) {
        const names = data.missingKeys.slice(0, 3).map((item) => prettyBlockName(item.name)).join('、');
        els.missingText.textContent =
          data.missingKeys.length + ' 种方块缺少材质（' + formatCount(total) + ' 个），已忽略：' + names +
          (data.missingKeys.length > 3 ? ' 等' : '');
      }
    }
  }
  if (els.lodValue) els.lodValue.textContent = '×' + state.lod;
}

/* -------------------------------------------------------------- worker IO */
function onWorkerMessage(event) {
  const data = event.data || {};
  if (data.type === 'ready') {
    state.workerReady = true;
    if (state.readyResolve) state.readyResolve();
    setEngineStatus('解析核心就绪', 'ready');
    return;
  }
  if (data.type === 'progress') {
    if (data.stage === 'parse') {
      showLoading('正在加载解析资源', '首次加载需载入压缩后的解析核心与材质（约 1.5 MB），请稍候…', 46);
      setLoadingStep('mesh');
      startCreep(78);
    } else if (data.stage === 'geometry') {
      showLoading('正在生成网格', '构建可见方块面与材质坐标…', 84);
      setLoadingStep('mesh');
      startCreep(91);
    }
    return;
  }
  if (data.type === 'geometry') {
    if (data.seq !== undefined && data.seq !== state.seq) return;
    onGeometry(data);
    return;
  }
  if (data.type === 'slice') {
    onSliceMessage(data);
    return;
  }
  if (data.type === 'error') {
    if (data.seq !== undefined && data.seq !== state.seq) return;
    const messages = {
      '-2': '文件过大，超出可渲染的方块上限。请尝试降低 LOD 或在游戏内裁剪结构。',
      '-3': '裁剪失败：文件名中的坐标范围与该世界不匹配。'
    };
    showError(data.message || messages[String(data.code)] || '文件格式不受支持，或文件已损坏。');
    return;
  }
  if (data.type === 'worker-error') {
    showError(data.message || '解析线程发生错误，请刷新页面重试。');
  }
}

/* --------------------------------------------------------------------- UI */
function setQuality(quality, update) {
  state.quality = quality;
  if (update !== false) {
    const ratio = quality === 'high'
      ? Math.min(window.devicePixelRatio || 1, 2)
      : (quality === 'mid' ? 1.25 : 1);
    renderer.setPixelRatio(ratio);
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    renderer.setSize(width, height, false);
    needsRender = true;
  }
  document.querySelectorAll('[data-quality]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.quality === quality);
  });
  if (els.qualityValue) {
    els.qualityValue.textContent = quality === 'high' ? '高' : (quality === 'mid' ? '中' : '低');
  }
}

function setLod(lod) {
  if (lod === state.lod) return;
  state.lod = lod;
  document.querySelectorAll('[data-lod]').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.lod) === lod);
  });
  if (els.lodValue) els.lodValue.textContent = '×' + lod;
  if (!state.hasFile || !state.workerReady) return;
  state.pendingFit = false;
  startParse(null, true);
}

function toggleGrid(force) {
  state.gridVisible = typeof force === 'boolean' ? force : !state.gridVisible;
  needsRender = true;
  if (gridGroup) gridGroup.visible = state.gridVisible;
  if (els.gridToggle) els.gridToggle.checked = state.gridVisible;
  const btn = document.querySelector('.stage-tool[data-action="toggle-grid"]');
  if (btn) btn.classList.toggle('active', state.gridVisible);
}

function togglePanel(force) {
  const mobile = window.matchMedia('(max-width: 1100px)').matches;
  let open;
  if (mobile) {
    open = typeof force === 'boolean' ? force : !viewerMain.classList.contains('sheet-open');
    viewerMain.classList.toggle('sheet-open', open);
  } else {
    open = typeof force === 'boolean' ? force : viewerMain.classList.contains('panel-collapsed');
    viewerMain.classList.toggle('panel-collapsed', !open);
  }
  document.querySelectorAll('[data-action="toggle-panel"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  setTimeout(updateScale, 260);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (viewerShell.classList.contains('pseudo-fullscreen')) {
      viewerShell.classList.remove('pseudo-fullscreen');
      syncFullscreenUI();
    } else if (viewerShell.requestFullscreen) {
      await viewerShell.requestFullscreen();
    } else {
      viewerShell.classList.add('pseudo-fullscreen');
      syncFullscreenUI();
    }
  } catch (err) {
    viewerShell.classList.toggle('pseudo-fullscreen');
    syncFullscreenUI();
  }
}

function syncFullscreenUI() {
  const on = Boolean(document.fullscreenElement) || viewerShell.classList.contains('pseudo-fullscreen');
  document.querySelectorAll('[data-action="fullscreen"]').forEach((btn) => {
    btn.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#i-' +
      (on ? 'fullscreen-exit' : 'fullscreen') +
      '"></use></svg>';
    btn.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    btn.setAttribute('title', on ? '退出全屏 (F)' : '全屏 (F)');
  });
  setTimeout(updateScale, 80);
}

function updateScale() {
  if (!state.hasFile || !els.scaleBar) {
    if (els.scaleBar) els.scaleBar.hidden = true;
    return;
  }
  const height = stage.clientHeight || 1;
  const distance = camera.position.distanceTo(controls.target);
  const worldPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let chosen = candidates[candidates.length - 1];
  for (const value of candidates) {
    if (value / worldPerPixel >= 56) { chosen = value; break; }
  }
  const pixels = Math.max(24, Math.round(chosen / worldPerPixel));
  els.scaleLine.style.width = pixels + 'px';
  els.scaleText.textContent = chosen * state.lod + ' 方块';
  els.scaleBar.hidden = false;
}

function wireUI() {
  document.querySelectorAll('[data-lod]').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.lod) === state.lod);
  });
  if (els.lodValue) els.lodValue.textContent = '×' + state.lod;
  const lodHint = document.getElementById('lodHint');
  if (lodHint && lodParam) {
    lodHint.textContent = '结构过大时提高 LOD 可降低细节、提升流畅度。';
  }
  const gridTool = document.querySelector('.stage-tool[data-action="toggle-grid"]');
  if (gridTool) gridTool.classList.add('active');

  document.querySelectorAll('[data-action="reset"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.hasFile) fitCamera();
    });
  });
  document.querySelectorAll('[data-action="fullscreen"]').forEach((btn) => {
    btn.addEventListener('click', toggleFullscreen);
  });
  document.querySelectorAll('[data-action="toggle-panel"]').forEach((btn) => {
    btn.addEventListener('click', () => togglePanel());
  });
  document.querySelectorAll('[data-action="toggle-grid"]').forEach((btn) => {
    btn.addEventListener('click', () => toggleGrid());
  });
  document.querySelectorAll('[data-action="retry"]').forEach((btn) => {
    btn.addEventListener('click', () => location.reload());
  });
  document.querySelectorAll('[data-lod]').forEach((btn) => {
    btn.addEventListener('click', () => setLod(Number(btn.dataset.lod)));
  });
  document.querySelectorAll('[data-quality]').forEach((btn) => {
    btn.addEventListener('click', () => setQuality(btn.dataset.quality, true));
  });
  if (els.gridToggle) {
    els.gridToggle.addEventListener('change', () => toggleGrid(els.gridToggle.checked));
  }
  if (els.rotateToggle) {
    els.rotateToggle.addEventListener('change', () => {
      controls.autoRotate = els.rotateToggle.checked;
    });
  }
  if (els.slice) {
    els.slice.addEventListener('input', applySlice);
  }
  document.addEventListener('fullscreenchange', syncFullscreenUI);

  window.addEventListener('keydown', (event) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'r') { if (state.hasFile) fitCamera(); }
    else if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
    else if (key === 'g') { toggleGrid(); }
    else if (['1', '2', '4', '8'].includes(key)) { setLod(Number(key)); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Control') controls.enableZoom = false;
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Control') controls.enableZoom = true;
  });
  window.addEventListener('blur', () => { controls.enableZoom = true; });

  stage.addEventListener('wheel', (event) => {
    if (!event.ctrlKey || !state.hasFile || state.loading) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const direction = event.deltaY < 0 ? 1 : -1;
    const next = Math.max(0, Math.min(state.sliceMax, (Number(els.slice.value) || 0) + direction));
    if (next !== Number(els.slice.value)) {
      els.slice.value = String(next);
      applySlice();
    }
  }, { passive: false, capture: true });

  window.addEventListener('mccloud:themechange', () => {
    const bg = cssColor('--stage-bg', '#e7edf6');
    scene.background.set(bg);
    scene.fog.color.set(bg);
    renderer.toneMappingExposure = document.documentElement.dataset.theme === 'dark' ? 1.3 : 1.15;
    if (state.lastBounds) rebuildGrid(state.lastBounds.mn, state.lastBounds.mx);
    renderer.shadowMap.needsUpdate = true;
    needsRender = true;
  });

  const mobile = window.matchMedia('(max-width: 1100px)');
  document.querySelectorAll('[data-action="toggle-panel"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', mobile.matches ? 'false' : 'true');
  });
  mobile.addEventListener('change', () => {
    viewerMain.classList.remove('sheet-open');
    viewerMain.classList.remove('panel-collapsed');
  });
}

function animate() {
  requestAnimationFrame(animate);
  if (!renderer) return;
  const controlsChanged = controls.update();
  if (needsRender || controlsChanged || controls.autoRotate) {
    renderer.render(scene, camera);
    needsRender = false;
    frame += 1;
    if (frame % 20 === 0) updateScale();
  }
}

function init() {
  initScene();
  wireUI();
  setQuality(state.quality, true);
  initWorker();
  boot();
  animate();
}

try {
  init();
} catch (err) {
  console.error(err);
  showError(err && err.message ? err.message : '3D 视图初始化失败。');
}
