import * as THREE from 'three';

const V = (x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);

export class GarageSystem {
  constructor(scene, camera, canvas, callbacks={}) {
    this.scene=scene; this.camera=camera; this.canvas=canvas; this.cb=callbacks;
    this.playerHeight=1.72*1.2;
    this.enabled=false; this.position=V(0,this.playerHeight,7); this.yaw=0; this.pitch=0;
    this.velocity=V(); this.interactCooldown=0; this.carMesh=null; this.deliveryMeshes=[];
    this.colliders=[]; this.staticColliders=[];
    this.carried=null; this.installing=null; this.mouse={x:0,y:0}; this._pointerHandler=e=>this.onMouse(e);
    this.build(); this.bind();
  }

  mat(color, emissive=0, intensity=0){return new THREE.MeshLambertMaterial({color,emissive,emissiveIntensity:intensity,flatShading:true});}
  mesh(geo,mat,pos,rot=V()){const o=new THREE.Mesh(geo,mat);o.position.copy(pos);o.rotation.set(rot.x,rot.y,rot.z);this.root.add(o);return o;}

  build(){
    // Room shell rebuilt with explicit clearances: no coplanar faces anywhere
    // (the old build z-fought at the front/back beams, shutter slats and wall
    // panels). All interaction points are unchanged: PC (7.5,-9.3), exit
    // (0,12.6+), car footprint at the origin, delivery zone (-7.2,10.3),
    // walk clamps +/-10.25 x and +/-13.1 z.
    this.scene.background=new THREE.Color(0x05070b);this.scene.fog=new THREE.Fog(0x05070b,18,36);
    this.root=new THREE.Group();this.scene.add(this.root);
    this.mesh(new THREE.PlaneGeometry(22,28,11,14),this.mat(0x22272c),V(0,0,0),V(-Math.PI/2,0,0));
    const grid=new THREE.GridHelper(22,22,0x474b4e,0x2d3235);grid.position.y=.008;this.root.add(grid);
    // Structural shell: side walls (inner face x=+/-10.825), back wall (inner
    // face z=-13.825), ceiling resting ON the wall tops (bottom face y=10.02).
    // Structural meshes double as collision sources: refreshColliders() reads
    // their post-editor-build world boxes, so moved/hidden walls stay in sync.
    const solid=m=>{this.staticColliders.push(m);return m;};
    solid(this.mesh(new THREE.BoxGeometry(.35,10,28.7),this.mat(0x252a2f),V(-11,5,0)));
    solid(this.mesh(new THREE.BoxGeometry(.35,10,28.7),this.mat(0x252a2f),V(11,5,0)));
    solid(this.mesh(new THREE.BoxGeometry(21.65,10,.35),this.mat(0x22272a),V(0,5,-14)));
    this.mesh(new THREE.BoxGeometry(22.7,.35,28.7),this.mat(0x15191d),V(0,10.2,0));
    // Front wall around the shutter opening (|x|<4, y<5): two piers + lintel,
    // all clear of the shutter body.
    solid(this.mesh(new THREE.BoxGeometry(6.65,10,.35),this.mat(0x22272a),V(-7.325,5,14)));
    solid(this.mesh(new THREE.BoxGeometry(6.65,10,.35),this.mat(0x22272a),V(7.325,5,14)));
    solid(this.mesh(new THREE.BoxGeometry(8.3,5,.35),this.mat(0x22272a),V(0,7.5,14)));
    // Interior trim: beams pulled 0.25 m proud of the walls, stripes/panels
    // layered at distinct depths and heights.
    this.mesh(new THREE.BoxGeometry(21.4,.4,.3),this.mat(0x30343a),V(0,5.1,-13.55));
    this.mesh(new THREE.BoxGeometry(21.4,.4,.3),this.mat(0x30343a),V(0,5.1,13.55));
    for(const s of [-1,1]){
      this.mesh(new THREE.BoxGeometry(.06,1.6,27),this.mat(0x7b2729),V(s*10.77,1.15,0));
      for(let z=-11;z<13;z+=4)this.mesh(new THREE.BoxGeometry(.07,3.2,3.5),this.mat(0x33383d),V(s*10.77,6.4,z));
    }
    // Fluorescent fixtures hang 0.33 m below the ceiling underside.
    for(const z of [-9,-3,3,9]) for(const x of [-5.5,5.5]){
      this.mesh(new THREE.BoxGeometry(4,.1,.35),this.mat(0xeaf5e5,0xeaf5e5,2),V(x,9.69,z));
      const light=new THREE.PointLight(0xd8e8dc,12,14,1.8);light.position.set(x,8.8,z);this.root.add(light);
    }
    const warm=new THREE.PointLight(0xff762e,10,11,1.6);warm.position.set(-8,4,-10);this.root.add(warm);
    // Shutter inside the front opening; slats 25 mm proud of the shutter face.
    this.shutter=this.mesh(new THREE.BoxGeometry(7.9,5,.25),this.mat(0x42484d),V(0,2.5,13.82));this.staticColliders.push(this.shutter);
    for(let y=.35;y<5;y+=.46)this.mesh(new THREE.BoxGeometry(7.7,.025,.06),this.mat(0x171b1f),V(0,y,13.64));
    this.exitGlow=this.mesh(new THREE.PlaneGeometry(4.5,2.2),new THREE.MeshBasicMaterial({color:0xff8d2c,transparent:true,opacity:.12,side:THREE.DoubleSide}),V(0,1.1,13.48),V(0,0,0));
    // Workbench, tools and compressor.
    this.mesh(new THREE.BoxGeometry(7,.25,1.8),this.mat(0x584333),V(-7.2,1.1,-8));
    for(const x of [-9.8,-4.6])this.mesh(new THREE.BoxGeometry(.22,2,.22),this.mat(0x2b3036),V(x,1,-8));
    this.mesh(new THREE.BoxGeometry(6.6,2.6,.12),this.mat(0x303842),V(-7.2,3,-8.85));
    for(let i=0;i<7;i++)this.mesh(new THREE.BoxGeometry(.08,.8,.08),this.mat(i%2?0xe3b038:0xb9483d),V(-9.4+i*.72,3.1,-8.74),V(0,0,(i-.3)*.08));
    this.mesh(new THREE.CylinderGeometry(.7,.7,1.8,8),this.mat(0x9b2b34),V(8.7,.9,-9),V(0,0,Math.PI/2));
    // Desk + chunky computer.
    this.mesh(new THREE.BoxGeometry(4,.25,2),this.mat(0x4b3d32),V(7.5,1.05,-10.2));
    for(const x of [6,9])this.mesh(new THREE.BoxGeometry(.18,2,.18),this.mat(0x242a31),V(x,1,-10.2));
    this.mesh(new THREE.BoxGeometry(1.9,1.5,1.25),this.mat(0x9d998b),V(7.5,2,-10.55));
    this.pcScreen=this.mesh(new THREE.PlaneGeometry(1.5,1),new THREE.MeshBasicMaterial({color:0x39d6e8}),V(7.5,2.08,-9.91),V(0,0,0));
    this.mesh(new THREE.BoxGeometry(1.9,.12,.7),this.mat(0x9d998b),V(7.5,1.28,-9.55),V(.12,0,0));
    // Delivery area paint and sign.
    const zone=this.mesh(new THREE.PlaneGeometry(6,5),new THREE.MeshBasicMaterial({color:0xe7b941,transparent:true,opacity:.15,side:THREE.DoubleSide}),V(-7.2,.015,10.3),V(-Math.PI/2,0,0));
    const edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(6,.03,5)),new THREE.LineBasicMaterial({color:0xe8c14a}));edge.position.set(-7.2,.03,10.3);this.root.add(edge);this.deliveryEdge=edge;
    this.addSign('DELIVERY / 配達',V(-10.68,4,9.8),Math.PI/2,0xe9b947);
    this.addSign('WANGAN WORKS',V(-10.68,5,-2),Math.PI/2,0xe7e9e2);
    this.parkedGroup=new THREE.Group();this.parkedGroup.position.set(0,.05,0);this.root.add(this.parkedGroup);
    // Children past this point are appended AFTER every editor-addressable
    // child (0-77), so garage-build childIndex operations keep resolving.
    // carDisplay hosts the Toyota Chaser GLB the game attaches in garage mode;
    // it replaces the hidden procedural parkedGroup as the showroom car.
    this.carDisplay=new THREE.Group();this.carDisplay.position.set(0,.05,0);this.carDisplay.rotation.y=-Math.PI/2;this.root.add(this.carDisplay);
    // The editor exposes the procedural car because it has selectable geometry,
    // while the playable game renders the GLB under carDisplay. Treat both
    // groups as one editor target so an Apply-to-Game transform/visibility
    // operation also reaches the car the player actually sees.
    this.parkedGroup.userData.editorBuildMirror='garage-showroom-car';
    this.carDisplay.userData.editorBuildMirror='garage-showroom-car';
    // The imported GLB is rotated PI inside carDisplay, while the procedural
    // editor car has that orientation baked into parkedGroup. Preserve the
    // existing visual heading when mirroring the editor's absolute rotation.
    this.carDisplay.userData.editorBuildQuaternionOffset=[0,-1,0,0];
    // PS2-style waypoint beacons (Enchanted Arms look): a faceted crystal
    // diamond that spins and bobs, ringed by 4 tiny diamonds of the same shape
    // orbiting it. Blue over the garage door, yellow over the market PC.
    this.beacons=[];
    this.exitMarkers=this.makeBeacon(0x2233dd,0x2f52ff);this.root.add(this.exitMarkers);
    this.pcMarkers=this.makeBeacon(0xcf9a15,0xffc22c);this.root.add(this.pcMarkers);
    // refreshExitMarkers normally follows the door/PC anchors. The runtime
    // build marks an explicitly edited marker so later collider refreshes do
    // not overwrite the transform that was just applied from the editor.
    this.exitMarkers.userData.editorAnchorFollower='garage-exit';
    this.pcMarkers.userData.editorAnchorFollower='garage-market';
    this.beacons.push(this.exitMarkers,this.pcMarkers);
    this.carryAnchor=new THREE.Group();this.carryAnchor.position.set(.45,-.45,-1);this.camera.add(this.carryAnchor);this.scene.add(this.camera);
    this.refreshColliders();
  }

  // Rebuilds the walk colliders from whatever is actually in the room right
  // now: the structural shell (wherever the editor build moved it), every
  // editor-placed object and the parked car. Hidden meshes and anything
  // outside the player's body band (floor decals, ceiling, hung signs) are
  // skipped. Interaction anchors that follow editor-moved props (garage door,
  // delivery zone, PC table) are refreshed together.
  refreshColliders(){
    this.root.updateMatrixWorld(true);
    const boxes=[];
    const consider=o=>{if(!o||o.visible===false)return;const box=new THREE.Box3().setFromObject(o);if(box.isEmpty()||box.min.y>1.72||box.max.y<.1)return;boxes.push(box);};
    for(const m of this.staticColliders)consider(m);
    const placed=this.root.children.find(c=>c.name==='Editor placed objects');
    if(placed&&placed.visible!==false)for(const child of placed.children)consider(child);
    if(this.carDisplay?.children.length&&this.carDisplay.visible!==false)consider(this.carDisplay);
    this.colliders=boxes;
    // The old desk PC was hidden and sits outside the remodelled room, so the
    // market terminal now lives at the small table with the game boxes.
    const table=placed?.children.find(c=>c.name==='table_small');
    this.pcPoint=table?V(table.position.x,0,table.position.z):V(7.5,0,-9.3);
    this.refreshExitMarkers();
  }
  // A single crystal-diamond waypoint marker, rendered as a PS2-style hologram
  // instead of a solid painted gem: a translucent additive body that glows on
  // its own, crisp faceted wireframe edges, and a soft outer rim halo. The three
  // layers share one octahedron and blend additively, so the beacon reads as a
  // projected blue/yellow hologram rather than one flat tint.
  makeBeacon(color,emissive){
    const group=new THREE.Group();
    const gem=new THREE.OctahedronGeometry(1,0);
    const body=new THREE.Mesh(gem,new THREE.MeshBasicMaterial({color:emissive,transparent:true,opacity:.3,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false}));
    const edges=new THREE.Mesh(gem,new THREE.MeshBasicMaterial({color:emissive,wireframe:true,transparent:true,opacity:.9,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false}));
    edges.scale.setScalar(1.014);
    const halo=new THREE.Mesh(gem,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.16,blending:THREE.AdditiveBlending,side:THREE.BackSide,depthWrite:false,toneMapped:false}));
    halo.scale.setScalar(1.35);
    const core=new THREE.Group();
    core.add(halo,body,edges);
    core.scale.set(.24,.44,.24);          // ~0.48 m wide, ~0.88 m tall
    core.position.y=1.35;core.userData.baseY=1.35;
    group.add(core);
    group.userData={core,body,edges,halo};
    return group;
  }
  animateBeacon(group,t){
    const {core,body,edges,halo}=group.userData;if(!core)return;
    core.rotation.y=t*1.3;core.position.y=core.userData.baseY+Math.sin(t*2)*.12;
    // Holographic shimmer: a fast flicker layered over a slow drift so the gem
    // looks like an unstable projection instead of a steady solid.
    const shimmer=.85+Math.sin(t*20)*.09+Math.sin(t*6.1)*.06;
    if(body)body.material.opacity=.3*shimmer;
    if(edges)edges.material.opacity=.9*shimmer;
    if(halo){halo.material.opacity=.16*(.7+.3*shimmer);halo.rotation.y=-t*.9;}
  }
  refreshExitMarkers(){
    const doorX=this.shutter?.position.x??0;
    this.exitPoint=V(doorX,0,12.6);
    if(this.exitMarkers&&!this.exitMarkers.userData.editorBuildTransformApplied)this.exitMarkers.position.set(doorX,0,12.4);
    const pc=this.pcPoint||V(7.5,0,-9.3);
    if(this.pcMarkers&&!this.pcMarkers.userData.editorBuildTransformApplied)this.pcMarkers.position.set(pc.x,0,pc.z);
  }
  onBuildApplied(){this.refreshColliders();}

  // Circle-vs-AABB pushout in the XZ plane; two passes settle corner contacts
  // between neighbouring boxes so the player slides along clutter and walls.
  resolveCollisions(next){
    const r=.35;
    for(let pass=0;pass<2;pass++)for(const box of this.colliders){
      if(next.x<box.min.x-r||next.x>box.max.x+r||next.z<box.min.z-r||next.z>box.max.z+r)continue;
      const cx=Math.max(box.min.x,Math.min(box.max.x,next.x)),cz=Math.max(box.min.z,Math.min(box.max.z,next.z));
      const dx=next.x-cx,dz=next.z-cz,d2=dx*dx+dz*dz;
      if(d2>=r*r)continue;
      if(d2>1e-8){const d=Math.sqrt(d2);next.x=cx+dx/d*r;next.z=cz+dz/d*r;}
      else{
        const pushL=next.x-(box.min.x-r),pushR=(box.max.x+r)-next.x,pushB=next.z-(box.min.z-r),pushF=(box.max.z+r)-next.z,m=Math.min(pushL,pushR,pushB,pushF);
        if(m===pushL)next.x=box.min.x-r;else if(m===pushR)next.x=box.max.x+r;else if(m===pushB)next.z=box.min.z-r;else next.z=box.max.z+r;
      }
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
    this.enabled=true;this.root.visible=true;this.position.set(0,this.playerHeight,8);this.yaw=0;this.pitch=0;this.velocity.set(0,0,0);this.carried=null;this.installing=null;this.camera.fov=66;this.camera.updateProjectionMatrix();
    this.refreshCar(carSpec);this.syncDeliveries(deliveries);this.refreshColliders();this.updateCamera();
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
      // Boxes spawn inside the painted delivery zone, wherever the editor
      // build moved its outline.
      const zone=this.deliveryEdge?.position||V(-7.2,0,10.3);
      g.position.set(zone.x+(i%3-1)*1.4,.02,zone.z+(Math.floor(i/3)-.5)*1.25);g.userData={delivery:d,index:i};this.root.add(g);this.deliveryMeshes.push(g);
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
      let next=this.position.clone().addScaledVector(this.velocity,dt);
      // Outer safety clamp only — real containment comes from the wall boxes,
      // which follow wherever the editor build moved the room shell.
      next.x=Math.max(-10.45,Math.min(10.45,next.x));next.z=Math.max(-13.45,Math.min(13.45,next.z));
      if(this.colliders.length)this.resolveCollisions(next);
      else{next.x=Math.max(-10.25,Math.min(10.25,next.x));next.z=Math.max(-13.1,Math.min(13.1,next.z));}
      this.position.copy(next);
    }
    this.updateCamera();const target=this.findInteraction(context);this.cb.prompt?.(target?.text||'',!!target);
    if(input.interactPressed&&this.interactCooldown<=0&&target){this.interactCooldown=.35;this.interact(target,context);}
    this.pcScreen.material.color.setHex(0x2b9da9+(Math.sin(performance.now()*.004)>0?0x000909:0));
    const t=performance.now()*.001;
    for(const b of this.beacons)this.animateBeacon(b,t);
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
    const pc=this.pcPoint||V(7.5,0,-9.3),exit=this.exitPoint||V(0,0,12.6);
    if(this.distance2D(pc)<2.7)candidates.push({type:'pc',pos:pc,text:'<kbd>E</kbd> USE WANGAN MARKET PC'});
    if(this.distance2D(exit)<2.5)candidates.push({type:'exit',pos:exit,text:'<kbd>E</kbd> EXIT TO EXPRESSWAY'});
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
