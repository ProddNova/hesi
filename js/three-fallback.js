const SOURCES = [
  'https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js',
  'https://unpkg.com/three@0.166.1/build/three.module.js',
  'https://esm.sh/three@0.166.1',
];

async function loadThree([source, ...rest]) {
  if (!source) throw new Error('Unable to load Three.js from any configured CDN');
  return import(source).catch((error) => {
    console.warn(`Three.js failed to load from ${source}`, error);
    return loadThree(rest);
  });
}

const THREE = await loadThree(SOURCES);

export const {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Clock,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Fog,
  FogExp2,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SRGBColorSpace,
  Scene,
  SpotLight,
  TorusGeometry,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  Vector3,
  WebGLRenderer,
} = THREE;

export default THREE;
