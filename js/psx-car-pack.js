import * as THREE from 'three';

const PACK_ROOT='../3d/PSXStyleCars-DevEdition';
const PAINT_COLORS=[
  0xb43f38,0xd6ad3d,0x596064,0x2f4a5f,0x30a78f,0xd4d1c8,
  0x463f5b,0x222529,0xa7b7bd,0x2d6a78,0x8e2f29,0xe9e2cf,
];
const WHEEL_FILES=[
  'sportWheel.obj','TunerWheel.obj','RallyWheelVer2.obj',
  'retroSportWheel.obj','AluWheel.obj','luxurySportWheel.obj',
  'StylishWheel.obj','RallyWheels.obj','luxuryWheel.obj',
  'RoyalSportCarLimitedEditionWheel.obj','TuningWheel.obj',
];
const RAW_MODELS=[
  ['AmericanEagle','AmericanEagle','AmericanEagle'],
  ['AmericanMuscle','AmericanMuscle','AmericanMuscle'],
  ['AmericanSportSedan','AmericanSportSedan','AmericanSportSedan'],
  ['AmericanSuperSedan','AmericanSuperSedan','AmericanSuperSedan'],
  ['AutobahnRacer','AutobahnRacer','autobahnRacer'],
  ['CuteMonster','CuteMonster','CuteMonster'],
  ['ElectricHyperCar','ElectricHyperCar','ElectricHypercar'],
  ['EnglishLightSportcar','EnglishLightSportcar','EnglishLightSportcar'],
  ['GermanBandit','GermanBandit','GermanBandit'],
  ['GermanHypercar','GermanHypercar','GermanHypercar'],
  ['GermanOldBandit','GermanOldBandit','GermanOldBandit'],
  ['GermanRetroHypercar','GermanRetroHypercar','GermanRetroHypercar'],
  ['GermanRetroSportCar','GermanRetroSportCar','GermanRetroSportCar'],
  ['GermanSmallCoupe','GermanSmallCoupe','GermanSmallCoupe'],
  ['GermanSmallFighter','GermanSmallFighter','GermanSmallFighter'],
  ['GermanSportCar','GermanSportCar','german_sport'],
  ['GermanSportLegend','GermanSportLegend','GermanSportLegend'],
  ['GermanSportWagen','GermanSportWagen','GermanSportWagen'],
  ['GermanV8Supercar','GermanV8Supercar','GermanV8Supercar'],
  ['Ital80sSupercar','Ital80sSupercar','Ital80sSupercar'],
  ['ItalHypercar16.4','ItalHypercar16.4','ItalHypercar16.4'],
  ['ItalHyperCarLimitedEdition','ItalHyperCarLimitedEdition','ItalHyperCarLimitedEdition'],
  ['ItalRareSupercar','ItalRareSupercar','ItalRareSupercar'],
  ['Japan4WDStreetRacer','Japan4WDStreetRacer','Japan4WDStreetRacer'],
  ['JapanDrifter','JapanDrifter','JapanDrifter'],
  ['JapanKeiCar','JapanKeiCar','JapanKeiCar'],
  ['JapanLegend','JapanLegend','JapanLegend'],
  ['JapanLegendaryDrifter','JapanLegendaryDrifter','JapanLegendaryDrifter'],
  ['JapanRallyFox','JapanRallyFox','JapanRallyFox'],
  ['JapanRallyLegacy','JapanRallyLegacy','JapanRallyLegacy'],
  ['JapanRallyLegendCoupe','JapanRallyLegendCoupe','JapanRallyLegendCoupe'],
  ['JapanRotaryCoupe','JapanRotaryCoupe','JapanRotaryCoupe'],
  ['JapanSedan','JapanSedan','JapanSedan'],
  ['JapanSmallCoupe','JapanSmallCoupe','JapanSmallCoupe'],
  ['JapanSmallFighter','JapanSmallFighter','JapanSmallFighter'],
  ['JapanSmallFWDCoupe','JapanSmallFWDCoupe','JapanSmallFWDCoupe'],
  ['JapanSportCoupe','JapanSportCoupe','JapanSportCoupe'],
  ['JapanSportCoupeTrackEdition','JapanSportCoupeTrackEdition','JapanSportCoupeTrackEdition'],
  ['JapanTuner','JapanTuner','JapanTuner'],
  ['KoreanHatch','KoreanHatch','KoreanHatch'],
  ['LightHypercar','LightHypercar','LightSupercar'],
  ['ModernRallyCar','ModernRallyCar','ModernRally'],
  ['NextGenGodzilla','NextGenGodzilla','NextGenGodzilla'],
  ['PoliceInterceptorEstate','PoliceInterceptorEstate','PoliceInterceptorEstate'],
  ['PoliceInterceptorEstateAI','PoliceInterceptorEstate','PoliceInterceptorEstateAIVersion'],
  ['RoyalMotorsport','RoyalMotorsport','RoyalMotorsport'],
  ['RoyalRacingCar','RoyalRacingCar','RoyalRacingCar'],
  ['RoyalSportCar','RoyalSportCar','RoyalSportCar'],
  ['RoyalSportCarLimitedEdition','RoyalSportCarLimitedEdition','RoyalSportCarLimitedEdition'],
  ['ScandinavianHypercar','ScandinavianHypercar','ScandinavianHypercar'],
];

