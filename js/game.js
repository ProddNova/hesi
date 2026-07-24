import * as THREE from 'three';
import * as MapModule from './map.js?v=20260722b';
import * as PhysicsModule from './physics.js?v=20260713a';
import * as TrafficModule from './traffic.js?v=20260723b';
import * as Data from './data.js';
import * as SaveModule from './save.js';
import * as AudioModule from './audio.js';
import { GarageSystem } from './garage.js?v=20260723b';
import { applyEditorBuilds, createRuntimeAssetPartResolver } from './editor-map-patch.js?v=20260724a';
// Same specifier as editor-map-patch.js so both share one module instance
// (and one texture cache/budget); a ?v= query here would fork the module.
import { buildCustomAssetGroup, fetchCustomAssetsDocument, setTextureSizeBudget } from './custom-assets.js';
import { carModelEntry, carModelTarget } from './car-models.js';
import { GameUI } from './ui.js?v=20260713a';
import { DeveloperMap } from './dev-map.js?v=20260716a';
import { DebugStats } from './debug-stats.js?v=20260720a';
import { DEFAULT_PSX_CAR_ID, PSX_CAR_MODELS, disposePSXCar, getPSXCarModel, loadPSXCar } from './psx-car-pack.js?v=20260723b';

const HighwayMap = MapModule.HighwayMap || MapModule.default;
const VehiclePhysics = PhysicsModule.VehiclePhysics || PhysicsModule.default;
const TrafficSystem = TrafficModule.TrafficSystem || TrafficModule.default;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const vec=p=>p?.isVector3?p:new THREE.Vector3(p?.x||0,p?.y||0,p?.z||0);
const DEFAULT_CUSTOM_CAR_SCALE=1;

