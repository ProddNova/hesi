/**
 * Static game data and deterministic economy helpers for Shutoko Nights.
 * Everything in this module is plain serialisable data so save files remain
 * portable between releases.
 */

export const DATA_VERSION = 1;

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

const car = (spec) => {
  const brakeForce = spec.brakeForce < 100
    ? Math.round(spec.brakeForce * spec.massKg * 1.05)
    : spec.brakeForce;
  const engine = {
    ...spec.engine,
    displacement: spec.engine.displacementL,
    powerHP: spec.engine.powerHp,
    horsepower: spec.engine.powerHp,
    power: spec.engine.powerHp,
    peakTorque: spec.engine.peakTorqueNm,
    torque: spec.engine.peakTorqueNm,
    redlineRPM: spec.engine.redlineRpm,
    idleRPM: spec.engine.idleRpm,
  };
  const transmission = {
    ...spec.transmission,
    gearRatios: spec.transmission.gears,
    ratios: spec.transmission.gears,
    reverseRatio: Math.abs(spec.transmission.reverse),
  };
  return deepFreeze({
    ...spec,
    engine,
    transmission,
    starter: spec.id === 'suzume-e90',
    price: spec.basePrice,
    color: spec.colors[0],
    power: spec.engine.powerHp,
    powerHP: spec.engine.powerHp,
    horsepower: spec.engine.powerHp,
    torque: spec.engine.peakTorqueNm,
    peakTorque: spec.engine.peakTorqueNm,
    engineLayout: spec.engine.layout,
    displacement: spec.engine.displacementL,
    idleRPM: spec.engine.idleRpm,
    redline: spec.engine.redlineRpm,
    redlineRPM: spec.engine.redlineRpm,
    gearRatios: spec.transmission.gears,
    finalDrive: spec.transmission.finalDrive,
    reverseRatio: Math.abs(spec.transmission.reverse),
    shiftTime: spec.transmission.shiftTime,
    mass: spec.massKg,
    frontWeight: spec.weightDistributionFront,
    wheelbase: spec.silhouette.wheelbase,
    length: spec.silhouette.length,
    width: spec.silhouette.width,
    wheelRadius: spec.silhouette.wheelRadius,
    maxSteer: spec.steeringLockDeg * Math.PI / 180,
    dimensions: {
      length: spec.silhouette.length,
      width: spec.silhouette.width,
      height: spec.silhouette.height,
      wheelbase: spec.silhouette.wheelbase,
    },
    brakeForce,
    dragArea: spec.dragCd * spec.frontalAreaM2,
    fuelCapacity: spec.fuelTankL,
    fuelUseMultiplier: spec.fuelFullLoadLph / Math.max(18, spec.fuelTankL),
  });
};