const labelFromId=id=>id
  .replace(/([a-z0-9])([A-Z])/g,'$1 $2')
  .replace(/(\d)([A-Za-z])/g,'$1 $2')
  .replace(/([A-Za-z])(\d)/g,'$1 $2')
  .replace(/\s+/g,' ')
  .trim();

export const PSX_CAR_MODELS=Object.freeze(RAW_MODELS.map(([id,folder,file],index)=>Object.freeze({
  id,folder,file,label:id==='PoliceInterceptorEstateAI'?'Police Interceptor Estate (AI)':labelFromId(id),
  color:PAINT_COLORS[index%PAINT_COLORS.length],
  wheel:WHEEL_FILES[index%WHEEL_FILES.length],
})));
export const DEFAULT_PSX_CAR_ID='JapanLegendaryDrifter';
const MODEL_BY_ID=new Map(PSX_CAR_MODELS.map(model=>[model.id,model]));

export function getPSXCarModel(id){
  return MODEL_BY_ID.get(id)||MODEL_BY_ID.get(DEFAULT_PSX_CAR_ID);
}

function assetUrl(relative){
  return new URL(`${PACK_ROOT}/${relative}`,import.meta.url).href;
}

async function fetchText(url,signal){
  const response=await fetch(url,{signal,cache:'force-cache'});
  if(!response.ok)throw new Error(`PSX asset ${response.status}: ${url}`);
  return response.text();
}

function stripUnsupportedLines(source){
  // A handful of source files contain decorative OBJ line elements. They add
  // draw calls but are invisible at driving distance, so omit them up front.
  return source.split(/\r?\n/).filter(line=>!line.startsWith('l ')).join('\n');
}

function measure(object){
  object.updateMatrixWorld(true);
  const box=new THREE.Box3().setFromObject(object),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  if(box.isEmpty()||size.lengthSq()===0)throw new Error('PSX car contains no visible geometry');
  return{box,size,center,length:Math.max(size.z,.001),width:Math.max(size.x,.001)};
}

function createBodyMaterials(color){
  const body=new THREE.MeshLambertMaterial({name:'psxBody',color,flatShading:true});
  const glass=new THREE.MeshLambertMaterial({name:'psxGlass',color:0x070b10,emissive:0x020306,emissiveIntensity:.12,flatShading:true});
  const trim=new THREE.MeshLambertMaterial({name:'psxTrim',color:0x0a0d11,flatShading:true});
  const headlight=new THREE.MeshBasicMaterial({name:'psxHeadlight',color:0xffe4b0});
  const taillight=new THREE.MeshBasicMaterial({name:'psxTaillight',color:0xff1833});
  return{
    body,glass,trim,headlight,taillight,
    all:[body,glass,trim,headlight,taillight],
    forName(name=''){
      if(name==='Material.001')return body;
      if(name==='Material'||name==='Material.002')return glass;
      if(name==='Material.004')return headlight;
      if(name==='Material.005')return taillight;
      return trim;
    },
  };
}

function prepareBody(object,materials){
  const sourceMaterials=new Set();
  object.traverse(child=>{
    if(!child.isMesh)return;
    if(!child.geometry.getAttribute('normal'))child.geometry.computeVertexNormals();
    const originals=Array.isArray(child.material)?child.material:[child.material];
    originals.forEach(material=>{if(material)sourceMaterials.add(material);});
    const mapped=originals.map(material=>materials.forName(material?.name));
    child.material=Array.isArray(child.material)?mapped:mapped[0];
    child.castShadow=false;child.receiveShadow=false;child.frustumCulled=true;
    child.updateMatrix();child.matrixAutoUpdate=false;
  });
  sourceMaterials.forEach(material=>material.dispose());
}

