/**
 * PSXStyle custom-car regression and performance budget.
 *
 * Run from repo root: node .devtests/psx-car-pack-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const OUT=join(ROOT,'.devtests','shots');
await mkdir(OUT,{recursive:true});
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.obj':'text/plain','.webmanifest':'application/manifest+json'};
const server=createServer(async(request,response)=>{
  try{
    const path=decodeURIComponent(request.url.split('?')[0]);
    const file=path==='/'?'/index.html':path;
    const body=await readFile(join(ROOT,file));
    response.writeHead(200,{'content-type':MIME[extname(file)]||'application/octet-stream'});
    response.end(body);
  }catch{
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;

const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const context=await browser.newContext({viewport:{width:844,height:390},deviceScaleFactor:2,isMobile:true,hasTouch:true});
await context.route('https://cdn.jsdelivr.net/**',async route=>{
  const url=new URL(route.request().url());
  const relative=url.pathname.replace(/^\/npm\/three@[^/]+\//,'');
  try{
    const body=await readFile(join(ROOT,'node_modules','three',relative));
    await route.fulfill({status:200,contentType:'text/javascript',body});
  }catch{
    await route.fulfill({status:404,body:'not found'});
  }
});

const page=await context.newPage();
const errors=[];
const packRequests=[];
page.on('dialog',dialog=>dialog.accept());
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('pageerror',error=>errors.push(String(error)));
page.on('request',request=>{if(request.url().includes('/3d/PSXStyleCars-DevEdition/'))packRequests.push(request.url());});
const results=[];
const check=(name,ok,detail='')=>{
  results.push({name,ok,detail});
  console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?` — ${detail}`:''}`);
};
const sampleFrames=async()=>{
  const deltas=await page.evaluate(()=>new Promise(resolve=>{
    const samples=[];let previous;
    const frame=now=>{
      if(previous!==undefined)samples.push(now-previous);
      previous=now;
      if(samples.length>=30)resolve(samples);else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  deltas.sort((a,b)=>a-b);
  return{p50:deltas[Math.floor(deltas.length*.5)],p95:deltas[Math.floor(deltas.length*.95)]};
};

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(()=>window.shutoko?.map,null,{timeout:30000});
const boot=await page.evaluate(()=>({
  enabled:window.shutoko.customCar.enabled,
  object:!!window.shutoko.customCar.object,
  options:document.querySelectorAll('#debug-custom-car-model option').length,
}));
check('boot does not create a pack car',!boot.enabled&&!boot.object);
check('developer menu exposes all 50 OBJ cars',boot.options===50,`options: ${boot.options}`);
check('boot downloads no pack model',packRequests.length===0,`requests: ${packRequests.length}`);

await page.tap('#new-game-button');
await page.waitForFunction(()=>window.shutoko.mode==='garage',null,{timeout:10000});
await page.waitForTimeout(300);
const garageOff=await page.evaluate(()=>({
  object:!!window.shutoko.customCar.object,
  procedural:window.shutoko.garage.parkedGroup.visible,
  geometries:window.shutoko.renderer.info.memory.geometries,
  textures:window.shutoko.renderer.info.memory.textures,
}));
check('disabled state keeps procedural garage car',!garageOff.object&&garageOff.procedural);

await page.evaluate(()=>window.shutoko.setCustomCarEnabled(true));
await page.waitForFunction(()=>window.shutoko.customCar.status==='ready',null,{timeout:30000});
await page.waitForTimeout(300);
const garageOn=await page.evaluate(()=>{
  const game=window.shutoko,car=game.customCar.object;
  const center=car?.getWorldPosition(new car.position.constructor());
  return{
    id:car?.userData.psxCarId,
    stats:car?.userData.psxStats,
    parent:car?.parent===game.garage.carDisplay,
    visible:car?.visible,
    collider:!!center&&game.garage.colliders.some(box=>center.x>=box.min.x&&center.x<=box.max.x&&center.z>=box.min.z&&center.z<=box.max.z),
    procedural:game.garage.parkedGroup.visible,
    geometries:game.renderer.info.memory.geometries,
    textures:game.renderer.info.memory.textures,
  };
});
check('selected PSX car replaces garage fallback',garageOn.id==='JapanLegendaryDrifter'&&garageOn.parent&&garageOn.visible&&!garageOn.procedural);
check('selected PSX garage car has a walk collider',garageOn.collider);
check('default car stays inside geometry budget',garageOn.stats?.triangles<10000&&garageOn.stats?.drawCalls<=10,JSON.stringify(garageOn.stats));
check('PSX car allocates no GPU textures',garageOn.textures===garageOff.textures,`${garageOff.textures} -> ${garageOn.textures}`);
check('lazy load fetches one body and one wheel',new Set(packRequests).size===2,`unique requests: ${new Set(packRequests).size}`);

await page.evaluate(()=>window.shutoko.toggleDebugMenu(true));
await page.selectOption('#debug-custom-car-model','JapanSportCoupe');
await page.waitForFunction(()=>window.shutoko.customCar.object?.userData.psxCarId==='JapanSportCoupe',null,{timeout:30000});
await page.screenshot({path:join(OUT,'psx-car-pack-menu.png')});
await page.evaluate(()=>window.shutoko.toggleDebugMenu(false));
await page.waitForTimeout(300);
const switched=await page.evaluate(()=>({
  id:window.shutoko.customCar.object?.userData.psxCarId,
  model:window.shutoko.state.settings.customCarModel,
  stats:window.shutoko.customCar.object?.userData.psxStats,
  geometries:window.shutoko.renderer.info.memory.geometries,
}));
check('menu changes the live car and persisted selection',switched.id==='JapanSportCoupe'&&switched.model==='JapanSportCoupe');
check('switch disposes the previous geometry',switched.geometries<=garageOn.geometries+2,`${garageOn.geometries} -> ${switched.geometries}`);

const catalog=await page.evaluate(async()=>{
  const game=window.shutoko,ids=[...document.querySelectorAll('#debug-custom-car-model option')].map(option=>option.value);
  const failed=[];let maxTriangles=0,maxTriangleModel='',maxDrawCalls=0;
  for(const id of ids){
    await game.setCustomCarModel(id,{persist:false,silent:true});
    const car=game.customCar.object,stats=car?.userData?.psxStats;
    if(car?.userData?.psxCarId!==id)failed.push(id);
    if((stats?.triangles||0)>maxTriangles){maxTriangles=stats.triangles;maxTriangleModel=id;}
    maxDrawCalls=Math.max(maxDrawCalls,stats?.drawCalls||0);
  }
  return{count:ids.length,failed,maxTriangles,maxTriangleModel,maxDrawCalls};
});
check('all 50 catalog cars parse and swap successfully',catalog.count===50&&catalog.failed.length===0,catalog.failed.join(', '));
check('entire catalog respects the low-poly budget',catalog.maxTriangles<18000&&catalog.maxDrawCalls<=16,`${catalog.maxTriangles} tri (${catalog.maxTriangleModel}) · ${catalog.maxDrawCalls} draw max`);

await page.evaluate(()=>window.shutoko.setCustomCarEnabled(false));
await page.waitForTimeout(300);
const released=await page.evaluate(()=>({
  object:!!window.shutoko.customCar.object,
  procedural:window.shutoko.garage.parkedGroup.visible,
  geometries:window.shutoko.renderer.info.memory.geometries,
}));
check('disable removes pack car and restores fallback',!released.object&&released.procedural);
check('disable releases pack geometries from GPU',released.geometries<=garageOff.geometries+1,`${garageOff.geometries} -> ${released.geometries}`);

await page.evaluate(()=>window.shutoko.exitGarage());
await page.waitForFunction(()=>window.shutoko.mode==='driving',null,{timeout:10000});
await page.waitForTimeout(500);
const roadOff=await page.evaluate(()=>({
  calls:window.shutoko.renderer.info.render.calls,
  triangles:window.shutoko.renderer.info.render.triangles,
  textures:window.shutoko.renderer.info.memory.textures,
}));
const roadOffTiming=await sampleFrames();
await page.evaluate(()=>window.shutoko.setCustomCarEnabled(true));
await page.waitForFunction(()=>window.shutoko.customCar.status==='ready',null,{timeout:30000});
await page.waitForTimeout(500);
const roadOn=await page.evaluate(()=>({
  calls:window.shutoko.renderer.info.render.calls,
  triangles:window.shutoko.renderer.info.render.triangles,
  textures:window.shutoko.renderer.info.memory.textures,
  stats:window.shutoko.customCar.object?.userData.psxStats,
}));
const roadOnTiming=await sampleFrames();
check('enabled car adds at most 8 road draw calls',roadOn.calls<=roadOff.calls+8,`${roadOff.calls} -> ${roadOn.calls}`);
check('enabled car adds fewer than 10k road triangles',roadOn.triangles<=roadOff.triangles+10000,`${roadOff.triangles} -> ${roadOn.triangles}`);
check('road car still adds no textures',roadOn.textures===roadOff.textures,`${roadOff.textures} -> ${roadOn.textures}`);
check('pack car avoids a frame-time cliff',roadOnTiming.p50<=roadOffTiming.p50*1.35+5,`p50 ${roadOffTiming.p50.toFixed(1)} -> ${roadOnTiming.p50.toFixed(1)} ms`);
await page.screenshot({path:join(OUT,'psx-car-pack-road.png')});

await page.evaluate(()=>window.shutoko.setCustomCarEnabled(false));
await page.waitForTimeout(300);
const roadReleased=await page.evaluate(()=>({
  object:!!window.shutoko.customCar.object,
  calls:window.shutoko.renderer.info.render.calls,
  triangles:window.shutoko.renderer.info.render.triangles,
}));
check('road disable returns to procedural render cost',!roadReleased.object&&roadReleased.calls<=roadOff.calls+1&&Math.abs(roadReleased.triangles-roadOff.triangles)<100,`${roadOff.calls}/${roadOff.triangles} -> ${roadReleased.calls}/${roadReleased.triangles}`);
check('no browser console errors',errors.length===0,errors.slice(0,3).join(' | '));

await browser.close();
server.close();
const failed=results.filter(result=>!result.ok);
console.log(JSON.stringify({roadOff,roadOn,roadOffTiming,roadOnTiming,packRequests:new Set(packRequests).size,failed:failed.length},null,2));
process.exit(failed.length?1:0);