export const CAR_SPECS = deepFreeze([
  car({
    id: 'suzume-e90',
    name: 'Suzume E90',
    subtitle: 'GL Touring Sedan',
    year: 1988,
    tier: 0,
    bodyStyle: 'compact-sedan',
    description: 'An honest, narrow old sedan. Slow enough to teach momentum and lively enough to teach countersteer.',
    basePrice: 165000,
    colors: ['#c8c3ad', '#8c2731', '#31506c', '#5c625c'],
    silhouette: {
      length: 4.12, width: 1.64, height: 1.38, wheelbase: 2.43,
      hood: 0.31, cabin: 0.48, trunk: 0.21, roofDrop: 0.08,
      wheelRadius: 0.29, wheelWidth: 0.18,
    },
    engine: {
      layout: 'I4', cylinders: 4, displacementL: 1.5, aspiration: 'NA',
      powerHp: 92, peakTorqueNm: 126, idleRpm: 850, redlineRpm: 6500,
      torqueCurve: [[800, 0.57], [1800, 0.78], [3200, 0.96], [4300, 1], [5600, 0.91], [6500, 0.70], [6900, 0.15]],
    },
    drivetrain: 'RWD',
    transmission: { gears: [3.55, 2.04, 1.38, 1.00, 0.81], reverse: -3.42, finalDrive: 4.10, shiftTime: 0.29, efficiency: 0.86 },
    massKg: 940, weightDistributionFront: 0.53, dragCd: 0.36, frontalAreaM2: 1.82,
    tireGrip: 0.94, brakeForce: 9.3, suspensionStiffness: 0.88, steeringLockDeg: 36,
    fuelTankL: 44, fuelIdleLph: 0.75, fuelFullLoadLph: 25, topSpeedKmh: 166,
  }),
  car({
    id: 'maboroshi-k-turbo',
    name: 'Maboroshi K-Turbo',
    subtitle: 'Pocket Works Hatch',
    year: 1994,
    tier: 1,
    bodyStyle: 'kei-hatch',
    description: 'A tiny turbo hatch with no mass to spare. It changes lanes like a thought, but dislikes crosswinds.',
    basePrice: 285000,
    colors: ['#e8dfb4', '#db3c34', '#3b7b87', '#6e6a79', '#eff0e8'],
    silhouette: {
      length: 3.30, width: 1.44, height: 1.42, wheelbase: 2.18,
      hood: 0.20, cabin: 0.67, trunk: 0.13, roofDrop: 0.03,
      wheelRadius: 0.25, wheelWidth: 0.15,
    },
    engine: {
      layout: 'I3', cylinders: 3, displacementL: 0.66, aspiration: 'Turbo',
      powerHp: 78, peakTorqueNm: 108, idleRpm: 950, redlineRpm: 7800,
      torqueCurve: [[900, 0.38], [2200, 0.60], [3400, 0.94], [4700, 1], [6500, 0.89], [7800, 0.67], [8200, 0.12]],
    },
    drivetrain: 'FWD',
    transmission: { gears: [3.25, 1.94, 1.32, 0.97, 0.76], reverse: -3.41, finalDrive: 4.70, shiftTime: 0.26, efficiency: 0.84 },
    massKg: 690, weightDistributionFront: 0.61, dragCd: 0.38, frontalAreaM2: 1.55,
    tireGrip: 0.96, brakeForce: 9.6, suspensionStiffness: 0.91, steeringLockDeg: 38,
    fuelTankL: 31, fuelIdleLph: 0.55, fuelFullLoadLph: 18, topSpeedKmh: 174,
  }),
  car({
    id: 'tsukuba-aerio',
    name: 'Tsukuba Aerio',
    subtitle: 'Clubman Roadster',
    year: 1997,
    tier: 2,
    bodyStyle: 'roadster',
    description: 'A featherweight open two-seater with a rev-hungry four. Braking late is practically compulsory.',
    basePrice: 610000,
    colors: ['#c12e32', '#e6e4db', '#1f4e74', '#172126', '#d0a432'],
    silhouette: {
      length: 3.86, width: 1.69, height: 1.18, wheelbase: 2.27,
      hood: 0.42, cabin: 0.45, trunk: 0.13, roofDrop: 0.18,
      wheelRadius: 0.30, wheelWidth: 0.19,
    },
    engine: {
      layout: 'I4', cylinders: 4, displacementL: 1.8, aspiration: 'NA',
      powerHp: 175, peakTorqueNm: 178, idleRpm: 900, redlineRpm: 7900,
      torqueCurve: [[900, 0.48], [2500, 0.69], [4400, 0.88], [6100, 1], [7400, 0.95], [7900, 0.82], [8300, 0.12]],
    },
    drivetrain: 'RWD',
    transmission: { gears: [3.14, 1.89, 1.33, 1.00, 0.81, 0.69], reverse: -3.18, finalDrive: 4.30, shiftTime: 0.23, efficiency: 0.89 },
    massKg: 1015, weightDistributionFront: 0.50, dragCd: 0.35, frontalAreaM2: 1.72,
    tireGrip: 1.04, brakeForce: 10.7, suspensionStiffness: 1.07, steeringLockDeg: 37,
    fuelTankL: 48, fuelIdleLph: 0.80, fuelFullLoadLph: 39, topSpeedKmh: 224,
  }),
  car({
    id: 'shirasawa-touring-gt',
    name: 'Shirasawa Touring GT',
    subtitle: 'All-Road Sports Wagon',
    year: 2001,
    tier: 3,
    bodyStyle: 'sport-wagon',
    description: 'A planted turbo wagon that shrugs off wet ramps. Safe at the front, playful when provoked.',
    basePrice: 1080000,
    colors: ['#24487a', '#c7c7c2', '#30343a', '#6a2830', '#46705d'],
    silhouette: {
      length: 4.55, width: 1.75, height: 1.43, wheelbase: 2.63,
      hood: 0.29, cabin: 0.62, trunk: 0.09, roofDrop: 0.04,
      wheelRadius: 0.31, wheelWidth: 0.21,
    },
    engine: {
      layout: 'H4', cylinders: 4, displacementL: 2.0, aspiration: 'Turbo',
      powerHp: 218, peakTorqueNm: 302, idleRpm: 800, redlineRpm: 7000,
      torqueCurve: [[800, 0.43], [2100, 0.72], [3200, 1], [4600, 0.98], [6100, 0.85], [7000, 0.65], [7400, 0.10]],
    },
    drivetrain: 'AWD',
    transmission: { gears: [3.45, 1.95, 1.37, 1.03, 0.78, 0.65], reverse: -3.33, finalDrive: 4.11, shiftTime: 0.25, efficiency: 0.84 },
    massKg: 1450, weightDistributionFront: 0.57, dragCd: 0.32, frontalAreaM2: 2.05,
    tireGrip: 1.06, brakeForce: 11.2, suspensionStiffness: 1.04, steeringLockDeg: 34,
    fuelTankL: 60, fuelIdleLph: 1.05, fuelFullLoadLph: 57, topSpeedKmh: 243,
  }),
  car({
    id: 'hoshino-arc-r',
    name: 'Hoshino Arc-R',
    subtitle: 'Type S Sports Coupe',
    year: 1999,
    tier: 4,
    bodyStyle: 'sports-coupe',
    description: 'A compact turbo coupe with a sharp front axle and a boost-heavy exit. Respect the rear tires.',
    basePrice: 1540000,
    colors: ['#d5d8d8', '#db7b25', '#183e6a', '#4c2028', '#202527'],
    silhouette: {
      length: 4.34, width: 1.76, height: 1.27, wheelbase: 2.52,
      hood: 0.36, cabin: 0.48, trunk: 0.16, roofDrop: 0.11,
      wheelRadius: 0.32, wheelWidth: 0.22,
    },
    engine: {
      layout: 'I4', cylinders: 4, displacementL: 2.0, aspiration: 'Turbo',
      powerHp: 247, peakTorqueNm: 337, idleRpm: 850, redlineRpm: 7400,
      torqueCurve: [[850, 0.38], [2400, 0.61], [3600, 0.96], [4400, 1], [6100, 0.91], [7400, 0.68], [7800, 0.12]],
    },
    drivetrain: 'RWD',
    transmission: { gears: [3.42, 2.01, 1.39, 1.06, 0.83, 0.69], reverse: -3.38, finalDrive: 4.08, shiftTime: 0.22, efficiency: 0.88 },
    massKg: 1260, weightDistributionFront: 0.54, dragCd: 0.31, frontalAreaM2: 1.89,
    tireGrip: 1.08, brakeForce: 11.7, suspensionStiffness: 1.12, steeringLockDeg: 35,
    fuelTankL: 55, fuelIdleLph: 0.95, fuelFullLoadLph: 64, topSpeedKmh: 263,
  }),
  car({
    id: 'nagare-rz',
    name: 'Nagare RZ',
    subtitle: 'Twin-Rotor Grand Sport',
    year: 2002,
    tier: 5,
    bodyStyle: 'fastback-coupe',
    description: 'A low twin-rotor fastback: smooth, light and ferociously thirsty when the second turbo wakes up.',
    basePrice: 2230000,
    colors: ['#a9232c', '#283f6d', '#e5e1d5', '#25282b', '#c99b28'],
    silhouette: {
      length: 4.43, width: 1.81, height: 1.22, wheelbase: 2.61,
      hood: 0.40, cabin: 0.49, trunk: 0.11, roofDrop: 0.14,
      wheelRadius: 0.33, wheelWidth: 0.24,
    },
    engine: {
      layout: 'R2', cylinders: 2, displacementL: 1.3, aspiration: 'Twin Turbo',
      powerHp: 280, peakTorqueNm: 314, idleRpm: 1000, redlineRpm: 8200,
      torqueCurve: [[1000, 0.35], [2800, 0.57], [4100, 0.89], [5200, 1], [6900, 0.96], [8200, 0.77], [8600, 0.10]],
    },
    drivetrain: 'RWD',
    transmission: { gears: [3.48, 2.02, 1.39, 1.00, 0.76, 0.62], reverse: -3.29, finalDrive: 4.10, shiftTime: 0.20, efficiency: 0.90 },
    massKg: 1280, weightDistributionFront: 0.51, dragCd: 0.29, frontalAreaM2: 1.84,
    tireGrip: 1.10, brakeForce: 12.1, suspensionStiffness: 1.14, steeringLockDeg: 34,
    fuelTankL: 76, fuelIdleLph: 1.25, fuelFullLoadLph: 78, topSpeedKmh: 285,
  }),
  car({
    id: 'kaido-rs6',
    name: 'Kaido RS-6',
    subtitle: 'Midnight Touring Coupe',
    year: 2000,
    tier: 6,
    bodyStyle: 'gt-coupe',
    description: 'The expressway benchmark: long-geared, eerily stable and powered by a deep-reserve straight six.',
    basePrice: 2960000,
    colors: ['#505b64', '#e5e5df', '#162d50', '#4c1720', '#161a1d'],
    silhouette: {
      length: 4.61, width: 1.79, height: 1.30, wheelbase: 2.68,
      hood: 0.41, cabin: 0.44, trunk: 0.15, roofDrop: 0.09,
      wheelRadius: 0.33, wheelWidth: 0.25,
    },
    engine: {
      layout: 'I6', cylinders: 6, displacementL: 2.6, aspiration: 'Twin Turbo',
      powerHp: 296, peakTorqueNm: 392, idleRpm: 800, redlineRpm: 7800,
      torqueCurve: [[800, 0.44], [2300, 0.72], [3400, 0.97], [4700, 1], [6500, 0.94], [7800, 0.74], [8200, 0.10]],
    },
    drivetrain: 'AWD',
    transmission: { gears: [3.21, 1.93, 1.30, 1.00, 0.75, 0.62], reverse: -3.38, finalDrive: 3.72, shiftTime: 0.22, efficiency: 0.85 },
    massKg: 1540, weightDistributionFront: 0.56, dragCd: 0.30, frontalAreaM2: 1.94,
    tireGrip: 1.11, brakeForce: 12.0, suspensionStiffness: 1.10, steeringLockDeg: 33,
    fuelTankL: 65, fuelIdleLph: 1.15, fuelFullLoadLph: 76, topSpeedKmh: 292,
  }),
  car({
    id: 'raijin-sovereign-8',
    name: 'Raijin Sovereign 8',
    subtitle: 'Executive V8 Limited',
    year: 2004,
    tier: 7,
    bodyStyle: 'big-body-sedan',
    description: 'Two tonnes of velvet-lined intent. The V8 turns Wangan traffic into scenery and tires into smoke.',
    basePrice: 3350000,
    colors: ['#111619', '#4b5050', '#e1ddcf', '#263752', '#4a2528'],
    silhouette: {
      length: 5.05, width: 1.88, height: 1.46, wheelbase: 2.92,
      hood: 0.33, cabin: 0.49, trunk: 0.18, roofDrop: 0.04,
      wheelRadius: 0.34, wheelWidth: 0.25,
    },
    engine: {
      layout: 'V8', cylinders: 8, displacementL: 4.5, aspiration: 'NA',
      powerHp: 326, peakTorqueNm: 446, idleRpm: 700, redlineRpm: 6800,
      torqueCurve: [[700, 0.68], [1700, 0.84], [3100, 0.97], [4300, 1], [5800, 0.91], [6800, 0.73], [7200, 0.10]],
    },
    drivetrain: 'RWD',
    transmission: { gears: [3.54, 2.06, 1.40, 1.00, 0.71, 0.58], reverse: -3.17, finalDrive: 3.46, shiftTime: 0.30, efficiency: 0.88 },
    massKg: 1840, weightDistributionFront: 0.55, dragCd: 0.29, frontalAreaM2: 2.18,
    tireGrip: 1.04, brakeForce: 11.6, suspensionStiffness: 0.98, steeringLockDeg: 32,
    fuelTankL: 82, fuelIdleLph: 1.55, fuelFullLoadLph: 91, topSpeedKmh: 278,
  }),
]);