function mergeObjectGeometry(object,mergeGeometries){
  object.updateMatrixWorld(true);
  const geometries=[];
  object.traverse(child=>{
    if(!child.isMesh||!child.geometry)return;
    const geometry=child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    geometry.deleteAttribute('color');
    geometries.push(geometry);
  });
  if(!geometries.length)throw new Error('PSX wheel contains no mesh');
  let merged;
  try{merged=geometries.length===1?geometries[0]:mergeGeometries(geometries,false);}catch{}
  if(!merged)merged=geometries[0];
  geometries.forEach(geometry=>{if(geometry!==merged)geometry.dispose();});
  return merged;
}

function countTriangles(object){
  let triangles=0;
  object.traverse(child=>{
    if(!child.isMesh||!child.geometry)return;
    const count=child.geometry.index?.count||child.geometry.getAttribute('position')?.count||0;
    triangles+=count/3*(child.isInstancedMesh?child.count:1);
  });
  return Math.round(triangles);
}

function countDrawCalls(object){
  let calls=0;
  object.traverse(child=>{
    if(!child.isMesh)return;
    calls+=Array.isArray(child.material)?Math.max(1,child.geometry.groups.length):1;
  });
  return calls;
}

function disposeParsedObject(object){
  const geometries=new Set(),materials=new Set();
  object.traverse(child=>{
    if(child.geometry)geometries.add(child.geometry);
    for(const material of(Array.isArray(child.material)?child.material:[child.material]))if(material)materials.add(material);
  });
  geometries.forEach(geometry=>geometry.dispose());
  materials.forEach(material=>material.dispose());
}

function buildWheelInstances({wheelSource,OBJLoader,mergeGeometries,frontZ,rearZ,wheelX,wheelY,wheelRadius}){
  const parsed=new OBJLoader().parse(stripUnsupportedLines(wheelSource));
  const wheelGeometry=mergeObjectGeometry(parsed,mergeGeometries);
  const bounds=measure(new THREE.Mesh(wheelGeometry));
  const nativeRadius=Math.max(bounds.size.y,bounds.size.z)*.5||.27;
  const nativeThickness=Math.max(bounds.size.x,.001);
  const wheelThickness=wheelRadius*.58;
  wheelGeometry.translate(-bounds.center.x,-bounds.center.y,-bounds.center.z);
  wheelGeometry.scale(wheelThickness/nativeThickness,wheelRadius/nativeRadius,wheelRadius/nativeRadius);
  wheelGeometry.computeBoundingSphere();
  disposeParsedObject(parsed);

  const rimMaterial=new THREE.MeshLambertMaterial({name:'psxWheel',color:0x92999f,flatShading:true});
  const rubberMaterial=new THREE.MeshLambertMaterial({name:'psxTire',color:0x060709,flatShading:true});
  const tireGeometry=new THREE.CylinderGeometry(1,1,1,10);
  tireGeometry.rotateZ(Math.PI/2);
  const rims=new THREE.InstancedMesh(wheelGeometry,rimMaterial,4);
  const tires=new THREE.InstancedMesh(tireGeometry,rubberMaterial,4);
  rims.name='PSX wheels';tires.name='PSX tires';
  rims.castShadow=tires.castShadow=false;rims.receiveShadow=tires.receiveShadow=false;
  rims.instanceMatrix.setUsage(THREE.DynamicDrawUsage);tires.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const wheels=[
    {x:-wheelX,z:frontZ,front:true,side:0},
    {x:wheelX,z:frontZ,front:true,side:Math.PI},
    {x:-wheelX,z:rearZ,front:false,side:0},
    {x:wheelX,z:rearZ,front:false,side:Math.PI},
  ];
  const position=new THREE.Vector3(),quaternion=new THREE.Quaternion(),scale=new THREE.Vector3(),matrix=new THREE.Matrix4(),euler=new THREE.Euler();
  let lastSteer=Infinity;
  const setSteering=steer=>{
    steer=THREE.MathUtils.clamp(Number(steer)||0,-.7,.7);
    if(Math.abs(steer-lastSteer)<.002)return;
    lastSteer=steer;
    wheels.forEach((wheel,index)=>{
      position.set(wheel.x,wheelY,wheel.z);
      euler.set(0,wheel.side+(wheel.front?steer:0),0);
      quaternion.setFromEuler(euler);
      scale.set(1,1,1);matrix.compose(position,quaternion,scale);rims.setMatrixAt(index,matrix);
      scale.set(wheelThickness,wheelRadius,wheelRadius);matrix.compose(position,quaternion,scale);tires.setMatrixAt(index,matrix);
    });
    rims.instanceMatrix.needsUpdate=true;tires.instanceMatrix.needsUpdate=true;
  };
  setSteering(0);
  rims.computeBoundingSphere();tires.computeBoundingSphere();
  return{rims,tires,setSteering,materials:[rimMaterial,rubberMaterial],geometries:[wheelGeometry,tireGeometry]};
}