class ShutokoNights {
  constructor(){
    this.canvas=document.getElementById('game-canvas');
    // MSAA is close to free on Apple tile-based GPUs and the PS2 target needs
    // clean edges at near-native resolution.
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,powerPreference:'high-performance',alpha:false});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.shadowMap.enabled=false;
    // Near plane at .3 keeps depth precision tight enough that coplanar road
    // details stop z-fighting at distance.
    this.camera=new THREE.PerspectiveCamera(64,16/9,.3,1250);
    this.roadScene=new THREE.Scene();this.garageScene=new THREE.Scene();
    this.clock=new THREE.Clock();this.keys={};this.pressed=new Set();this.mode='boot';this.started=false;this.isTouchDevice=matchMedia('(pointer: coarse)').matches||navigator.maxTouchPoints>0;
    // Per-frame subsystem timings (ms). Filled by animate()/updateDriving()
    // and consumed by DebugStats so long frames name their cause in the log.
    this.frameProf={phys:0,traffic:0,map:0,render:0,persist:0,other:0,total:0};
    this.run={score:0,combo:1,comboTimer:0,lives:3,nearMisses:0,bestRunCombo:1};
    this.lastService=null;this.contactCooldown=0;this.ghostTimer=0;this.crash={active:false,timer:0};this.cameraMode='chase';this.camPos=new THREE.Vector3();this.camLook=new THREE.Vector3();
    this.mobileFPS={startedAt:performance.now(),frames:0};
    this.debug={menuOpen:false,noclip:false,trafficDisabled:false,hitboxes:{roads:false,walls:false,vehicles:false,services:false,world:false},position:new THREE.Vector3(),yaw:0,pitch:0,moveSpeed:55,worldRefresh:0};
    // On-foot mode: step out of the car anywhere (G), walk in first person, and
    // step back in when close. The car and world freeze while walking.
    this.walk={active:false,position:new THREE.Vector3(),yaw:0,pitch:0,velocity:new THREE.Vector3(),height:1.7,groundY:0,carPos:new THREE.Vector3(),carHeading:0};
    this.admin={unlocked:false,infiniteMoney:false,infiniteLives:false,infiniteFuel:false,timeScale:1,trafficDensity:1,trafficTruckRatio:0.09,trafficVanRatio:0.19,trafficLaneChange:1,trafficSpeed:1};
    this.setupLights();this.setupPersistence();this.setupUI();this.setupInput();this.buildWorld();this.setupCarModelHotReload();
    this.setupDebugMenu();
    this.setupDevMap();
    this.setupDebugStats();
    this.resize();window.addEventListener('resize',()=>this.resize());
    // iOS Safari: orientation changes and browser-chrome show/hide don't always
    // fire a plain resize, so listen to everything and settle late.
    window.addEventListener('orientationchange',()=>{this.resize();setTimeout(()=>this.resize(),350);});
    window.visualViewport?.addEventListener('resize',()=>this.resize());
    this.ui.showBoot(this.hadSave);this.ui.finishLoading();this.animate();
  }

  setupPersistence(){
    const SaveCtor=SaveModule.SaveSystem||SaveModule.default;
    try{this.saver=typeof SaveCtor==='function'?new SaveCtor({autoLoad:false,autoStart:false}):SaveCtor;}catch(e){console.warn('Save system fallback',e);this.saver=null;}
    this.runtimeSaveKey='shutoko-nights.runtime.v2';let raw=null;
    try{const serialized=localStorage.getItem(this.runtimeSaveKey);raw=serialized?JSON.parse(serialized):null;if(!raw&&localStorage.getItem(SaveModule.SAVE_KEY||'shutoko-nights.save'))raw=this.saver?.load?.()||null;}catch(e){console.warn(e);}
    this.hadSave=!!raw;
    this.catalog=Data.CARS||Data.CAR_CATALOG||Data.CAR_SPECS||Data.cars||[];
    this.partCatalog=Data.PARTS||Data.PART_CATALOG||Data.UPGRADE_PARTS||Data.parts||[];
    if(!Array.isArray(this.catalog)&&typeof this.catalog==='object')this.catalog=Object.values(this.catalog);
    if(!Array.isArray(this.partCatalog)&&typeof this.partCatalog==='object')this.partCatalog=Object.values(this.partCatalog).flat();
    const starter=this.catalog.find(c=>c.starter)||this.catalog.find(c=>c.id===Data.STARTER_CAR_ID)||this.catalog[0]||this.fallbackCar();
    const starterOwned=Data.createStarterCar?.()||{...starter,carId:starter.id,color:starter.colors?.[0]||starter.color};
    const defaults={version:2,money:Data.ECONOMY?.startingMoney??45000,ownedCarId:starter.id,ownedCar:starterOwned,installedParts:[],fuel:starterOwned.fuelLiters??starter.fuelTankL??starter.fuelCapacity??45,auctionSeed:Math.floor(Math.random()*2147483646)+1,auctions:[],deliveries:[],settings:{volume:.65,camera:'chase',gearbox:'auto',resolution:480,quality:'medium',customCar:true,customCarScale:DEFAULT_CUSTOM_CAR_SCALE,customCarModel:DEFAULT_PSX_CAR_ID,customCarVersion:1},records:{bestCombo:1,bestScore:0,totalBanked:0},admin:{unlocked:false,infiniteMoney:false,infiniteLives:false,infiniteFuel:false,timeScale:1,trafficDensity:1}};
    this.state=this.normalizeState(raw||defaults,defaults);
    if(this.catalog.length>1&&!this.state.auctions.length)this.state.auctions=this.generateAuctions(this.state.auctionSeed);
    this.customCar={enabled:true,scale:DEFAULT_CUSTOM_CAR_SCALE,modelId:this.state.settings.customCarModel,object:null,loadPromise:null,loadingModelId:null,status:'idle',requestId:0,abortController:null};
    this.editorCarAssets=null;this.editorCarResolver=null;this.carModelReloadPromise=null;this.carModelChannel=null;
    this.admin={...this.admin,...this.state.admin};this.cameraMode=this.state.settings.camera||'chase';this.persist();
  }

  normalizeState(raw,d){
    const s={...d,...raw};s.settings={...d.settings,...raw.settings};s.records={...d.records,...raw.records};s.admin={...d.admin,...raw.admin};
    if(!['low','medium','high'].includes(s.settings.quality)){const legacy=+s.settings.resolution||480;s.settings.quality=legacy<=320?'low':legacy>=640?'high':'medium';}
    s.money=Number.isFinite(+s.money)?+s.money:d.money;s.installedParts=Array.isArray(s.installedParts)?s.installedParts:[];s.deliveries=Array.isArray(s.deliveries)?s.deliveries:[];s.auctions=Array.isArray(s.auctions)?s.auctions:[];
    const currentCarVisual=raw.settings?.customCarVersion===1;s.settings.customCar=true;s.settings.customCarModel=getPSXCarModel(currentCarVisual?s.settings.customCarModel:DEFAULT_PSX_CAR_ID).id;s.settings.customCarScale=DEFAULT_CUSTOM_CAR_SCALE;s.settings.customCarVersion=1;
    const savedCarId=s.ownedCarId||s.ownedCar?.carId||s.ownedCar?.id,playable=this.catalog.find(c=>c.id===savedCarId);s.ownedCarId=playable?.id||d.ownedCarId;s.ownedCar=playable?(s.ownedCar||playable):d.ownedCar;
    if(this.catalog.length<=1)s.auctions=[];
    s.fuel=Number.isFinite(+s.fuel)?+s.fuel:(s.ownedCar.fuelCapacity||45);return s;
  }
  persist(){const t0=performance.now();this.state.admin={...this.admin};try{localStorage.setItem(this.runtimeSaveKey,JSON.stringify(this.state));this.saver?.save?.(this.state);}catch(e){console.warn('Autosave unavailable',e);}if(this.frameProf)this.frameProf.persist+=performance.now()-t0;}
  generateAuctions(seed){
    if(this.catalog.length<=1)return[];
    const fn=Data.generateAuctions||Data.generateAuctionListings||Data.createAuctions;
    if(fn){try{return fn(seed,this.catalog);}catch(e){console.warn(e);}}
    let x=seed>>>0;const rnd=()=>((x=(x*1664525+1013904223)>>>0)/4294967296);const list=[];
    for(let i=0;i<Math.max(8,Math.min(11,this.catalog.length*2));i++){const car=this.catalog[(1+Math.floor(rnd()*Math.max(1,this.catalog.length-1)))%this.catalog.length];const mileage=Math.floor(18000+rnd()*185000),condition=.82+rnd()*.18;list.push({id:`lot-${i}`,carId:car.id,car:{...car},year:(car.year||1994)-Math.floor(rnd()*3),mileage,condition,grade:['3','3.5','4','4.5'][Math.floor(rnd()*4)],price:Math.round((car.price||250000)*(.78+condition*.25)/1000)*1000,effectivePower:(car.power||car.horsepower||100)*condition});}return list;
  }
  fallbackCar(){return{id:'koten-90',name:'Koten Maru 90',year:1988,starter:true,color:'#7d3037',price:85000,power:90,torque:128,mass:1040,drivetrain:'RWD',engineLayout:'I4',redline:6500,idleRPM:850,gearRatios:[3.35,1.95,1.29,.96,.78],finalDrive:4.1,tireGrip:1.02,brakeForce:10500,suspensionStiffness:1,fuelCapacity:45,dimensions:{length:4.25,width:1.67,height:1.32}};}

  setupLights(){
    // Night-runners mood: a warm sodium-tinted city haze rather than a cold
    // blue night. The fill is kept low so lamps, emissive windows and light
    // pools still carry the scene, but warm and lifted just enough that the
    // asphalt and distant traffic read their colour instead of falling to flat
    // black between the pools. A cool moon rim keeps some colour contrast.
    this.roadScene.background=new THREE.Color(0x080605);this.roadScene.fog=new THREE.FogExp2(0x16110d,.0017);
    // Tagged gameSceneLight so the Lights editor app (js/lighting-config.js) can
    // re-tint colour/warmth/intensity and js/editor-map-patch.js re-applies the
    // saved config at boot.
    const tag=l=>{l.userData.gameSceneLight=true;return l;};
    this.roadScene.add(tag(new THREE.HemisphereLight(0x564a40,0x1e1510,1.58)));this.roadScene.add(tag(new THREE.AmbientLight(0x64524a,.66)));const moon=tag(new THREE.DirectionalLight(0x9aa6c4,.72));moon.position.set(-200,300,-100);this.roadScene.add(moon);
    this.garageScene.add(tag(new THREE.HemisphereLight(0x7f91a6,0x17100c,1.7)));
  }
  buildWorld(){
    const mapBuildStarted=performance.now();
    // ?legacyMouths=1 draws the pre-junction-rebuild full ribbons; ?legacyProgressiveMerges=1
    // disables the four Checkpoint-1 progressive records; ?paAccessLanes=1
    // restores the temporarily disabled PA access lanes (debug/screenshot A/B only)
    try{const params=typeof location!=='undefined'?new URLSearchParams(location.search):new URLSearchParams();const legacyMouths=params.get('legacyMouths')==='1';const legacyProgressiveMerges=params.get('legacyProgressiveMerges')==='1';const paAccessLanes=params.get('paAccessLanes')==='1';const p4CorridorDebug=params.get('p4CorridorDebug')==='1';const p2HandoffDebug=params.get('p2HandoffDebug')==='1';this.p4OwnershipDebug=params.get('p4OwnershipDebug')==='1';this.p4CaptureView=params.get('p4Capture');this.map=new HighwayMap(this.roadScene,{quality:this.renderQuality?.()||'medium',...(legacyMouths?{junctionMouthSurfaces:false}:{}),...(legacyProgressiveMerges?{progressiveMerges:false}:{}),...(paAccessLanes?{paAccessLanes:true}:{}),...(p4CorridorDebug?{progressiveCorridorDebug:true}:{}),...(p2HandoffDebug?{progressiveMergeHandoffDebug:true}:{}),...(this.p4OwnershipDebug?{progressiveOwnershipDebug:true,markingDebug:true}:{})});this.map.build?.();}catch(e){console.error('Map init',e);this.map=null;}
    this.performanceMetrics={...(this.performanceMetrics||{}),mapBuildMs:performance.now()-mapBuildStarted};
    // Live road adapter: physics substeps query fresh geometry every 1/120 s
    // (fixes the stale-clamp stuck-in-guardrail bug) and sweep the corridor
    // union for continuous collision so barriers are solid at any speed.
    this.roadAdapter={
      // getRoadInfo returns a fresh object per call, so annotating it in
      // place is safe and skips a large object copy per physics substep
      // (2-3 of these per frame; the copies were measurable GC churn).
      getRoadInfo:(p)=>{const info=this.map?.getRoadInfo?.(p,this.currentRoadInfo?.routeId)||null;if(!info)return{onRoad:false,drivable:false,surfaceGrip:.55,snapHeight:false};this.currentRoadInfo=info;this.roadAdapter.onRoad=info.drivable!==false;info.height=info.height??info.point?.y;info.snapHeight=true;info.surfaceGrip=info.drivable===false?.55:(info.surfaceGrip??1);return info;},
      sweep:(from,to,radius)=>{const hit=this.map?.sweepWallCollision?.(from,to,null,Math.max(.62,radius),1.5);if(!hit?.hit)return null;return{hit:true,normal:hit.normal,correctedPosition:hit.position,penetration:0,kind:'wall',restitution:.12,friction:.4};},
      onRoad:true,
    };
    const effective=this.getEffectiveCar();this.audio?.setVehicle?.(effective);
    this.physics=new VehiclePhysics({...effective,fuel:this.state.fuel});this.placeAtSpawn();this.setPhysicsFuel(this.state.fuel);
    this.playerMesh=this.createCarMesh(effective,true);this.roadScene.add(this.playerMesh);this.ensureCustomCarLoaded({silent:true,persist:false});
    try{this.traffic=new TrafficSystem(this.roadScene,this.map,{count:this.isTouchDevice?44:56,density:1,maxVehicles:84});this.applyTrafficAdmin();}catch(e){console.error('Traffic init',e);this.traffic=null;}
    this.garage=new GarageSystem(this.garageScene,this.camera,this.canvas,{
      isOverlayOpen:()=>this.ui?.pcOpen||this.ui?.phoneOpen,openPC:()=>this.ui.openPC(this.getPCContext()),exitGarage:()=>this.exitGarage(),sleep:()=>this.returnToMenu(),finishInstall:d=>this.finishInstall(d),
      prompt:(t,v)=>this.ui.prompt(t,v),toast:t=>this.ui.toast(t),installProgress:(l,p)=>this.ui.installProgress(l,p),uiClick:()=>this.audioClick(),instantDelivery:()=>this.admin.instantDelivery
    });
    this.garage.root.visible=false;this.roadScene.add(this.camera);
    // World-editor builds (data/editor/*-build.json): replay saved map edits on
    // the freshly generated highway and garage. No build files -> no-op.
    applyEditorBuilds({map:this.map,garageRoot:this.garage?.root,roadScene:this.roadScene,garageScene:this.garageScene}).then(r=>{if(r.customAssets)this.applyCarModelDocument(r.customAssets,{reloadPlayer:true});if(r.applied||r.skipped)console.log(`[editor] map edits applied: ${r.applied}, skipped: ${r.skipped}`);}).catch(e=>console.warn('Editor build apply',e)).finally(()=>{this.garage?.onBuildApplied?.();this.prewarmGpuResources();});
    this.applyRetroMaterials(this.roadScene);this.applyRetroMaterials(this.garageScene);
    // The selected PSX car is the only player-car visual. It starts loading
    // beside the lightweight player anchor and moves with that anchor on road.
  }

  // Uploads every road-scene geometry/texture and compiles every shader
  // program in one hidden render during boot. Without this, three.js creates
  // GPU resources lazily the first time an object is drawn, so first-time
  // chunk visibility, traffic pop-in and route-specific content caused
  // driver stalls (buffer/texture uploads + program links, worst case
  // hundreds of ms) in the middle of driving. Runs after the editor builds
  // land so streamed placements and imported textures are covered too.
  prewarmGpuResources(){
    if(!this.renderer||!this.roadScene)return;
    const t0=performance.now();
    const restore=[];
    try{
      this.roadScene.traverse(o=>{
        if(o.visible===false){restore.push([o,'visible',false]);o.visible=true;}
        if((o.isMesh||o.isInstancedMesh||o.isLine||o.isPoints)&&o.frustumCulled){restore.push([o,'frustumCulled',true]);o.frustumCulled=false;}
      });
      // Render one frame straight to the canvas: every draw call executes,
      // uploading buffers/textures and compiling programs. It must be the
      // canvas, not an offscreen target — three.js hardcodes linear output
      // color space for non-XR render targets and the output color space is
      // part of the program cache key, so an offscreen prewarm compiles
      // throwaway variants and leaves the real sRGB compiles to happen
      // mid-drive. The frame itself is harmless: it is the normal boot view
      // with distant chunks also visible, behind the boot overlay.
      // Traffic's lazily created brake-lamp material shares its program with
      // the always-present tail-lamp material, so it needs no special case.
      // One frame covers exactly ONE lighting state — the light count is
      // part of every program's cache key, so a light that later joined or
      // left the render list would obsolete every program compiled here and
      // re-link them all mid-drive. The map upholds that invariant by never
      // chunk-streaming lights (HighwayMap._addChunkMesh), and the garage
      // transitions swap scene and headlights in the same tick.
      this.renderer.render(this.roadScene,this.camera);
      this.performanceMetrics={...(this.performanceMetrics||{}),prewarmMs:performance.now()-t0,prewarmed:{geometries:this.renderer.info.memory.geometries,textures:this.renderer.info.memory.textures,programs:this.renderer.info.programs.length}};
    }catch(e){console.warn('GPU prewarm',e);}
    finally{for(const [object,key,value] of restore)object[key]=value;}
  }

  setupUI(){
    this.ui=new GameUI({continue:()=>this.start(),newGame:()=>this.newGame(),phoneChanged:o=>this.audioClick(),getPhoneContext:()=>this.getPhoneContext(),tow:()=>this.tow(),
      getMinimap:()=>{const s=this.getVehicleState(),p=vec(s.position||s);return{data:this.map?.getMinimapData?.()||null,player:{x:p.x,z:p.z,heading:s.heading||0},services:this.map?.getServiceAreas?.()||[]};},setting:(k,v)=>this.changeSetting(k,v),adminUnlock:ok=>this.unlockAdmin(ok),adminAction:a=>this.adminAction(a),adminToggle:(k,v)=>this.adminToggle(k,v),adminTime:v=>{this.admin.timeScale=v;this.persist();},adminTraffic:v=>{this.admin.trafficDensity=v;this.traffic?.setDensity?.(v);this.syncTrafficControls();this.persist();this.ui.toast(`TRAFFIC DENSITY ${v}×`,'amber');},uiClick:()=>this.audioClick(),
      getPCContext:()=>this.getPCContext(),buyCar:i=>this.buyCar(i),buyPart:i=>this.buyPart(i),buyFuelCan:()=>this.buyFuelCan(),pcChanged:o=>{if(o)document.exitPointerLock?.();},returnGarage:()=>this.enterGarage('crash')});
    const AudioCtor=AudioModule.AudioSystem||AudioModule.default;
    try{this.audio=typeof AudioCtor==='function'?new AudioCtor({volume:this.state.settings.volume}):AudioCtor;}catch(e){console.warn('Audio init',e);}
  }
  setupInput(){
    const block=new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space']);
    window.addEventListener('keydown',e=>{
      const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName||'');
      if((e.code==='Digit0'||e.code==='Numpad0')&&!typing&&!e.repeat){e.preventDefault();this.toggleDebugMenu();return;}
      if(e.code==='KeyM'&&!typing&&!e.repeat){e.preventDefault();this.toggleDevMap();return;}
      if(e.code==='KeyI'&&!typing&&!e.repeat){e.preventDefault();this.debugStats?.toggle();return;}
      if(e.code==='KeyP'&&!typing&&!e.repeat){e.preventDefault();this.debugStats?.toggleRecording();return;}
      // While the developer map is open it owns input (it handles Escape via a
      // capture-phase listener); swallow the rest so no gameplay key leaks through.
      if(this.devMap?.isOpen())return;
      if(block.has(e.code))e.preventDefault();if(!this.keys[e.code])this.pressed.add(e.code);this.keys[e.code]=true;
      this.audio?.unlock?.();this.audio?.resume?.();
      if(e.code==='KeyF'&&!this.ui.pcOpen&&this.started){this.ui.togglePhone(this.getPhoneContext());this.pressed.delete(e.code);}
      if(e.code==='KeyH'&&this.started&&!e.repeat){this.toggleHUD();this.pressed.delete(e.code);}
      if(e.code==='KeyC'&&this.mode==='driving'){this.cycleCamera();this.pressed.delete(e.code);}
      if(e.code==='KeyR'&&this.mode==='driving'){this.recover();this.pressed.delete(e.code);}
      // Step out of / back into the car anywhere.
      if(e.code==='KeyG'&&this.started&&!e.repeat&&!this.ui.pcOpen&&!this.ui.phoneOpen&&!this.debug.menuOpen){if(this.mode==='driving')this.exitVehicle();else if(this.mode==='walk')this.tryEnterVehicle();this.pressed.delete(e.code);}
      if(e.code==='F1'){e.preventDefault();this.ui.showHelp();}
    });
    window.addEventListener('keyup',e=>{this.keys[e.code]=false;});window.addEventListener('blur',()=>{this.keys={};this.pressed.clear();this.releaseTouchInput?.();});
    document.addEventListener('mousemove',e=>{if(this.debug?.noclip&&document.pointerLockElement===this.canvas&&!this.debug.menuOpen){this.debug.yaw-=e.movementX*.0022;this.debug.pitch=clamp(this.debug.pitch-e.movementY*.0022,-Math.PI*.49,Math.PI*.49);}});
    document.addEventListener('mousemove',e=>{if(this.mode==='walk'&&this.walk.active&&document.pointerLockElement===this.canvas){this.walk.yaw-=e.movementX*.0023;this.walk.pitch=clamp(this.walk.pitch-e.movementY*.0021,-1.35,1.25);}});
    this.canvas.addEventListener('click',()=>{if(this.mode==='walk'&&this.walk.active&&document.pointerLockElement!==this.canvas)this.requestDronePointerLock();});
    document.addEventListener('wheel',e=>{if(!this.debug?.noclip||this.debug.menuOpen)return;e.preventDefault();const factor=e.deltaY<0?1.18:1/1.18;this.debug.moveSpeed=clamp(this.debug.moveSpeed*factor,5,400);this.updateDroneSpeedHUD();},{passive:false});
    this.canvas.addEventListener('click',()=>{if(this.debug?.noclip&&!this.debug.menuOpen&&document.pointerLockElement!==this.canvas)this.requestDronePointerLock();});
    // iOS Safari: block pinch zoom, long-press callout/selection and double-tap zoom on the game surface.
    for(const type of ['gesturestart','gesturechange','gestureend'])document.addEventListener(type,e=>e.preventDefault());
    document.addEventListener('contextmenu',e=>{if(this.isTouchDevice)e.preventDefault();});
    if(this.isTouchDevice){
      document.addEventListener('dblclick',e=>e.preventDefault());
      this.canvas.addEventListener('touchstart',e=>e.preventDefault(),{passive:false});
      document.getElementById('touch-controls')?.addEventListener('touchstart',e=>e.preventDefault(),{passive:false});
      document.getElementById('touch-controls')?.addEventListener('touchmove',e=>e.preventDefault(),{passive:false});
    }
    this.setupTouchInput();
  }

  setupTouchInput(){
    const root=document.getElementById('touch-controls');if(!root)return;
    this.touchPointers=new Map();
    // setPointerCapture throws NotFoundError if the pointer already ended;
    // an uncaught throw here silently dropped the whole press.
    const capture=(el,id)=>{try{el.setPointerCapture?.(id);}catch(e){}};
    const press=(button,e)=>{const code=button.dataset.code;if(!code)return;e.preventDefault();capture(button,e.pointerId);this.touchPointers.set(e.pointerId,{code,button});if(!this.keys[code])this.pressed.add(code);this.keys[code]=true;button.classList.add('active');this.audio?.unlock?.();navigator.vibrate?.(8);};
    const release=e=>{const held=this.touchPointers.get(e.pointerId);if(!held)return;this.touchPointers.delete(e.pointerId);if(![...this.touchPointers.values()].some(v=>v.code===held.code))this.keys[held.code]=false;held.button.classList.remove('active');};
    root.querySelectorAll('[data-code]').forEach(button=>{button.addEventListener('pointerdown',e=>press(button,e));button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);button.addEventListener('contextmenu',e=>e.preventDefault());});
    root.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('pointerdown',e=>{
      e.preventDefault();this.audio?.unlock?.();button.classList.add('active');setTimeout(()=>button.classList.remove('active'),100);const action=button.dataset.action;
      if(action==='phone'&&this.started&&!this.ui.pcOpen)this.ui.togglePhone(this.getPhoneContext());
      else if(action==='camera'&&this.mode==='driving')this.cycleCamera();
      else if(action==='recover'&&this.mode==='driving')this.recover();
      else if(action==='vehicle'&&this.started){if(this.mode==='driving')this.exitVehicle();else if(this.mode==='walk')this.tryEnterVehicle();}
      else if(action==='hud'&&this.started)this.toggleHUD();
      else if(action==='debug')this.toggleDebugMenu();
      else if(action==='dev-map'&&this.started&&!this.ui.phoneOpen&&!this.ui.pcOpen&&!this.debug.menuOpen)this.toggleDevMap();
      else if(action==='drone-faster'&&this.debug.noclip){this.debug.moveSpeed=clamp(this.debug.moveSpeed*1.25,5,400);this.updateDroneSpeedHUD();}
      else if(action==='drone-slower'&&this.debug.noclip){this.debug.moveSpeed=clamp(this.debug.moveSpeed/1.25,5,400);this.updateDroneSpeedHUD();}
      navigator.vibrate?.(10);
    }));
    const bindLook=(look,isActive,onMove)=>{let pointer=null,lastX=0,lastY=0;
      look?.addEventListener('pointerdown',e=>{if(!isActive())return;e.preventDefault();pointer=e.pointerId;lastX=e.clientX;lastY=e.clientY;capture(look,e.pointerId);});
      look?.addEventListener('pointermove',e=>{if(e.pointerId!==pointer||!isActive())return;e.preventDefault();const movementX=e.clientX-lastX,movementY=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;onMove(movementX,movementY);});
      const end=e=>{if(e.pointerId===pointer)pointer=null;};look?.addEventListener('pointerup',end);look?.addEventListener('pointercancel',end);look?.addEventListener('lostpointercapture',end);
    };
    bindLook(document.getElementById('touch-look'),()=>this.mode==='garage'||this.mode==='walk',(x,y)=>{
      if(this.mode==='garage')this.garage?.onMouse?.({movementX:x*1.35,movementY:y*1.35});
      else if(this.mode==='walk'&&this.walk.active){this.walk.yaw-=x*.004;this.walk.pitch=clamp(this.walk.pitch-y*.004,-1.35,1.25);}
    });
    bindLook(document.getElementById('touch-drone-look'),()=>this.debug.noclip&&!this.debug.menuOpen,(x,y)=>{this.debug.yaw-=x*.004;this.debug.pitch=clamp(this.debug.pitch-y*.004,-Math.PI*.49,Math.PI*.49);});
    this.releaseTouchInput=()=>{this.touchPointers?.forEach(({code,button})=>{this.keys[code]=false;button.classList.remove('active');});this.touchPointers?.clear();};
    document.addEventListener('visibilitychange',()=>{if(document.hidden){this.releaseTouchInput();this.persist();}});
    window.addEventListener('pagehide',()=>this.persist());
  }

  toggleHUD(){const visible=this.ui.toggleHUD();if(visible)this.ui.toast('HUD ON','amber');}

  syncTouchUI(){
    const root=document.getElementById('touch-controls');if(!root)return;const blocked=this.ui?.phoneOpen||this.ui?.pcOpen||this.debug.menuOpen||!document.getElementById('run-over')?.classList.contains('hidden')||!document.getElementById('pause-help')?.classList.contains('hidden');
    document.body.dataset.gameMode=this.mode;document.body.classList.toggle('noclip-active',!!this.debug.noclip);document.body.classList.toggle('controls-blocked',!!blocked);root.classList.toggle('hidden',!this.started||!['driving','garage','walk'].includes(this.mode));
    const vehicleButton=root.querySelector('[data-action="vehicle"]');if(vehicleButton){const walking=this.mode==='walk';vehicleButton.textContent=walking?'ENTER CAR':'EXIT CAR';vehicleButton.setAttribute('aria-label',walking?'Enter vehicle':'Exit vehicle');}
    if(blocked)this.releaseTouchInput?.();
  }

  start(){this.audio?.unlock?.();this.ui.hideBoot();this.started=true;this.enterGarage('start');}
  newGame(){
    this.ui?.closePhone?.();this.ui?.closePC?.();try{localStorage.removeItem(this.runtimeSaveKey);this.saver?.newGame?.();}catch(e){}
    const starter=this.catalog.find(c=>c.starter)||this.catalog.find(c=>c.id===Data.STARTER_CAR_ID)||this.catalog[0]||this.fallbackCar(),starterOwned=Data.createStarterCar?.()||{...starter,carId:starter.id,color:starter.colors?.[0]||starter.color};this.state={version:2,money:Data.ECONOMY?.startingMoney??45000,ownedCarId:starter.id,ownedCar:starterOwned,installedParts:[],fuel:starterOwned.fuelLiters??starter.fuelTankL??starter.fuelCapacity??45,auctionSeed:Math.floor(Math.random()*2147483646)+1,auctions:[],deliveries:[],settings:{volume:.65,camera:'chase',gearbox:'auto',resolution:480,quality:'medium',customCar:true,customCarScale:DEFAULT_CUSTOM_CAR_SCALE,customCarModel:DEFAULT_PSX_CAR_ID,customCarVersion:1},records:{bestCombo:1,bestScore:0,totalBanked:0},admin:{unlocked:false,infiniteMoney:false,infiniteLives:false,infiniteFuel:false,timeScale:1,trafficDensity:1}};
    this.state.auctions=this.generateAuctions(this.state.auctionSeed);this.customCar.enabled=true;this.customCar.scale=DEFAULT_CUSTOM_CAR_SCALE;this.customCar.modelId=DEFAULT_PSX_CAR_ID;this.clearCustomCarObject({abort:true});this.syncCustomCarControls();this.admin={...this.state.admin,timeScale:1};this.run={score:0,combo:1,comboTimer:0,lives:3,nearMisses:0,bestRunCombo:1};this.fuelWarned=false;this.persist();this.refreshVehicle();this.ui.hideBoot();this.started=true;this.enterGarage('new');
  }

  placeAtSpawn(){
    const sp=this.map?.initialSpawn||this.map?.getInitialSpawn?.()||{position:{x:0,y:6,z:0},heading:0};const p=vec(sp.position||sp);
    if(this.physics.setPosition)this.physics.setPosition(p.x,p.y,p.z,sp.heading||0);else if(this.physics.reset)this.physics.reset(p,sp.heading||0);else {this.physics.state.position.copy(p);this.physics.state.heading=sp.heading||0;}
  }
  enterGarage(reason='service'){
    this.ui.fade(true);setTimeout(()=>{
      if(reason==='crash'||reason==='tow'){this.run={score:0,combo:1,comboTimer:0,lives:3,nearMisses:0,bestRunCombo:1};}
      this.mode='garage';this.crash.active=false;this.ghostTimer=0;this.playerMesh.visible=false;this.garage.root.visible=true;this.garageScene.add(this.camera);this.garage.enter(this.getEffectiveCar(),this.availableDeliveries());this.ensureGarageCar();this.applyRetroMaterials(this.garage.carDisplay);this.ui.showHUD(true);this.ui.prompt('',false);this.ui.fade(false);this.ui.toast(reason==='crash'?'Car recovered. Unbanked score lost.':'Tatsumi PA workshop // Shift complete','amber');if(this.p4CaptureView)setTimeout(()=>this.exitGarage(),80);
    },480);
  }
  exitGarage(){
    this.bankScore('GARAGE');this.ui.fade(true);setTimeout(()=>{this.mode='driving';this.ghostTimer=0;this.garage.leave();this.attachCustomCarVisual();this.garage.root.visible=false;this.releaseGarageTextures();this.roadScene.add(this.camera);this.playerMesh.visible=true;this.placeAtSpawn();this.updatePlayerMesh();this.snapDrivingCamera();this.lastService='garage';this.contactCooldown=1.2;this.ui.fade(false);this.ui.toast('Tatsumi PA // Drive safe','amber');if(this.p4CaptureView)this.applyP4CaptureView(this.p4CaptureView);},480);
  }
  // Sleeping in the garage bed banks the run, saves, and drops back to the
  // main menu (boot screen) where Continue / New Game live. Mirrors the scene
  // teardown exitGarage does, but stops the game instead of driving.
  returnToMenu(){
    this.bankScore?.('SLEEP');this.ui.fade(true);
    setTimeout(()=>{
      if(this.mode==='garage')this.garage.leave();
      this.garage.root.visible=false;this.playerMesh.visible=false;
      this.roadScene.add(this.camera);
      this.ui.closePhone?.();this.ui.closePC?.();
      this.ui.showHUD(false);this.ui.prompt('',false);
      this.mode='boot';this.started=false;this.persist();
      this.ui.showBoot(true);
      this.ui.fade(false);
    },480);
  }
  // The garage scene is never rendered while driving, but its textures (the
  // editor's furniture/wall/poster images) stay uploaded after the first
  // garage frame — the game boots into the garage, so they otherwise occupy
  // VRAM for the whole drive. Dropping the GPU copies here (JS images stay
  // cached) keeps long drives free of that pressure on weak GPUs; three.js
  // re-uploads them automatically on the next garage render.
  releaseGarageTextures(){
    const collect=scene=>{const set=new Set();scene.traverse(o=>{for(const m of(Array.isArray(o.material)?o.material:o.material?[o.material]:[]))for(const key of ['map','emissiveMap','alphaMap','lightMap','aoMap'])if(m[key])set.add(m[key]);});return set;};
    const keep=collect(this.roadScene);
    for(const t of collect(this.garageScene))if(!keep.has(t))t.dispose();
  }

  getInput(){
    const throttle=this.keys.KeyW||this.keys.ArrowUp,brake=this.keys.KeyS||this.keys.ArrowDown,left=this.keys.KeyA||this.keys.ArrowLeft,right=this.keys.KeyD||this.keys.ArrowRight;
    const canInteract=this.getTelemetry().speedKmh<18;
    // Positive steer yaws the car toward the physics "right" basis, which is
    // screen-LEFT for the chase camera, so the left key must map to +1.
    return{throttle:throttle?1:0,brake:brake?1:0,steer:(left?1:0)+(right?-1:0),handbrake:!!this.keys.Space,shiftUp:canInteract?this.take('ShiftLeft','ShiftRight'):this.take('ShiftLeft','ShiftRight','KeyE'),shiftDown:this.take('ControlLeft','ControlRight','KeyQ'),clutch:false};
  }
  getWalkInput(){return{forward:!!(this.keys.KeyW||this.keys.ArrowUp),backward:!!(this.keys.KeyS||this.keys.ArrowDown),left:!!this.keys.KeyA,right:!!this.keys.KeyD,sprint:!!this.keys.ShiftLeft,interactPressed:this.take('KeyE')};}
  take(...codes){for(const c of codes)if(this.pressed.has(c)){this.pressed.delete(c);return true;}return false;}

  animate(){requestAnimationFrame(()=>this.animate());
    // Clamp at 50 ms so a 20 fps phone still simulates at full speed (the
    // physics integrates fixed 120 Hz substeps internally, so a large dt
    // stays stable); anything slower degrades to slow motion rather than
    // exploding.
    const pf=this.frameProf;pf.phys=pf.traffic=pf.map=pf.render=pf.persist=0;const frameStart=performance.now();this.updateMobileFPS(frameStart);
    let dt=Math.min(.05,this.clock.getDelta()||.016);dt*=this.admin.timeScale||1;if(this.crash.active)dt*=.28;this.syncTouchUI();
    // Developer map freezes gameplay (vehicle + drone stay put) while it is open.
    // Freezing is preferable to letting the car/camera drift on stuck input.
    if(this.devMap?.isOpen()){this.render();this.finishFrameProf(frameStart);this.pressed.clear();return;}
    if(this.debug.noclip)this.updateNoclip(dt);else if(this.mode==='driving')this.updateDriving(dt);else if(this.mode==='garage')this.updateGarage(dt);else if(this.mode==='walk')this.updateWalk(dt);else if(this.mode==='boot')this.updateBoot();
    this.updateDebugHitboxes(dt);
    this.render();this.finishFrameProf(frameStart);this.pressed.clear();
  }
  finishFrameProf(frameStart){const pf=this.frameProf;pf.total=performance.now()-frameStart;pf.other=Math.max(0,pf.total-pf.phys-pf.traffic-pf.map-pf.render-pf.persist);this.debugStats?.frame(pf);}
  updateMobileFPS(now){if(!this.isTouchDevice)return;const meter=this.mobileFPS;meter.frames++;const elapsed=now-meter.startedAt;if(elapsed<500)return;this.ui.updateFPS(meter.frames*1000/elapsed);meter.frames=0;meter.startedAt=now;}
  updateBoot(){const t=performance.now()*.00004;const center=this.map?.initialSpawn?.position||{x:0,y:8,z:0};this.camera.position.set(center.x+Math.cos(t)*45,24,center.z+Math.sin(t)*45);this.camera.lookAt(center.x,5,center.z);}
  updateGarage(dt){
    this.makeDeliveriesReady();this.garage.update(dt,this.getWalkInput(),this.getPCContext());
    this.ui.updateHUD({speedKmh:0,rpm:0,gearLabel:'N',redline:7000,fuelFraction:this.state.fuel/(this.getEffectiveCar().fuelCapacity||45)},this.run,{money:this.displayMoney(),routeName:'TATSUMI PA',areaName:'WANGAN WORKS'});
  }

  // ---- On-foot mode (step out of the car anywhere) -------------------------
  // Reuses the garage's first-person feel (WASD + pointer-lock mouselook) but
  // on the open highway. The car and world freeze while you are out; walk back
  // within a few metres and press G to get in.
  exitVehicle(){
    if(this.mode!=='driving'||this.crash.active)return;
    if((this.getTelemetry().speedKmh||0)>12){this.ui.toast('SLOW DOWN TO STEP OUT','amber');return;}
    const s=this.getVehicleState(),p=vec(s.position||s),h=s.heading??s.yaw??0;
    this.walk.carPos.copy(p);this.walk.carHeading=h;
    // Stand one lane-width to the side of the car, on the road surface.
    const side=new THREE.Vector3(Math.cos(h),0,-Math.sin(h));
    const stand=p.clone().addScaledVector(side,2.2);
    const gy=this.map?.getRoadInfo?.(stand)?.point?.y;
    this.walk.groundY=Number.isFinite(gy)?gy:p.y;
    this.walk.position.set(stand.x,this.walk.groundY+this.walk.height,stand.z);
    this.walk.velocity.set(0,0,0);
    // Face back toward the car (garage camera convention: fwd = -sin y,-cos y).
    const dx=p.x-stand.x,dz=p.z-stand.z;this.walk.yaw=Math.atan2(-dx,-dz);this.walk.pitch=-0.05;
    this.walk.active=true;this.mode='walk';
    this.ui.showHUD(false);if(!this.isTouchDevice)this.requestDronePointerLock();
    this.ui.toast(this.isTouchDevice?'STEPPED OUT // TOUCH CONTROLS · ENTER CAR TO RETURN':'STEPPED OUT // WASD walk · G to get back in','amber');
  }
  tryEnterVehicle(){
    if(this.mode!=='walk')return;
    const d=Math.hypot(this.walk.position.x-this.walk.carPos.x,this.walk.position.z-this.walk.carPos.z);
    if(d>4.5){this.ui.toast('GET CLOSER TO YOUR CAR','amber');return;}
    this.walk.active=false;this.mode='driving';document.exitPointerLock?.();
    this.contactCooldown=1.0;this.snapDrivingCamera();this.ui.showHUD(true);this.ui.prompt('',false);
    this.ui.toast('BACK IN THE CAR','amber');
  }
  updateWalk(dt){
    if(!this.walk.active)return;
    const w=this.walk,cosP=Math.cos(w.pitch);
    if(!this.ui.pcOpen&&!this.ui.phoneOpen&&!this.debug.menuOpen){
      const forward=new THREE.Vector3(-Math.sin(w.yaw),0,-Math.cos(w.yaw)),right=new THREE.Vector3(Math.cos(w.yaw),0,-Math.sin(w.yaw));
      const input=this.getWalkInput();let wish=new THREE.Vector3();
      if(input.forward)wish.add(forward);if(input.backward)wish.sub(forward);if(input.right)wish.add(right);if(input.left)wish.sub(right);
      if(wish.lengthSq())wish.normalize();
      const speed=input.sprint?5.6:3.2;w.velocity.lerp(wish.multiplyScalar(speed),1-Math.exp(-dt*12));
      w.position.addScaledVector(w.velocity,dt);
      const gy=this.map?.getRoadInfo?.(w.position)?.point?.y;
      if(Number.isFinite(gy))w.groundY+=(gy-w.groundY)*Math.min(1,dt*8);
      w.position.y=w.groundY+w.height;
    }
    this.camera.position.copy(w.position);this.camera.up.set(0,1,0);
    this.camera.lookAt(w.position.x-Math.sin(w.yaw)*cosP,w.position.y+Math.sin(w.pitch),w.position.z-Math.cos(w.yaw)*cosP);
    this.map?.update?.(w.position,performance.now()/1000);
    const near=Math.hypot(w.position.x-w.carPos.x,w.position.z-w.carPos.z)<4.5;
    this.ui.prompt(near?'<kbd>G</kbd> GET IN CAR':'WASD walk · look with mouse · <kbd>G</kbd> return to car',true);
  }

  updateDriving(dt){
    if(this.debug.menuOpen){this.updateAudio({...this.getTelemetry(),throttle:0,slip:0},dt);return;}
    // On touch devices you cannot browse the phone and steer at the same
    // time, so the world freezes while an overlay is up. Desktop keeps
    // driving as before.
    if(this.isTouchDevice&&(this.ui.phoneOpen||this.ui.pcOpen)&&!this.crash.active){const tel=this.getTelemetry();this.updateAudio({...tel,throttle:0,slip:0},dt);return;}
    this.contactCooldown=Math.max(0,this.contactCooldown-dt);this.updateGhost(dt);if(this.crash.active){this.updateCrash(dt);return;}
    const state=this.getVehicleState(),pos=vec(state.position||state);
    const roadInfo=(this.roadAdapter?this.roadAdapter.getRoadInfo(pos):null)||this.map?.getRoadInfo?.(pos)||{};
    const input=this.getInput();this.lastDriveInput=input;const settings={automatic:this.state.settings.gearbox!=='manual',gearbox:this.state.settings.gearbox,infiniteFuel:this.admin.infiniteFuel};
    const pf=this.frameProf;let t0=performance.now();
    try{this.physics.update(dt,input,this.roadAdapter||roadInfo,settings);}catch(e){console.error('Physics update',e);this.mode='error';throw e;}
    pf.phys+=performance.now()-t0;
    // Wall contacts are now resolved inside the physics substeps (swept CCD);
    // pull the events out for scoring so scrapes/hits still cost combo/lives.
    for(const ev of this.physics.consumeEvents?.()||[]){if(ev.type==='collision'&&(ev.kind==='wall'||ev.kind==='impact'))this.registerContact('wall',{severity:ev.severity,normal:ev.normal});}
    if(this.admin.infiniteFuel)this.setPhysicsFuel(this.getEffectiveCar().fuelCapacity||45);
    this.syncFuelFromPhysics();this.resolveMapCollision();
    t0=performance.now();if(!this.debug.trafficDisabled)this.traffic?.update?.(dt,this.getVehicleState(),{roadInfo:this.currentRoadInfo,playerGhost:this.ghostTimer>0});pf.traffic+=performance.now()-t0;
    this.handleTrafficEvents();this.updatePlayerMesh();
    t0=performance.now();this.map?.update?.(pos,performance.now()/1000);pf.map+=performance.now()-t0;
    const tel=this.getTelemetry();this.updateScoring(dt,tel);this.updateServices(tel);this.updateCamera(dt,tel);this.updateAudio(tel,dt);this.updateHUD(tel,this.currentRoadInfo||roadInfo);
    if((tel.fuel??this.state.fuel)<=0.001&&!this.fuelWarned){this.fuelWarned=true;this.ui.toast('OUT OF FUEL // Open phone to call tow','red');}
  }

  setupDebugMenu(){
    this.debug.root=document.getElementById('debug-menu');this.debug.droneHUD=document.getElementById('debug-drone-hud');this.debug.speedHUD=document.getElementById('debug-drone-speed');this.updateDroneSpeedHUD();
    this.debug.overlay=new THREE.Group();this.debug.overlay.name='Debug hitboxes';this.debug.overlay.renderOrder=999;this.roadScene.add(this.debug.overlay);this.debug.layers={};
    const bind=(id,fn)=>document.getElementById(id)?.addEventListener('change',e=>fn(e.target.checked));
    bind('debug-noclip',v=>this.setNoclip(v));bind('debug-traffic',v=>this.setTrafficDisabled(v));
    const customModel=document.getElementById('debug-custom-car-model');if(customModel){for(const model of PSX_CAR_MODELS){const option=document.createElement('option');option.value=model.id;option.textContent=model.label;customModel.append(option);}customModel.addEventListener('change',e=>this.setCustomCarModel(e.target.value));}
    this.syncCustomCarControls();
    // Live traffic test sliders: drag updates instantly (no persist), release commits.
    const trafficRange=(id,key)=>{const el=document.getElementById(id);if(!el)return;el.addEventListener('input',e=>this.setTrafficParam(key,e.target.value,false));el.addEventListener('change',e=>this.setTrafficParam(key,e.target.value,true));};
    trafficRange('debug-traffic-intensity','density');trafficRange('debug-traffic-truck','truck');trafficRange('debug-traffic-van','van');trafficRange('debug-traffic-lanechange','lanechange');trafficRange('debug-traffic-speed','speed');this.syncTrafficControls();
    document.getElementById('debug-close')?.addEventListener('click',()=>this.toggleDebugMenu(false));
    document.querySelectorAll('[data-debug-hitbox]').forEach(input=>input.addEventListener('change',()=>this.setDebugHitbox(input.dataset.debugHitbox,input.checked)));
    document.getElementById('debug-hitboxes-all')?.addEventListener('click',()=>{const inputs=[...document.querySelectorAll('[data-debug-hitbox]')],enable=inputs.some(input=>!input.checked);for(const input of inputs){input.checked=enable;this.setDebugHitbox(input.dataset.debugHitbox,enable);}});
  }
  toggleDebugMenu(force){
    const open=typeof force==='boolean'?force:!this.debug.menuOpen;this.debug.menuOpen=open;this.debug.root?.classList.toggle('hidden',!open);this.debug.root?.setAttribute('aria-hidden',String(!open));if(open){this.syncTrafficControls();this.syncCustomCarControls();}
    this.keys={};this.pressed.clear();this.releaseTouchInput?.();if(open)document.exitPointerLock?.();else if(this.debug.noclip&&!this.isTouchDevice)this.requestDronePointerLock();
  }
  requestDronePointerLock(){try{const result=this.canvas.requestPointerLock?.();result?.catch?.(()=>{});}catch(e){}}
  updateDroneSpeedHUD(){if(this.debug?.speedHUD)this.debug.speedHUD.textContent=`${Math.round(this.debug.moveSpeed)} M/S`;}
  setupDevMap(){
    // Full-screen developer network map (M). A debug/inspection tool separate
    // from the phone minimap. It never touches game internals directly — every
    // interaction goes through these callbacks (see js/dev-map.js / DEV_MAP.md).
    try{
      this.devMap=new DeveloperMap({
        getNetwork:()=>this.getDevNetwork(),
        getCurrentPosition:()=>{const p=this.debug.noclip?this.debug.position:vec(this.getVehicleState().position||this.getVehicleState());return{x:p.x,y:p.y,z:p.z};},
        getCurrentHeading:()=>{if(this.debug.noclip)return this.debug.yaw;const s=this.getVehicleState();return s.heading??s.yaw??0;},
        getCurrentRoute:()=>{try{const p=this.debug.noclip?this.debug.position:vec(this.getVehicleState().position||this.getVehicleState());const info=this.map?.getRoadInfo?.(p);return info?.routeName||info?.route?.name||info?.routeId||null;}catch(e){return null;}},
        isNoclipActive:()=>!!this.debug.noclip,
        teleportToRoutePoint:(payload)=>this.teleportToRoutePoint(payload),
        onOpen:()=>{this.keys={};this.pressed.clear();this.releaseTouchInput?.();document.exitPointerLock?.();},
        // Deliberately do NOT reacquire pointer lock on close; just leave input clean.
        onClose:()=>{this.keys={};this.pressed.clear();this.releaseTouchInput?.();},
      });
    }catch(e){console.error('Dev map init',e);this.devMap=null;}
  }
  toggleDevMap(){this.devMap?.toggle();}
  // Debug stats overlay (js/debug-stats.js): I toggles it, P records a stats
  // log and copies it to the clipboard on stop. Owns no game state; it reads
  // everything through this snapshot.
  setupDebugStats(){
    try{this.debugStats=new DebugStats({renderer:this.renderer,toast:(t,c)=>this.ui?.toast?.(t,c),getSnapshot:()=>this.getDebugStatsSnapshot()});}catch(e){console.error('Debug stats init',e);this.debugStats=null;}
  }
  getDebugStatsSnapshot(){
    const scene=this.mode==='garage'?this.garageScene:this.roadScene;
    let chunksVisible=0;const chunksTotal=this.map?._chunks?.size??0;
    if(this.map?._chunks)for(const c of this.map._chunks.values())if(c.group.visible)chunksVisible+=1;
    let x=0,z=0,speedKmh=0,route=null;
    try{
      if(this.debug.noclip){x=this.debug.position.x;z=this.debug.position.z;}
      else{const s=this.getVehicleState(),p=vec(s.position||s);x=p.x;z=p.z;if(this.mode==='driving')speedKmh=this.getTelemetry().speedKmh||0;}
      route=this.currentRoadInfo?.routeId||null;
    }catch(e){}
    return{scene,mode:this.debug.noclip?'noclip':this.mode,quality:this.renderQuality(),
      resolution:`${this.canvas.width}x${this.canvas.height}`,dpr:window.devicePixelRatio||1,
      chunksVisible,chunksTotal,traffic:this.traffic?.active?.length??0,x,z,speedKmh,route,
      prewarm:this.performanceMetrics?.prewarmMs!=null?`${this.performanceMetrics.prewarmMs.toFixed(0)}ms (${this.performanceMetrics.prewarmed?.geometries??'?'} geo · ${this.performanceMetrics.prewarmed?.textures??'?'} tex · ${this.performanceMetrics.prewarmed?.programs??'?'} prog)`:'not run'};
  }
  getDevNetwork(){
    const mm=this.map?.getMinimapData?.();if(!mm)return null;
    // Start from the authoritative runtime minimap network (real names, ids,
    // kinds, colours, geometry) and enrich each route with the metadata the
    // tooltip needs (group, lane count, travel direction).
    const routes=mm.routes.map((route)=>{
      let meta=null;try{meta=this.map.getRoute?.(route.id);}catch(e){meta=null;}
      const groupName=meta?.group?(this.map.groups?.get?.(meta.group)?.name||null):null;
      return {...route,
        group:meta?.group??null,groupName,
        lanes:meta?.lanes??null,
        oneWay:meta?.oneWay,bidirectional:meta?.bidirectional,
        direction:meta?.oneWayDirection??1};
    });
    return {routes,bounds:mm.bounds,junctions:mm.junctions,serviceAreas:mm.serviceAreas,garage:mm.garage,prototypePins:mm.prototypePins||[]};
  }
  _snapNoclipCamera(){
    const cp=Math.cos(this.debug.pitch),look=new THREE.Vector3(Math.sin(this.debug.yaw)*cp,Math.sin(this.debug.pitch),Math.cos(this.debug.yaw)*cp);
    this.camera.position.copy(this.debug.position);this.camera.up.set(0,1,0);this.camera.lookAt(this.debug.position.clone().add(look));this.camera.fov=64;this.camera.updateProjectionMatrix();
  }
  applyP4CaptureView(name){
    // Deterministic, query-only visual-audit cameras. These source-chainage
    // fixtures are intentionally independent of progressive phase output so
    // legacy/progressive comparisons use identical transforms.
    const p2=this.map?.progressiveTransitionById?.get?.('J48:merge:wangan_1:ramp_41:end'),mid=(from,to)=>(from+to)*.5;
    const views={
      'high-plan':{routeId:'c1_0',distance:10928,lane:null,up:150,back:0,lateral:0,plan:true},
      'corridor-debug':{routeId:'c1_0',distance:10945,lane:null,up:125,back:0,lateral:-4,plan:true},
      'host-approach':{routeId:'c1_0',distance:10882,lane:1,up:7,back:58,lateral:0},
      'auxiliary-lane':{routeId:'c1_0',distance:10928,lane:null,targetLateral:-5.325,up:6,back:42,lateral:0},
      'branch-handoff':{routeId:'r1_0',distance:148,lane:0,up:8,back:48,lateral:0},
      'guardrail-opening':{routeId:'r1_0',distance:140,lane:null,targetLateral:-4.1,up:13,back:30,lateral:-15},
      'collision-hitbox':{routeId:'c1_0',distance:10982.425,lane:null,up:72,back:0,lateral:0,plan:true,hitboxes:true},
      'p2-handoff-debug':{routeId:'wangan_1',distance:p2?mid(p2.openingStart,p2.transitionEnd):31110,lane:null,up:500,back:0,lateral:0,plan:true},
      'p2-ramp-opening':{routeId:'ramp_41',distance:p2?p2.branchAtHost(mid(p2.openingStart,p2.fiveLaneStart)):555,lane:null,up:10,back:48,lateral:0},
      'p2-full-five':{routeId:'wangan_1',distance:p2?mid(p2.fiveLaneStart,p2.fiveLaneEnd):30982,lane:null,targetLateral:8.875,up:9,back:54,lateral:0},
      'p2-first-abs':{routeId:'wangan_1',distance:p2?mid(p2.absorptionStart,p2.firstAbsorptionEnd):31070,lane:null,targetLateral:8.875,up:10,back:58,lateral:0},
      'p2-four-lane':{routeId:'wangan_1',distance:p2?mid(p2.firstAbsorptionEnd,p2.secondAbsorptionStart):31156,lane:null,targetLateral:7.1,up:9,back:54,lateral:0},
      'p2-second-abs':{routeId:'wangan_1',distance:p2?mid(p2.secondAbsorptionStart,p2.transitionEnd):31243,lane:null,targetLateral:5.9,up:10,back:58,lateral:0},
      'p2-final-three':{routeId:'wangan_1',distance:p2?p2.transitionEnd+p2.mergeStageLength*.5:31332,lane:0,up:8,back:52,lateral:0},
      'p2-handoff-hitbox':{routeId:'wangan_1',distance:p2?mid(p2.fiveLaneStart,p2.fiveLaneEnd):30982,lane:null,up:190,back:0,lateral:0,plan:true,hitboxes:true},
      'normal-chase':{position:{x:-1052.7282169,y:64.8843403,z:-3016.0130739},target:{x:-1012.7993393,y:60.0715092,z:-3026.8561882}},
      'close-marking':{routeId:'r1_0',distance:154,lane:0,up:7,back:28,lateral:0},
      'guardrail-side':{routeId:'r1_0',distance:145,lane:null,targetLateral:-4.1,up:11,back:26,lateral:-16},
      'host-continuation':{routeId:'c1_0',distance:11035,lane:1,up:7,back:45,lateral:0},
      'branch-continuation':{routeId:'r1_0',distance:215,lane:0,up:7,back:45,lateral:0},
    };
    const view=views[name];if(!view||!this.map)return false;
    this.traffic?.setDensity?.(0);this.traffic?.vehicles?.forEach?.(vehicle=>{if(vehicle.mesh)vehicle.mesh.visible=false;});
    this.debug.noclip=true;this.debug.trafficDisabled=true;if(this.playerMesh)this.playerMesh.visible=false;
    this.setDebugHitbox?.('roads',!!view.hitboxes);this.setDebugHitbox?.('walls',!!view.hitboxes);
    const clutter=new Set([this.map.materials.facadeOffice,this.map.materials.facadeDark,this.map.materials.facadeHotel,this.map.materials.facadeIndustrial,this.map.materials.building]);this.map.group.traverse(object=>{if(object.isMesh&&clutter.has(object.material))object.visible=false;});
    document.querySelector('#hud')?.setAttribute('style','display:none!important');document.querySelector('#debug-drone-hud')?.setAttribute('style','display:none!important');
    let target,tangent,normal;
    if(view.position&&view.target){
      this.debug.position.copy(vec(view.position));target=vec(view.target);tangent=target.clone().sub(this.debug.position).normalize();normal=new THREE.Vector3(tangent.z,0,-tangent.x).normalize();
    }else if(view.path==='auxiliary'){
      const transition=this.map.progressiveTransitionById.get('J2:diverge:c1_0:r1_0:start');if(!transition)return;const path=transition.laneCentres.find(entry=>entry.id==='aux:0').points;
      const sampleAt=hostS=>{let upper=1;while(upper<path.length&&path[upper].hostS<hostS)upper++;const right=path[Math.min(upper,path.length-1)],left=path[Math.max(0,upper-1)],t=clamp((hostS-left.hostS)/Math.max(1e-6,right.hostS-left.hostS),0,1);return vec(left.position).lerp(vec(right.position),t);};
      const anchor=sampleAt(view.hostS),look=sampleAt(Math.min(transition.transferComplete,view.hostS+view.lookAhead));target=look;tangent=look.clone().sub(sampleAt(view.hostS-2)).normalize();normal=new THREE.Vector3(tangent.z,0,-tangent.x).normalize();
      this.debug.position.copy(anchor).addScaledVector(tangent,-view.back).addScaledVector(normal,view.lateral);this.debug.position.y=anchor.y+view.up;
    }else{
      const route=this.map.routes.get(view.routeId),frame=this.map._frameAt(route,view.distance);target=view.lane===null?this.map._deckPoint(frame,view.targetLateral||0,.1):this.map.sampleLane(view.routeId,view.distance,view.lane,1).position;tangent=frame.tangent;normal=frame.normal;
      this.debug.position.set(target.x-tangent.x*view.back+normal.x*view.lateral,target.y+view.up,target.z-tangent.z*view.back+normal.z*view.lateral);
    }
    const x=this.debug.position.x,y=this.debug.position.y,z=this.debug.position.z;
    this.debug.position.set(x,y,z);this.debug.yaw=Math.atan2(target.x-x,target.z-z);const horizontal=Math.hypot(target.x-x,target.z-z);this.debug.pitch=Math.atan2(target.y-y,Math.max(.001,horizontal));
    this._snapNoclipCamera();this.map._visibleKey=null;this.map.update(this.debug.position,performance.now()/1000);
    if(name==='corridor-debug')this.installP4CorridorLegend();if(name==='p2-handoff-debug')this.installP2HandoffLegend();if(this.p4OwnershipDebug)this.installP4OwnershipLegend();
    return true;
  }
  installP2HandoffLegend(){
    if(document.querySelector('#p2-handoff-legend'))return;
    const transition=this.map?.progressiveTransitionById?.get?.('J48:merge:wangan_1:ramp_41:end'),data=this.map?.progressiveMergeHandoffDebugOverlay?.userData;if(!transition||!data)return;
    const corridors=transition.auxiliaryLaneCorridors.map(corridor=>corridor.filter(section=>section.hostS<=transition.fiveLaneStart+.01)),count=corridors[0].length,indices=[0,.25,.5,.75,1].map(ratio=>Math.min(count-1,Math.round((count-1)*ratio))),samples=indices.map(index=>`${corridors[0][index].hostS.toFixed(1)}: ${corridors[0][index].width.toFixed(2)} / ${corridors[1][index].width.toFixed(2)} m`).join('<br>');
    const legend=document.createElement('div');legend.id='p2-handoff-legend';legend.style.cssText='position:fixed;left:18px;top:18px;z-index:9999;padding:13px 15px;background:rgba(2,5,12,.92);border:1px solid #fff04a;color:#f4f7ff;font:600 13px/1.43 ui-monospace,monospace;pointer-events:none;text-shadow:0 1px 2px #000;max-width:430px';
    legend.innerHTML=`<div style="font-size:15px;color:#fff">P2 J48 TRUE 3+2 HANDOFF PLAN</div><div style="color:#ff8f3f">OPENING ${transition.mergeOpeningStart.toFixed(2)}</div><div style="color:#fff04a">HANDOFF / FULL 5 START ${transition.fiveLaneStart.toFixed(2)}</div><div style="color:#55ff88">FULL 5 END / FIRST ABS ${transition.fiveLaneEnd.toFixed(2)}</div><div style="color:#d279ff">SECOND ABS 4-&gt;3 ${transition.secondAbsorptionStart.toFixed(2)}</div><div style="color:#45dfff">STABLE 3-LANE ${transition.transitionEnd.toFixed(2)}</div><div style="margin-top:5px"><span style="color:#35d6ff">--</span> host:0 &nbsp;<span style="color:#45ff89">--</span> host:1 &nbsp;<span style="color:#ffdf45">--</span> host:2</div><div><span style="color:#ff5cdb">--</span> ramp/aux:0 &nbsp;<span style="color:#a56cff">--</span> ramp/aux:1</div><div style="color:#ff3b30">-- true host exterior edge ${data.hostExteriorLaneEdgeOffset.toFixed(3)} m</div><div>five-slot offsets: ${data.temporaryLaneCentreOffsets.map(value=>value.toFixed(3)).join(' / ')} m</div><div><span style="color:#fff">|</span> sampled ramp widths (aux:0 / aux:1)</div><div style="color:#dfe7f5">${samples}</div><div>minimum before handoff: ${data.minimumPreHandoffLaneWidth.toFixed(3)} m</div>`;
    document.body.append(legend);
  }
  installP4CorridorLegend(){
    if(document.querySelector('#p4-corridor-legend'))return;
    const transition=this.map?.progressiveTransitionById?.get?.('J2:diverge:c1_0:r1_0:start');if(!transition)return;
    const legend=document.createElement('div');legend.id='p4-corridor-legend';legend.style.cssText='position:fixed;left:18px;top:18px;z-index:9999;padding:12px 14px;background:rgba(2,5,12,.88);border:1px solid #78e8ff;color:#f4f7ff;font:600 14px/1.45 ui-monospace,monospace;pointer-events:none;text-shadow:0 1px 2px #000';
    const minimum=Math.min(...transition.auxiliaryCorridor.map(section=>section.width)),minimumLane=Math.min(...transition.auxiliaryLaneCorridors.flat().map(section=>section.width));
    legend.innerHTML=`<div style="color:#fff;font-size:15px">P4 ${transition.id} · ${transition.topology}</div><div><span style="color:#29e6ff">━━</span> exit lane 0 centre</div><div><span style="color:#6e7dff">━━</span> exit lane 1 centre</div><div><span style="color:#ffa52f">━━</span> host/exit boundary</div><div><span style="color:#fff">━━</span> exit lane divider</div><div><span style="color:#ff3fd2">━━</span> exit outer boundary</div><div><span style="color:#70ff55">━━</span> target r1_0 lanes ${transition.branchExitLanes.join(' + ')}</div><div><span style="color:#fff">┃</span> total width · min ${minimum.toFixed(2)} m</div><div><span style="color:#fff">┃</span> per-lane width · min ${minimumLane.toFixed(2)} m</div><div><span style="color:#ffe52a">┃</span> outer marked lane · ${transition.auxiliaryMarkedWidth.toFixed(2)} m</div><div><span style="color:#ffee22">●</span> ownership @ host ${transition.transferComplete.toFixed(2)} / branch ${transition.transferCompleteBranch.toFixed(2)}</div>`;
    document.body.append(legend);
  }
  installP4OwnershipLegend(){
    if(document.querySelector('#p4-ownership-legend'))return;
    const data=this.map?.progressiveOwnershipDebugOverlay?.userData;if(!data)return;
    const markings=data.markings,rails=data.rails;
    const legend=document.createElement('div');legend.id='p4-ownership-legend';legend.style.cssText='position:fixed;right:18px;top:18px;z-index:9999;padding:12px 14px;background:rgba(2,5,12,.9);border:1px solid #fff;color:#f4f7ff;font:600 13px/1.42 ui-monospace,monospace;pointer-events:none;text-shadow:0 1px 2px #000;max-width:360px';
    legend.innerHTML=`<div style="color:#fff;font-size:15px">P4 emitted ownership</div><div style="color:#ff2a2a">RED host markings · ${markings.host}</div><div style="color:#38ff68">GREEN branch markings · ${markings.branch}</div><div style="color:#ffe52a">YELLOW transition markings · ${markings.transition}</div><div style="color:#ff29e6">MAGENTA illegal retained · ${markings.illegalRetained}</div><div style="color:#9d9d9d">suppressed attempts · ${markings.suppressedAttempts}</div><div style="margin-top:5px;color:#2485ff">BLUE host rail · ${rails.hostSegments}</div><div style="color:#ff8b24">ORANGE branch rail · ${rails.branchSegments}</div><div style="color:#fff">WHITE transition rail · ${rails.transitionSegments}</div><div style="color:#ff0022">BRIGHT RED blocked opening · ${rails.blocked}</div><div style="color:#24f5ff">CYAN unexplained gap · ${rails.unexplainedGaps}</div><div style="color:#d7d7d7">owner handoff gap · ${rails.handoffGap.toFixed(2)} m</div>`;
    document.body.append(legend);
  }
  teleportToRoutePoint({routeId,distance,lane=0,direction=1}){
    // Use the authoritative route sampler for the exact centre, road height and
    // travel tangent at the clicked chainage.
    let sample=null;try{sample=this.map?.sampleLane?.(routeId,distance,lane,direction);}catch(e){console.error('teleport sample',e);return null;}
    if(!sample)return null;
    const centre=vec(sample.position||sample.point||sample.center);
    const heading=Number.isFinite(sample.heading)?sample.heading:Math.atan2(sample.tangent?.x||0,sample.tangent?.z||1);
    if(this.debug.noclip){
      // Noclip drone teleport: move the debug/drone position + yaw, then refresh
      // the camera and streamed chunks/world visibility immediately.
      this.debug.position.set(centre.x,centre.y+2.2,centre.z);this.debug.yaw=heading;
      this._snapNoclipCamera();
      this.map?.update?.(this.debug.position,performance.now()/1000);
      return {x:this.debug.position.x,y:this.debug.position.y,z:this.debug.position.z,heading,routeName:sample.routeName};
    }
    // Driving teleport: reset the physics pose (setPosition clears linear and
    // angular velocity), place the car just above the surface, refresh mesh,
    // camera, current road info and streamed chunks, and arm a contact cooldown
    // so it does not immediately register a crash.
    const target=vec({x:centre.x,y:centre.y+0.6,z:centre.z});
    if(this.physics.setPosition)this.physics.setPosition(target.x,target.y,target.z,heading);else this.physics.reset?.(target,heading);
    this.contactCooldown=1.2;this.fuelWarned=false;
    this.currentRoadInfo=this.map?.getRoadInfo?.(target)||this.currentRoadInfo;
    this.updatePlayerMesh();this.snapDrivingCamera();
    this.map?.update?.(target,performance.now()/1000);
    return {x:target.x,y:target.y,z:target.z,heading,routeName:sample.routeName};
  }
  setTrafficDisabled(disabled){
    this.debug.trafficDisabled=!!disabled;if(disabled)this.traffic?.clear?.();
    const input=document.getElementById('debug-traffic');if(input)input.checked=!!disabled;
    this.ui?.toast?.(disabled?'DEBUG // TRAFFIC OFF':'DEBUG // TRAFFIC ON','amber');
  }
  // Push every stored traffic tunable into the live system (used at init and
  // whenever a value is restored from the save).
  applyTrafficAdmin(){
    if(!this.traffic)return;const a=this.admin;
    this.traffic.setDensity?.(clamp(a.trafficDensity??1,0,3));
    this.traffic.setTypeMix?.({truck:clamp(a.trafficTruckRatio??0.09,0,0.6),van:clamp(a.trafficVanRatio??0.19,0,0.7)});
    this.traffic.setLaneChangeRate?.(clamp(a.trafficLaneChange??1,0,3));
    this.traffic.setSpeedFactor?.(clamp(a.trafficSpeed??1,0.4,1.8));
  }
  // One entry point for every dev-panel traffic slider. commit=false while
  // dragging (live, no disk write), commit=true on release.
  setTrafficParam(key,value,commit=true){
    const v=+value;if(!Number.isFinite(v))return;const a=this.admin;
    if(key==='density'){a.trafficDensity=clamp(v,0,3);this.traffic?.setDensity?.(a.trafficDensity);}
    else if(key==='truck'){a.trafficTruckRatio=clamp(v/100,0,0.6);this.traffic?.setTypeMix?.({truck:a.trafficTruckRatio,van:a.trafficVanRatio??0.19});}
    else if(key==='van'){a.trafficVanRatio=clamp(v/100,0,0.7);this.traffic?.setTypeMix?.({truck:a.trafficTruckRatio??0.09,van:a.trafficVanRatio});}
    else if(key==='lanechange'){a.trafficLaneChange=clamp(v/100,0,3);this.traffic?.setLaneChangeRate?.(a.trafficLaneChange);}
    else if(key==='speed'){a.trafficSpeed=clamp(v/100,0.4,1.8);this.traffic?.setSpeedFactor?.(a.trafficSpeed);}
    else return;
    this.syncTrafficControls();if(commit)this.persist();
  }
  // Reflect stored values back into the sliders + readouts (skips the control
  // the user is actively dragging so it doesn't fight them).
  syncTrafficControls(){
    const a=this.admin;
    const set=(id,val,label)=>{const el=document.getElementById(id);if(el&&document.activeElement!==el)el.value=String(val);const lab=document.getElementById(id+'-val');if(lab)lab.textContent=label;};
    const truckPct=Math.round((a.trafficTruckRatio??0.09)*100),vanPct=Math.round((a.trafficVanRatio??0.19)*100),carPct=Math.max(0,100-truckPct-vanPct);
    const lanePct=Math.round((a.trafficLaneChange??1)*100),speedPct=Math.round((a.trafficSpeed??1)*100),density=a.trafficDensity??1;
    set('debug-traffic-intensity',density,`${density.toFixed(2)}×`);
    set('debug-traffic-truck',truckPct,`${truckPct}%`);
    set('debug-traffic-van',vanPct,`${vanPct}%`);
    set('debug-traffic-lanechange',lanePct,lanePct===0?'OFF':`${lanePct}%`);
    set('debug-traffic-speed',speedPct,`${speedPct}%`);
    const note=document.getElementById('debug-traffic-mix-note');if(note)note.textContent=`auto ${carPct}% · furgoni ${vanPct}% · tir ${truckPct}%`;
  }
  syncCustomCarControls(){
    if(!this.customCar)return;const select=document.getElementById('debug-custom-car-model'),model=getPSXCarModel(this.customCar.modelId);if(select&&document.activeElement!==select)select.value=model.id;
  }
  setupCarModelHotReload(){
    if(typeof BroadcastChannel==='undefined')return;
    try{
      this.carModelChannel=new BroadcastChannel('hesi-car-models');
      this.carModelChannel.addEventListener('message',event=>{if(event.data?.type==='reload-car-models')this.reloadEditorCarModels({announce:true});});
      window.addEventListener('beforeunload',()=>this.carModelChannel?.close?.(),{once:true});
    }catch(error){console.warn('Car Modeler live channel unavailable',error);}
  }
  applyCarModelDocument(document,{reloadPlayer=false,announce=false}={}){
    if(!document)return null;
    this.editorCarAssets=document;
    this.editorCarResolver=createRuntimeAssetPartResolver(document,this.map);
    const result=this.traffic?.applyModelOverrides?.(document,{resolveAssetPart:this.editorCarResolver})||{models:0,settings:0,active:0};
    if(reloadPlayer)this.loadCustomCar(this.customCar.modelId,{force:true}).catch(error=>console.warn('Player car Modeler override',error));
    if(announce)this.ui?.toast?.(`CARS APPLIED // ${result.active||0} ACTIVE TRAFFIC VEHICLES`,'amber');
    return result;
  }
  async reloadEditorCarModels({announce=false}={}){
    if(this.carModelReloadPromise)return this.carModelReloadPromise;
    this.carModelReloadPromise=fetchCustomAssetsDocument()
      .then(document=>this.applyCarModelDocument(document,{reloadPlayer:true,announce}))
      .catch(error=>{console.warn('Car Modeler hot reload',error);if(announce)this.ui?.toast?.('CARS APPLY FAILED // CHECK EDITOR','red');return null;})
      .finally(()=>{this.carModelReloadPromise=null;});
    return this.carModelReloadPromise;
  }
  syncPlayerVisuals(){
    // There is no procedural fallback: the player anchor contains lights only,
    // while the selected PSX model is the sole visible vehicle in both scenes.
    if(!this.playerMesh)return;const chase=this.cameraMode==='chase',customOnRoad=this.customCar?.object?.parent===this.playerMesh,customInGarage=this.customCar?.object?.parent===this.garage?.carDisplay;if(this.garage?.carDisplay)this.garage.carDisplay.visible=!!customInGarage;if(this.garage?.parkedGroup)this.garage.parkedGroup.visible=false;if(this.customCar?.object)this.customCar.object.visible=(chase&&customOnRoad)||(this.mode==='garage'&&customInGarage);
  }
  attachCustomCarVisual(){if(!this.playerMesh||!this.customCar?.object)return;const parent=(this.mode==='garage'?this.garage?.carDisplay:null)||this.playerMesh;parent.add(this.customCar.object);this.customCar.object.scale.setScalar(DEFAULT_CUSTOM_CAR_SCALE);this.syncPlayerVisuals();}
  ensureGarageCar(){
    this.attachCustomCarVisual();
    if(this.customCar.object)this.garage?.refreshColliders?.();
    else this.loadCustomCar().then(()=>this.garage?.refreshColliders?.()).catch(e=>console.warn('PSX garage car load',e));
  }
  disposeCarVisual(visual){
    if(!visual)return;
    if(visual.userData?.hesiCarOverrideAssetId){visual.removeFromParent();return;}
    disposePSXCar(visual);
  }
  clearCustomCarObject({abort=false}={}){
    if(abort){this.customCar.requestId++;this.customCar.abortController?.abort();this.customCar.abortController=null;this.customCar.loadPromise=null;this.customCar.loadingModelId=null;}
    if(this.customCar.object){this.disposeCarVisual(this.customCar.object);this.customCar.object=null;}
    this.syncPlayerVisuals();
  }
  async loadCustomCar(modelId=this.customCar.modelId,{force=false}={}){
    modelId=getPSXCarModel(modelId).id;
    const target=carModelTarget('player',modelId),entry=carModelEntry(this.editorCarAssets,target),overrideId=entry?.assetId&&this.editorCarAssets?.assets?.[entry.assetId]?entry.assetId:null;
    const currentOverride=this.customCar.object?.userData?.hesiCarOverrideAssetId||null;
    if(!force&&this.customCar.object?.userData?.psxCarId===modelId&&currentOverride===overrideId)return this.customCar.object;
    if(!force&&this.customCar.loadPromise&&this.customCar.loadingModelId===modelId)return this.customCar.loadPromise;
    const requestId=++this.customCar.requestId,controller=new AbortController(),spec=this.getEffectiveCar(),length=spec.dimensions?.length||spec.length||4.25,color=spec.color;
    this.customCar.abortController?.abort();this.customCar.abortController=controller;this.customCar.loadingModelId=modelId;this.customCar.status='loading';this.syncCustomCarControls();
    const promise=overrideId
      ? Promise.resolve().then(()=>{
        const definition=this.editorCarAssets.assets[overrideId];
        const visual=buildCustomAssetGroup(definition,this.editorCarAssets.textures||{},{resolveAssetPart:this.editorCarResolver||(()=>null)});
        if(!visual.children.length)throw new Error(`Car override ${overrideId} contains no renderable parts`);
        visual.name=`Modeler car · ${definition.label||modelId}`;
        visual.userData.psxCarId=modelId;visual.userData.psxCarLabel=getPSXCarModel(modelId).label;visual.userData.hesiCarOverrideAssetId=overrideId;
        return visual;
      })
      : loadPSXCar(modelId,{length,color,signal:controller.signal});
    this.customCar.loadPromise=promise;
    try{
      const visual=await promise;if(requestId!==this.customCar.requestId||modelId!==this.customCar.modelId){this.disposeCarVisual(visual);return null;}
      try{await this.renderer.compileAsync?.(visual,this.camera,this.mode==='garage'?this.garageScene:this.roadScene);}catch(e){console.warn('PSX car shader prewarm',e);}
      if(requestId!==this.customCar.requestId||modelId!==this.customCar.modelId){this.disposeCarVisual(visual);return null;}
      const previous=this.customCar.object;this.customCar.object=visual;visual.scale.setScalar(DEFAULT_CUSTOM_CAR_SCALE);this.customCar.status='ready';this.attachCustomCarVisual();if(previous)this.disposeCarVisual(previous);this.garage?.refreshColliders?.();this.syncCustomCarControls();
      this.syncPlayerVisuals();return visual;
    }catch(error){
      if(error?.name==='AbortError'||requestId!==this.customCar.requestId)return null;this.customCar.status='error';this.syncCustomCarControls();throw error;
    }finally{
      if(requestId===this.customCar.requestId){this.customCar.loadPromise=null;this.customCar.loadingModelId=null;this.customCar.abortController=null;}
    }
  }
  async ensureCustomCarLoaded({silent=false,persist=true}={}){
    this.customCar.enabled=true;this.state.settings.customCar=true;this.state.settings.customCarScale=DEFAULT_CUSTOM_CAR_SCALE;if(persist)this.persist();this.syncCustomCarControls();if(!silent)this.ui?.toast?.('PSXSTYLE CAR // CARICAMENTO MODELLO','amber');try{const visual=await this.loadCustomCar();if(visual){this.attachCustomCarVisual();if(!silent)this.ui?.toast?.(`PSXSTYLE CAR // ${getPSXCarModel(this.customCar.modelId).label.toUpperCase()}`,'amber');}}catch(error){console.error('PSX car load',error);this.customCar.status='error';this.syncCustomCarControls();if(!silent)this.ui?.toast?.('PSXSTYLE CAR // MODELLO NON DISPONIBILE','red');}
  }
  async setCustomCarModel(modelId,{persist=true,silent=false}={}){
    const next=getPSXCarModel(modelId);if(next.id===this.customCar.modelId){this.syncCustomCarControls();return;}const previousId=this.customCar.modelId;this.customCar.modelId=next.id;this.state.settings.customCarModel=next.id;this.state.settings.customCarVersion=1;if(persist)this.persist();this.syncCustomCarControls();
    try{const visual=await this.loadCustomCar(next.id);if(visual&&!silent)this.ui?.toast?.(`PSXSTYLE // ${next.label.toUpperCase()}`,'amber');}catch(error){console.error('PSX car switch',error);if(this.customCar.object){this.customCar.modelId=this.customCar.object.userData.psxCarId||previousId;this.state.settings.customCarModel=this.customCar.modelId;this.customCar.status='ready';if(persist)this.persist();this.syncCustomCarControls();}if(!silent)this.ui?.toast?.('PSXSTYLE // CAMBIO MODELLO FALLITO','red');}
  }
  setNoclip(enabled){
    enabled=!!enabled;const input=document.getElementById('debug-noclip');if(input)input.checked=enabled;
    if(enabled){
      if(!this.started||this.mode!=='driving'){if(input)input.checked=false;this.ui?.toast?.('NOCLIP AVAILABLE ON THE HIGHWAY','red');return;}
      const direction=new THREE.Vector3();this.camera.getWorldDirection(direction);this.debug.position.copy(this.camera.position);this.debug.yaw=Math.atan2(direction.x,direction.z);this.debug.pitch=Math.asin(clamp(direction.y,-1,1));this.debug.noclip=true;this.playerMesh.visible=false;this.debug.droneHUD?.classList.remove('hidden');this.ui?.toast?.('NOCLIP // DRONE ACTIVE','amber');
    }else if(this.debug.noclip){
      this.debug.noclip=false;document.exitPointerLock?.();const p=this.debug.position.clone(),info=this.map?.getRoadInfo?.(p)||null;
      if(info&&Number.isFinite(info.height)&&(info.worldDistance??0)<80)p.y=info.height+.65;
      const heading=this.debug.yaw;if(this.physics.setPosition)this.physics.setPosition(p.x,p.y,p.z,heading);else this.physics.reset?.(p,heading);
      this.mode='driving';this.playerMesh.visible=true;this.updatePlayerMesh();this.contactCooldown=1.2;this.snapDrivingCamera();this.debug.droneHUD?.classList.add('hidden');this.ui?.toast?.('NOCLIP OFF // CAR RESPAWNED HERE','amber');
    }
  }
  updateNoclip(dt){
    if(!this.debug.menuOpen){
      const turn=1.35*dt;if(this.keys.ArrowLeft)this.debug.yaw+=turn;if(this.keys.ArrowRight)this.debug.yaw-=turn;if(this.keys.ArrowUp)this.debug.pitch=clamp(this.debug.pitch+turn,-Math.PI*.49,Math.PI*.49);if(this.keys.ArrowDown)this.debug.pitch=clamp(this.debug.pitch-turn,-Math.PI*.49,Math.PI*.49);
      const forward=new THREE.Vector3(Math.sin(this.debug.yaw),0,Math.cos(this.debug.yaw)),right=new THREE.Vector3(-Math.cos(this.debug.yaw),0,Math.sin(this.debug.yaw));const speed=this.debug.moveSpeed*((this.keys.ShiftLeft||this.keys.ShiftRight)?3.5:1);
      const move=new THREE.Vector3();if(this.keys.KeyW)move.add(forward);if(this.keys.KeyS)move.sub(forward);if(this.keys.KeyD)move.add(right);if(this.keys.KeyA)move.sub(right);if(this.keys.Space||this.keys.KeyE)move.y+=1;if(this.keys.ControlLeft||this.keys.ControlRight||this.keys.KeyQ)move.y-=1;if(move.lengthSq())this.debug.position.addScaledVector(move.normalize(),speed*dt);
    }
    const cp=Math.cos(this.debug.pitch),look=new THREE.Vector3(Math.sin(this.debug.yaw)*cp,Math.sin(this.debug.pitch),Math.cos(this.debug.yaw)*cp);this.camera.position.copy(this.debug.position);this.camera.up.set(0,1,0);this.camera.lookAt(this.debug.position.clone().add(look));this.camera.fov=64;this.camera.updateProjectionMatrix();
    this.map?.update?.(this.debug.position,performance.now()/1000);if(!this.debug.trafficDisabled)this.traffic?.update?.(dt,{position:this.debug.position,previousPosition:this.debug.position,velocity:new THREE.Vector3(),heading:this.debug.yaw,width:1,length:1});
  }

  _debugMaterial(color,opacity=1){return new THREE.LineBasicMaterial({color,transparent:opacity<1,opacity,depthTest:false,depthWrite:false,toneMapped:false});}
  _buildRoadHitboxes(){
    const group=new THREE.Group(),positions=[];for(const route of this.map?.routes?.values?.()||[]){const frames=route.renderFrames||[],count=route.closed?frames.length:frames.length-1;for(let i=0;i<count;i++){const a=frames[i],b=frames[(i+1)%frames.length];if(!a||!b)continue;const point=(f,side)=>f.position.clone().addScaledVector(f.normal,side*f.half).add(new THREE.Vector3(0,.14+Math.tan(f.bank||0)*side*f.half,0)),al=point(a,-1),ar=point(a,1),bl=point(b,-1),br=point(b,1);for(const v of[al,ar,br,al,br,bl])positions.push(v.x,v.y,v.z);}}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0x39e6ff,wireframe:true,transparent:true,opacity:.52,depthTest:false,depthWrite:false,toneMapped:false}));mesh.renderOrder=998;group.add(mesh);return group;
  }
  _buildWallHitboxes(){
    const positions=[];for(const wall of this.map?.wallSegments||[]){const a=wall.start,b=wall.end,h=wall.height||1.2;if(!a||!b)continue;positions.push(a.x,a.y,a.z,b.x,b.y,b.z,a.x,a.y+h,a.z,b.x,b.y+h,b.z,a.x,a.y,a.z,a.x,a.y+h,a.z,b.x,b.y,b.z,b.x,b.y+h,b.z);}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));const lines=new THREE.LineSegments(geometry,this._debugMaterial(0xff365b,.9));lines.renderOrder=999;const group=new THREE.Group();group.add(lines);return group;
  }
  _buildServiceHitboxes(){
    const group=new THREE.Group(),material=this._debugMaterial(0xffd34f,.9);for(const area of this.map?.serviceAreas||[]){const edges=new THREE.EdgesGeometry(new THREE.BoxGeometry(area.width||20,6,area.length||30)),lines=new THREE.LineSegments(edges,material);lines.position.copy(area.center);lines.position.y=(area.elevation??area.center.y)+3;lines.rotation.y=Math.atan2(area.tangent?.x||0,area.tangent?.z||1);lines.renderOrder=999;group.add(lines);}return group;
  }
  _buildVehicleHitboxes(){const group=new THREE.Group();this.debug.playerHelper=new THREE.BoxHelper(this.playerMesh,0x7dff62);group.add(this.debug.playerHelper);this.debug.trafficHelpers=(this.traffic?.pool||[]).map(vehicle=>{const helper=new THREE.BoxHelper(vehicle.mesh,0xff9a2e);helper.visible=false;group.add(helper);return{vehicle,helper};});return group;}
  _disposeDebugGroup(group){if(!group)return;group.traverse(o=>{o.geometry?.dispose?.();if(o.material&&!Array.isArray(o.material))o.material.dispose?.();});group.removeFromParent();}
  setDebugHitbox(kind,enabled){
    if(!(kind in this.debug.hitboxes))return;this.debug.hitboxes[kind]=!!enabled;let layer=this.debug.layers[kind];if(enabled&&!layer){if(kind==='roads')layer=this._buildRoadHitboxes();else if(kind==='walls')layer=this._buildWallHitboxes();else if(kind==='services')layer=this._buildServiceHitboxes();else if(kind==='vehicles')layer=this._buildVehicleHitboxes();else layer=new THREE.Group();layer.name=`Debug ${kind}`;this.debug.layers[kind]=layer;this.debug.overlay.add(layer);}if(layer)layer.visible=!!enabled;if(kind==='world'&&enabled)this.debug.worldRefresh=Infinity;
  }
  _refreshWorldHitboxes(){
    const layer=this.debug.layers.world;if(!layer)return;for(const child of[...layer.children])this._disposeDebugGroup(child);const candidates=[];this.map?.group?.traverse?.(o=>{if(o.isMesh&&o.visible&&o.parent?.visible!==false)candidates.push(o);});const origin=this.debug.noclip?this.debug.position:this.camera.position;let count=0;for(const mesh of candidates){if(count>=120)break;mesh.geometry?.computeBoundingSphere?.();const center=mesh.geometry?.boundingSphere?.center?.clone?.();if(!center)continue;mesh.localToWorld(center);if(center.distanceToSquared(origin)>650*650)continue;const helper=new THREE.BoxHelper(mesh,0xb06cff);helper.material.depthTest=false;helper.material.transparent=true;helper.material.opacity=.48;helper.renderOrder=997;layer.add(helper);count++;}
  }
  updateDebugHitboxes(dt){
    if(this.debug.hitboxes.vehicles){this.debug.playerHelper?.update?.();if(this.debug.playerHelper)this.debug.playerHelper.visible=this.playerMesh.visible;for(const {vehicle,helper}of this.debug.trafficHelpers||[]){helper.visible=!!vehicle.active;if(vehicle.active)helper.update();}}
    if(this.debug.hitboxes.world){this.debug.worldRefresh+=dt;if(this.debug.worldRefresh>.45){this.debug.worldRefresh=0;this._refreshWorldHitboxes();}}
  }

  getVehicleState(){return this.physics.getState?.()||this.physics.state||this.physics;}
  getTelemetry(){const t=this.physics.getTelemetry?.()||this.physics.telemetry||{};const s=this.getVehicleState();const speedMS=Math.abs(t.speedMS??t.speed??s.speed??s.velocity?.length?.()??0),gear=t.gear??s.gear??1,slip=t.slip??t.slipAngle??Math.max(Math.abs(t.frontSlipAngle||0),Math.abs(t.rearSlipAngle||0),t.frontSaturation||0,t.rearSaturation||0);return{...t,speedMS,speedKmh:t.speedKmh??speedMS*3.6,rpm:t.rpm??s.rpm??900,gear,gearLabel:t.gearLabel??(gear===0?'N':gear<0?'R':String(gear)),redline:t.redline??this.getEffectiveCar().redline??7000,fuel:t.fuel??s.fuel??this.state.fuel,fuelFraction:t.fuelFraction??((t.fuel??s.fuel??this.state.fuel)/(this.getEffectiveCar().fuelCapacity||45)),slip,throttle:t.throttle??this.lastDriveInput?.throttle??0};}
  syncFuelFromPhysics(){const t=this.getTelemetry();if(Number.isFinite(t.fuel)){this.state.fuel=t.fuel;
    // Persist on a fixed 10 s cadence instead of randomly (~every 2.5 s at
    // 100 fps): persist() does two JSON serializations + two localStorage
    // writes on the main thread, which is a measurable frame stall. Fuel is
    // also persisted on tab hide, garage entry and every menu transaction,
    // so the longer interval risks nothing.
    const now=performance.now();if(!this._lastFuelPersist||now-this._lastFuelPersist>10000){this._lastFuelPersist=now;this.persist();}}}
  setPhysicsFuel(v){if(this.physics.state)this.physics.state.fuel=v;if('fuel'in this.physics)this.physics.fuel=v;this.state.fuel=v;}

  updateScoring(dt,t){
    if(t.speedKmh>=100){const flow=(t.speedKmh-85)*.21*this.run.combo;this.run.score+=flow*dt;}
    if(this.run.combo>1){this.run.comboTimer-=dt;if(this.run.comboTimer<=0){this.run.combo=Math.max(1,this.run.combo-dt*.85);if(this.run.combo<=1.01){this.run.combo=1;this.run.nearMisses=0;}}}
    this.run.comboTimerFraction=this.run.combo>1?clamp(this.run.comboTimer/4.5,0,1):0;
    this.run.bestRunCombo=Math.max(this.run.bestRunCombo,this.run.combo);this.state.records.bestCombo=Math.max(this.state.records.bestCombo||1,this.run.combo);
  }
  handleTrafficEvents(){
    let events=[];try{events=this.traffic?.consumeEvents?.()||this.traffic?.getEvents?.()||[];}catch(e){}
    for(const e of events){
      const type=(e.type||e.kind||'').toLowerCase();
      if(type.includes('near'))this.nearMiss(e);else if(type.includes('collision')||type.includes('contact'))this.registerContact('traffic',e);
    }
  }
  updateGhost(dt){
    const wasGhost=this.ghostTimer>0;this.ghostTimer=Math.max(0,this.ghostTimer-dt);
    if(this.playerMesh&&this.mode==='driving'&&!this.debug.noclip)this.playerMesh.visible=!this.ghostTimer||Math.floor(this.ghostTimer*8)%2===0;
    if(wasGhost&&!this.ghostTimer&&this.playerMesh&&!this.debug.noclip)this.playerMesh.visible=true;
  }
  nearMiss(e={}){const t=this.getTelemetry();if(t.speedKmh<100)return;const distance=e.distance??e.clearance??1.2;const base=e.points??Math.round(220+(t.speedKmh-100)*4+Math.max(0,1.5-distance)*420);this.run.combo=clamp(this.run.combo+.25+(distance<.65?.2:0),1,8);this.run.comboTimer=4.5;this.run.nearMisses++;const points=base*this.run.combo;this.run.score+=points;this.ui.nearMiss(points,distance<.65);this.audio?.nearMiss?.({side:e.side==='left'?-1:1,speedKmh:t.speedKmh,closeness:e.closeness??1-distance/2.25});}
  registerContact(kind,e={}){if(this.contactCooldown>0||this.ghostTimer>0||this.crash.active)return;this.contactCooldown=1.1;this.run.combo=1;this.run.comboTimer=0;this.run.nearMisses=0;const severity=Number.isFinite(e.severity)?e.severity:(e.intensity??4);const impact=clamp(severity/8,.4,2);this.audio?.crash?.(impact);
    // A light scrape only breaks the combo; a real impact costs one of the three
    // lives. Every registered contact then starts five seconds of blinking
    // invulnerability; traffic collision checks are disabled for that window.
    const serious=severity>2.5,lostLife=serious&&!this.admin.infiniteLives;
    if(lostLife)this.run.lives--;
    this.ghostTimer=5;
    if(kind!=='wall')this.physics.resolveCollision?.({...e,normal:e.normal||new THREE.Vector3(1,0,0),kind});
    if(this.run.lives<=0)this.beginCrash();
    else this.ui.toast(lostLife?`${kind.toUpperCase()} CONTACT // LIFE LOST // GHOST 5S`:serious?`${kind.toUpperCase()} CONTACT // GHOST 5S`:`${kind.toUpperCase()} SCRAPE // GHOST 5S`,'red');
  }
  beginCrash(){this.wasteRun();}
  updateCrash(){this.crash.active=false;this.wasteRun();}
  // The third life no longer starts a crash animation or relocates the car: it
  // only wipes the unbanked score and refills the three-hit counter.
  wasteRun(){this.crash.active=false;this.run.score=0;this.run.lives=3;this.ui.toast('WASTED // SCORE RESET — RESTART FROM 0','red');}

  resolveMapCollision(){
    const s=this.getVehicleState(),position=vec(s.position||s),previous=vec(s.previousPosition||position),velocity=vec(s.velocity||{});let hit=null;
    const wallRadius=Math.max(.62,(s.width||this.getEffectiveCar().width||1.7)*.46);
    try{hit=this.map?.sweepWallCollision?.(previous,position,velocity,wallRadius,2.5)||this.map?.resolveWallCollision?.(position,velocity,wallRadius);}catch(e){console.warn('Wall collision check',e);}
    if(hit&&(hit.collided??hit.hit??hit===true)){
      const detail=hit===true?{}:hit;
      if(detail.normal&&!Number.isFinite(detail.severity))detail.severity=Math.max(0,-vec(velocity).dot(vec(detail.normal)));
      if(hit.position){this.physics.position?.copy?.(hit.position);s.position?.copy?.(hit.position);}if(hit.velocity){this.physics.velocity?.copy?.(hit.velocity);s.velocity?.copy?.(hit.velocity);}
      this.registerContact('wall',detail);
    }
  }
  updateServices(t){
    const p=vec(this.getVehicleState().position||this.getVehicleState());let prox=this.map?.getServiceAreaProximity?.(p);
    if(Array.isArray(prox))prox=prox[0];const area=prox?.area||prox?.service||prox;const dist=prox?.distance??(area?.position?area.position.distanceTo?.(p):Infinity);const inside=!!(prox?.inside||area&&(dist<(area.radius||area.triggerRadius||22)));
    let interactAvailable=false;
    if(inside&&area){const id=area.id||area.name;if(this.lastService!==id){this.lastService=id;this.bankScore(area.name||'SERVICE AREA');this.autoRefuel(area);}
      if((area.garage||area.hasGarage||String(area.id).includes('garage'))&&t.speedKmh<12){interactAvailable=true;this.ui.prompt('<kbd>E</kbd> ENTER WANGAN WORKS GARAGE',true);if(this.take('KeyE'))this.enterGarage('service');}
    }else{if(this.lastService&&(!area||dist>(area.radius||30)+15))this.lastService=null;if(!this.ui.pcOpen)this.ui.prompt('',false);}
    if(!prox){let g=false;try{g=this.map?.checkGarageTransition?.(p,t.speedKmh);}catch(e){}if(g&&t.speedKmh<12){interactAvailable=true;this.ui.prompt('<kbd>E</kbd> ENTER GARAGE',true);if(this.take('KeyE'))this.enterGarage('service');}}
    document.body.classList.toggle('interact-available',interactAvailable);
  }
  bankScore(name){if(this.run.score<1)return;const earned=Math.floor(this.run.score*(Data.ECONOMY?.scoreToMoney??Data.SCORE_TO_MONEY??.42));this.state.money+=earned;this.state.records.bestScore=Math.max(this.state.records.bestScore||0,Math.floor(this.run.score));this.state.records.totalBanked=(this.state.records.totalBanked||0)+earned;this.ui.toast(`${name.toUpperCase()} // ${Math.floor(this.run.score).toLocaleString()} BANKED = ¥${earned.toLocaleString()}`,'amber');this.run.score=0;this.run.combo=1;this.run.comboTimer=0;this.run.nearMisses=0;this.persist();}
  autoRefuel(area){const car=this.getEffectiveCar(),capacity=car.fuelCapacity||45,needed=Math.max(0,capacity-this.state.fuel);if(needed<1)return;const cost=Math.ceil(needed*(Data.ECONOMY?.refuelPricePerLiter||Data.ECONOMY?.fuelPerLiter||170));if(this.state.money>=cost||this.admin.infiniteMoney){if(!this.admin.infiniteMoney)this.state.money-=cost;this.setPhysicsFuel(capacity);this.fuelWarned=false;this.ui.toast(`REFUELED ${needed.toFixed(1)}L // ¥${cost.toLocaleString()}`);this.persist();}else this.ui.toast('Not enough money to refuel','red');}

  updatePlayerMesh(){const s=this.getVehicleState(),p=vec(s.position||s);this.playerMesh.position.copy(p);this.playerMesh.rotation.y=(s.heading??s.yaw??0)+Math.PI;const steer=s.steerAngle??s.steering??0;for(const w of this.playerMesh.userData.frontWheels||[])w.rotation.y=steer;this.customCar?.object?.userData?.setSteering?.(steer);}
  updateCamera(dt,t){const s=this.getVehicleState(),p=vec(s.position||s),h=s.heading??s.yaw??0,f=new THREE.Vector3(Math.sin(h),0,Math.cos(h));let desired,look;
    this.syncPlayerVisuals();
    if(this.cameraMode==='hood'){desired=p.clone().addScaledVector(f,1.65).add(new THREE.Vector3(0,1.02,0));look=p.clone().addScaledVector(f,12).add(new THREE.Vector3(0,.9,0));}
    else if(this.cameraMode==='cockpit'){desired=p.clone().addScaledVector(f,.55).add(new THREE.Vector3(0,1.12,0));look=p.clone().addScaledVector(f,11).add(new THREE.Vector3(0,.9,0));}
    else{const lag=6.2+t.speedKmh*.01,road=this.currentRoadInfo;desired=p.clone().addScaledVector(f,-lag).add(new THREE.Vector3(0,road?.tunnel?1.95:2.7,0));look=p.clone().addScaledVector(f,3.5+t.speedKmh*.014).add(new THREE.Vector3(0,.62,0));}
    const a=1-Math.exp(-dt*(this.cameraMode==='chase'?8.5:18));this.camPos.lerp(desired,a);this.camLook.lerp(look,a);
    const maxPositionLag=this.cameraMode==='chase'?2.6:.7,maxLookLag=this.cameraMode==='chase'?3:1.2;
    if(this.camPos.distanceToSquared(desired)>maxPositionLag*maxPositionLag)this.camPos.sub(desired).setLength(maxPositionLag).add(desired);
    if(this.camLook.distanceToSquared(look)>maxLookLag*maxLookLag)this.camLook.sub(look).setLength(maxLookLag).add(look);
    this.camera.position.copy(this.camPos);this.camera.up.set(0,1,0);this.camera.lookAt(this.camLook);this.camera.fov=THREE.MathUtils.lerp(this.camera.fov,60+clamp(t.speedKmh/300,0,1)*17,1-Math.exp(-dt*4));this.camera.updateProjectionMatrix();
  }
  snapDrivingCamera(){const s=this.getVehicleState(),p=vec(s.position||s),h=s.heading??s.yaw??0,f=new THREE.Vector3(Math.sin(h),0,Math.cos(h)),road=this.map?.getRoadInfo?.(p),speed=this.getTelemetry().speedKmh||0;this.currentRoadInfo=road;
    if(this.cameraMode==='hood'){this.camPos.copy(p).addScaledVector(f,1.65).add(new THREE.Vector3(0,1.02,0));this.camLook.copy(p).addScaledVector(f,12).add(new THREE.Vector3(0,.9,0));}
    else if(this.cameraMode==='cockpit'){this.camPos.copy(p).addScaledVector(f,.55).add(new THREE.Vector3(0,1.12,0));this.camLook.copy(p).addScaledVector(f,11).add(new THREE.Vector3(0,.9,0));}
    else{const lag=6.2+speed*.01;this.camPos.copy(p).addScaledVector(f,-lag).add(new THREE.Vector3(0,road?.tunnel?1.95:2.7,0));this.camLook.copy(p).addScaledVector(f,3.5+speed*.014).add(new THREE.Vector3(0,.62,0));}
    this.syncPlayerVisuals();this.camera.position.copy(this.camPos);this.camera.up.set(0,1,0);this.camera.fov=64;this.camera.lookAt(this.camLook);this.camera.updateProjectionMatrix();}
  cycleCamera(){const modes=['chase','hood','cockpit'];this.cameraMode=modes[(modes.indexOf(this.cameraMode)+1)%modes.length];this.state.settings.camera=this.cameraMode;this.snapDrivingCamera();this.ui.toast(`CAMERA // ${this.cameraMode.toUpperCase()}`);this.persist();}
  recover(){const s=this.getVehicleState(),p=vec(s.position||s);const info=this.map?.getRoadInfo?.(p)||{};const target=vec(info.center||info.position||p);target.y=(info.height??target.y)+.6;const h=info.heading??s.heading??0;if(this.physics.setPosition)this.physics.setPosition(target.x,target.y,target.z,h);else this.physics.reset?.(target,h);this.run.score=Math.max(0,this.run.score-1000);this.run.combo=1;this.ui.toast('RECOVERED // −1,000 SCORE','red');}

  updateHUD(t,roadInfo){const s=this.getVehicleState();const route=roadInfo.route||roadInfo.routeName||roadInfo.routeId||'C1 INNER',area=roadInfo.district||roadInfo.segmentName||'SHUTO EXPRESSWAY';this.ui.updateHUD(t,this.run,{money:this.displayMoney(),routeName:typeof route==='string'?route:route.name,areaName:area});
    const mm=this.map?.getMinimapData?.()||this.map?.minimapData||null,services=this.map?.getServiceAreas?.()||this.map?.serviceAreas||this.map?.services||[];if(mm)this.ui.drawMinimap(mm,{x:vec(s.position||s).x,z:vec(s.position||s).z,heading:s.heading||0},services);
  }
  updateAudio(t,dt){try{this.audio?.update?.({rpm:t.rpm,redlineRpm:t.redline,speedKmh:t.speedKmh,throttle:t.throttle,slip:t.slip,turbo:this.getEffectiveCar().turbo||0,running:t.fuel>0,fuel:t.fuelFraction});}catch(e){} }
  render(){const scene=this.mode==='garage'?this.garageScene:this.roadScene;const t0=performance.now();this.renderer.render(scene,this.camera);this.frameProf.render+=performance.now()-t0;}
  renderQuality(){
    const q=this.state?.settings?.quality;if(['low','medium','high'].includes(q))return q;
    const legacy=+this.state?.settings?.resolution||480;return legacy<=320?'low':legacy>=640?'high':'medium';
  }
  resize(){
    // PS2-era target: near-native internal resolution. Low keeps weaker
    // devices playable, High is true device pixels.
    const q=this.renderQuality(),scale={low:.55,medium:.75,high:1}[q]||.75;
    const dpr=Math.min(window.devicePixelRatio||1,3);
    let w=Math.round(innerWidth*dpr*scale),h=Math.round(innerHeight*dpr*scale);
    // ~3.2 MP cap keeps 3x-DPR phones inside the fill-rate budget.
    const maxPixels=3200000;const px=w*h;if(px>maxPixels){const s=Math.sqrt(maxPixels/px);w=Math.round(w*s);h=Math.round(h*s);}
    w=Math.max(320,w);h=Math.max(200,h);
    this.renderer.setSize(w,h,false);
    this.camera.aspect=innerWidth/Math.max(1,innerHeight);this.camera.updateProjectionMatrix();
    this.canvas.style.imageRendering='auto';
    this.map?.setQuality?.(q);
    // Editor-imported textures are capped to a per-quality size so imported
    // 1000+ px images cannot blow VRAM on weak GPUs; cached textures re-upload
    // at the new cap when the player changes quality.
    setTextureSizeBudget({low:128,medium:256,high:512}[q]||256);
  }
  // The old PSX pass (vertex snap, 31-level posterize, nearest-filter mush) is
  // gone. This pass only normalizes textures for the clean PS2 look: bilinear
  // filtering + mipmaps + a touch of anisotropy so signs stay legible.
  applyRetroMaterials(scene){const maxAniso=this.renderer.capabilities.getMaxAnisotropy?.()||1;scene.traverse(o=>{if(!o.material)return;for(const m of(Array.isArray(o.material)?o.material:[o.material])){if(m.map){m.map.magFilter=THREE.LinearFilter;m.map.minFilter=THREE.LinearMipmapLinearFilter;m.map.generateMipmaps=true;m.map.anisotropy=Math.min(4,maxAniso);m.map.needsUpdate=true;}m.dithering=true;}});}

  createCarMesh(spec,player=false){
    // Physics/camera anchor only. The box-built fallback car was removed; the
    // PSX model loaded by loadCustomCar is the only vehicle geometry.
    const g=new THREE.Group(),d=spec.dimensions||{},L=d.length||4.25,W=d.width||1.7;
    if(player){const left=new THREE.SpotLight(0xffe4bd,900,58,.48,.72,1.35),right=left.clone();left.position.set(-W*.28,.72,-L*.49);right.position.set(W*.28,.72,-L*.49);left.target.position.set(-W*.28,.1,-28);right.target.position.set(W*.28,.1,-28);g.add(left,right,left.target,right.target);}
    g.userData.frontWheels=[];g.userData.visualMeshes=[];return g;
  }

  getOwnedBase(){const saved=this.state.ownedCar||{},id=this.state.ownedCarId||saved.carId||saved.id,base=this.catalog.find(c=>c.id===id)||saved||this.fallbackCar();return{...base,...saved,id:base.id||id,carId:id,color:saved.color||base.colors?.[0]||base.color,engine:{...(base.engine||{}),...(saved.engine||{})}};}
  getPartsForOwned(){const id=this.state.ownedCarId;const list=typeof Data.getPartsForCar==='function'?Data.getPartsForCar(id):this.partCatalog;return(list||[]).filter(p=>!p.carIds||p.carIds.includes(id)||p.universal);}
  getEffectiveCar(){
    const base=this.getOwnedBase(),parts=this.getPartsForOwned().filter(p=>this.state.installedParts.includes(p.id));
    if(typeof Data.buildVehicleStats==='function'){try{const v=Data.buildVehicleStats({...base,carId:this.state.ownedCarId,installedParts:this.state.installedParts},this.state.installedParts);return{...v,power:v.engine?.powerHp,horsepower:v.engine?.powerHp,peakTorque:v.engine?.peakTorqueNm,mass:v.massKg,fuelCapacity:v.fuelTankL,redline:v.engine?.redlineRpm,engineLayout:v.engine?.layout,gearRatios:v.transmission?.gears,finalDrive:v.transmission?.finalDrive,dimensions:{length:v.silhouette?.length,width:v.silhouette?.width,height:v.silhouette?.height},wheelbase:v.silhouette?.wheelbase,wheelRadius:v.silhouette?.wheelRadius,width:v.silhouette?.width,length:v.silhouette?.length};}catch(e){console.warn(e);}}
    if(typeof Data.applyParts==='function'){try{return Data.applyParts(base,parts);}catch(e){}}
    if(typeof Data.applyUpgrades==='function'){try{return Data.applyUpgrades(base,parts);}catch(e){}}
    const s=structuredClone(base);s.power=s.power||s.horsepower||s.engine?.horsepower||90;s.mass=s.mass||1050;s.tireGrip=s.tireGrip||s.grip||1;s.brakeForce=s.brakeForce||10500;s.suspensionStiffness=s.suspensionStiffness||1;
    for(const p of parts){const m=p.modifiers||p.delta||{};if(m.powerMultiplier)s.power*=m.powerMultiplier;if(m.power)s.power+=m.power;if(m.horsepower)s.power+=m.horsepower;if(m.massDelta)s.mass+=m.massDelta;if(m.mass&&m.mass<0)s.mass+=m.mass;if(m.gripMultiplier)s.tireGrip*=m.gripMultiplier;if(m.tireGrip)s.tireGrip+=m.tireGrip;if(m.brakeMultiplier)s.brakeForce*=m.brakeMultiplier;if(m.brakeForce&&m.brakeForce<100)s.brakeForce*=m.brakeForce;if(m.suspensionStiffness)s.suspensionStiffness*=m.suspensionStiffness;if(m.gearRatioMultiplier)s.gearRatioMultiplier=(s.gearRatioMultiplier||1)*m.gearRatioMultiplier;if(m.turbo||m.turboStage)s.turbo=Math.max(s.turbo||0,m.turbo||m.turboStage);}
    s.horsepower=s.power;return s;
  }
  refreshVehicle(){const spec=this.getEffectiveCar();this.physics?.changeSpec?.(spec);this.physics?.setCarSpec?.(spec);this.audio?.setVehicle?.(spec);if(this.playerMesh){this.roadScene.remove(this.playerMesh);this.playerMesh=this.createCarMesh(spec,true);this.roadScene.add(this.playerMesh);this.applyRetroMaterials(this.playerMesh);}this.setPhysicsFuel(Math.min(this.state.fuel,spec.fuelCapacity||45));this.garage?.refreshCar(spec);this.attachCustomCarVisual();}

  getPhoneContext(){return{runScore:this.run.score,combo:this.run.combo,bestCombo:this.state.records.bestCombo,bestScore:this.state.records.bestScore,money:this.displayMoney(),towCost:Data.ECONOMY?.towCost||2500,settings:this.state.settings,adminUnlocked:this.admin.unlocked,admin:this.admin};}
  getPCContext(){const owned=this.getOwnedBase(),parts=this.getPartsForOwned(),fuelCan=Data.CONSUMABLES?.[0];return{money:this.displayMoney(),owned,stats:this.getEffectiveCar(),fuel:this.state.fuel,installed:this.state.installedParts,installedNames:parts.filter(p=>this.state.installedParts.includes(p.id)).map(p=>p.name),parts,deliveries:this.state.deliveries,auctions:this.state.auctions.map(a=>({...a,mileage:a.mileage??a.mileageKm,grade:a.grade??a.conditionGrade,effectivePower:a.effectivePower??a.engine?.powerHp,car:{...(a.car||this.catalog.find(c=>c.id===a.carId)||a),color:a.color||(a.car?.color)}})),tradeValue:this.tradeValue(),fuelCan,fuelCanPrice:fuelCan?.price||1200};}
  displayMoney(){return this.admin.infiniteMoney?99999999:this.state.money;}
  tradeValue(){const c=this.getOwnedBase();if(typeof Data.calculateTradeValue==='function')return Math.floor(Data.calculateTradeValue({...c,carId:this.state.ownedCarId,installedParts:this.state.installedParts}));if(typeof Data.calculateTradeIn==='function')return Math.floor(Data.calculateTradeIn(c));return Math.floor((c.basePrice||c.price||90000)*.58);}
  buyCar(i){const a=this.state.auctions[i],car=a?.car||this.catalog.find(c=>c.id===a?.carId);if(!a||!car)return;const net=Math.max(0,(a.price||car.basePrice||car.price||0)-this.tradeValue());if(!this.admin.infiniteMoney&&this.state.money<net){this.ui.toast('Insufficient funds','red');return;}if(!this.admin.infiniteMoney)this.state.money-=net;const owned=Data.carFromAuctionListing?.(a)||{...car,carId:car.id,condition:a.condition??1,mileageKm:a.mileage??a.mileageKm??0,color:a.color||car.colors?.[0]};this.state.ownedCarId=car.id;this.state.ownedCar=owned;this.state.installedParts=[];this.state.deliveries=[];this.state.fuel=owned.fuelLiters??car.fuelTankL??car.fuelCapacity??50;this.persist();this.refreshVehicle();this.garage.syncDeliveries([]);this.ui.refreshPC(this.getPCContext());this.ui.toast(`${car.name} purchased // Trade complete`,'amber');}
  buyPart(i){const p=this.getPartsForOwned()[i];if(!p)return;if(this.state.installedParts.includes(p.id)||this.state.deliveries.some(d=>d.partId===p.id))return;if(!this.admin.infiniteMoney&&this.state.money<p.price){this.ui.toast('Insufficient funds','red');return;}if(!this.admin.infiniteMoney)this.state.money-=p.price;this.state.deliveries.push({id:`delivery-${Date.now()}-${i}`,partId:p.id,name:p.name,type:'part',readyAt:Date.now()+(this.admin.instantDelivery?0:3500)});this.persist();this.ui.refreshPC(this.getPCContext());this.ui.toast(`${p.name} ordered // Delivery incoming`);setTimeout(()=>this.makeDeliveriesReady(),3600);}
  buyFuelCan(){const can=Data.CONSUMABLES?.[0],price=can?.price||1200;if(!this.admin.infiniteMoney&&this.state.money<price){this.ui.toast('Insufficient funds','red');return;}if(!this.admin.infiniteMoney)this.state.money-=price;this.state.deliveries.push({id:`fuel-${Date.now()}`,partId:can?.id||'fuel-can',name:can?.name||'Fuel Can',liters:can?.liters||10,type:'fuel',readyAt:Date.now()+(this.admin.instantDelivery?0:2500)});this.persist();this.ui.refreshPC(this.getPCContext());this.ui.toast('Fuel can ordered');setTimeout(()=>this.makeDeliveriesReady(),2600);}
  availableDeliveries(){return this.state.deliveries.filter(d=>(d.readyAt||0)<=Date.now()||this.admin.instantDelivery);}
  makeDeliveriesReady(){if(!this.garage?.enabled)return;const ready=this.availableDeliveries();const signature=ready.map(d=>d.id).join('|');if(signature!==this.deliverySignature){this.deliverySignature=signature;this.garage.syncDeliveries(ready);if(ready.length)this.ui.toast(`${ready.length} delivery box${ready.length>1?'es':''} ready`);}}
  finishInstall(d){const idx=this.state.deliveries.findIndex(x=>x.id===d.id||x.partId===d.partId);if(idx>=0)this.state.deliveries.splice(idx,1);if(d.type==='fuel'||String(d.partId).includes('fuel-can')){const cap=this.getEffectiveCar().fuelCapacity||45,liters=d.liters||10;this.state.fuel=Math.min(cap,this.state.fuel+liters);this.setPhysicsFuel(this.state.fuel);this.fuelWarned=false;this.ui.toast(`Fuel can poured // +${liters}L`,'amber');}else if(!this.state.installedParts.includes(d.partId)){this.state.installedParts.push(d.partId);this.ui.toast(`${d.name} installed // Stats updated`,'amber');this.refreshVehicle();}this.persist();this.deliverySignature='';this.garage.syncDeliveries(this.availableDeliveries());this.ui.refreshPC(this.getPCContext());}

  changeSetting(k,v){this.state.settings[k]=v;if(k==='volume'){this.audio?.setVolume?.(v);this.audio?.setMasterVolume?.(v);}if(k==='camera'){this.cameraMode=v;if(this.mode==='driving')this.snapDrivingCamera();}if(k==='resolution'||k==='quality')this.resize();this.persist();this.audioClick();}
  unlockAdmin(ok){if(!ok)return;this.admin.unlocked=true;this.persist();this.ui.toast('ADMIN MODE UNLOCKED','amber');}
  adminToggle(k,v){const prop={money:'infiniteMoney',lives:'infiniteLives',fuel:'infiniteFuel'}[k]||k;this.admin[prop]=v;this.persist();this.ui.toast(`${prop.replace(/([A-Z])/g,' $1').toUpperCase()} ${v?'ON':'OFF'}`,'amber');}
  adminAction(a){if(a==='money')this.state.money+=100000;else if(a==='garage'){this.ui.closePhone();this.enterGarage('admin');}else if(a==='pc'){this.ui.closePhone();if(this.mode!=='garage')this.enterGarage('admin');setTimeout(()=>this.ui.openPC(this.getPCContext()),this.mode==='garage'?40:560);}else if(a==='highway'){this.ui.closePhone();if(this.mode==='garage')this.exitGarage();else{this.mode='driving';this.placeAtSpawn();this.snapDrivingCamera();this.contactCooldown=1.2;}}else if(a==='deliverybay'){this.ui.closePhone();if(this.mode==='garage'){this.makeDeliveriesReady();this.garage.position.set(-7.35,this.garage.playerHeight,9);this.garage.yaw=Math.PI/2;this.garage.pitch=0;}}else if(a==='carbay'){this.ui.closePhone();if(this.mode==='garage'){this.garage.position.set(0,this.garage.playerHeight,3.65);this.garage.yaw=0;this.garage.pitch=-.08;}}else if(a==='fuel'){this.setPhysicsFuel(this.getEffectiveCar().fuelCapacity||45);this.fuelWarned=false;}else if(a==='lives')this.run.lives=3;else if(a==='parts'){this.state.installedParts=this.getPartsForOwned().map(p=>p.id);this.refreshVehicle();}else if(a==='delivery'){this.admin.instantDelivery=true;this.state.deliveries.forEach(d=>d.readyAt=0);this.makeDeliveriesReady();}else if(a==='boost'){this.physics.setSpeed?.(69.44);this.physics.setVelocity?.(69.44);if(!this.physics.setVelocity&&this.physics.velocity){const h=this.getVehicleState().heading||0;this.physics.velocity.set(Math.sin(h)*69.44,0,Math.cos(h)*69.44);}}this.persist();if(!['garage','pc','highway','deliverybay','carbay'].includes(a))this.ui.openPhoneApp('admin');this.ui.toast(`ADMIN // ${a.toUpperCase()}`,'amber');}
  tow(){const cost=Data.ECONOMY?.towCost||2500;
    // Never refuse the tow: a broke player out of fuel on the expressway
    // would otherwise be soft-locked. Take whatever they can pay.
    const paid=this.admin.infiniteMoney?0:Math.min(cost,this.state.money);this.state.money-=paid;
    this.run.score=0;this.run.combo=1;this.fuelWarned=false;this.ui.closePhone();this.persist();this.enterGarage('tow');
    if(paid<cost)this.ui.toast(`Tow driver took your last ¥${paid.toLocaleString()}`,'red');}
  audioClick(){this.audio?.uiClick?.();}
}

try{window.shutoko=new ShutokoNights();}catch(error){
  console.error(error);const loading=document.getElementById('loading');if(loading){loading.innerHTML=`<b>BOOT ERROR</b><span>${error.message}</span>`;loading.style.color='#ff3951';}
}