export const CARS = CAR_SPECS;
export const CAR_BY_ID = deepFreeze(Object.fromEntries(CAR_SPECS.map((entry) => [entry.id, entry])));
export const STARTER_CAR_ID = 'suzume-e90';

const part = (entry) => {
  const source = entry.modifiers || {};
  const modifiers = {
    ...source,
    ...(source.massDeltaKg !== undefined ? { massDelta: source.massDeltaKg } : {}),
    ...(source.redlineDeltaRpm !== undefined ? { redlineDelta: source.redlineDeltaRpm } : {}),
    ...(source.suspensionMultiplier !== undefined ? { suspensionStiffness: source.suspensionMultiplier } : {}),
    ...(source.turboLevel !== undefined ? { turbo: source.turboLevel, turboStage: source.turboLevel } : {}),
    ...(source.fuelConsumptionMultiplier !== undefined ? { fuelUseMultiplier: source.fuelConsumptionMultiplier } : {}),
  };
  return deepFreeze({ compatibleCars: 'all', universal: true, ...entry, modifiers });
};

export const PART_CATALOG = deepFreeze([
  part({ id: 'intake-s1', category: 'engine', slot: 'intake', stage: 1, name: 'Cold Ram Intake', price: 28000, description: 'Less intake restriction and a sharper throttle.', modifiers: { powerMultiplier: 1.025, torqueMultiplier: 1.018, fuelConsumptionMultiplier: 1.01 }, statDeltas: { power: '+2.5%', torque: '+1.8%' } }),
  part({ id: 'intake-s2', category: 'engine', slot: 'intake', stage: 2, name: 'Carbon Airbox', price: 76000, description: 'A sealed high-flow airbox tuned for expressway load.', modifiers: { powerMultiplier: 1.052, torqueMultiplier: 1.034, fuelConsumptionMultiplier: 1.015 }, statDeltas: { power: '+5.2%', torque: '+3.4%' } }),
  part({ id: 'exhaust-s1', category: 'engine', slot: 'exhaust', stage: 1, name: 'Street Cat-Back', price: 42000, description: 'A freer rear section with restrained motorway drone.', modifiers: { powerMultiplier: 1.032, torqueMultiplier: 1.022, massDeltaKg: -5, fuelConsumptionMultiplier: 1.012, exhaustLevel: 1 }, statDeltas: { power: '+3.2%', torque: '+2.2%', mass: '-5 kg' } }),
  part({ id: 'exhaust-s2', category: 'engine', slot: 'exhaust', stage: 2, name: 'Titanium Full System', price: 124000, description: 'Headers, high-flow catalyst and a very light rear section.', modifiers: { powerMultiplier: 1.071, torqueMultiplier: 1.047, massDeltaKg: -13, fuelConsumptionMultiplier: 1.025, exhaustLevel: 2 }, statDeltas: { power: '+7.1%', torque: '+4.7%', mass: '-13 kg' } }),
  part({ id: 'ecu-s1', category: 'engine', slot: 'ecu', stage: 1, name: 'Street ECU', price: 68000, description: 'Ignition and fuel mapping for pump fuel.', modifiers: { powerMultiplier: 1.045, torqueMultiplier: 1.052, redlineDeltaRpm: 150, fuelConsumptionMultiplier: 1.02 }, statDeltas: { power: '+4.5%', torque: '+5.2%', redline: '+150 rpm' } }),
  part({ id: 'ecu-s2', category: 'engine', slot: 'ecu', stage: 2, name: 'Night Map ECU', price: 176000, description: 'Aggressive high-load calibration with launch enrichment.', modifiers: { powerMultiplier: 1.09, torqueMultiplier: 1.105, redlineDeltaRpm: 350, fuelConsumptionMultiplier: 1.06 }, statDeltas: { power: '+9.0%', torque: '+10.5%', redline: '+350 rpm' } }),
  part({ id: 'turbo-s1', category: 'engine', slot: 'turbo', stage: 1, name: 'Low-Mount Turbo Kit', price: 238000, description: 'Fast-spooling street boost; converts naturally aspirated engines too.', modifiers: { powerMultiplier: 1.18, torqueMultiplier: 1.22, fuelConsumptionMultiplier: 1.13, turboLevel: 1 }, statDeltas: { power: '+18%', torque: '+22%', turbo: '0.55 bar' } }),
  part({ id: 'turbo-s2', category: 'engine', slot: 'turbo', stage: 2, name: 'High-Flow Turbo Kit', price: 445000, description: 'A larger compressor, intercooler and supporting fuel system.', modifiers: { powerMultiplier: 1.36, torqueMultiplier: 1.39, fuelConsumptionMultiplier: 1.25, turboLevel: 2 }, statDeltas: { power: '+36%', torque: '+39%', turbo: '0.90 bar' } }),
  part({ id: 'turbo-s3', category: 'engine', slot: 'turbo', stage: 3, name: 'Wangan Special Turbo', price: 780000, description: 'A serious top-end system with lag, whistle and four-digit ambitions.', modifiers: { powerMultiplier: 1.58, torqueMultiplier: 1.54, fuelConsumptionMultiplier: 1.39, turboLevel: 3 }, statDeltas: { power: '+58%', torque: '+54%', turbo: '1.25 bar' } }),
  part({ id: 'tires-s1', category: 'tires', slot: 'tires', stage: 1, name: 'Fresh Touring Tires', price: 24000, description: 'New rubber with predictable breakaway.', modifiers: { gripMultiplier: 1.06 }, statDeltas: { grip: '+6%' } }),
  part({ id: 'tires-s2', category: 'tires', slot: 'tires', stage: 2, name: 'Night Sport Tires', price: 68000, description: 'A sticky road compound that tolerates sustained speed.', modifiers: { gripMultiplier: 1.14, rollingResistanceMultiplier: 1.015 }, statDeltas: { grip: '+14%' } }),
  part({ id: 'tires-s3', category: 'tires', slot: 'tires', stage: 3, name: 'Street Semi-Slicks', price: 146000, description: 'Maximum dry grip with an abrupt limit.', modifiers: { gripMultiplier: 1.23, rollingResistanceMultiplier: 1.03 }, statDeltas: { grip: '+23%' } }),
  part({ id: 'suspension-s1', category: 'suspension', slot: 'suspension', stage: 1, name: 'Sport Springs', price: 39000, description: 'Lower roll and quicker weight transfer.', modifiers: { suspensionMultiplier: 1.10, gripMultiplier: 1.015, massDeltaKg: -2 }, statDeltas: { stiffness: '+10%', grip: '+1.5%', mass: '-2 kg' } }),
  part({ id: 'suspension-s2', category: 'suspension', slot: 'suspension', stage: 2, name: 'Adjustable Coilovers', price: 112000, description: 'Matched dampers and springs for the tight C1.', modifiers: { suspensionMultiplier: 1.25, gripMultiplier: 1.035, steeringResponseMultiplier: 1.08, massDeltaKg: -5 }, statDeltas: { stiffness: '+25%', grip: '+3.5%', response: '+8%' } }),
  part({ id: 'suspension-s3', category: 'suspension', slot: 'suspension', stage: 3, name: 'Circuit Geometry Kit', price: 228000, description: 'Roll centre correction, arms and firm monotube dampers.', modifiers: { suspensionMultiplier: 1.43, gripMultiplier: 1.06, steeringResponseMultiplier: 1.15, massDeltaKg: -8 }, statDeltas: { stiffness: '+43%', grip: '+6%', response: '+15%' } }),
  part({ id: 'brakes-s1', category: 'brakes', slot: 'brakes', stage: 1, name: 'Performance Pads', price: 26000, description: 'Higher-friction pads and fresh fluid.', modifiers: { brakeMultiplier: 1.10, brakeFadeMultiplier: 0.88 }, statDeltas: { braking: '+10%', fade: '-12%' } }),
  part({ id: 'brakes-s2', category: 'brakes', slot: 'brakes', stage: 2, name: 'Slotted Rotor Set', price: 87000, description: 'Larger rotors with braided lines.', modifiers: { brakeMultiplier: 1.22, brakeFadeMultiplier: 0.68, massDeltaKg: 2 }, statDeltas: { braking: '+22%', fade: '-32%', mass: '+2 kg' } }),
  part({ id: 'brakes-s3', category: 'brakes', slot: 'brakes', stage: 3, name: 'Six-Piston Brake Kit', price: 214000, description: 'Repeatable stopping power for 280 km/h entries.', modifiers: { brakeMultiplier: 1.36, brakeFadeMultiplier: 0.48, massDeltaKg: 4 }, statDeltas: { braking: '+36%', fade: '-52%', mass: '+4 kg' } }),
  part({ id: 'weight-s1', category: 'weight', slot: 'weight', stage: 1, name: 'Touring Weight Trim', price: 55000, description: 'Lighter seats, battery and exhaust shields.', modifiers: { massDeltaKg: -42, cabinNoiseMultiplier: 1.08 }, statDeltas: { mass: '-42 kg' } }),
  part({ id: 'weight-s2', category: 'weight', slot: 'weight', stage: 2, name: 'Clubman Reduction', price: 164000, description: 'Interior trim removal and lightweight panels.', modifiers: { massDeltaKg: -96, cabinNoiseMultiplier: 1.18 }, statDeltas: { mass: '-96 kg' } }),
  part({ id: 'weight-s3', category: 'weight', slot: 'weight', stage: 3, name: 'Composite Body Program', price: 390000, description: 'Composite closures and obsessive bracket removal.', modifiers: { massDeltaKg: -162, dragDeltaCd: -0.005, cabinNoiseMultiplier: 1.34 }, statDeltas: { mass: '-162 kg', drag: '-0.005 Cd' } }),
  part({ id: 'gearbox-s1', category: 'gearbox', slot: 'gearbox', stage: 1, name: 'Close-Ratio Gearset', price: 92000, description: 'Shorter lower gears keep the engine on cam.', modifiers: { gearRatioMultiplier: 1.07, finalDriveMultiplier: 1.02, shiftTimeMultiplier: 0.90 }, statDeltas: { acceleration: '+7%', shift: '-10%', topSpeed: '-5%' } }),
  part({ id: 'gearbox-s2', category: 'gearbox', slot: 'gearbox', stage: 2, name: 'Wangan Gearset', price: 188000, description: 'Stronger internals and a taller final drive for the bayshore.', modifiers: { gearRatioMultiplier: 0.98, finalDriveMultiplier: 0.90, shiftTimeMultiplier: 0.76, transmissionEfficiencyMultiplier: 1.025 }, statDeltas: { topSpeed: '+10%', shift: '-24%', acceleration: '-2%' } }),
  part({ id: 'gearbox-s3', category: 'gearbox', slot: 'gearbox', stage: 3, name: 'Dog Engagement Six-Speed', price: 354000, description: 'Instant, brutal shifts and motorsport-strength gears.', modifiers: { gearRatioMultiplier: 1.025, finalDriveMultiplier: 0.96, shiftTimeMultiplier: 0.48, transmissionEfficiencyMultiplier: 1.05 }, statDeltas: { acceleration: '+2.5%', topSpeed: '+2%', shift: '-52%' } }),
]);

