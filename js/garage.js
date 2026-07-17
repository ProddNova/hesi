import * as THREE from 'three';
import { createGarageTextures } from './textures.js';

const V = (x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);

export class GarageSystem {
  constructor(scene, camera, canvas, callbacks={}) {
    this.scene=scene; this.camera=camera; this.canvas=canvas; this.cb=callbacks;
    this.enabled=false; this.position=V(0,1.72,7); this.yaw=0; this.pitch=0;
    this.velocity=V(); this.interactCooldown=0; this.carMesh=null; this.deliveryMeshes=[];
    this.carried=null; this.installing=null; this.mouse={x:0,y:0}; this._pointerHandler=e=>this.onMouse(e);
    this.build(); this.bind();
  }

  mat(color, emissive=0, intensity=0){return new THREE.MeshLambertMaterial({color,emissive,emissiveIntensity:intensity,flatShading:true});}
  mesh(geo,mat,pos,rot=V()){const o=new THREE.Mesh(geo,mat);o.position.copy(pos);o.rotation.set(rot.x,rot.y,rot.z);this.root.add(o);return o;}

  build(){
    // Room shell with explicit clearances: no coplanar faces anywhere.
    // All interaction points are unchanged: PC (7.5,-9.3), exit (0,12.6+),
    // car footprint at the origin, delivery zone (-7.2,10.3), walk clamps
    // +/-10.25 x and +/-13.1 z. Visual language matches the world pass:
    // pixel-tile concrete, baked paint, low-res posters, boxy clutter.
    this.scene.background=new THREE.Color(0x05070b);this.scene.fog=new THREE.Fog(0x05070b,18,36);
    this.root=new THREE.Group();this.scene.add(this.root);
    this.tex=createGarageTextures?.()||null;
    const texMat=(t,extra={})=>this.tex?new THREE.MeshLambertMaterial({map:t,...extra}):this.mat(extra.fallback??0x22272c);
    // Floor: whole-room pixel concrete with slab joints, painted work bay
    // around the car and scuff lanes toward the shutter (baked, no grid).
    this.mesh(new THREE.PlaneGeometry(22,28,1,1),texMat(this.tex?.floor,{fallback:0x22272c}),V(0,0,0),V(-Math.PI/2,0,0));
    // Structural shell: side walls (inner face x=+/-10.825), back wall (inner
    // face z=-13.825), ceiling resting ON the wall tops (bottom face y=10.02).
    let wallMat=this.mat(0x252a2f);
    if(this.tex){const wallTex=this.tex.wall.clone();wallTex.wrapS=THREE.RepeatWrapping;wallTex.wrapT=THREE.ClampToEdgeWrapping;wallTex.repeat.set(6,1);wallTex.needsUpdate=true;wallMat=new THREE.MeshLambertMaterial({map:wallTex});}
    this.mesh(new THREE.BoxGeometry(.35,10,28.7),wallMat,V(-11,5,0));
    this.mesh(new THREE.BoxGeometry(.35,10,28.7),wallMat,V(11,5,0));
    this.mesh(new THREE.BoxGeometry(21.65,10,.35),wallMat,V(0,5,-14));
    this.mesh(new THREE.BoxGeometry(22.7,.35,28.7),this.mat(0x15191d),V(0,10.2,0));
    // Front wall around the shutter opening (|x|<4, y<5): two piers + lintel.
    this.mesh(new THREE.BoxGeometry(6.65,10,.35),wallMat,V(-7.325,5,14));
    this.mesh(new THREE.BoxGeometry(6.65,10,.35),wallMat,V(7.325,5,14));
    this.mesh(new THREE.BoxGeometry(8.3,5,.35),wallMat,V(0,7.5,14));
    // Interior trim beams + ceiling cable trays with drop conduits.
    this.mesh(new THREE.BoxGeometry(21.4,.4,.3),this.mat(0x30343a),V(0,5.1,-13.55));
    this.mesh(new THREE.BoxGeometry(21.4,.4,.3),this.mat(0x30343a),V(0,5.1,13.55));
    for(const x of [-8.2,8.2])this.mesh(new THREE.BoxGeometry(.5,.12,27),this.mat(0x3a4046),V(x,9.9,0));
    this.mesh(new THREE.BoxGeometry(.09,8.8,.09),this.mat(0x3a4046),V(-10.6,5.4,-10.5));
    this.mesh(new THREE.BoxGeometry(.09,8.8,.09),this.mat(0x3a4046),V(10.6,5.4,-6.5));
    for(const s of [-1,1]){
      this.mesh(new THREE.BoxGeometry(.06,1.6,27),this.mat(0x7b2729),V(s*10.77,1.15,0));
      for(let z=-11;z<13;z+=4)this.mesh(new THREE.BoxGeometry(.07,3.2,3.5),this.mat(0x33383d),V(s*10.77,6.4,z));
    }
    // Fluorescent fixtures: 8 emissive tubes, 4 real lights (alternating) —
    // half the point-light cost of the old room, same perceived coverage.
    let fixtureIndex=0;
    for(const z of [-9,-3,3,9]) for(const x of [-5.5,5.5]){
      this.mesh(new THREE.BoxGeometry(4,.1,.35),this.mat(0xeaf5e5,0xeaf5e5,2),V(x,9.69,z));
      if(fixtureIndex%2===0){const light=new THREE.PointLight(0xd8e8dc,15,16,1.8);light.position.set(x,8.8,z);this.root.add(light);}
      fixtureIndex+=1;
    }
    const warm=new THREE.PointLight(0xff762e,10,11,1.6);warm.position.set(-8,4,-10);this.root.add(warm);
    // Shutter: slat texture on the door body (baked slats, no strip meshes).
    this.shutter=this.mesh(new THREE.BoxGeometry(7.9,5,.25),texMat(this.tex?.shutter,{fallback:0x42484d}),V(0,2.5,13.82));
    this.exitGlow=this.mesh(new THREE.PlaneGeometry(4.5,2.2),new THREE.MeshBasicMaterial({color:0xff8d2c,transparent:true,opacity:.12,side:THREE.DoubleSide}),V(0,1.1,13.48),V(0,0,0));
    // Workbench, pegboard tools and compressor.
    this.mesh(new THREE.BoxGeometry(7,.25,1.8),this.mat(0x584333),V(-7.2,1.1,-8));
    for(const x of [-9.8,-4.6])this.mesh(new THREE.BoxGeometry(.22,2,.22),this.mat(0x2b3036),V(x,1,-8));
    this.mesh(new THREE.BoxGeometry(6.6,2.6,.12),this.mat(0x303842),V(-7.2,3,-8.85));
    for(let i=0;i<7;i++)this.mesh(new THREE.BoxGeometry(.08,.8,.08),this.mat(i%2?0xe3b038:0xb9483d),V(-9.4+i*.72,3.1,-8.74),V(0,0,(i-.3)*.08));
    // shelf above the bench: paint cans + small boxes
    this.mesh(new THREE.BoxGeometry(6.6,.08,.55),this.mat(0x4a5058),V(-7.2,4.4,-8.7));
    for(let i=0;i<5;i++)this.mesh(new THREE.CylinderGeometry(.16,.16,.36,8),this.mat([0xb8bcc4,0x8a3636,0x365e8a,0x8a8452,0x4a6a3a][i]),V(-9.4+i*1.1,4.62,-8.7));
    this.mesh(new THREE.CylinderGeometry(.7,.7,1.8,8),this.mat(0x9b2b34),V(8.7,.9,-9),V(0,0,Math.PI/2));
    this.mesh(new THREE.CylinderGeometry(.32,.32,.1,10),this.mat(0x22262b),V(8.7,1.9,-9));
    // Desk + chunky computer.
    this.mesh(new THREE.BoxGeometry(4,.25,2),this.mat(0x4b3d32),V(7.5,1.05,-10.2));
    for(const x of [6,9])this.mesh(new THREE.BoxGeometry(.18,2,.18),this.mat(0x242a31),V(x,1,-10.2));
    this.mesh(new THREE.BoxGeometry(1.9,1.5,1.25),this.mat(0x9d998b),V(7.5,2,-10.55));
    this.pcScreen=this.mesh(new THREE.PlaneGeometry(1.5,1),new THREE.MeshBasicMaterial({color:0x39d6e8}),V(7.5,2.08,-9.91),V(0,0,0));
    this.mesh(new THREE.BoxGeometry(1.9,.12,.7),this.mat(0x9d998b),V(7.5,1.28,-9.55),V(.12,0,0));
    // Steel shelving + boxed clutter: two units on the back wall, two on the
    // left wall, one right — instanced crates/tires/drums keep it cheap.
    this.buildShelving();
    // Delivery area paint and sign.
    this.mesh(new THREE.PlaneGeometry(6,5),new THREE.MeshBasicMaterial({color:0xe7b941,transparent:true,opacity:.15,side:THREE.DoubleSide}),V(-7.2,.015,10.3),V(-Math.PI/2,0,0));
    const edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(6,.03,5)),new THREE.LineBasicMaterial({color:0xe8c14a}));edge.position.set(-7.2,.03,10.3);this.root.add(edge);
    this.addSign('DELIVERY / 配達',V(-10.68,4,9.8),Math.PI/2,0xe9b947);
    this.addSign('WANGAN WORKS',V(-10.68,5,-2),Math.PI/2,0xe7e9e2);
    this.addSign('禁煙 NO SMOKING',V(10.68,4.4,2),-Math.PI/2,0xd84848);
    // Posters (low-res prints) on the walls.
    if(this.tex){
      const poster=(t,pos,ry)=>{const m=this.mesh(new THREE.PlaneGeometry(1.5,2),new THREE.MeshLambertMaterial({map:t}),pos,V(0,ry,0));return m;};
      poster(this.tex.posterTires,V(-10.79,3.4,-5.5),Math.PI/2);
      poster(this.tex.posterNight,V(-10.79,3.6,3.2),Math.PI/2);
      poster(this.tex.posterSafety,V(4.2,3.6,-13.79),0);
    }
    this.parkedGroup=new THREE.Group();this.parkedGroup.position.set(0,.05,0);this.root.add(this.parkedGroup);
    this.carryAnchor=new THREE.Group();this.carryAnchor.position.set(.45,-.45,-1);this.camera.add(this.carryAnchor);this.scene.add(this.camera);
  }

  buildShelving(){
    const shelfUnits=[
      {x:-1.4,z:-13.35,ry:0},{x:2.4,z:-13.35,ry:0},
      {x:-10.45,z:-2.5,ry:Math.PI/2},{x:-10.45,z:3.6,ry:Math.PI/2},
      {x:10.45,z:6.8,ry:-Math.PI/2},
    ];
    const frameMat=this.mat(0x37507a),plankMat=this.mat(0x555c66);
    for(const u of shelfUnits){
      const g=new THREE.Group();g.position.set(u.x,0,u.z);g.rotation.y=u.ry;this.root.add(g);
      for(const px of [-1.35,1.35])for(const pz of [-.28,.28]){
        const post=new THREE.Mesh(new THREE.BoxGeometry(.07,2.3,.07),frameMat);post.position.set(px,1.15,pz);g.add(post);
      }
      for(const py of [.4,1.15,1.9]){
        const plank=new THREE.Mesh(new THREE.BoxGeometry(2.8,.06,.66),plankMat);plank.position.set(0,py,0);g.add(plank);
      }
    }
    // Instanced crates on shelves + floor stacks by the delivery zone.
    const crateMat=this.tex?new THREE.MeshLambertMaterial({map:this.tex.crate}):this.mat(0xa77a43);
    const crates=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),crateMat,34);
    const tmpM=new THREE.Matrix4(),tmpQ=new THREE.Quaternion(),tmpS=new THREE.Vector3(),tmpP=new THREE.Vector3();
    let ci=0;const seed=(n)=>{const x=Math.sin(n*127.1)*43758.5453;return x-Math.floor(x);};
    const crateAt=(x,y,z,ry,s)=>{if(ci>=34)return;tmpQ.setFromAxisAngle(V(0,1,0),ry);tmpS.setScalar(s);tmpS.y=s*.78;tmpP.set(x,y,z);tmpM.compose(tmpP,tmpQ,tmpS);crates.setMatrixAt(ci,tmpM);ci+=1;};
    for(const [ui,u] of shelfUnits.entries()){
      const along=u.ry===0?V(1,0,0):V(0,0,u.ry>0?-1:1);
      for(const py of [.47,1.22,1.97]){
        const n=1+Math.floor(seed(ui*7+py*13)*3);
        for(let i=0;i<n;i+=1){
          const off=(i-(n-1)/2)*.92+(seed(ui*31+i*17+py)*0.2-0.1);
          crateAt(u.x+along.x*off,py+.3,u.z+along.z*off,seed(ui*11+i)*0.5-0.25,.62+seed(ui+i*3)*.24);
        }
      }
    }
    crateAt(-9.3,.42,7.4,.2,.84);crateAt(-9.3,1.2,7.5,.5,.7);crateAt(-8.3,.4,6.6,-.3,.76);
    crates.instanceMatrix.needsUpdate=true;this.root.add(crates);
    // Instanced tires: two floor stacks + shelf row.
    const tires=new THREE.InstancedMesh(new THREE.CylinderGeometry(.34,.34,.23,10),this.mat(0x0c0e10),14);
    let ti=0;const tireAt=(x,y,z)=>{if(ti>=14)return;tmpQ.identity();tmpS.setScalar(1);tmpP.set(x,y,z);tmpM.compose(tmpP,tmpQ,tmpS);tires.setMatrixAt(ti,tmpM);ti+=1;};
    for(let i=0;i<4;i+=1)tireAt(9.7,.14+i*.24,3.2);
    for(let i=0;i<3;i+=1)tireAt(9.1,.14+i*.24,4.1);
    for(let i=0;i<3;i+=1)tireAt(-10.45,2.32,-2.9+i*.75);
    tires.instanceMatrix.needsUpdate=true;this.root.add(tires);
    // Drums in the back-right corner.
    for(const [i,c] of [0x365e8a,0x8a3636,0x7a7d82].entries()){
      this.mesh(new THREE.CylinderGeometry(.31,.31,.95,8),this.mat(c),V(9.6+((i%2)*-.75),.48,-12.6+i*.7));
    }
  }

  addSign(text,pos,ry=0,color=0xffffff){
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=96;const c=canvas.getContext('2d');c.fillStyle='#15191f';c.fillRect(0,0,512,96);c.strokeStyle=`#${color.toString(16).padStart(6,'0')}`;c.lineWidth=5;c.strokeRect(3,3,506,90);c.fillStyle=`#${color.toString(16).padStart(6,'0')}`;c.font='bold 38px monospace';c.textAlign='center';c.fillText(text,256,62);
    const tex=new THREE.CanvasTexture(canvas);tex.magFilter=THREE.NearestFilter;tex.minFilter=THREE.NearestFilter;
    const sign=this.mesh(new THREE.PlaneGeometry(5.5,1.03),new THREE.MeshBasicMaterial({map:tex}),pos,V(0,ry,0));return sign;
  }

  bind(){
    this.canvas.addEventListener('click',()=>{if(this.enabled&&!this.cb.isOverlayOpen?.())this.canvas.requestPointerLock?.();});
    document.addEventListener('pointerlockchange',()=>{if(document.pointerLockElement===this.canvas)document.addEventListener('mousemove',this._pointerHandler);else document.removeEventListener('mousemove',this._pointerHandler);});
  }
  onMouse(e){if(!this.enabled)return;this.yaw-=e.movementX*.0023;this.pitch=Math.max(-1.35,Math.min(1.25,this.pitch-e.movementY*.0021));}

  enter(carSpec,deliveries=[]){
    this.enabled=true;this.root.visible=true;this.position.set(0,1.72,8);this.yaw=0;this.pitch=0;this.velocity.set(0,0,0);this.carried=null;this.installing=null;this.camera.fov=66;this.camera.updateProjectionMatrix();
    this.refreshCar(carSpec);this.syncDeliveries(deliveries);this.updateCamera();
  }
  leave(){this.enabled=false;document.exitPointerLock?.();this.clearCarry();}

  refreshCar(spec={}){
    this.parkedGroup.clear();
    const color=spec.color??0x8e2635, bodyMat=this.mat(typeof color==='string'?new THREE.Color(color):color);
    const length=spec.dimensions?.length??4.35,width=spec.dimensions?.width??1.72,height=spec.dimensions?.height??1.28;
    const body=new THREE.Mesh(new THREE.BoxGeometry(width,.48,length),bodyMat);body.position.y=.55;body.geometry.translate(0,0,0);this.parkedGroup.add(body);
    const hood=new THREE.Mesh(new THREE.BoxGeometry(width*.91,.18,length*.28),bodyMat);hood.position.set(0,.83,-length*.31);this.parkedGroup.add(hood);
    const cabin=new THREE.Mesh(new THREE.BoxGeometry(width*.78,height*.52,length*.43),this.mat(0x162231));cabin.position.set(0,1.05,length*.04);this.parkedGroup.add(cabin);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(width*.73,.13,length*.35),bodyMat);roof.position.set(0,1.38,length*.04);this.parkedGroup.add(roof);
    const bumper=new THREE.Mesh(new THREE.BoxGeometry(width*.96,.2,.16),this.mat(0x202327));bumper.position.set(0,.38,-length*.51);this.parkedGroup.add(bumper);
    const wheelGeo=new THREE.CylinderGeometry(.31,.31,.19,8),wheelMat=this.mat(0x0a0b0d);
    for(const x of [-width*.52,width*.52])for(const z of [-length*.31,length*.31]){const w=new THREE.Mesh(wheelGeo,wheelMat);w.rotation.z=Math.PI/2;w.position.set(x,.38,z);this.parkedGroup.add(w);}
    for(const x of [-width*.31,width*.31]){const lamp=new THREE.Mesh(new THREE.BoxGeometry(.3,.18,.05),this.mat(0xffdba1,0xffc06a,1));lamp.position.set(x,.65,-length*.505);this.parkedGroup.add(lamp);}
    const tail=new THREE.Mesh(new THREE.BoxGeometry(width*.55,.13,.05),this.mat(0xff1f31,0xff1028,1));tail.position.set(0,.67,length*.505);this.parkedGroup.add(tail);
    this.parkedGroup.rotation.y=Math.PI/2;
  }

  syncDeliveries(deliveries=[]){
    for(const m of this.deliveryMeshes)this.root.remove(m);this.deliveryMeshes=[];
    deliveries.forEach((d,i)=>{
      if(this.carried?.id===(d.id||d.partId))return;
      const g=new THREE.Group();const box=new THREE.Mesh(new THREE.BoxGeometry(1.15,.72,.9),this.mat(0xa77a43));box.position.y=.36;g.add(box);
      const tape=new THREE.Mesh(new THREE.BoxGeometry(.15,.735,.91),this.mat(0xd6bd7b));tape.position.y=.36;g.add(tape);
      const label=this.makeLabel(d.name||d.partName||d.partId||'PERFORMANCE PART');label.position.set(0,.48,.456);g.add(label);
      g.position.set(-9+i%3*1.55,.02,9+Math.floor(i/3)*1.2);g.userData={delivery:d,index:i};this.root.add(g);this.deliveryMeshes.push(g);
    });
  }
  makeLabel(text){const c=document.createElement('canvas');c.width=256;c.height=96;const x=c.getContext('2d');x.fillStyle='#eee9d9';x.fillRect(0,0,256,96);x.fillStyle='#13171b';x.font='bold 18px monospace';x.fillText('WANGAN MARKET',10,25);x.font='13px monospace';x.fillText(String(text).slice(0,25),10,52);x.fillRect(10,67,190,5);for(let i=0;i<16;i++)x.fillRect(10+i*10,72,i%3?3:6,18);const t=new THREE.CanvasTexture(c);t.magFilter=THREE.NearestFilter;return new THREE.Mesh(new THREE.PlaneGeometry(.8,.3),new THREE.MeshBasicMaterial({map:t}));}

  update(dt,input={},context={}){
    if(!this.enabled)return;
    this.interactCooldown=Math.max(0,this.interactCooldown-dt);
    if(this.installing){
      this.installing.elapsed+=dt;const p=Math.min(1,this.installing.elapsed/this.installing.duration);this.cb.installProgress?.(`INSTALLING ${this.installing.delivery.name||'PART'}`,p);
      if(p>=1){const d=this.installing.delivery;this.installing=null;this.cb.installProgress?.('',null);this.clearCarry();this.cb.finishInstall?.(d);}
      this.updateCamera();return;
    }
    if(!this.cb.isOverlayOpen?.()){
      const forward=V(-Math.sin(this.yaw),0,-Math.cos(this.yaw)),right=V(Math.cos(this.yaw),0,-Math.sin(this.yaw));let wish=V();
      if(input.forward)wish.add(forward);if(input.backward)wish.sub(forward);if(input.right)wish.add(right);if(input.left)wish.sub(right);
      if(wish.lengthSq())wish.normalize();const speed=input.sprint?5.3:3.2;this.velocity.lerp(wish.multiplyScalar(speed),1-Math.exp(-dt*12));
      let next=this.position.clone().addScaledVector(this.velocity,dt);next.x=Math.max(-10.25,Math.min(10.25,next.x));next.z=Math.max(-13.1,Math.min(13.1,next.z));
      // Keep the walker out of the parked car's footprint.
      if(Math.abs(next.x)<2.0&&Math.abs(next.z)<2.8){const dx=2.0-Math.abs(next.x),dz=2.8-Math.abs(next.z);if(dx<dz)next.x=Math.sign(next.x||1)*2.0;else next.z=Math.sign(next.z||1)*2.8;}
      this.position.copy(next);
    }
    this.updateCamera();const target=this.findInteraction(context);this.cb.prompt?.(target?.text||'',!!target);
    if(input.interactPressed&&this.interactCooldown<=0&&target){this.interactCooldown=.35;this.interact(target,context);}
    this.pcScreen.material.color.setHex(0x2b9da9+(Math.sin(performance.now()*.004)>0?0x000909:0));
  }

  updateCamera(){
    this.camera.position.copy(this.position);
    this.camera.up.set(0,1,0);
    const cosPitch=Math.cos(this.pitch);
    const forward=V(-Math.sin(this.yaw)*cosPitch,Math.sin(this.pitch),-Math.cos(this.yaw)*cosPitch);
    this.camera.lookAt(this.position.clone().add(forward));
  }
  distance2D(p){return Math.hypot(this.position.x-p.x,this.position.z-p.z);}
  lookScore(p){const f=V(-Math.sin(this.yaw),0,-Math.cos(this.yaw));const to=V(p.x-this.position.x,0,p.z-this.position.z).normalize();return f.dot(to);}
  findInteraction(context){
    const candidates=[];
    if(this.distance2D(V(7.5,0,-9.3))<2.7)candidates.push({type:'pc',pos:V(7.5,0,-9.3),text:'<kbd>E</kbd> USE WANGAN MARKET PC'});
    if(this.distance2D(V(0,0,12.6))<2.5)candidates.push({type:'exit',pos:V(0,0,13),text:'<kbd>E</kbd> EXIT TO EXPRESSWAY'});
    if(this.carried&&this.distance2D(V(0,0,0))<4.0)candidates.push({type:'install',pos:V(0,0,0),text:`<kbd>E</kbd> INSTALL ${this.carried.name||'DELIVERY'}`});
    if(!this.carried)for(const m of this.deliveryMeshes)if(this.distance2D(m.position)<2)candidates.push({type:'delivery',pos:m.position,mesh:m,delivery:m.userData.delivery,text:`<kbd>E</kbd> PICK UP ${m.userData.delivery.name||'DELIVERY BOX'}`});
    return candidates.filter(c=>this.lookScore(c.pos)>-.1).sort((a,b)=>this.distance2D(a.pos)-this.distance2D(b.pos))[0]||null;
  }
  interact(target){
    this.cb.uiClick?.();
    if(target.type==='pc'){document.exitPointerLock?.();this.cb.openPC?.();}
    else if(target.type==='exit')this.cb.exitGarage?.();
    else if(target.type==='delivery')this.pickup(target.mesh,target.delivery);
    else if(target.type==='install'){this.installing={delivery:this.carried,elapsed:0,duration:this.cb.instantDelivery?.()?0.25:2.4};}
  }
  pickup(mesh,delivery){
    this.carried=delivery;this.root.remove(mesh);this.deliveryMeshes=this.deliveryMeshes.filter(m=>m!==mesh);
    const held=new THREE.Group();const box=new THREE.Mesh(new THREE.BoxGeometry(.65,.42,.52),this.mat(0xa77a43));held.add(box);const tape=new THREE.Mesh(new THREE.BoxGeometry(.09,.43,.53),this.mat(0xd6bd7b));held.add(tape);held.rotation.set(-.15,.25,0);this.carryAnchor.add(held);this.heldMesh=held;this.cb.toast?.(`${delivery.name||'Part'} picked up`);
  }
  clearCarry(){if(this.heldMesh)this.carryAnchor.remove(this.heldMesh);this.heldMesh=null;this.carried=null;}
  dispose(){document.removeEventListener('mousemove',this._pointerHandler);this.scene.remove(this.root);}
}

export default GarageSystem;