export async function loadPSXCar(modelId,{length=4.25,color,signal}={}){
  const model=getPSXCarModel(modelId);
  const bodyUrl=assetUrl(`body/${model.folder}/${model.file}.obj`);
  const wheelUrl=assetUrl(`Wheels/${model.wheel}`);
  const [{OBJLoader},{mergeGeometries},bodySource,wheelSource]=await Promise.all([
    import('three/addons/loaders/OBJLoader.js'),
    import('three/addons/utils/BufferGeometryUtils.js'),
    fetchText(bodyUrl,signal),
    fetchText(wheelUrl,signal),
  ]);
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');

  const body=new OBJLoader().parse(stripUnsupportedLines(bodySource));
  body.name=`${model.label} body`;
  const bodyMaterials=createBodyMaterials(color??model.color);
  prepareBody(body,bodyMaterials);
  const bounds=measure(body);
  const targetLength=THREE.MathUtils.clamp(Number(length)||4.25,3.4,5.5);
  const bodyScale=targetLength/bounds.length;
  const visualWidth=bounds.width*bodyScale;
  const visualLength=bounds.length*bodyScale;
  const wheelRadius=THREE.MathUtils.clamp(targetLength*.071,.27,.36);
  const bodyGroundY=Math.max(.045,wheelRadius*.55);
  body.scale.setScalar(bodyScale);
  body.position.set(-bounds.center.x*bodyScale,bodyGroundY-bounds.box.min.y*bodyScale,-bounds.center.z*bodyScale);
  body.updateMatrix();body.matrixAutoUpdate=false;

  const rearZ=(bounds.box.min.z-bounds.center.z)*bodyScale+visualLength*.23;
  const frontZ=(bounds.box.max.z-bounds.center.z)*bodyScale-visualLength*.19;
  const wheelX=Math.max(visualWidth*.42,visualWidth*.5-wheelRadius*.22);
  const wheelY=wheelRadius+.045;
  const wheelParts=buildWheelInstances({wheelSource,OBJLoader,mergeGeometries,frontZ,rearZ,wheelX,wheelY,wheelRadius});

  const root=new THREE.Group();
  root.name=`PSXStyleCars · ${model.label}`;
  // The source pack faces +Z. Shutoko's player rig faces -Z locally.
  root.rotation.y=Math.PI;
  root.add(body,wheelParts.tires,wheelParts.rims);
  root.userData.psxCarId=model.id;
  root.userData.psxCarLabel=model.label;
  root.userData.setSteering=wheelParts.setSteering;
  root.userData.ownedMaterials=[...bodyMaterials.all,...wheelParts.materials];
  root.userData.ownedGeometries=wheelParts.geometries;
  root.userData.psxStats={triangles:countTriangles(root),drawCalls:countDrawCalls(root)};
  return root;
}

export function disposePSXCar(object){
  if(!object)return;
  object.removeFromParent();
  const geometries=new Set(object.userData.ownedGeometries||[]),materials=new Set(object.userData.ownedMaterials||[]);
  object.traverse(child=>{
    if(child.geometry)geometries.add(child.geometry);
    for(const material of(Array.isArray(child.material)?child.material:[child.material]))if(material)materials.add(material);
  });
  geometries.forEach(geometry=>geometry.dispose());
  materials.forEach(material=>{
    for(const key of['map','normalMap','roughnessMap','metalnessMap','emissiveMap','aoMap'])material[key]?.dispose?.();
    material.dispose();
  });
}