export const PARTS = PART_CATALOG;
export const PART_BY_ID = deepFreeze(Object.fromEntries(PART_CATALOG.map((entry) => [entry.id, entry])));
export const PART_CATEGORIES = deepFreeze([
  { id: 'engine', label: 'Engine', order: 0 },
  { id: 'tires', label: 'Tires', order: 1 },
  { id: 'suspension', label: 'Suspension', order: 2 },
  { id: 'brakes', label: 'Brakes', order: 3 },
  { id: 'weight', label: 'Weight Reduction', order: 4 },
  { id: 'gearbox', label: 'Gearbox', order: 5 },
]);

export const CONSUMABLES = deepFreeze([
  { id: 'fuel-can-20l', category: 'fuel', name: '20 L Emergency Fuel Can', price: 9000, liters: 20, deliverySeconds: 12, description: 'Delivered to the garage shutter. Carry it to the car to refuel.' },
]);

export const ECONOMY = deepFreeze({
  currency: '¥',
  startingMoney: 135000,
  scoreToMoney: 0.44,
  minimumBankPayout: 100,
  refuelPricePerLiter: 185,
  fuelPerLiter: 185,
  fuelCanPrice: 9000,
  towCost: 12000,
  resetPenalty: 2500,
  baseDeliverySeconds: 18,
  partResaleRate: 0.34,
  tradeBaseRate: 0.68,
  auctionCount: 10,
  listingRefreshCost: 75000,
  listingPriceVariance: 0.075,
  nearMissBaseScore: 260,
  speedScorePerSecond: 3.8,
});

