import * as THREE from 'three';

export class GameUI {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.$ = id => document.getElementById(id);
    this.phoneOpen = false;
    this.pcOpen = false;
    this.pcTab = 'auction';
    this.phonePage = 'home';
    this.lastMinimap = null;
    this.lastContext = null;
    this.minimapCtx = this.$('minimap').getContext('2d');
    this.bind();
  }

  bind() {
    this.$('continue-button').onclick = () => this.cb.continue?.();
    this.$('new-game-button').onclick = () => {
      if (confirm('Erase saved progress and begin a new night?')) this.cb.newGame?.();
    };
    this.$('phone-close').onclick = () => this.closePhone();
    this.$('phone-home-key').onclick = () => this.showPhoneHome();
    this.$('phone-back').onclick = () => this.showPhoneHome();
    document.querySelectorAll('[data-app]').forEach(b => b.onclick = () => this.openPhoneApp(b.dataset.app));
    document.querySelectorAll('.pc nav button').forEach(b => b.onclick = () => {
      this.pcTab = b.dataset.tab;
      document.querySelectorAll('.pc nav button').forEach(n => n.classList.toggle('active', n === b));
      this.renderPC();
      this.cb.uiClick?.();
    });
    this.$('pc-exit').onclick = () => this.closePC();
    this.$('return-garage').onclick = () => {
      this.$('run-over').classList.add('hidden');
      this.cb.returnGarage?.();
    };
    this.$('help-close').onclick = () => this.$('pause-help').classList.add('hidden');
    window.addEventListener('keydown', e => {
      if (e.code === 'Escape') {
        if (this.pcOpen) this.closePC();
        else if (this.phoneOpen) this.closePhone();
        else this.$('pause-help').classList.add('hidden');
      }
    });
  }

  finishLoading() { setTimeout(() => this.$('loading').classList.add('out'), 180); }
  hideBoot() { this.$('boot-screen').classList.remove('active'); }
  showBoot(hasSave = true) {
    this.$('boot-screen').classList.add('active');
    this.$('continue-button').textContent = hasSave ? 'CONTINUE' : 'START NIGHT';
  }
  showHUD(show = true) { this.$('hud').classList.toggle('hidden', !show); }
  fade(active) { this.$('fade').classList.toggle('on', active); }

  updateHUD(t = {}, run = {}, meta = {}) {
    const speed = Math.max(0, Math.round(t.speedKmh ?? t.speed ?? 0));
    const rpm = Math.max(0, Math.round(t.rpm ?? 0));
    this.$('speed-readout').textContent = speed;
    this.$('rpm-readout').textContent = String(rpm).padStart(4, '0');
    this.$('gear-readout').textContent = t.gearLabel ?? (t.gear === 0 ? 'N' : t.gear ?? 'N');
    this.$('tach-fill').style.height = `${Math.min(100, (rpm / Math.max(1, t.redline ?? 7000)) * 100)}%`;
    const fuelPct = Math.max(0, Math.min(100, (t.fuelFraction ?? 1) * 100));
    this.$('fuel-fill').style.width = `${fuelPct}%`;
    this.$('fuel-fill').style.background = fuelPct < 15 ? 'var(--red)' : 'var(--cyan)';
    this.$('fuel-readout').textContent = `${Math.round(fuelPct)}%`;
    this.$('hud-score').textContent = Math.floor(run.score ?? 0).toString().padStart(6, '0');
    this.$('hud-combo').textContent = `×${(run.combo ?? 1).toFixed(1)}`;
    this.$('combo-label').textContent = run.combo > 1 ? `${run.nearMisses ?? 0} CLEAN PASSES` : speed >= 100 ? 'HUNT THE GAP' : '100 KM/H TO SCORE';
    this.$('combo-bar').firstElementChild.style.width = `${Math.max(0, Math.min(100, run.comboTimerFraction ?? 0) * 100)}%`;
    this.$('hud-money').textContent = this.money(meta.money ?? 0);
    this.$('route-name').textContent = (meta.routeName ?? 'C1 INNER').toUpperCase();
    this.$('area-name').textContent = (meta.areaName ?? 'TOKYO').toUpperCase();
    this.$('phone-location').textContent = (meta.routeName ?? 'C1 INNER').toUpperCase();
    [...this.$('lives').querySelectorAll('i')].forEach((el, i) => el.classList.toggle('lost', i >= (run.lives ?? 3)));
  }

  drawMinimap(data, player, services = [], largeCanvas = null) {
    if (!data?.routes?.length && !Array.isArray(data)) return;
    this.lastMinimap = { data, player, services };
    const canvas = largeCanvas || this.$('minimap');
    const c = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    c.fillStyle = '#050910'; c.fillRect(0, 0, w, h);
    const routes = data.routes || data;
    const all = routes.flatMap(r => r.points || r);
    if (!all.length) return;
    const xs = all.map(p => p.x), zs = all.map(p => p.z ?? p.y);
    const bounds = data.bounds || { minX:Math.min(...xs), maxX:Math.max(...xs), minZ:Math.min(...zs), maxZ:Math.max(...zs) };
    const pad = largeCanvas ? 22 : 12;
    const scale = Math.min((w-pad*2)/Math.max(1,bounds.maxX-bounds.minX),(h-pad*2)/Math.max(1,bounds.maxZ-bounds.minZ));
    const tx = x => w/2+(x-(bounds.minX+bounds.maxX)/2)*scale;
    const ty = z => h/2-(z-(bounds.minZ+bounds.maxZ)/2)*scale; // +Z = north = up
    routes.forEach((r, idx) => {
      const pts = r.points || r;
      c.beginPath();
      pts.forEach((p,i) => i ? c.lineTo(tx(p.x),ty(p.z??p.y)) : c.moveTo(tx(p.x),ty(p.z??p.y)));
      if (r.closed) c.closePath();
      c.strokeStyle = r.color || (idx === 0 ? '#ff8e2d':'#324458');
      c.lineWidth = largeCanvas ? 4 : 2; c.stroke();
    });
    services.forEach(s => {
      c.fillStyle = s.garage ? '#ff4156':'#39d7f2';
      c.fillRect(tx(s.position?.x ?? s.x)-3,ty(s.position?.z ?? s.z)-3,6,6);
      if (largeCanvas) { c.fillStyle='#ccd4df'; c.font='10px monospace'; c.fillText(s.name || 'PA',tx(s.position?.x ?? s.x)+6,ty(s.position?.z ?? s.z)-5); }
    });
    if (player) {
      const x=tx(player.x), y=ty(player.z);
      // North-up canvas (y = -z): heading 0 (+Z) points straight up, so the
      // up-drawn arrow rotates by the heading directly.
      c.save(); c.translate(x,y); c.rotate(player.heading ?? 0);
      c.fillStyle='#fff'; c.beginPath(); c.moveTo(0,-7);c.lineTo(5,5);c.lineTo(0,2);c.lineTo(-5,5);c.closePath();c.fill(); c.restore();
    }
  }

  prompt(text, visible = true) {
    const el=this.$('interaction-prompt'); el.innerHTML = text; el.classList.toggle('hidden', !visible);
  }
  toast(text, tone = 'cyan') {
    const el=document.createElement('div'); el.className='toast'; el.textContent=text;
    el.style.borderColor = tone === 'red' ? 'var(--red)' : tone === 'amber' ? 'var(--amber)' : 'var(--cyan)';
    this.$('toast-stack').append(el); setTimeout(()=>el.remove(),3100);
  }
  nearMiss(points, close = false) {
    const el=this.$('near-miss'); el.innerHTML=`${close?'THREAD THE NEEDLE':'NEAR MISS'} <b>+${Math.floor(points)}</b>`;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
  showRunOver(score) { this.$('lost-score').textContent=Math.floor(score).toLocaleString(); this.$('run-over').classList.remove('hidden'); }
  showHelp() { this.$('pause-help').classList.remove('hidden'); }
  installProgress(label, progress) {
    const el=this.$('install-progress'); el.classList.toggle('hidden', progress == null);
    if (progress != null) { this.$('install-label').textContent=label; el.querySelector('i').style.width=`${Math.min(100,progress*100)}%`; }
  }

  togglePhone(context) { this.phoneOpen ? this.closePhone() : this.openPhone(context); }
  openPhone(context = {}) {
    if (this.pcOpen) return;
    this.lastContext=context; this.phoneOpen=true; this.$('phone').classList.remove('hidden'); this.showPhoneHome(); this.cb.phoneChanged?.(true); this.cb.uiClick?.();
  }
  closePhone() { this.phoneOpen=false; this._stopMapRefresh(); this.$('phone').classList.add('hidden'); this.cb.phoneChanged?.(false); this.cb.uiClick?.(); }
  showPhoneHome() { this.phonePage='home';this._stopMapRefresh();this.$('phone-home').classList.add('active');this.$('phone-app').classList.remove('active');this.cb.uiClick?.(); }
  openPhoneApp(app) {
    this.phonePage=app; this.$('phone-home').classList.remove('active'); this.$('phone-app').classList.add('active');
    this._stopMapRefresh();
    const root=this.$('phone-app'), c=this.cb.getPhoneContext?.() || this.lastContext || {};
    if (app==='map') {
      root.innerHTML='<div class="app-view"><h2>EXPRESSWAY MAP</h2><p>Drag to pan · pinch or double-tap to zoom · ⌖ recenters</p><canvas id="phone-map-canvas" class="phone-map"></canvas><button id="phone-map-center" class="map-center">⌖ MY CAR</button></div>';
      this.initPhoneMap(this.$('phone-map-canvas'));
      this.$('phone-map-center').onclick=()=>{if(this.mapView){this.mapView.followPlayer=true;}this.renderPhoneMap();this.cb.uiClick?.();};
    } else if(app==='tow') {
      root.innerHTML=`<div class="app-view"><h2>湾岸 TOW</h2><p>Emergency recovery to the Shiba PA garage. Your current run will be lost.</p><div class="phone-card"><small>SERVICE FEE</small><b>${this.money(c.towCost??2500)}</b><button id="call-tow">CALL TOW TRUCK</button></div></div>`;
      this.$('call-tow').onclick=()=>this.cb.tow?.();
    } else if(app==='stats') {
      root.innerHTML=`<div class="app-view"><h2>NIGHT LOG</h2><p>Driver statistics</p>${this.phoneCard('CURRENT RUN',(c.runScore??0).toLocaleString())}${this.phoneCard('LIVE COMBO',`×${(c.combo??1).toFixed(1)}`)}${this.phoneCard('BEST COMBO',`×${(c.bestCombo??1).toFixed(1)}`)}${this.phoneCard('BEST BANK',(c.bestScore??0).toLocaleString())}${this.phoneCard('BALANCE',this.money(c.money??0))}</div>`;
    } else if(app==='settings') {
      const s=c.settings||{};
      root.innerHTML=`<div class="app-view"><h2>SETTINGS</h2><p>Changes save automatically</p>
        ${this.setting('MASTER VOLUME',`<input id="set-volume" type="range" min="0" max="1" step=".05" value="${s.volume??.65}">`)}
        ${this.setting('CAMERA',`<select id="set-camera"><option value="chase">Chase</option><option value="hood">Hood</option><option value="cockpit">Cockpit</option></select>`)}
        ${this.setting('GEARBOX',`<select id="set-gearbox"><option value="auto">Automatic</option><option value="manual">Manual</option></select>`)}
        ${this.setting('RENDER QUALITY',`<select id="set-quality"><option value="low">Low · chunky PSX</option><option value="medium">Medium · default</option><option value="high">High · sharp</option></select>`)}
        <button id="phone-newgame">WIPE SAVE / NEW GAME</button></div>`;
      this.$('set-camera').value=s.camera||'chase';this.$('set-gearbox').value=s.gearbox||'auto';this.$('set-quality').value=['low','medium','high'].includes(s.quality)?s.quality:'medium';
      ['volume','camera','gearbox','quality'].forEach(k=>this.$(`set-${k}`).onchange=e=>this.cb.setting?.(k,k==='volume'?+e.target.value:e.target.value));
      this.$('phone-newgame').onclick=()=>{if(confirm('Erase all progress?'))this.cb.newGame?.();};
    } else if(app==='admin') this.renderAdmin(root,c);
    else {
      root.innerHTML='<div class="app-view"><h2>CONTROLS</h2><p>Keyboard driver manual</p><div class="phone-card"><small>DRIVING</small><b>WASD / ARROWS</b><p>Shift/E up · Ctrl/Q down<br>Space handbrake · C camera<br>F phone · R recover</p></div><div class="phone-card"><small>GARAGE</small><b>WASD + MOUSE</b><p>E interact / carry / install<br>Esc releases pointer</p></div></div>';
    }
    this.cb.uiClick?.();
  }

  renderAdmin(root,c) {
    if(!c.adminUnlocked){
      root.innerHTML='<div class="app-view"><h2>ADMIN ACCESS</h2><p>Workshop diagnostic terminal. Enter authorization PIN.</p><input id="admin-code" class="admin-code" maxlength="4" inputmode="numeric" placeholder="••••"><button id="admin-unlock" style="width:100%;margin-top:9px">AUTHORIZE</button></div>';
      this.$('admin-unlock').onclick=()=>{const ok=this.$('admin-code').value==='1997';this.cb.adminUnlock?.(ok);if(ok)this.openPhoneApp('admin');else this.toast('ACCESS DENIED','red');};
    } else {
      root.innerHTML=`<div class="app-view"><h2>ADMIN // ACTIVE</h2><p>Real-time test controls</p><div class="admin-grid">
      <button data-admin="money">+ ¥100,000</button><button data-admin="garage">TELEPORT GARAGE</button><button data-admin="pc">OPEN GARAGE PC</button><button data-admin="highway">START ON HIGHWAY</button><button data-admin="deliverybay">WARP TO DELIVERY</button><button data-admin="carbay">WARP TO CAR</button><button data-admin="fuel">REFILL FUEL</button><button data-admin="lives">RESET LIVES</button><button data-admin="parts">UNLOCK PARTS</button><button data-admin="delivery">INSTANT DELIVERY</button><button data-admin="boost">SET 250 KM/H</button></div>
      ${this.setting('INFINITE MONEY',`<input data-toggle="money" type="checkbox" ${c.admin?.infiniteMoney?'checked':''}>`)}
      ${this.setting('INFINITE LIVES',`<input data-toggle="lives" type="checkbox" ${c.admin?.infiniteLives?'checked':''}>`)}
      ${this.setting('INFINITE FUEL',`<input data-toggle="fuel" type="checkbox" ${c.admin?.infiniteFuel?'checked':''}>`)}
      ${this.setting('TIME SCALE',`<select id="admin-time"><option value=".5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>`)}
      ${this.setting('TRAFFIC DENSITY',`<select id="admin-traffic"><option value=".5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="2.5">2.5×</option><option value="3">3×</option></select>`)}</div>`;
      root.querySelectorAll('[data-admin]').forEach(b=>b.onclick=()=>this.cb.adminAction?.(b.dataset.admin));
      root.querySelectorAll('[data-toggle]').forEach(i=>i.onchange=()=>this.cb.adminToggle?.(i.dataset.toggle,i.checked));
      this.$('admin-time').value=String(c.admin?.timeScale||1);this.$('admin-time').onchange=e=>this.cb.adminTime?.(+e.target.value);
      this.$('admin-traffic').value=String(c.admin?.trafficDensity||1);this.$('admin-traffic').onchange=e=>this.cb.adminTraffic?.(+e.target.value);
    }
  }
  phoneCard(label,value){return `<div class="phone-card"><small>${label}</small><b>${value}</b></div>`;}
  setting(label,control){return `<label class="setting"><span>${label}</span>${control}</label>`;}

  /* Phone map: fully self-drawn from live map data with pan / pinch / follow. */
  _stopMapRefresh(){if(this._mapTimer){clearInterval(this._mapTimer);this._mapTimer=null;}this.phoneMapCanvas=null;}
  initPhoneMap(canvas){
    const rect=canvas.getBoundingClientRect();
    const dpr=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(220,Math.round((rect.width||280)*dpr));
    canvas.height=Math.max(220,Math.round((rect.height||280)*dpr));
    this.mapView=this.mapView||{zoom:2.4,followPlayer:true,cx:0,cz:0};
    const pointers=new Map();let pinchDist=0,pinchZoom=this.mapView.zoom;
    canvas.addEventListener('pointerdown',e=>{e.preventDefault();try{canvas.setPointerCapture?.(e.pointerId);}catch(err){}pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===2){const [a,b]=[...pointers.values()];pinchDist=Math.hypot(a.x-b.x,a.y-b.y);pinchZoom=this.mapView.zoom;}});
    canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;e.preventDefault();
      const prev=pointers.get(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===1&&this._mapRenderScale){this.mapView.followPlayer=false;this.mapView.cx-=(e.clientX-prev.x)*dpr/this._mapRenderScale;this.mapView.cz+=(e.clientY-prev.y)*dpr/this._mapRenderScale;this.renderPhoneMap();}
      else if(pointers.size===2){const [a,b]=[...pointers.values()];const d=Math.hypot(a.x-b.x,a.y-b.y);this.mapView.zoom=Math.min(16,Math.max(.8,pinchZoom*d/Math.max(24,pinchDist)));this.renderPhoneMap();}});
    const up=e=>{if(!pointers.has(e.pointerId))return;pointers.delete(e.pointerId);
      const now=performance.now();
      if(pointers.size===0&&now-(this._mapLastTap||0)<320){this.mapView.zoom=this.mapView.zoom<4?6:2.4;this.renderPhoneMap();}
      if(pointers.size===0)this._mapLastTap=now;};
    canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
    this.phoneMapCanvas=canvas;
    this.renderPhoneMap();
    this._mapTimer=setInterval(()=>this.renderPhoneMap(),650);
  }
  renderPhoneMap(){
    const canvas=this.phoneMapCanvas;
    if(!canvas||!canvas.isConnected){this._stopMapRefresh();return;}
    const src=this.cb.getMinimap?.()||this.lastMinimap;
    const c=canvas.getContext('2d');const w=canvas.width,h=canvas.height;
    c.fillStyle='#060a10';c.fillRect(0,0,w,h);
    if(!src?.data?.routes?.length){c.fillStyle='#7c8aa0';c.font=`${Math.round(12*(w/280))}px monospace`;c.textAlign='center';c.fillText('NO SIGNAL // DRIVE TO SYNC',w/2,h/2);return;}
    const {data,player,services=[]}=src;const b=data.bounds;const view=this.mapView;
    if(view.followPlayer&&player){view.cx=player.x;view.cz=player.z;}
    else if(!view.cx&&!view.cz){view.cx=(b.minX+b.maxX)/2;view.cz=(b.minZ+b.maxZ)/2;}
    const baseScale=Math.min(w/Math.max(1,b.maxX-b.minX),h/Math.max(1,b.maxZ-b.minZ));
    const scale=baseScale*view.zoom;this._mapRenderScale=scale;
    const tx=x=>w/2+(x-view.cx)*scale, ty=z=>h/2-(z-view.cz)*scale; // north-up
    for(const r of data.routes){
      const pts=r.points||[];if(!pts.length)continue;
      c.beginPath();pts.forEach((p,i)=>i?c.lineTo(tx(p.x),ty(p.z)):c.moveTo(tx(p.x),ty(p.z)));
      if(r.closed)c.closePath();
      c.strokeStyle=r.color||'#42546b';c.lineWidth=Math.max(1.5,(r.width||2)*Math.min(2.4,view.zoom*.5));c.lineJoin='round';c.stroke();
    }
    const fontPx=Math.max(9,Math.round(10*(w/280)));
    for(const s of services){
      const x=tx(s.position?.x??s.x),y=ty(s.position?.z??s.z);
      if(x<-30||y<-30||x>w+30||y>h+30)continue;
      c.fillStyle=s.garage||s.hasGarage?'#ff4156':'#39d7f2';c.fillRect(x-4,y-4,8,8);
      c.fillStyle='#ccd4df';c.font=`${fontPx}px monospace`;c.textAlign='left';c.fillText(s.name||'PA',x+8,y-6);
    }
    if(data.garage){const x=tx(data.garage.x),y=ty(data.garage.z);c.strokeStyle='#ff9a2e';c.lineWidth=2;c.strokeRect(x-6,y-6,12,12);c.fillStyle='#ff9a2e';c.font=`${fontPx}px monospace`;c.fillText('GARAGE',x+9,y+4);}
    if(player){
      const x=tx(player.x),y=ty(player.z);
      c.save();c.translate(x,y);c.rotate(player.heading??0);
      c.fillStyle='#fff';c.strokeStyle='#05080e';c.lineWidth=2;
      c.beginPath();c.moveTo(0,-9);c.lineTo(6,7);c.lineTo(0,3);c.lineTo(-6,7);c.closePath();c.stroke();c.fill();c.restore();
    }
    c.fillStyle='#5d6b80';c.font=`${fontPx}px monospace`;c.textAlign='right';c.fillText(`×${view.zoom.toFixed(1)}`,w-8,h-8);
  }

  openPC(context) {
    this.lastContext=context;this.pcOpen=true;this.phoneOpen=false;this.$('phone').classList.add('hidden');this.$('pc-overlay').classList.remove('hidden');this.pcTab='auction';
    document.querySelectorAll('.pc nav button').forEach(n=>n.classList.toggle('active',n.dataset.tab==='auction'));
    this.renderPC();this.cb.pcChanged?.(true);this.cb.uiClick?.();
  }
  closePC(){this.pcOpen=false;this.$('pc-overlay').classList.add('hidden');this.cb.pcChanged?.(false);this.cb.uiClick?.();}
  refreshPC(context){this.lastContext=context;if(this.pcOpen)this.renderPC();}
  renderPC(){
    const c=this.cb.getPCContext?.()||this.lastContext||{};this.$('pc-money').textContent=this.money(c.money||0);const root=this.$('pc-content');
    if(this.pcTab==='auction')this.renderAuction(root,c);else if(this.pcTab==='parts')this.renderParts(root,c);else this.renderGarageTab(root,c);
  }
  renderAuction(root,c){
    root.innerHTML=`<div class="market-title"><div><p>毎晩更新 // SEEDED INVENTORY</p><h2>TONIGHT'S VEHICLE AUCTION</h2></div><p>${c.auctions?.length||0} VERIFIED LOTS · TRADE-IN APPLIED AUTOMATICALLY</p></div><div class="listing-grid">${(c.auctions||[]).map((a,i)=>{
      const car=a.car||a;const final=a.price??car.price??0;const affordable=(c.money+(c.tradeValue||0))>=final;
      return `<article class="car-card"><div class="car-preview" data-preview="${i}" style="--car:${car.color||'#c73642'}"><span class="lot">LOT ${a.lotNumber||String(i+1).padStart(3,'0')}</span></div><div class="car-info"><h3>${car.name||car.model}</h3><p class="meta">${a.year||car.year||1994} · ${(a.mileage||0).toLocaleString()} KM · ${car.engine?.layout||car.engineLayout||'I4'} ${(car.engine?.displacementL||car.engine?.displacement||car.displacement||2).toFixed?.(1)||2}L</p><div class="auction-sheet"><span>POWER</span><span>${Math.round(a.effectivePower||car.engine?.powerHp||car.power||car.horsepower||100)} HP</span><span>DRIVE</span><span>${car.drivetrain||'RWD'}</span><span>CONDITION</span><span class="grade">${a.grade||'4'}</span><span>ASK</span><span>${this.money(final)}</span></div><div class="price-row"><small>TRADE ${this.money(c.tradeValue||0)}</small><b>${this.money(final)}</b><button data-buy-car="${i}" ${affordable?'':'disabled'}>${affordable?'BUY + TRADE':'INSUFFICIENT'}</button></div></div></article>`;
    }).join('')}</div>`;
    this.renderAuctionPreviews(root,c.auctions||[]);
    root.querySelectorAll('[data-buy-car]').forEach(b=>b.onclick=()=>this.cb.buyCar?.(+b.dataset.buyCar));
  }
  renderAuctionPreviews(root,auctions){
    let renderer=this.previewRenderer;
    try{
      if(!renderer){const canvas=document.createElement('canvas');renderer=new THREE.WebGLRenderer({canvas,antialias:false,alpha:false,preserveDrawingBuffer:true});renderer.setSize(320,150,false);renderer.outputColorSpace=THREE.SRGBColorSpace;this.previewRenderer=renderer;}
      const scene=new THREE.Scene();scene.background=new THREE.Color(0x252d38);scene.add(new THREE.HemisphereLight(0xbcc8d3,0x22242a,2.1));const key=new THREE.DirectionalLight(0xffd7a1,2.4);key.position.set(-4,6,-5);scene.add(key);
      const floor=new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshLambertMaterial({color:0x4b5158,flatShading:true}));floor.rotation.x=-Math.PI/2;scene.add(floor);
      const camera=new THREE.PerspectiveCamera(32,320/150,.1,50);camera.position.set(6.2,3.3,7.1);camera.lookAt(0,.65,0);
      auctions.forEach((a,i)=>{const car=a.car||a,group=this.makePreviewCar(car);scene.add(group);group.rotation.y=-.62;renderer.render(scene,camera);const el=root.querySelector(`[data-preview="${i}"]`);if(el){el.style.backgroundImage=`url(${renderer.domElement.toDataURL('image/png')})`;el.style.backgroundSize='cover';el.style.backgroundPosition='center';el.classList.add('rendered');}scene.remove(group);group.traverse(o=>{o.geometry?.dispose?.();o.material?.dispose?.();});});
      floor.geometry.dispose();floor.material.dispose();
    }catch(e){console.warn('Auction preview renderer unavailable',e);}
  }
  makePreviewCar(car={}){
    const s=car.silhouette||car.dimensions||{},L=s.length||4.3,W=s.width||1.72,H=s.height||1.3,wheelbase=s.wheelbase||L*.6,hood=s.hood??.28,cabin=s.cabin??.45;
    const g=new THREE.Group(),body=new THREE.MeshLambertMaterial({color:new THREE.Color(car.color||'#a72d38'),flatShading:true}),glass=new THREE.MeshLambertMaterial({color:0x101b26,flatShading:true}),rubber=new THREE.MeshLambertMaterial({color:0x090a0c,flatShading:true}),lamp=new THREE.MeshBasicMaterial({color:0xffd9a0});
    const add=(geo,mat,x,y,z)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);g.add(m);return m;};add(new THREE.BoxGeometry(W,.48,L),body,0,.48,0);add(new THREE.BoxGeometry(W*.94,.16,L*Math.max(.2,hood)),body,0,.77,-L*.34);const cabinLen=L*Math.max(.32,Math.min(.52,cabin));add(new THREE.BoxGeometry(W*.76,H*.48,cabinLen),glass,0,1.03,L*.03);add(new THREE.BoxGeometry(W*.71,.12,cabinLen*.82),body,0,1.34,L*.03);add(new THREE.BoxGeometry(W*.96,.16,.12),body,0,.38,L*.51);
    const wheelGeo=new THREE.CylinderGeometry(s.wheelRadius||.31,s.wheelRadius||.31,.2,8);for(const x of [-W*.52,W*.52])for(const z of [-wheelbase*.5,wheelbase*.5]){const w=new THREE.Mesh(wheelGeo,rubber);w.position.set(x,.34,z);w.rotation.z=Math.PI/2;g.add(w);}for(const x of [-W*.3,W*.3])add(new THREE.BoxGeometry(.26,.12,.035),lamp,x,.64,-L*.505);return g;
  }
  renderParts(root,c){
    const parts=c.parts||[];
    const can=c.fuelCan||{name:'EMERGENCY FUEL CAN',liters:10};root.innerHTML=`<div class="market-title"><div><p>湾岸 PERFORMANCE // FITMENT VERIFIED</p><h2>PARTS FOR ${c.owned?.name||'YOUR CAR'}</h2></div><p>DELIVERED BOXES MUST BE INSTALLED BY HAND</p></div><div class="part-list">${parts.map((p,i)=>{
      const owned=c.installed?.includes(p.id),pending=c.deliveries?.some(d=>(d.partId||d.id)===p.id),affordable=c.money>=p.price;
      return `<article class="part-row"><div class="part-icon">${this.partIcon(p.category)}</div><div><h3>${p.name}</h3><p>${(p.category||'UPGRADE').toUpperCase()} · ${p.description||'Performance component'}</p></div><div class="part-delta">${this.deltaText(p.statDeltas||p.modifiers||p.delta||{})}</div><button data-buy-part="${i}" ${(owned||pending||!affordable)?'disabled':''}>${owned?'INSTALLED':pending?'IN DELIVERY':affordable?this.money(p.price):'NEED '+this.money(p.price)}</button></article>`;
    }).join('')}<article class="part-row"><div class="part-icon">⛽</div><div><h3>${can.name}</h3><p>DELIVERED TO GARAGE · CARRY IT TO THE CAR</p></div><div class="part-delta">+${can.liters||10} L FUEL</div><button id="buy-fuel-can" ${c.money<(c.fuelCanPrice||1200)?'disabled':''}>${this.money(c.fuelCanPrice||1200)}</button></article></div>`;
    root.querySelectorAll('[data-buy-part]').forEach(b=>b.onclick=()=>this.cb.buyPart?.(+b.dataset.buyPart));this.$('buy-fuel-can').onclick=()=>this.cb.buyFuelCan?.();
  }
  renderGarageTab(root,c){
    const car=c.owned||{};const stats=c.stats||car;
    const brakeRating=(stats.brakeForce||1)/(car.brakeForce||stats.brakeForce||1)*100;
    root.innerHTML=`<div class="market-title"><div><p>OWNER FILE // ONE CAR POLICY</p><h2>MY GARAGE</h2></div><p>${c.deliveries?.length||0} DELIVERY BOXES WAITING</p></div><div class="owned-card"><div class="owned-hero"><div class="car-preview" style="--car:${car.color||'#8c3038'}"></div></div><div class="stat-bars"><p class="eyebrow">${car.year||1989} // ${car.drivetrain||'RWD'} // ${car.engine?.layout||car.engineLayout||'I4'}</p><h2>${car.name||'NIGHT RUNNER'}</h2>${this.statBar('POWER',stats.power||stats.horsepower||90,500,'HP')}${this.statBar('MASS',stats.mass||stats.massKg||1100,2000,'KG',true)}${this.statBar('TIRE GRIP',stats.tireGrip||stats.grip||1.0,1.8,'μ')}${this.statBar('BRAKES',brakeRating,150,'%')}${this.statBar('FUEL',c.fuel||0,car.fuelCapacity||car.fuelTankL||50,'L')}<div class="installed-list"><b>INSTALLED PARTS</b><br>${(c.installedNames||[]).join(' · ')||'Factory specification'}</div></div></div>`;
  }
  statBar(label,val,max,unit,invert=false){const pct=Math.min(100,(val/max)*100);return `<div class="stat"><span>${label}</span><div><i style="width:${invert?100-pct/2:pct}%"></i></div><b>${typeof val==='number'?val.toFixed(val<10?2:0):val} ${unit}</b></div>`;}
  deltaText(d){const map={powerMultiplier:'POWER',power:'POWER',torque:'TORQUE',tireGrip:'GRIP',grip:'GRIP',gripMultiplier:'GRIP',brakeMultiplier:'BRAKE',braking:'BRAKE',brakeForce:'BRAKE',massDelta:'MASS',mass:'MASS',suspensionStiffness:'STIFFNESS',stiffness:'STIFFNESS',gearRatioMultiplier:'GEARING',acceleration:'ACCEL',topSpeed:'TOP SPEED',shift:'SHIFT',redline:'REDLINE',turbo:'BOOST',drag:'DRAG',fade:'FADE',response:'RESPONSE'};return Object.entries(d).map(([k,v])=>{const label=map[k]||k.replace(/([A-Z])/g,' $1').toUpperCase();if(typeof v!=='number')return `${label} ${v}`;if(k.toLowerCase().includes('multiplier')){const pct=Math.round((v-1)*100);return `${label} ${pct>=0?'+':''}${pct}%`;}return `${label} ${v>0?'+':''}${v}`;}).join(' · ')||'FITMENT UPGRADE';}
  partIcon(cat=''){return ({engine:'⚙',turbo:'◉',intake:'≋',exhaust:'≋',tires:'◎',suspension:'⌁',brakes:'⊘',weight:'▱',gearbox:'⇅'}[cat.toLowerCase()]||'◇');}
  money(n){return `¥${Math.max(0,Math.round(n)).toLocaleString('en-US')}`;}
}

export default GameUI;
