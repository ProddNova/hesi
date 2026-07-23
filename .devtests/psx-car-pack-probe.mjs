/**
 * PSXStyle player-car regression and performance budget.
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
    response.writeHead(200,{'content-type':MIME[extname(file)]||'application/octet-stream','cache-control':'no-store'});
    response.end(body);
  }catch{
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;

const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
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
const sampleFrames=async()=>page.evaluate(()=>new Promise(resolve=>{
  const samples=[];let previous;
  const frame=now=>{
    if(previous!==undefined)samples.push(now-previous);
    previous=now;
    if(samples.length>=30){
      samples.sort((a,b)=>a-b);
      resolve({p50:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)]});
    }else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}));

await page.goto(`http://127.0.0.1:${port}/`);
await page.evaluate(()=>localStorage.clear());
await page.reload();
await page.waitForFunction(()=>window.shutoko?.customCar?.status==='ready',null,{timeout:60000});
const boot=await page.evaluate(()=>{
  const game=window.shutoko;
  const anchorMeshes=game.playerMesh.children.filter(object=>object.isMesh).length;
  return{
    enabled:game.customCar.enabled,
    model:game.customCar.object?.userData.psxCarId,
    parent:game.customCar.object?.parent===game.playerMesh,
    options:document.querySelectorAll('#debug-custom-car-model option').length,
    selected:document.querySelector('#debug-custom-car-model')?.value,
    toggle:Boolean(document.querySelector('#debug-custom-car')),
    scale:Boolean(document.querySelector('#debug-custom-car-scale')),
    catalog:game.catalog.map(car=>car.name),
    auctions:game.state.auctions.length,
    settings:game.state.settings,
    anchorMeshes,
  };
});
check('Japan Sedan is the always-on default model',boot.enabled&&boot.model==='JapanSedan'&&boot.parent&&boot.selected==='JapanSedan');
check('Japan Sedan is the only playable catalog car',boot.catalog.length===1&&boot.catalog[0]==='Japan Sedan'&&boot.auctions===0,JSON.stringify(boot.catalog));
check('developer UI keeps only the model picker',boot.options===50&&!boot.toggle&&!boot.scale,`options: ${boot.options}`);
check('player anchor has no procedural rectangle meshes',boot.anchorMeshes===0,`meshes: ${boot.anchorMeshes}`);
check('save settings are migrated to the permanent PSX visual',boot.settings.customCar===true&&boot.settings.customCarModel==='JapanSedan'&&boot.settings.customCarVersion===1);
check('default load fetches one body and one wheel',new Set(packRequests).size===2,`unique requests: ${new Set(packRequests).size}`);

await page.click('#new-game-button');
await page.waitForFunction(()=>window.shutoko.mode==='garage'&&window.shutoko.customCar.status==='ready'
  &&window.shutoko.customCar.object?.parent===window.shutoko.garage.carDisplay,null,{timeout:60000});
await page.waitForTimeout(300);
const garage=await page.evaluate(()=>{
  const game=window.shutoko,car=game.customCar.object;
  return{
    id:car.userData.psxCarId,
    stats:car.userData.psxStats,
    parent:car.parent===game.garage.carDisplay,
    visible:car.visible&&game.garage.carDisplay.visible,
    collider:game.garage.colliders.some(box=>{
      const bounds=box.clone();
      const carBox=new box.constructor().setFromObject(game.garage.carDisplay);
      return bounds.intersectsBox(carBox);
    }),
    proceduralChildren:game.garage.parkedGroup.children.length,
    proceduralVisible:game.garage.parkedGroup.visible,
    geometries:game.renderer.info.memory.geometries,
    textures:game.renderer.info.memory.textures,
  };
});
check('garage renders Japan Sedan under the showroom anchor',garage.id==='JapanSedan'&&garage.parent&&garage.visible);
check('garage has no procedural fallback car',garage.proceduralChildren===0&&!garage.proceduralVisible);
check('Japan Sedan creates the garage walk collider',garage.collider);
check('default car stays inside geometry budget',garage.stats?.triangles<18000&&garage.stats?.drawCalls<=10,JSON.stringify(garage.stats));
await page.screenshot({path:join(OUT,'psx-car-pack-garage.png')});

await page.evaluate(()=>window.shutoko.toggleDebugMenu(true));
await page.selectOption('#debug-custom-car-model','JapanSportCoupe');
await page.waitForFunction(()=>window.shutoko.customCar.object?.userData.psxCarId==='JapanSportCoupe',null,{timeout:30000});
const switched=await page.evaluate(()=>({
  id:window.shutoko.customCar.object?.userData.psxCarId,
  model:window.shutoko.state.settings.customCarModel,
  geometries:window.shutoko.renderer.info.memory.geometries,
}));
check('picker changes the live car and persisted selection',switched.id==='JapanSportCoupe'&&switched.model==='JapanSportCoupe');
check('switch disposes the previous geometry',switched.geometries<=garage.geometries+2,`${garage.geometries} -> ${switched.geometries}`);

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
  await game.setCustomCarModel('JapanSedan',{persist:false,silent:true});
  return{count:ids.length,failed,maxTriangles,maxTriangleModel,maxDrawCalls};
});
check('all 50 picker models parse and swap successfully',catalog.count===50&&catalog.failed.length===0,catalog.failed.join(', '));
check('entire picker catalog respects the low-poly budget',catalog.maxTriangles<18000&&catalog.maxDrawCalls<=16,`${catalog.maxTriangles} tri (${catalog.maxTriangleModel}) · ${catalog.maxDrawCalls} draw max`);
await page.evaluate(()=>window.shutoko.toggleDebugMenu(false));

await page.evaluate(()=>window.shutoko.exitGarage());
await page.waitForFunction(()=>window.shutoko.mode==='driving'&&window.shutoko.customCar.object?.parent===window.shutoko.playerMesh,null,{timeout:10000});
await page.waitForTimeout(500);
const road=await page.evaluate(()=>{
  const game=window.shutoko;
  const anchorMeshes=game.playerMesh.children.filter(object=>object.isMesh).length;
  return{
    id:game.customCar.object?.userData.psxCarId,
    visible:game.customCar.object?.visible,
    parent:game.customCar.object?.parent===game.playerMesh,
    anchorMeshes,
    calls:game.renderer.info.render.calls,
    triangles:game.renderer.info.render.triangles,
    textures:game.renderer.info.memory.textures,
  };
});
const roadTiming=await sampleFrames();
check('road uses the same Japan Sedan with no rectangle fallback',road.id==='JapanSedan'&&road.visible&&road.parent&&road.anchorMeshes===0);
check('road frame timing remains finite after catalog swaps',Number.isFinite(roadTiming.p50)&&roadTiming.p50<500,`p50 ${roadTiming.p50.toFixed(1)} ms · p95 ${roadTiming.p95.toFixed(1)} ms`);
await page.screenshot({path:join(OUT,'psx-car-pack-road.png')});
check('no browser console errors',errors.length===0,errors.slice(0,3).join(' | '));

await browser.close();
server.close();
const failed=results.filter(result=>!result.ok);
console.log(JSON.stringify({garage,road,roadTiming,packRequests:new Set(packRequests).size,failed:failed.length},null,2));
process.exit(failed.length?1:0);