export const CONDITION_GRADES = deepFreeze({
  '5': { label: '5 / Museum', power: 1.000, grip: 1.000, brake: 1.000, suspension: 1.000, value: 1.14 },
  '4.5': { label: '4.5 / Excellent', power: 0.994, grip: 0.995, brake: 0.996, suspension: 0.995, value: 1.05 },
  '4': { label: '4 / Good', power: 0.985, grip: 0.988, brake: 0.990, suspension: 0.986, value: 0.96 },
  '3.5': { label: '3.5 / Used', power: 0.968, grip: 0.976, brake: 0.981, suspension: 0.970, value: 0.84 },
  '3': { label: '3 / Worn', power: 0.943, grip: 0.958, brake: 0.966, suspension: 0.949, value: 0.70 },
  '2.5': { label: '2.5 / Rough', power: 0.910, grip: 0.930, brake: 0.945, suspension: 0.918, value: 0.55 },
});

export function hashSeed(seed) {
  const text = String(seed ?? 'shutoko');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x9e3779b9;
}

/** Mulberry32: compact, deterministic, and sufficient for auction generation. */
export function createSeededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function getCarSpec(carId) {
  return CAR_BY_ID[carId] || CAR_BY_ID[STARTER_CAR_ID];
}

export function getPart(partId) {
  return PART_BY_ID[partId] || null;
}

