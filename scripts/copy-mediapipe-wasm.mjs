import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(resolve(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'),
);
if (packageJson.version !== '1.2.3') throw new Error(`Unexpected tasks-vision version: ${packageJson.version}`);

const source = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const mediapipeDir = resolve(root, 'public/mediapipe');
for (const entry of await readdir(mediapipeDir)) {
  if (entry === 'wasm' || entry.startsWith('wasm-'))
    await rm(resolve(mediapipeDir, entry), { recursive: true, force: true });
}
const destination = resolve(mediapipeDir, `wasm-${packageJson.version}`);
await mkdir(destination, { recursive: true });
const files = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];
for (const file of files) await copyFile(resolve(source, file), resolve(destination, file));

const modelsDir = resolve(mediapipeDir, 'models');
const checksums = new Map(
  (await readFile(resolve(modelsDir, 'SHA256SUMS'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [digest, file] = line.trim().split(/\s+/);
      return [file, digest];
    }),
);
const models = [
  { prefix: 'pose_landmarker_lite', constant: 'POSE_MODEL_SHA8' },
  { prefix: 'pose_landmarker_full', constant: 'POSE_FULL_MODEL_SHA8' },
  { prefix: 'hand_landmarker', constant: 'HAND_MODEL_SHA8' },
];
const verifiedModels = [];
for (const { prefix, constant } of models) {
  const modelFile = (await readdir(modelsDir)).find((name) => name.startsWith(`${prefix}.`) && name.endsWith('.task'));
  if (!modelFile) throw new Error(`${prefix} model not found in public/mediapipe/models/`);
  const digest = createHash('sha256')
    .update(await readFile(resolve(modelsDir, modelFile)))
    .digest('hex');
  const expected = checksums.get(modelFile);
  if (digest !== expected) throw new Error(`${prefix} model checksum mismatch. Expected ${expected}, got ${digest}`);
  const sha8 = digest.slice(0, 8);
  const expectedName = `${prefix}.${sha8}.task`;
  if (modelFile !== expectedName) throw new Error(`${prefix} model must be named ${expectedName} (found ${modelFile})`);
  verifiedModels.push([constant, sha8]);
}

const assetsSource = await readFile(resolve(root, 'src/cv/mediapipeAssets.ts'), 'utf8');
for (const [name, value] of [['MEDIAPIPE_WASM_VERSION', packageJson.version], ...verifiedModels]) {
  if (!assetsSource.includes(`${name} = '${value}'`))
    throw new Error(`src/cv/mediapipeAssets.ts is out of sync: expected ${name} = '${value}'`);
}
console.log(
  `MediaPipe ${packageJson.version}: module WASM copied to wasm-${packageJson.version}/; ${models.map(({ prefix }) => prefix).join(' and ')} models verified.`,
);
