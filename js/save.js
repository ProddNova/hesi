import {
  CAR_BY_ID,
  CONSUMABLES,
  ECONOMY,
  PART_BY_ID,
  carFromAuctionListing,
  calculateTradeValue,
  createSeededAuction,
  createStarterCar,
  getCarSpec,
  getConditionEffects,
  hashSeed,
} from './data.js';

export const SAVE_KEY = 'shutoko-nights.save';
export const SAVE_VERSION = 4;
export const AUTOSAVE_INTERVAL_MS = 30000;

const memoryStore = new Map();
const memoryStorage = {
  getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : null; },
  setItem(key, value) { memoryStore.set(key, String(value)); },
  removeItem(key) { memoryStore.delete(key); },
};

const nowIso = () => new Date().toISOString();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));

function clone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* JSON fallback below */ }
  }
  return JSON.parse(JSON.stringify(value));
}

export function createAuctionSeed() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    return `${values[0].toString(36)}${values[1].toString(36)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultSettings() {
  return {
    masterVolume: 0.82,
    engineVolume: 0.88,
    effectsVolume: 0.90,
    ambientVolume: 0.28,
    transmission: 'automatic',
    camera: 'chase',
    renderResolution: '480p',
    renderScale: 1,
    trafficDensity: 1,
    steeringSensitivity: 1,
    speedUnit: 'kmh',
    screenShake: true,
    showFps: false,
  };
}

export function createDefaultRecords() {
  return {
    bestRunScore: 0,
    bestBankedScore: 0,
    bestCombo: 1,
    highestComboChain: 0,
    maxSpeedKmh: 0,
    totalBankedMoney: 0,
    totalRunScore: 0,
    totalNearMisses: 0,
    totalDistanceKm: 0,
    totalFuelUsedL: 0,
    totalPlaySeconds: 0,
    runsStarted: 0,
    runsBanked: 0,
    runsCrashed: 0,
    contacts: 0,
    carsPurchased: 0,
    partsPurchased: 0,
    partsInstalled: 0,
    towsCalled: 0,
  };
}

export function createNewGame(seed = createAuctionSeed()) {
  const timestamp = nowIso();
  const auctionSeed = String(seed);
  return {
    version: SAVE_VERSION,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSavedAt: null,
    money: ECONOMY.startingMoney,
    ownedCar: createStarterCar(),
    auctionSeed,
    auctionListings: createSeededAuction(auctionSeed),
    deliveries: [],
    inventory: { fuelCans: 0 },
    settings: createDefaultSettings(),
    records: createDefaultRecords(),
    currentRun: {
      score: 0,
      combo: 1,
      comboChain: 0,
      lives: 3,
      nearMisses: 0,
      distanceKm: 0,
      active: false,
      startedAt: null,
    },
    admin: {
      enabled: false,
      infiniteMoney: false,
      infiniteLives: false,
      infiniteFuel: false,
      unlockAllParts: false,
      instantDelivery: false,
      timeScale: 1,
    },
    flags: {
      introSeen: false,
      phoneSeen: false,
      pcSeen: false,
      garageTutorialSeen: false,
    },
  };
}

/**
 * Migrate historical/unversioned saves without throwing. The migration is
 * intentionally tolerant because early prototypes used several field names.
 */
export function migrateSave(input) {
  let save = input && typeof input === 'object' ? clone(input) : {};
  let version = Math.max(0, Math.floor(finite(save.version, 0)));

  if (version < 1) {
    const legacyCar = save.ownedCar || save.currentCar || save.car;
    const legacyCarId = typeof legacyCar === 'string'
      ? legacyCar
      : legacyCar?.carId || legacyCar?.id || save.ownedCarId;
    const starter = createStarterCar();
    save.money = finite(save.money ?? save.cash ?? save.credits, ECONOMY.startingMoney);
    save.ownedCar = {
      ...starter,
      ...(legacyCar && typeof legacyCar === 'object' ? legacyCar : {}),
      carId: CAR_BY_ID[legacyCarId] ? legacyCarId : starter.carId,
      installedParts: legacyCar?.installedParts || save.installedParts || save.parts || [],
      fuelLiters: finite(legacyCar?.fuelLiters ?? legacyCar?.fuel ?? save.fuel, starter.fuelLiters),
    };
    save.auctionSeed = String(save.auctionSeed || save.seed || createAuctionSeed());
    save.auctionListings = save.auctionListings || save.auctions || createSeededAuction(save.auctionSeed);
    save.version = 1;
    version = 1;
  }

  if (version < 2) {
    if (save.auction && typeof save.auction === 'object') {
      save.auctionSeed ||= String(save.auction.seed || createAuctionSeed());
      save.auctionListings ||= save.auction.listings;
    }
    save.deliveries ||= save.pendingDeliveries || [];
    save.inventory ||= { fuelCans: finite(save.fuelCans, 0) };
    save.settings = { ...createDefaultSettings(), ...(save.settings || {}) };
    save.version = 2;
    version = 2;
  }

  if (version < 3) {
    save.records = { ...createDefaultRecords(), ...(save.records || save.stats || {}) };
    save.currentRun ||= {
      score: finite(save.runScore, 0), combo: finite(save.combo, 1), comboChain: 0,
      lives: finite(save.lives, 3), nearMisses: 0, distanceKm: 0, active: false, startedAt: null,
    };
    save.admin ||= {};
    save.flags ||= {};
    save.version = 3;
    version = 3;
  }

  if (version < 4) {
    // v4 made every acquisition explicit and stored condition effects so the
    // same auction car drives identically after a data-table update.
    const owned = save.ownedCar || createStarterCar();
    owned.instanceId ||= `car-migrated-${Date.now().toString(36)}`;
    owned.acquiredAt ||= save.createdAt || nowIso();
    owned.purchasePrice = finite(owned.purchasePrice, 0);
    owned.conditionGrade ||= '4';
    owned.conditionEffects ||= getConditionEffects(owned.conditionGrade, owned.mileageKm);
    save.ownedCar = owned;
    save.version = 4;
  }

  save.version = SAVE_VERSION;
  return save;
}

function sanitizeOwnedCar(input) {
  const fallback = createStarterCar();
  const source = input && typeof input === 'object' ? input : fallback;
  const carId = CAR_BY_ID[source.carId] ? source.carId : fallback.carId;
  const spec = getCarSpec(carId);
  const mileageKm = Math.max(0, finite(source.mileageKm, carId === fallback.carId ? fallback.mileageKm : 0));
  const conditionGrade = String(source.conditionGrade || '4');
  const ids = Array.isArray(source.installedParts) ? source.installedParts : [];
  const installedParts = [...new Set(ids.map((entry) => typeof entry === 'string' ? entry : entry?.partId || entry?.id).filter((id) => PART_BY_ID[id]))];
  return {
    instanceId: String(source.instanceId || `car-${Date.now().toString(36)}`),
    carId,
    sourceListingId: source.sourceListingId ? String(source.sourceListingId) : null,
    acquiredAt: source.acquiredAt || nowIso(),
    acquiredMileageKm: Math.max(0, finite(source.acquiredMileageKm, mileageKm)),
    purchasePrice: Math.max(0, Math.round(finite(source.purchasePrice, 0))),
    color: typeof source.color === 'string' ? source.color : spec.colors[0],
    mileageKm,
    conditionGrade,
    conditionEffects: {
      ...getConditionEffects(conditionGrade, mileageKm),
      ...(source.conditionEffects && typeof source.conditionEffects === 'object' ? source.conditionEffects : {}),
    },
    installedParts,
    fuelLiters: clamp(source.fuelLiters ?? source.fuel, 0, spec.fuelTankL),
  };
}

function sanitizeListings(input, seed) {
  if (!Array.isArray(input) || input.length < 8) return createSeededAuction(seed);
  return input.slice(0, 12).map((listing, index) => {
    const source = listing && typeof listing === 'object' ? listing : {};
    const spec = getCarSpec(source.carId);
    const mileageKm = Math.max(0, Math.round(finite(source.mileageKm ?? source.mileage, 60000)));
    const conditionGrade = String(source.conditionGrade || source.grade || '4');
    const conditionEffects = {
      ...getConditionEffects(conditionGrade, mileageKm),
      ...(source.conditionEffects && typeof source.conditionEffects === 'object' ? source.conditionEffects : {}),
    };
    return {
      ...source,
      id: String(source.id || `auc-${hashSeed(seed).toString(36)}-${index + 1}`),
      carId: spec.id,
      name: source.name || spec.name,
      subtitle: source.subtitle || spec.subtitle,
      year: Math.round(finite(source.year, spec.year)),
      mileageKm,
      mileage: mileageKm,
      conditionGrade,
      grade: conditionGrade,
      condition: Number.isFinite(Number(source.condition)) ? Number(source.condition) : conditionEffects.powerMultiplier,
      conditionEffects,
      color: typeof source.color === 'string' ? source.color : spec.colors[0],
      price: Math.max(1000, Math.round(finite(source.price, spec.basePrice))),
      status: ['available', 'sold', 'owned', 'withdrawn'].includes(source.status) ? source.status : 'available',
    };
  });
}

function sanitizeDeliveries(input) {
  if (!Array.isArray(input)) return [];
  const validStatuses = new Set(['ordered', 'ready', 'carried', 'installed', 'consumed']);
  return input.slice(0, 64).flatMap((delivery, index) => {
    if (!delivery || typeof delivery !== 'object') return [];
    const kind = (delivery.kind === 'fuel' || delivery.type === 'fuel') ? 'fuel' : 'part';
    let itemId = String(delivery.itemId || delivery.partId || (kind === 'fuel' ? 'fuel-can-20l' : ''));
    if (kind === 'fuel' && itemId === 'fuel-can') itemId = 'fuel-can-20l';
    if (kind === 'part' && !PART_BY_ID[itemId]) return [];
    if (kind === 'fuel' && !CONSUMABLES.some((item) => item.id === itemId)) return [];
    const readyAtValue = typeof delivery.readyAt === 'number'
      ? delivery.readyAt
      : (Date.parse(delivery.readyAt) || Date.now());
    const orderedAtValue = typeof delivery.orderedAt === 'number'
      ? new Date(delivery.orderedAt).toISOString()
      : (delivery.orderedAt || nowIso());
    const partData = PART_BY_ID[itemId];
    return [{
      id: String(delivery.id || `delivery-${Date.now().toString(36)}-${index}`),
      kind,
      itemId,
      partId: kind === 'fuel' ? 'fuel-can' : itemId,
      type: kind,
      name: delivery.name || (kind === 'fuel' ? '20L Fuel Can' : partData?.name || itemId),
      orderedAt: orderedAtValue,
      readyAt: readyAtValue,
      status: validStatuses.has(delivery.status) ? delivery.status : (readyAtValue <= Date.now() ? 'ready' : 'ordered'),
      pricePaid: Math.max(0, Math.round(finite(delivery.pricePaid, 0))),
    }];
  });
}

export function normalizeSave(input) {
  const inputVersion = Math.max(0, Math.floor(finite(input?.version, 0)));
  const migrated = migrateSave(input);
  migrated.ownedCar ||= createStarterCar();
  if (migrated.ownedCarId && !migrated.ownedCar.carId) migrated.ownedCar.carId = migrated.ownedCarId;
  if (inputVersion < SAVE_VERSION && Array.isArray(migrated.installedParts)) migrated.ownedCar.installedParts = migrated.installedParts;
  if (inputVersion < SAVE_VERSION && Number.isFinite(Number(migrated.fuel))) migrated.ownedCar.fuelLiters = Number(migrated.fuel);
  if (!migrated.ownedCar.mileageKm && migrated.ownedCar.mileage) migrated.ownedCar.mileageKm = migrated.ownedCar.mileage;
  if (!migrated.auctionListings && Array.isArray(migrated.auctions)) migrated.auctionListings = migrated.auctions;
  const defaults = createNewGame(migrated.auctionSeed || createAuctionSeed());
  const settings = { ...defaults.settings, ...(migrated.settings || {}) };
  const records = { ...defaults.records, ...(migrated.records || {}) };
  const currentRun = { ...defaults.currentRun, ...(migrated.currentRun || {}) };
  const admin = { ...defaults.admin, ...(migrated.admin || {}) };
  const flags = { ...defaults.flags, ...(migrated.flags || {}) };
  const auctionSeed = String(migrated.auctionSeed || defaults.auctionSeed);

  if (settings.volume !== undefined) settings.masterVolume = settings.volume;
  if (settings.gearbox !== undefined) settings.transmission = settings.gearbox === 'manual' ? 'manual' : 'automatic';
  if (settings.resolution !== undefined) {
    const resolution = String(settings.resolution).replace(/p$/i, '');
    if (['240', '360', '480', '720'].includes(resolution)) settings.renderResolution = `${resolution}p`;
  }
  if (records.bestScore !== undefined) records.bestRunScore = Math.max(records.bestRunScore || 0, finite(records.bestScore, 0));
  if (records.totalBanked !== undefined) records.totalBankedMoney = Math.max(records.totalBankedMoney || 0, finite(records.totalBanked, 0));

  settings.masterVolume = clamp(settings.masterVolume, 0, 1);
  settings.engineVolume = clamp(settings.engineVolume, 0, 1);
  settings.effectsVolume = clamp(settings.effectsVolume, 0, 1);
  settings.ambientVolume = clamp(settings.ambientVolume, 0, 1);
  settings.renderScale = clamp(settings.renderScale, 0.5, 2);
  settings.trafficDensity = clamp(settings.trafficDensity, 0.35, 1.75);
  settings.steeringSensitivity = clamp(settings.steeringSensitivity, 0.5, 1.6);
  settings.transmission = settings.transmission === 'manual' ? 'manual' : 'automatic';
  settings.camera = ['chase', 'hood', 'cockpit'].includes(settings.camera) ? settings.camera : 'chase';
  settings.renderResolution = ['240p', '360p', '480p', '720p'].includes(settings.renderResolution) ? settings.renderResolution : '480p';

  for (const key of Object.keys(defaults.records)) records[key] = Math.max(0, finite(records[key], defaults.records[key]));
  currentRun.score = Math.max(0, Math.round(finite(currentRun.score, 0)));
  currentRun.combo = clamp(currentRun.combo, 1, 99);
  currentRun.comboChain = Math.max(0, Math.round(finite(currentRun.comboChain, 0)));
  currentRun.lives = Math.round(clamp(currentRun.lives, 0, 3));
  currentRun.nearMisses = Math.max(0, Math.round(finite(currentRun.nearMisses, 0)));
  currentRun.distanceKm = Math.max(0, finite(currentRun.distanceKm, 0));
  currentRun.active = Boolean(currentRun.active);
  admin.timeScale = clamp(admin.timeScale, 0.1, 4);
  for (const key of ['enabled', 'infiniteMoney', 'infiniteLives', 'infiniteFuel', 'unlockAllParts', 'instantDelivery']) admin[key] = Boolean(admin[key]);

  const ownedCar = sanitizeOwnedCar(migrated.ownedCar);
  const auctionListings = sanitizeListings(migrated.auctionListings, auctionSeed);
  const normalized = {
    version: SAVE_VERSION,
    revision: Math.max(0, Math.floor(finite(migrated.revision, 0))),
    createdAt: migrated.createdAt || defaults.createdAt,
    updatedAt: migrated.updatedAt || defaults.updatedAt,
    lastSavedAt: migrated.lastSavedAt || null,
    money: Math.max(0, Math.round(finite(migrated.money, ECONOMY.startingMoney))),
    ownedCar,
    auctionSeed,
    auctionListings,
    deliveries: sanitizeDeliveries(migrated.deliveries),
    inventory: { fuelCans: Math.max(0, Math.floor(finite(migrated.inventory?.fuelCans, 0))) },
    settings,
    records,
    currentRun,
    admin,
    flags,
  };
  // Runtime aliases make the save directly consumable by both the richer data
  // API and the compact game orchestrator without maintaining a second file.
  normalized.ownedCarId = ownedCar.carId;
  normalized.installedParts = [...ownedCar.installedParts];
  normalized.fuel = ownedCar.fuelLiters;
  normalized.auctions = auctionListings;
  normalized.settings.volume = normalized.settings.masterVolume;
  normalized.settings.gearbox = normalized.settings.transmission === 'manual' ? 'manual' : 'auto';
  normalized.settings.resolution = Number.parseInt(normalized.settings.renderResolution, 10);
  normalized.records.bestScore = normalized.records.bestRunScore;
  normalized.records.totalBanked = normalized.records.totalBankedMoney;
  return normalized;
}

export const validateSave = normalizeSave;

export class SaveSystem {
  constructor(options = {}) {
    this.key = options.key || SAVE_KEY;
    this.autosaveIntervalMs = Math.max(5000, finite(options.autosaveIntervalMs, AUTOSAVE_INTERVAL_MS));
    this.listeners = new Set();
    this.dirty = false;
    this.dirtyReason = null;
    this.lastStorageError = null;
    this.isPersistent = false;
    this._timer = null;
    this._boundVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.flush('visibility');
    };
    this._boundBeforeUnload = () => this.flush('unload');
    this._storage = this._selectStorage(options.storage);
    this.data = options.autoLoad === false ? createNewGame(options.seed) : this.load(options.seed);
    if (options.autoStart !== false) this.startAutosave();
  }

  _selectStorage(preferred) {
    let candidate = preferred || null;
    if (!candidate && typeof window !== 'undefined') {
      try { candidate = window.localStorage; }
      catch (error) {
        this.lastStorageError = error;
        this.isPersistent = false;
        return memoryStorage;
      }
    }
    if (!candidate) return memoryStorage;
    try {
      const testKey = `${this.key}.storage-test`;
      candidate.setItem(testKey, '1');
      candidate.removeItem(testKey);
      this.isPersistent = true;
      return candidate;
    } catch (error) {
      this.lastStorageError = error;
      this.isPersistent = false;
      return memoryStorage;
    }
  }

  _fallBack(error, operation) {
    this.lastStorageError = error instanceof Error ? error : new Error(String(error));
    this.isPersistent = false;
    this._storage = memoryStorage;
    this._emit('storageerror', { error: this.lastStorageError, operation, persistent: false });
  }

  _read() {
    try {
      return this._storage.getItem(this.key);
    } catch (error) {
      this._fallBack(error, 'read');
      return this._storage.getItem(this.key);
    }
  }

  _write(serialized) {
    try {
      this._storage.setItem(this.key, serialized);
      return true;
    } catch (error) {
      this._fallBack(error, 'write');
      try {
        this._storage.setItem(this.key, serialized);
        return true;
      } catch (fallbackError) {
        this.lastStorageError = fallbackError;
        return false;
      }
    }
  }

  _emit(type, detail = {}) {
    const event = { type, detail, data: this.data, system: this };
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { console.error('SaveSystem listener failed', error); }
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(`shutoko:${type}`, { detail: { ...detail, data: this.data } }));
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(seed) {
    const raw = this._read();
    if (!raw) {
      this.data = createNewGame(seed);
      this.dirty = true;
      this.save('new-game');
      return this.data;
    }
    try {
      const parsed = JSON.parse(raw);
      const needsMigration = Math.floor(finite(parsed?.version, 0)) !== SAVE_VERSION;
      this.data = normalizeSave(parsed);
      this.dirty = needsMigration;
      if (needsMigration) this.save('migration');
      this._emit('load', { migratedTo: SAVE_VERSION });
      return this.data;
    } catch (error) {
      this.lastStorageError = error;
      try { this._storage.setItem(`${this.key}.corrupt.${Date.now()}`, raw); } catch { /* fallback still works */ }
      this.data = createNewGame(seed);
      this.dirty = true;
      this.save('corrupt-save-recovery');
      this._emit('recovered', { error });
      return this.data;
    }
  }

  _ingestExternalState(external) {
    const source = external && typeof external === 'object' ? external : {};
    const merged = clone(this.data || createNewGame(source.auctionSeed));
    merged.money = finite(source.money, merged.money);
    merged.auctionSeed = String(source.auctionSeed || merged.auctionSeed || createAuctionSeed());
    if (Array.isArray(source.auctions)) merged.auctionListings = source.auctions;
    else if (Array.isArray(source.auctionListings)) merged.auctionListings = source.auctionListings;

    const sourceCar = source.ownedCar && typeof source.ownedCar === 'object' ? source.ownedCar : {};
    const carId = source.ownedCarId || sourceCar.carId || sourceCar.id || merged.ownedCar.carId;
    const changedCar = carId !== merged.ownedCar.carId;
    const numericCondition = Number(sourceCar.condition);
    merged.ownedCar = {
      ...merged.ownedCar,
      carId,
      instanceId: changedCar ? `car-${Date.now().toString(36)}` : merged.ownedCar.instanceId,
      acquiredAt: changedCar ? nowIso() : merged.ownedCar.acquiredAt,
      acquiredMileageKm: changedCar ? finite(sourceCar.mileageKm ?? sourceCar.mileage, 0) : merged.ownedCar.acquiredMileageKm,
      purchasePrice: finite(sourceCar.purchasePrice ?? sourceCar.price, merged.ownedCar.purchasePrice),
      color: sourceCar.color || merged.ownedCar.color,
      mileageKm: Math.max(0, finite(sourceCar.mileageKm ?? sourceCar.mileage, merged.ownedCar.mileageKm)),
      conditionGrade: sourceCar.conditionGrade || sourceCar.grade || merged.ownedCar.conditionGrade,
      installedParts: Array.isArray(source.installedParts)
        ? source.installedParts
        : (sourceCar.installedParts || merged.ownedCar.installedParts),
      fuelLiters: finite(source.fuel ?? sourceCar.fuelLiters ?? sourceCar.fuel, merged.ownedCar.fuelLiters),
    };
    if (Number.isFinite(numericCondition)) {
      merged.ownedCar.conditionEffects = {
        powerMultiplier: numericCondition,
        torqueMultiplier: numericCondition,
        gripMultiplier: 0.9 + numericCondition * 0.1,
        brakeMultiplier: 0.94 + numericCondition * 0.06,
        suspensionMultiplier: 0.9 + numericCondition * 0.1,
        valueMultiplier: numericCondition,
      };
    } else if (sourceCar.conditionEffects) {
      merged.ownedCar.conditionEffects = sourceCar.conditionEffects;
    }

    if (Array.isArray(source.deliveries)) merged.deliveries = source.deliveries;
    merged.settings = { ...merged.settings, ...(source.settings || {}) };
    merged.records = { ...merged.records, ...(source.records || {}) };
    merged.currentRun = { ...merged.currentRun, ...(source.currentRun || {}) };
    merged.admin = { ...merged.admin, ...(source.admin || {}) };
    merged.flags = { ...merged.flags, ...(source.flags || {}) };
    return merged;
  }

  save(reason = 'manual') {
    if (reason && typeof reason === 'object') {
      this.data = this._ingestExternalState(reason);
      reason = 'external-state';
    }
    if (!this.data) this.data = createNewGame();
    this.data = normalizeSave(this.data);
    this.data.revision += 1;
    this.data.updatedAt = nowIso();
    this.data.lastSavedAt = this.data.updatedAt;
    const success = this._write(JSON.stringify(this.data));
    if (success) {
      this.dirty = false;
      this.dirtyReason = null;
      this._emit('save', { reason, persistent: this.isPersistent });
    }
    return success;
  }

  flush(reason = 'autosave') {
    return this.dirty ? this.save(reason) : true;
  }

  markDirty(reason = 'update') {
    this.dirty = true;
    this.dirtyReason = reason;
    this.data.updatedAt = nowIso();
    this._emit('change', { reason });
    return this.data;
  }

  startAutosave() {
    if (this._timer || typeof setInterval !== 'function') return;
    this._timer = setInterval(() => this.flush('interval'), this.autosaveIntervalMs);
    this._timer.unref?.();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._boundVisibility);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this._boundBeforeUnload);
  }

  stopAutosave() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._boundVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this._boundBeforeUnload);
  }

  dispose() {
    this.flush('dispose');
    this.stopAutosave();
    this.listeners.clear();
  }

  snapshot() {
    return clone(this.data);
  }

  getState() { return this.data; }

  setState(state) {
    return this.save(state);
  }

  clear() { return this.erase(); }

  transact(mutator, reason = 'transaction', autosave = true) {
    if (typeof mutator !== 'function') throw new TypeError('SaveSystem.transact requires a function');
    const draft = clone(this.data);
    const result = mutator(draft);
    this.data = normalizeSave(draft);
    this.markDirty(reason);
    if (autosave) this.save(reason);
    return result;
  }

  update(patchOrUpdater, reason = 'update', autosave = false) {
    return this.transact((draft) => {
      if (typeof patchOrUpdater === 'function') return patchOrUpdater(draft);
      Object.assign(draft, patchOrUpdater || {});
      return draft;
    }, reason, autosave);
  }

  newGame(seed = createAuctionSeed()) {
    this.data = createNewGame(seed);
    this.markDirty('new-game');
    this.save('new-game');
    this._emit('reset', { seed: this.data.auctionSeed });
    return this.data;
  }

  reset(seed) { return this.newGame(seed); }

  erase() {
    try { this._storage.removeItem(this.key); } catch (error) { this._fallBack(error, 'erase'); }
    return this.newGame();
  }

  exportSave(pretty = true) {
    return JSON.stringify(this.data, null, pretty ? 2 : 0);
  }

  importSave(serialized) {
    const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    this.data = normalizeSave(parsed);
    this.markDirty('import');
    this.save('import');
    return this.data;
  }

  canAfford(amount) {
    return this.data.admin.infiniteMoney || this.data.money >= Math.max(0, finite(amount, 0));
  }

  addMoney(amount, reason = 'money-added') {
    const delta = Math.round(finite(amount, 0));
    this.transact((draft) => { draft.money = Math.max(0, draft.money + delta); }, reason, true);
    return this.data.money;
  }

  spend(amount, reason = 'purchase') {
    const cost = Math.max(0, Math.round(finite(amount, 0)));
    if (!this.canAfford(cost)) return false;
    this.transact((draft) => {
      if (!draft.admin.infiniteMoney) draft.money = Math.max(0, draft.money - cost);
    }, reason, true);
    return true;
  }

  bankScore(score = this.data.currentRun.score) {
    const bankedScore = Math.max(0, Math.round(finite(score, 0)));
    const payout = bankedScore > 0 ? Math.max(ECONOMY.minimumBankPayout, Math.floor(bankedScore * ECONOMY.scoreToMoney)) : 0;
    this.transact((draft) => {
      draft.money += payout;
      draft.records.bestRunScore = Math.max(draft.records.bestRunScore, bankedScore);
      draft.records.bestBankedScore = Math.max(draft.records.bestBankedScore, bankedScore);
      draft.records.totalBankedMoney += payout;
      draft.records.totalRunScore += bankedScore;
      if (bankedScore > 0) draft.records.runsBanked += 1;
      Object.assign(draft.currentRun, { score: 0, combo: 1, comboChain: 0, lives: 3, nearMisses: 0, distanceKm: 0, active: false, startedAt: null });
    }, 'bank-score', true);
    return { score: bankedScore, payout, money: this.data.money };
  }

  buyCar(listingOrId) {
    const listing = typeof listingOrId === 'string'
      ? this.data.auctionListings.find((entry) => entry.id === listingOrId)
      : listingOrId;
    if (!listing || listing.status !== 'available') return { ok: false, reason: 'unavailable' };
    const tradeValue = calculateTradeValue(this.data.ownedCar);
    const price = Math.max(0, Math.round(finite(listing.price, 0)));
    const netCost = Math.max(0, price - tradeValue);
    if (!this.canAfford(netCost)) return { ok: false, reason: 'funds', price, tradeValue, netCost };

    this.transact((draft) => {
      if (!draft.admin.infiniteMoney) draft.money = Math.max(0, draft.money - netCost);
      const match = draft.auctionListings.find((entry) => entry.id === listing.id);
      if (match) match.status = 'owned';
      draft.ownedCar = carFromAuctionListing(listing);
      draft.records.carsPurchased += 1;
    }, 'buy-car', true);
    return { ok: true, price, tradeValue, netCost, car: this.data.ownedCar, money: this.data.money };
  }

  buyPart(partId, options = {}) {
    const selected = PART_BY_ID[partId];
    if (!selected) return { ok: false, reason: 'unknown-part' };
    const pending = this.data.deliveries.some((entry) => entry.kind === 'part' && entry.itemId === partId && !['installed', 'consumed'].includes(entry.status));
    if (pending || this.data.ownedCar.installedParts.includes(partId)) return { ok: false, reason: 'already-owned' };
    if (!this.canAfford(selected.price)) return { ok: false, reason: 'funds', price: selected.price };
    const instant = Boolean(options.instant ?? this.data.admin.instantDelivery);
    const orderedAtMs = Date.now();
    const delivery = {
      id: `delivery-${orderedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'part', itemId: partId, orderedAt: new Date(orderedAtMs).toISOString(),
      readyAt: new Date(orderedAtMs + (instant ? 0 : ECONOMY.baseDeliverySeconds * 1000)).toISOString(),
      status: instant ? 'ready' : 'ordered', pricePaid: selected.price,
    };
    this.transact((draft) => {
      if (!draft.admin.infiniteMoney) draft.money -= selected.price;
      draft.deliveries.push(delivery);
      draft.records.partsPurchased += 1;
    }, 'buy-part', true);
    return { ok: true, delivery: clone(delivery), money: this.data.money };
  }

  buyFuelCan(options = {}) {
    const item = CONSUMABLES.find((entry) => entry.id === 'fuel-can-20l');
    if (!item || !this.canAfford(item.price)) return { ok: false, reason: 'funds', price: item?.price || 0 };
    const instant = Boolean(options.instant ?? this.data.admin.instantDelivery);
    const orderedAtMs = Date.now();
    const delivery = {
      id: `delivery-${orderedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'fuel', itemId: item.id, orderedAt: new Date(orderedAtMs).toISOString(),
      readyAt: new Date(orderedAtMs + (instant ? 0 : item.deliverySeconds * 1000)).toISOString(),
      status: instant ? 'ready' : 'ordered', pricePaid: item.price,
    };
    this.transact((draft) => {
      if (!draft.admin.infiniteMoney) draft.money -= item.price;
      draft.deliveries.push(delivery);
    }, 'buy-fuel-can', true);
    return { ok: true, delivery: clone(delivery), money: this.data.money };
  }

  refreshDeliveries(at = Date.now()) {
    const due = this.data.deliveries.filter((delivery) => {
      const readyAt = typeof delivery.readyAt === 'number' ? delivery.readyAt : Date.parse(delivery.readyAt);
      return delivery.status === 'ordered' && readyAt <= at;
    });
    if (!due.length) return this.data.deliveries;
    const ids = new Set(due.map((delivery) => delivery.id));
    this.transact((draft) => {
      for (const delivery of draft.deliveries) if (ids.has(delivery.id)) delivery.status = 'ready';
    }, 'deliveries-ready', true);
    return this.data.deliveries;
  }

  setDeliveryStatus(deliveryId, status) {
    if (!['ready', 'carried', 'installed', 'consumed'].includes(status)) return false;
    const found = this.data.deliveries.find((entry) => entry.id === deliveryId);
    if (!found) return false;
    this.transact((draft) => {
      const delivery = draft.deliveries.find((entry) => entry.id === deliveryId);
      delivery.status = status;
    }, `delivery-${status}`, true);
    return true;
  }

  installPart(deliveryOrPartId) {
    this.refreshDeliveries();
    const delivery = this.data.deliveries.find((entry) =>
      entry.kind === 'part' && (entry.id === deliveryOrPartId || entry.itemId === deliveryOrPartId) && ['ready', 'carried'].includes(entry.status));
    if (!delivery) return { ok: false, reason: 'not-ready' };
    const selected = PART_BY_ID[delivery.itemId];
    this.transact((draft) => {
      const current = draft.deliveries.find((entry) => entry.id === delivery.id);
      current.status = 'installed';
      draft.ownedCar.installedParts = draft.ownedCar.installedParts.filter((id) => PART_BY_ID[id]?.slot !== selected.slot);
      draft.ownedCar.installedParts.push(selected.id);
      draft.records.partsInstalled += 1;
    }, 'install-part', true);
    return { ok: true, part: selected, installedParts: [...this.data.ownedCar.installedParts] };
  }

  useFuelCan(deliveryId) {
    this.refreshDeliveries();
    const delivery = this.data.deliveries.find((entry) => entry.kind === 'fuel' && (entry.id === deliveryId || entry.itemId === deliveryId) && ['ready', 'carried'].includes(entry.status));
    if (!delivery) return { ok: false, reason: 'not-ready' };
    const item = CONSUMABLES.find((entry) => entry.id === delivery.itemId);
    const before = this.data.ownedCar.fuelLiters;
    this.transact((draft) => {
      const spec = getCarSpec(draft.ownedCar.carId);
      draft.ownedCar.fuelLiters = Math.min(spec.fuelTankL, draft.ownedCar.fuelLiters + item.liters);
      draft.deliveries.find((entry) => entry.id === delivery.id).status = 'consumed';
    }, 'use-fuel-can', true);
    return { ok: true, litersAdded: this.data.ownedCar.fuelLiters - before, fuelLiters: this.data.ownedCar.fuelLiters };
  }

  refuel(liters = Infinity) {
    const spec = getCarSpec(this.data.ownedCar.carId);
    const needed = Math.max(0, spec.fuelTankL - this.data.ownedCar.fuelLiters);
    const amount = Math.min(needed, Math.max(0, finite(liters, needed)));
    const affordable = this.data.admin.infiniteMoney ? amount : Math.min(amount, this.data.money / ECONOMY.refuelPricePerLiter);
    const cost = Math.round(affordable * ECONOMY.refuelPricePerLiter);
    this.transact((draft) => {
      if (!draft.admin.infiniteMoney) draft.money = Math.max(0, draft.money - cost);
      draft.ownedCar.fuelLiters = Math.min(spec.fuelTankL, draft.ownedCar.fuelLiters + affordable);
    }, 'refuel', true);
    return { liters: affordable, cost, fuelLiters: this.data.ownedCar.fuelLiters, money: this.data.money };
  }

  callTow() {
    if (!this.canAfford(ECONOMY.towCost)) return { ok: false, reason: 'funds', cost: ECONOMY.towCost };
    this.transact((draft) => {
      if (!draft.admin.infiniteMoney) draft.money -= ECONOMY.towCost;
      draft.records.towsCalled += 1;
      draft.currentRun.active = false;
      draft.currentRun.combo = 1;
      draft.currentRun.comboChain = 0;
    }, 'tow', true);
    return { ok: true, cost: ECONOMY.towCost, money: this.data.money };
  }

  setSetting(key, value) {
    if (!(key in createDefaultSettings())) return false;
    this.transact((draft) => { draft.settings[key] = value; }, `setting-${key}`, true);
    return true;
  }

  setAdmin(patch) {
    this.transact((draft) => Object.assign(draft.admin, patch || {}), 'admin', true);
    return this.data.admin;
  }

  recordDriveStats(stats = {}, autosave = false) {
    this.update((draft) => {
      const distance = Math.max(0, finite(stats.distanceKm, 0));
      const fuel = Math.max(0, finite(stats.fuelUsedL, 0));
      const play = Math.max(0, finite(stats.playSeconds, 0));
      draft.records.totalDistanceKm += distance;
      draft.records.totalFuelUsedL += fuel;
      draft.records.totalPlaySeconds += play;
      draft.records.maxSpeedKmh = Math.max(draft.records.maxSpeedKmh, finite(stats.speedKmh, 0));
      draft.records.bestCombo = Math.max(draft.records.bestCombo, finite(stats.combo, 1));
      draft.records.highestComboChain = Math.max(draft.records.highestComboChain, finite(stats.comboChain, 0));
      draft.records.totalNearMisses += Math.max(0, Math.floor(finite(stats.nearMisses, 0)));
      draft.ownedCar.mileageKm += distance;
      if (!draft.admin.infiniteFuel) draft.ownedCar.fuelLiters = Math.max(0, draft.ownedCar.fuelLiters - fuel);
    }, 'drive-stats', autosave);
  }
}

export const saveSystem = new SaveSystem();
export const saveManager = saveSystem;

export function loadSave(seed) { return saveSystem.load(seed); }
export function saveGame(reason) { return saveSystem.save(reason); }
export function newGame(seed) { return saveSystem.newGame(seed); }
export function getSaveData() { return saveSystem.data; }

export default saveSystem;