export function getPartsByCategory(category) {
  return PART_CATALOG.filter((entry) => entry.category === category);
}

export function conditionFromMileage(mileageKm, random = Math.random) {
  const wear = Math.max(0, mileageKm) / 230000 + random() * 0.32;
  if (wear < 0.19) return '5';
  if (wear < 0.36) return '4.5';
  if (wear < 0.58) return '4';
  if (wear < 0.79) return '3.5';
  if (wear < 1.01) return '3';
  return '2.5';
}

export function getConditionEffects(grade = '4', mileageKm = 0) {
  const base = CONDITION_GRADES[String(grade)] || CONDITION_GRADES['4'];
  const highMileage = Math.max(0, mileageKm - 80000);
  const mileageWear = Math.min(0.055, highMileage / 3000000);
  return {
    powerMultiplier: Math.max(0.84, base.power - mileageWear),
    torqueMultiplier: Math.max(0.85, base.power - mileageWear * 0.82),
    gripMultiplier: Math.max(0.86, base.grip - mileageWear * 0.48),
    brakeMultiplier: Math.max(0.88, base.brake - mileageWear * 0.35),
    suspensionMultiplier: Math.max(0.84, base.suspension - mileageWear * 0.60),
    valueMultiplier: Math.max(0.40, base.value - mileageWear * 2.4),
  };
}

function roundTo(value, step = 1000) {
  return Math.round(value / step) * step;
}

function randomInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

export function createSeededAuction(seed, count = ECONOMY.auctionCount) {
  const random = createSeededRandom(seed);
  const requestedCount = typeof count === 'number' ? count : ECONOMY.auctionCount;
  const targetCount = Math.max(8, Math.min(12, Math.round(requestedCount || ECONOMY.auctionCount)));
  const roster = [];
  while (roster.length < targetCount) {
    const cycle = CAR_SPECS.slice();
    for (let index = cycle.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [cycle[index], cycle[swapIndex]] = [cycle[swapIndex], cycle[index]];
    }
    roster.push(...cycle);
  }

  return roster.slice(0, targetCount).map((spec, index) => {
    const ageFactor = Math.max(0.25, (2027 - spec.year) / 28);
    const mileageKm = roundTo(randomInt(random, 18000, Math.round(205000 * ageFactor + 52000)), 1000);
    const conditionGrade = conditionFromMileage(mileageKm, random);
    const condition = getConditionEffects(conditionGrade, mileageKm);
    const variance = 1 + (random() * 2 - 1) * ECONOMY.listingPriceVariance;
    const collectible = spec.year < 1995 ? 1.04 : 1;
    const price = Math.max(90000, roundTo(spec.basePrice * condition.valueMultiplier * collectible * variance, 5000));
    const color = spec.colors[randomInt(random, 0, spec.colors.length - 1)];
    const lotNumber = 1000 + randomInt(random, 0, 8999);
    const inspection = {
      exterior: conditionGrade,
      interior: random() > 0.72 ? 'B' : random() > 0.20 ? 'C' : 'D',
      notes: mileageKm > 150000 ? 'High mileage; drivetrain inspected.' : random() > 0.55 ? 'Minor age marks. No structural repair.' : 'Clean underbody. Service history included.',
    };
    return {
      id: `auc-${hashSeed(seed).toString(36)}-${String(index + 1).padStart(2, '0')}`,
      lotNumber,
      carId: spec.id,
      name: spec.name,
      subtitle: spec.subtitle,
      year: spec.year,
      mileageKm,
      mileage: mileageKm,
      conditionGrade,
      grade: conditionGrade,
      condition: condition.powerMultiplier,
      conditionEffects: condition,
      color,
      engine: {
        layout: spec.engine.layout,
        displacementL: spec.engine.displacementL,
        aspiration: spec.engine.aspiration,
        powerHp: Math.round(spec.engine.powerHp * condition.powerMultiplier),
      },
      effectivePower: Math.round(spec.engine.powerHp * condition.powerMultiplier),
      drivetrain: spec.drivetrain,
      inspection,
      price,
      status: 'available',
      preview: { bodyStyle: spec.bodyStyle, silhouette: spec.silhouette, color },
    };
  });
}

export const generateAuctionListings = createSeededAuction;

export function createStarterCar() {
  const spec = getCarSpec(STARTER_CAR_ID);
  const mileageKm = 184000;
  const conditionGrade = '3.5';
  return {
    instanceId: `car-starter-${Date.now().toString(36)}`,
    carId: spec.id,
    acquiredAt: new Date().toISOString(),
    purchasePrice: 0,
    color: spec.colors[0],
    mileageKm,
    conditionGrade,
    conditionEffects: getConditionEffects(conditionGrade, mileageKm),
    installedParts: [],
    fuelLiters: spec.fuelTankL * 0.72,
  };
}

export function carFromAuctionListing(listing) {
  const spec = getCarSpec(listing?.carId);
  const mileageKm = Math.max(0, Number(listing?.mileageKm) || 0);
  const conditionGrade = String(listing?.conditionGrade || '4');
  return {
    instanceId: `car-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    carId: spec.id,
    sourceListingId: listing?.id || null,
    acquiredAt: new Date().toISOString(),
    purchasePrice: Math.max(0, Number(listing?.price) || spec.basePrice),
    color: listing?.color || spec.colors[0],
    mileageKm,
    conditionGrade,
    conditionEffects: getConditionEffects(conditionGrade, mileageKm),
    installedParts: [],
    fuelLiters: Math.min(spec.fuelTankL, Math.max(spec.fuelTankL * 0.12, Number(listing?.fuelLiters) || spec.fuelTankL * 0.35)),
  };
}

function uniqueBestParts(partIds) {
  const bestBySlot = new Map();
  for (const id of partIds || []) {
    const selected = getPart(typeof id === 'string' ? id : id?.partId || id?.id);
    if (!selected) continue;
    const previous = bestBySlot.get(selected.slot);
    if (!previous || selected.stage >= previous.stage) bestBySlot.set(selected.slot, selected);
  }
  return [...bestBySlot.values()];
}

export function getEffectiveInstalledParts(partIds) {
  return uniqueBestParts(partIds);
}

export function buildVehicleStats(carOrId, installedParts, overrideCondition) {
  const owned = typeof carOrId === 'object' && carOrId ? carOrId : { carId: carOrId };
  const spec = getCarSpec(owned.carId || owned.id || carOrId);
  const numericCondition = Number(owned.condition);
  const condition = overrideCondition || owned.conditionEffects || (Number.isFinite(numericCondition)
    ? {
      powerMultiplier: numericCondition,
      torqueMultiplier: numericCondition,
      gripMultiplier: 0.9 + numericCondition * 0.1,
      brakeMultiplier: 0.94 + numericCondition * 0.06,
      suspensionMultiplier: 0.9 + numericCondition * 0.1,
    }
    : getConditionEffects(owned.conditionGrade, owned.mileageKm ?? owned.mileage));
  const selectedParts = uniqueBestParts(installedParts || owned.installedParts || []);
  const mods = {
    powerMultiplier: condition.powerMultiplier || 1,
    torqueMultiplier: condition.torqueMultiplier || condition.powerMultiplier || 1,
    gripMultiplier: condition.gripMultiplier || 1,
    brakeMultiplier: condition.brakeMultiplier || 1,
    suspensionMultiplier: condition.suspensionMultiplier || 1,
    gearRatioMultiplier: 1,
    finalDriveMultiplier: 1,
    shiftTimeMultiplier: 1,
    transmissionEfficiencyMultiplier: 1,
    fuelConsumptionMultiplier: 1,
    rollingResistanceMultiplier: 1,
    steeringResponseMultiplier: 1,
    massDeltaKg: 0,
    dragDeltaCd: 0,
    redlineDeltaRpm: 0,
    turboLevel: spec.engine.aspiration.includes('Turbo') ? 0.5 : 0,
    exhaustLevel: 0,
  };

  for (const selected of selectedParts) {
    for (const [key, value] of Object.entries(selected.modifiers || {})) {
      if (key.endsWith('Multiplier')) mods[key] = (mods[key] ?? 1) * value;
      else if (key.endsWith('DeltaKg') || key.endsWith('DeltaCd') || key.endsWith('DeltaRpm')) mods[key] = (mods[key] ?? 0) + value;
      else mods[key] = Math.max(mods[key] || 0, value);
    }
  }

  const powerHp = Math.round(spec.engine.powerHp * mods.powerMultiplier);
  const peakTorqueNm = Math.round(spec.engine.peakTorqueNm * mods.torqueMultiplier);
  const massKg = Math.max(560, Math.round(spec.massKg + mods.massDeltaKg));
  const ratios = spec.transmission.gears.map((ratio) => ratio * mods.gearRatioMultiplier);
  const finalDrive = spec.transmission.finalDrive * mods.finalDriveMultiplier;
  const estimatedTopSpeedKmh = Math.round(spec.topSpeedKmh * Math.cbrt(mods.powerMultiplier / Math.max(0.8, (spec.dragCd + mods.dragDeltaCd) / spec.dragCd)) / Math.max(0.86, mods.finalDriveMultiplier * mods.gearRatioMultiplier));

  return {
    id: spec.id,
    carId: spec.id,
    name: spec.name,
    year: spec.year,
    price: spec.basePrice,
    bodyStyle: spec.bodyStyle,
    silhouette: spec.silhouette,
    dimensions: spec.dimensions,
    color: owned.color || spec.colors[0],
    drivetrain: spec.drivetrain,
    engine: {
      ...spec.engine,
      powerHp,
      peakTorqueNm,
      redlineRpm: spec.engine.redlineRpm + mods.redlineDeltaRpm,
      turboLevel: mods.turboLevel,
      exhaustLevel: mods.exhaustLevel,
      torqueCurve: spec.engine.torqueCurve.map(([rpm, torque]) => [rpm + (rpm === spec.engine.redlineRpm ? mods.redlineDeltaRpm : 0), torque]),
    },
    transmission: {
      ...spec.transmission,
      gears: ratios,
      finalDrive,
      shiftTime: spec.transmission.shiftTime * mods.shiftTimeMultiplier,
      efficiency: Math.min(0.97, spec.transmission.efficiency * mods.transmissionEfficiencyMultiplier),
    },
    massKg,
    mass: massKg,
    power: powerHp,
    powerHP: powerHp,
    horsepower: powerHp,
    torque: peakTorqueNm,
    peakTorque: peakTorqueNm,
    engineLayout: spec.engine.layout,
    idleRPM: spec.engine.idleRpm,
    redline: spec.engine.redlineRpm + mods.redlineDeltaRpm,
    redlineRPM: spec.engine.redlineRpm + mods.redlineDeltaRpm,
    weightDistributionFront: spec.weightDistributionFront,
    frontWeight: spec.weightDistributionFront,
    dragCd: Math.max(0.22, spec.dragCd + mods.dragDeltaCd),
    frontalAreaM2: spec.frontalAreaM2,
    tireGrip: spec.tireGrip * mods.gripMultiplier,
    brakeForce: spec.brakeForce * mods.brakeMultiplier,
    suspensionStiffness: spec.suspensionStiffness * mods.suspensionMultiplier,
    steeringLockDeg: spec.steeringLockDeg,
    maxSteer: spec.steeringLockDeg * Math.PI / 180,
    steeringResponse: mods.steeringResponseMultiplier,
    rollingResistance: mods.rollingResistanceMultiplier,
    fuelTankL: spec.fuelTankL,
    fuelCapacity: spec.fuelTankL,
    fuelIdleLph: spec.fuelIdleLph,
    fuelFullLoadLph: spec.fuelFullLoadLph * mods.fuelConsumptionMultiplier,
    estimatedTopSpeedKmh,
    gearRatios: ratios,
    finalDrive,
    turbo: mods.turboLevel,
    installedParts: selectedParts.map((entry) => entry.id),
    modifiers: mods,
  };
}

export const calculateVehicleStats = buildVehicleStats;

export function getPartsForCar(carId) {
  return PART_CATALOG.filter((entry) => entry.compatibleCars === 'all'
    || entry.universal
    || entry.carIds?.includes(carId));
}

/** Compatibility-friendly upgrade application used by the physics/game layer. */
export function applyParts(baseCar, parts = []) {
  const effective = buildVehicleStats(baseCar, parts);
  return {
    ...baseCar,
    ...effective,
    engine: effective.engine,
    transmission: effective.transmission,
    condition: Number.isFinite(Number(baseCar?.condition)) ? Number(baseCar.condition) : 1,
    mileage: Number(baseCar?.mileage ?? baseCar?.mileageKm) || 0,
    installedParts: effective.installedParts,
  };
}

export const applyUpgrades = applyParts;

export function calculateTradeValue(ownedCar) {
  if (!ownedCar) return 0;
  const spec = getCarSpec(ownedCar.carId || ownedCar.id);
  const currentMileage = Number(ownedCar.mileageKm ?? ownedCar.mileage) || 0;
  const numericCondition = Number(ownedCar.condition);
  const condition = getConditionEffects(ownedCar.conditionGrade, currentMileage);
  if (Number.isFinite(numericCondition)) condition.valueMultiplier = Math.max(0.4, Math.min(1.14, numericCondition));
  else if (Number.isFinite(Number(ownedCar.conditionEffects?.valueMultiplier))) condition.valueMultiplier = Number(ownedCar.conditionEffects.valueMultiplier);
  const mileageSincePurchase = Math.max(0, currentMileage - (ownedCar.acquiredMileageKm || currentMileage));
  const roadWear = Math.max(0.82, 1 - mileageSincePurchase / 180000);
  const partsValue = uniqueBestParts(ownedCar.installedParts).reduce((sum, installed) => sum + installed.price * ECONOMY.partResaleRate, 0);
  const statedPrice = Number(ownedCar.purchasePrice ?? ownedCar.price);
  const acquisitionAnchor = statedPrice > 0 ? Math.min(spec.basePrice * 1.05, statedPrice) : spec.basePrice;
  return Math.max(45000, roundTo(acquisitionAnchor * ECONOMY.tradeBaseRate * condition.valueMultiplier * roadWear + partsValue, 5000));
}

export const calculateTradeIn = calculateTradeValue;

export function torqueAtRpm(engine, rpm) {
  const curve = engine?.torqueCurve || [];
  if (!curve.length) return 0;
  const target = Math.max(curve[0][0], Number(rpm) || 0);
  for (let index = 1; index < curve.length; index += 1) {
    const [nextRpm, nextValue] = curve[index];
    const [previousRpm, previousValue] = curve[index - 1];
    if (target <= nextRpm) {
      const t = (target - previousRpm) / Math.max(1, nextRpm - previousRpm);
      return engine.peakTorqueNm * (previousValue + (nextValue - previousValue) * t);
    }
  }
  return engine.peakTorqueNm * curve[curve.length - 1][1];
}

export default deepFreeze({
  DATA_VERSION,
  cars: CAR_SPECS,
  carById: CAR_BY_ID,
  parts: PART_CATALOG,
  partById: PART_BY_ID,
  partCategories: PART_CATEGORIES,
  consumables: CONSUMABLES,
  economy: ECONOMY,
  conditionGrades: CONDITION_GRADES,
});
