import * as THREE from 'three';

const G = 9.81;
const TAU = Math.PI * 2;
const HP_TO_WATTS = 745.699872;
const EPSILON = 1e-6;

const clamp = THREE.MathUtils.clamp;

// --- Handling feel ---------------------------------------------------------
// How much of the tires' lateral grip a held steering input may ask for in a
// steady corner. Deliberately below 1: the remainder is the margin the car
// spends on bumps, on the throttle and on a lane change taken mid-corner. At
// 1.0 every held turn is already a slide waiting for its trigger.
const STEER_GRIP_BUDGET = 0.94;
// Extra lock allowed on the way into a corner, before the lateral grip the
// steering asked for has actually arrived. Fades to nothing as the corner loads.
const TURN_IN_BOOST = 0.55;
// A direction change must first unwind the lateral load from the previous
// corner. Give that short transition more authority than a turn from straight;
// it disappears as soon as the old load is gone and never raises steady lock.
const DIRECTION_CHANGE_BOOST = 0.8;
// When the car counts as sliding, measured in multiples of the rear tires' own
// peak slip angle rather than in degrees — a soft tire on a wet surface is away
// at an angle a sticky one is still gripping at. Nothing below onset is touched,
// so ordinary hard cornering never meets the assists.
const SLIDE_ONSET = 1;
const SLIDE_RANGE = 1.15;
// Fraction of the slide-cancelling steering angle handed to the driver, and the
// surplus yaw rate (per second) the stability control removes at full slide.
const COUNTER_STEER_ASSIST = 0.55;
const STABILITY_YAW_GAIN = 2.6;
// Drive force allowed past what is left of the driven axle's friction circle.
const TRACTION_HEADROOM = 1.18;
// Body attitude gradients, in radians per g, at the stock suspension rate.
const ROLL_GRADIENT = 0.061;
const PITCH_GRADIENT = 0.028;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function firstNumber(source, keys, fallback) {
  for (const key of keys) {
    const value = source?.[key];
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function wrapAngle(angle) {
  return THREE.MathUtils.euclideanModulo(angle + Math.PI, TAU) - Math.PI;
}

function smoothstep01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Progressive tire saturation.
 *
 * A linear cornering stiffness clipped by a friction circle breaks away as a
 * step: full grip on one frame, a scaled-down fraction on the next, with
 * nothing in between for the driver to read or to catch. This rolls the same
 * stiffness over into its own limit instead — within 2% of linear up to half
 * the limit, 84% of the limit at the slip angle where the linear model would
 * have hit it, and asymptotic to the limit beyond that. Grip therefore never
 * disappears past the peak, it only stops growing, which is what makes a slide
 * both readable and recoverable.
 */
function saturate(force, limit) {
  if (!(limit > EPSILON)) return 0;
  const ratio = force / limit;
  const shaped = ratio * ratio;
  return force / Math.sqrt(Math.sqrt(1 + shaped * shaped));
}

function asVector3(value, fallback = null) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(finite(value[0], 0), finite(value[1], 0), finite(value[2], 0));
  }
  if (value && Number.isFinite(value.x) && Number.isFinite(value.z)) {
    return new THREE.Vector3(value.x, finite(value.y, 0), value.z);
  }
  return fallback ? fallback.clone() : new THREE.Vector3();
}

function normalizeCurve(curve, idleRPM, redlineRPM, peakTorque, engineLayout) {
  const points = [];
  if (Array.isArray(curve)) {
    for (const item of curve) {
      if (Array.isArray(item) && Number.isFinite(item[0]) && Number.isFinite(item[1])) {
        points.push({ rpm: item[0], torque: item[1] });
      } else if (item && Number.isFinite(item.rpm)) {
        const torque = firstNumber(item, ['torque', 'nm', 'value'], NaN);
        if (Number.isFinite(torque)) points.push({ rpm: item.rpm, torque });
      }
    }
  } else if (curve && typeof curve === 'object') {
    for (const [rpm, torque] of Object.entries(curve)) {
      if (Number.isFinite(Number(rpm)) && Number.isFinite(torque)) {
        points.push({ rpm: Number(rpm), torque });
      }
    }
  }

  if (points.length < 2) {
    const layout = String(engineLayout || 'I4').toUpperCase();
    const lowBias = layout.includes('V8') ? 0.86 : layout.includes('I6') ? 0.76 : 0.62;
    points.length = 0;
    points.push(
      { rpm: idleRPM, torque: peakTorque * 0.52 },
      { rpm: Math.max(idleRPM + 600, redlineRPM * 0.28), torque: peakTorque * lowBias },
      { rpm: redlineRPM * 0.53, torque: peakTorque },
      { rpm: redlineRPM * 0.76, torque: peakTorque * 0.95 },
      { rpm: redlineRPM, torque: peakTorque * 0.72 },
      { rpm: redlineRPM + 400, torque: 0 },
    );
  }

  // The game data may store a normalized torque-shape (0..1) rather than Nm.
  // Detect it before advertised-power correction so the curve retains its shape.
  const largestCurveValue = points.reduce((maximum, point) => Math.max(maximum, Math.abs(point.torque)), 0);
  if (largestCurveValue > 0 && largestCurveValue <= 3.5) {
    for (const point of points) point.torque *= peakTorque;
  }

  points.sort((a, b) => a.rpm - b.rpm);
  return points;
}

function curveTorque(points, rpm) {
  if (!points.length || rpm < points[0].rpm * 0.45) return 0;
  if (rpm <= points[0].rpm) return points[0].torque;
  for (let i = 1; i < points.length; i += 1) {
    if (rpm <= points[i].rpm) {
      const a = points[i - 1];
      const b = points[i];
      const t = (rpm - a.rpm) / Math.max(1, b.rpm - a.rpm);
      return THREE.MathUtils.lerp(a.torque, b.torque, t);
    }
  }
  return 0;
}

function flattenParts(spec) {
  const installed = spec?.installedParts ?? spec?.parts ?? [];
  if (Array.isArray(installed)) return installed.filter(Boolean);
  if (installed && typeof installed === 'object') return Object.values(installed).flat().filter(Boolean);
  return [];
}

function mergePartModifiers(spec, base) {
  const totals = {
    powerMultiplier: 1,
    torqueMultiplier: 1,
    gripMultiplier: 1,
    brakeMultiplier: 1,
    suspensionMultiplier: 1,
    steeringMultiplier: 1,
    dragMultiplier: 1,
    fuelUseMultiplier: 1,
    rollingResistanceMultiplier: 1,
    gearRatioMultiplier: 1,
    shiftTimeMultiplier: 1,
    efficiencyMultiplier: 1,
    massDelta: 0,
    dragAreaDelta: 0,
    redlineDelta: 0,
    fuelCapacityDelta: 0,
    finalDriveMultiplier: 1,
    gearRatios: null,
    finalDrive: null,
  };

  for (const partEntry of flattenParts(spec)) {
    const part = typeof partEntry === 'string' ? {} : (partEntry.modifiers ?? partEntry.stats ?? partEntry);
    totals.powerMultiplier *= firstNumber(part, ['powerMultiplier', 'powerMult', 'hpMultiplier'], 1);
    totals.torqueMultiplier *= firstNumber(part, ['torqueMultiplier', 'torqueMult'], 1);
    totals.gripMultiplier *= firstNumber(part, ['gripMultiplier', 'tireGripMultiplier', 'gripMult'], 1);
    totals.brakeMultiplier *= firstNumber(part, ['brakeMultiplier', 'brakeForceMultiplier', 'brakeMult'], 1);
    totals.suspensionMultiplier *= firstNumber(part, ['suspensionMultiplier', 'stiffnessMultiplier', 'suspensionMult'], 1);
    totals.steeringMultiplier *= firstNumber(part, ['steeringMultiplier', 'steeringResponseMultiplier', 'steeringMult'], 1);
    totals.dragMultiplier *= firstNumber(part, ['dragMultiplier', 'dragMult'], 1);
    totals.fuelUseMultiplier *= firstNumber(part, ['fuelUseMultiplier', 'fuelConsumptionMultiplier', 'consumptionMultiplier'], 1);
    totals.rollingResistanceMultiplier *= firstNumber(part, ['rollingResistanceMultiplier'], 1);
    totals.gearRatioMultiplier *= firstNumber(part, ['gearRatioMultiplier'], 1);
    totals.shiftTimeMultiplier *= firstNumber(part, ['shiftTimeMultiplier'], 1);
    totals.efficiencyMultiplier *= firstNumber(part, ['transmissionEfficiencyMultiplier', 'efficiencyMultiplier'], 1);
    totals.finalDriveMultiplier *= firstNumber(part, ['finalDriveMultiplier'], 1);
    totals.massDelta += firstNumber(part, ['massDelta', 'massDeltaKg', 'weightDelta', 'kgDelta'], 0);
    totals.dragAreaDelta += firstNumber(part, ['dragAreaDelta', 'cdADelta'], 0);
    totals.redlineDelta += firstNumber(part, ['redlineDelta', 'redlineDeltaRpm', 'rpmDelta'], 0);
    totals.fuelCapacityDelta += firstNumber(part, ['fuelCapacityDelta'], 0);

    const powerDelta = firstNumber(part, ['powerDelta', 'hpDelta', 'horsepowerDelta'], 0);
    if (powerDelta) totals.powerMultiplier *= (base.powerHP + powerDelta) / Math.max(1, base.powerHP);
    const gripDelta = firstNumber(part, ['gripDelta'], 0);
    if (gripDelta) totals.gripMultiplier *= Math.max(0.25, (base.tireGrip + gripDelta) / Math.max(0.1, base.tireGrip));
    const brakeDelta = firstNumber(part, ['brakeForceDelta'], 0);
    if (brakeDelta) totals.brakeMultiplier *= Math.max(0.25, (base.brakeForce + brakeDelta) / Math.max(1, base.brakeForce));

    if (Array.isArray(part.gearRatios) && part.gearRatios.length) totals.gearRatios = part.gearRatios.slice();
    if (Number.isFinite(part.finalDrive)) totals.finalDrive = part.finalDrive;
  }
  return totals;
}

function buildSpec(carSpec = {}) {
  const engine = carSpec.engine ?? {};
  const transmission = carSpec.transmission ?? carSpec.gearbox ?? {};
  const tires = carSpec.tires ?? {};
  const suspension = carSpec.suspension ?? {};
  const brakes = carSpec.brakes ?? {};
  const silhouette = carSpec.silhouette ?? carSpec.dimensions ?? {};
  const collisionOffset = carSpec.collisionOffset ?? carSpec.hitboxOffset ?? {};
  const nestedPower = firstNumber(engine, ['powerHP', 'powerHp', 'horsepower', 'hp', 'power'], NaN);
  const rootPower = firstNumber(carSpec, ['powerHP', 'powerHp', 'horsepower', 'hp'], NaN);
  const genericPower = Number.isFinite(carSpec.power) ? carSpec.power : NaN;
  let resolvedPower = Number.isFinite(rootPower) ? rootPower : nestedPower;
  // game.js's compatibility path uses 90 hp as an upgrade multiplier base. If
  // that field accompanies a proper nested powerHp figure, preserve the real
  // car distinction while still honoring the multiplier applied to that 90.
  if (!Number.isFinite(rootPower) && Number.isFinite(nestedPower) && Number.isFinite(genericPower)) {
    resolvedPower = nestedPower > 130 && genericPower >= 65 && genericPower <= 125
      ? nestedPower * (genericPower / 90)
      : genericPower;
  } else if (!Number.isFinite(resolvedPower)) resolvedPower = Number.isFinite(genericPower) ? genericPower : 90;
  const dragCd = firstNumber(carSpec, ['dragCd', 'dragCoefficient'], NaN);
  const frontalArea = firstNumber(carSpec, ['frontalAreaM2', 'frontalArea'], NaN);
  const suppliedRolling = firstNumber(carSpec, ['rollingResistance', 'crr'], 0.014);
  const steeringLockDeg = firstNumber(carSpec, ['steeringLockDeg'], firstNumber(silhouette, ['steeringLockDeg'], NaN));
  const conditionEffects = carSpec.conditionEffects ?? carSpec.wearEffects ?? {};
  const conditionGrade = Number.parseFloat(carSpec.conditionGrade ?? carSpec.grade);

  const base = {
    id: carSpec.id ?? carSpec.name ?? 'vehicle',
    name: carSpec.name ?? 'Street Car',
    mass: firstNumber(carSpec, ['mass', 'weight', 'massKg'], 1120),
    powerHP: resolvedPower,
    peakTorque: firstNumber(carSpec, ['peakTorque', 'peakTorqueNm', 'torque', 'torqueNm'], firstNumber(engine, ['peakTorque', 'peakTorqueNm', 'torque', 'torqueNm'], 135)),
    idleRPM: firstNumber(carSpec, ['idleRPM', 'idleRpm'], firstNumber(engine, ['idleRPM', 'idleRpm'], 850)),
    redlineRPM: firstNumber(carSpec, ['redlineRPM', 'redlineRpm', 'redline', 'maxRPM'], firstNumber(engine, ['redlineRPM', 'redlineRpm', 'redline', 'maxRPM'], 6500)),
    engineLayout: carSpec.engineLayout ?? engine.layout ?? engine.type ?? 'I4',
    torqueCurve: carSpec.torqueCurve ?? engine.torqueCurve,
    drivetrain: String(carSpec.drivetrain ?? transmission.drivetrain ?? 'RWD').toUpperCase(),
    gearRatios: (carSpec.gearRatios ?? transmission.gearRatios ?? transmission.ratios ?? transmission.gears ?? [3.42, 2.05, 1.41, 1.08, 0.86]).slice(),
    finalDrive: firstNumber(carSpec, ['finalDrive'], firstNumber(transmission, ['finalDrive'], 4.1)),
    reverseRatio: Math.abs(firstNumber(carSpec, ['reverseRatio'], firstNumber(transmission, ['reverseRatio', 'reverse'], 3.2))),
    shiftTime: firstNumber(carSpec, ['shiftTime'], firstNumber(transmission, ['shiftTime'], 0.19)),
    efficiency: firstNumber(carSpec, ['drivetrainEfficiency', 'efficiency'], firstNumber(transmission, ['efficiency'], 0.86)),
    wheelbase: firstNumber(carSpec, ['wheelbase'], firstNumber(silhouette, ['wheelbase'], 2.52)),
    trackWidth: firstNumber(carSpec, ['trackWidth', 'track'], 1.48),
    width: firstNumber(carSpec, ['width'], firstNumber(silhouette, ['width'], 1.72)),
    length: firstNumber(carSpec, ['length'], firstNumber(silhouette, ['length'], 4.25)),
    height: firstNumber(carSpec, ['height'], firstNumber(silhouette, ['height'], 1.45)),
    collisionOffsetX: firstNumber(carSpec, ['collisionOffsetX', 'hitboxOffsetX'], firstNumber(collisionOffset, ['x', 'offsetX'], 0)),
    collisionOffsetY: firstNumber(carSpec, ['collisionOffsetY', 'hitboxOffsetY'], firstNumber(collisionOffset, ['y', 'offsetY'], 0)),
    collisionOffsetZ: firstNumber(carSpec, ['collisionOffsetZ', 'hitboxOffsetZ'], firstNumber(collisionOffset, ['z', 'offsetZ'], 0)),
    cgHeight: firstNumber(carSpec, ['cgHeight', 'centerOfMassHeight'], 0.52),
    frontWeight: firstNumber(carSpec, ['frontWeight', 'frontWeightDistribution', 'weightDistributionFront'], 0.55),
    wheelRadius: firstNumber(carSpec, ['wheelRadius'], firstNumber(silhouette, ['wheelRadius'], 0.305)),
    tireGrip: firstNumber(carSpec, ['tireGrip', 'grip', 'tireMu'], firstNumber(tires, ['grip', 'mu'], 1)),
    // ~21 N/rad per newton of axle load, which is where a road tire actually
    // sits. The old 68000/72000 was about 60% of that, and a soft tire needs a
    // big slip angle before it makes force: the car took 0.87 s to reach 0.8 g
    // at speed, which reads as "it barely turns" long before any grip runs out.
    cornerStiffnessFront: firstNumber(carSpec, ['cornerStiffnessFront'], firstNumber(tires, ['cornerStiffnessFront'], 105000)),
    cornerStiffnessRear: firstNumber(carSpec, ['cornerStiffnessRear'], firstNumber(tires, ['cornerStiffnessRear'], 111000)),
    brakeForce: firstNumber(carSpec, ['brakeForce', 'maxBrakeForce'], firstNumber(brakes, ['force', 'maxForce'], 14500)),
    brakeBias: firstNumber(carSpec, ['brakeBias', 'frontBrakeBias'], firstNumber(brakes, ['bias', 'frontBias'], 0.64)),
    suspensionStiffness: firstNumber(carSpec, ['suspensionStiffness', 'stiffness'], firstNumber(suspension, ['stiffness'], 1)),
    maxSteer: firstNumber(carSpec, ['maxSteer', 'steeringAngle'], Number.isFinite(steeringLockDeg) ? THREE.MathUtils.degToRad(steeringLockDeg) : 0.56),
    dragArea: firstNumber(carSpec, ['dragArea', 'cdA'], Number.isFinite(dragCd) && Number.isFinite(frontalArea) ? dragCd * frontalArea : 0.68),
    rollingResistance: suppliedRolling > 0.1 ? 0.014 * suppliedRolling : suppliedRolling,
    fuelCapacity: firstNumber(carSpec, ['fuelCapacity', 'fuelTankL', 'tankSize'], firstNumber(engine, ['fuelCapacity', 'fuelTankL'], 48)),
    fuelIdleLph: firstNumber(carSpec, ['fuelIdleLph'], firstNumber(engine, ['fuelIdleLph'], NaN)),
    fuelFullLoadLph: firstNumber(carSpec, ['fuelFullLoadLph'], firstNumber(engine, ['fuelFullLoadLph'], NaN)),
    fuelUseMultiplier: firstNumber(carSpec, ['fuelUseMultiplier', 'fuelConsumptionMultiplier'], 1),
    condition: firstNumber(carSpec, ['condition', 'conditionFactor'], Number.isFinite(conditionGrade) ? clamp(0.84 + conditionGrade * 0.035, 0.78, 1) : 1),
    mileage: firstNumber(carSpec, ['mileage', 'mileageKm'], 0),
    rideHeight: firstNumber(carSpec, ['rideHeight'], 0.42),
  };

  // Auction wear is deliberately mild but physically meaningful.
  let conditionFactor = base.condition;
  if (conditionFactor > 1.2) conditionFactor /= 100;
  conditionFactor = clamp(conditionFactor, 0.72, 1);
  const mileageWear = clamp((base.mileage - 40000) / 350000, 0, 0.11);
  const suppliedConditionPower = firstNumber(conditionEffects, ['powerMultiplier', 'engineMultiplier'], NaN);
  const wearPower = Number.isFinite(suppliedConditionPower) ? suppliedConditionPower : conditionFactor * (1 - mileageWear);
  const wearGrip = firstNumber(conditionEffects, ['gripMultiplier', 'tireMultiplier'], 0.9 + conditionFactor * 0.1 - mileageWear * 0.22);
  const wearBrake = firstNumber(conditionEffects, ['brakeMultiplier'], 0.94 + conditionFactor * 0.06 - mileageWear * 0.1);
  const wearSuspension = firstNumber(conditionEffects, ['suspensionMultiplier'], 0.94 + conditionFactor * 0.06 - mileageWear * 0.08);

  const modifiers = mergePartModifiers(carSpec, base);
  const spec = {
    ...base,
    mass: clamp(base.mass + modifiers.massDelta, 480, 3500),
    powerHP: base.powerHP * modifiers.powerMultiplier * wearPower,
    peakTorque: base.peakTorque * modifiers.powerMultiplier * modifiers.torqueMultiplier * wearPower,
    redlineRPM: base.redlineRPM + modifiers.redlineDelta,
    tireGrip: clamp(base.tireGrip * modifiers.gripMultiplier * wearGrip, 0.45, 2.1),
    brakeForce: base.brakeForce * modifiers.brakeMultiplier * wearBrake,
    suspensionStiffness: base.suspensionStiffness * modifiers.suspensionMultiplier * wearSuspension,
    maxSteer: base.maxSteer * modifiers.steeringMultiplier,
    dragArea: Math.max(0.25, base.dragArea * modifiers.dragMultiplier + modifiers.dragAreaDelta),
    rollingResistance: base.rollingResistance * modifiers.rollingResistanceMultiplier,
    fuelCapacity: Math.max(5, base.fuelCapacity + modifiers.fuelCapacityDelta),
    fuelUseMultiplier: base.fuelUseMultiplier * modifiers.fuelUseMultiplier,
    efficiency: base.efficiency * modifiers.efficiencyMultiplier,
    shiftTime: base.shiftTime * modifiers.shiftTimeMultiplier,
    finalDrive: modifiers.finalDrive ?? base.finalDrive * modifiers.finalDriveMultiplier,
    gearRatios: (modifiers.gearRatios ?? base.gearRatios).map((ratio) => Math.max(0.05, Number(ratio) * modifiers.gearRatioMultiplier)),
    source: carSpec,
  };

  // Some data sets express brakeForce as desired deceleration in m/s².
  if (spec.brakeForce < 100) spec.brakeForce *= spec.mass;

  spec.frontWeight = clamp(spec.frontWeight, 0.35, 0.7);
  spec.brakeBias = clamp(spec.brakeBias, 0.45, 0.82);
  spec.efficiency = clamp(spec.efficiency, 0.55, 0.96);
  spec.redlineRPM = Math.max(spec.idleRPM + 1800, spec.redlineRPM);
  spec.torqueCurve = normalizeCurve(spec.torqueCurve, spec.idleRPM, spec.redlineRPM, spec.peakTorque, spec.engineLayout);

  // Honor an advertised power figure even when a hand-authored torque curve is inconsistent.
  let curvePeakWatts = 0;
  for (const point of spec.torqueCurve) curvePeakWatts = Math.max(curvePeakWatts, point.torque * point.rpm * TAU / 60);
  if (curvePeakWatts > EPSILON && Number.isFinite(spec.powerHP)) {
    const torqueScale = clamp(spec.powerHP * HP_TO_WATTS / curvePeakWatts, 0.55, 1.8);
    spec.torqueCurve = spec.torqueCurve.map((point) => ({ rpm: point.rpm, torque: point.torque * torqueScale }));
    spec.peakTorque *= torqueScale;
  }
  return Object.freeze(spec);
}

/**
 * A planar rigid-body bicycle model intended for a 60 Hz browser game. The
 * public vectors are Three.js objects so the renderer can consume them without
 * per-frame conversion or allocation.
 */
export class VehiclePhysics {
  constructor(carSpec = {}) {
    this.spec = buildSpec(carSpec);
    this.transmissionMode = String(carSpec.transmissionMode ?? 'automatic').toLowerCase();
    this.position = new THREE.Vector3();
    this.previousPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.yawRate = 0;
    this.steering = 0;
    this.rpm = this.spec.idleRPM;
    this.gear = 1;
    this.fuel = clamp(firstNumber(carSpec, ['fuel', 'fuelLiters'], this.spec.fuelCapacity), 0, this.spec.fuelCapacity);
    this.engineRunning = this.fuel > 0;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.time = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this._longitudinalAcceleration = 0;
    this._lateralAcceleration = 0;
    this._previousInput = {};
    this._events = [];
    this._collisionSerial = 0;
    this._lastCollision = null;
    this._safePosition = new THREE.Vector3();
    this._safeHeading = 0;
    this._safeTimer = 0;
    this._roadHeightVelocity = 0;
    this._fuelUsed = 0;
    this._distanceTravelled = 0;
    this._engineTorque = 0;
    this._driveForce = 0;
    this._wheelSpin = 0;
    this._frontSlip = 0;
    this._rearSlip = 0;
    this._frontSaturation = 0;
    this._rearSaturation = 0;
    this._frontLock = 0;
    this._rearLock = 0;
    this._surfaceGrip = 1;
    this._contactCooldown = 0;
    this._postImpactTimer = 0;
    this._yawKickCooldown = 0;
    this._lastThrottle = 0;
    this._collisionOffsetScratch = new THREE.Vector3();
    this._collisionFromScratch = new THREE.Vector3();
    this._collisionToScratch = new THREE.Vector3();

    this._state = {
      position: this.position,
      previousPosition: this.previousPosition,
      velocity: this.velocity,
      heading: this.heading,
      yaw: this.heading,
      yawRate: this.yawRate,
      speed: 0,
      speedKmh: 0,
      forwardSpeed: 0,
      lateralSpeed: 0,
      steering: 0,
      gear: this.gear,
      rpm: this.rpm,
      fuel: this.fuel,
      fuelCapacity: this.spec.fuelCapacity,
      engineRunning: this.engineRunning,
      bodyRoll: 0,
      bodyPitch: 0,
      width: this.spec.width,
      length: this.spec.length,
      height: this.spec.height,
      collisionOffsetX: this.spec.collisionOffsetX,
      collisionOffsetY: this.spec.collisionOffsetY,
      collisionOffsetZ: this.spec.collisionOffsetZ,
      collisionRadius: Math.hypot(this.spec.width * 0.5, this.spec.length * 0.5),
      spec: this.spec,
    };
    this._telemetry = {};
    this._refreshPublicState(0, 0);
  }

  setPosition(x, y, z, heading = this.heading) {
    if (x?.isVector3 || (x && typeof x === 'object')) {
      const position = asVector3(x);
      heading = finite(y, finite(x.heading, this.heading));
      this.position.copy(position);
    } else {
      this.position.set(finite(x, 0), finite(y, 0), finite(z, 0));
    }
    this.previousPosition.copy(this.position);
    this.heading = wrapAngle(finite(heading, 0));
    this.yawRate = 0;
    this.velocity.set(0, 0, 0);
    this.steering = 0;
    this._longitudinalAcceleration = 0;
    this._lateralAcceleration = 0;
    this._roadHeightVelocity = 0;
    this._postImpactTimer = 0;
    this._yawKickCooldown = 0;
    this._safePosition.copy(this.position);
    this._safeHeading = this.heading;
    this._refreshPublicState(0, 0);
    return this;
  }

  setVelocity(value, lateral = null) {
    if (value?.isVector3 || (value && typeof value === 'object')) {
      this.velocity.copy(asVector3(value));
    } else {
      const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
      const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
      this.velocity.copy(forward.multiplyScalar(finite(value, 0)));
      if (Number.isFinite(lateral)) this.velocity.addScaledVector(right, lateral);
    }
    return this;
  }

  setSpeed(speed) {
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.velocity.copy(forward).multiplyScalar(finite(speed, 0));
    this._refreshPublicState();
    return this;
  }

  changeSpec(carSpec = {}, preserve = {}) {
    const oldCapacity = this.spec.fuelCapacity;
    const oldFuel = this.fuel;
    const oldFraction = oldCapacity > 0 ? oldFuel / oldCapacity : 0;
    this.spec = buildSpec(carSpec);
    if (preserve.fuel === false) {
      this.fuel = clamp(firstNumber(carSpec, ['fuel', 'fuelLiters'], this.spec.fuelCapacity), 0, this.spec.fuelCapacity);
    } else if (Number.isFinite(carSpec.fuel ?? carSpec.fuelLiters)) {
      this.fuel = clamp(carSpec.fuel ?? carSpec.fuelLiters, 0, this.spec.fuelCapacity);
    } else {
      this.fuel = clamp(preserve.fuelAmount ? oldFuel : oldFraction * this.spec.fuelCapacity, 0, this.spec.fuelCapacity);
    }
    this.gear = clamp(this.gear, -1, this.spec.gearRatios.length);
    this.rpm = clamp(this.rpm, this.spec.idleRPM, this.spec.redlineRPM + 300);
    this.engineRunning = this.fuel > 0;
    this._state.spec = this.spec;
    this._state.width = this.spec.width;
    this._state.length = this.spec.length;
    this._state.height = this.spec.height;
    this._state.collisionOffsetX = this.spec.collisionOffsetX;
    this._state.collisionOffsetY = this.spec.collisionOffsetY;
    this._state.collisionOffsetZ = this.spec.collisionOffsetZ;
    this._state.collisionRadius = Math.hypot(this.spec.width * 0.5, this.spec.length * 0.5);
    this._refreshPublicState(0, 0);
    return this;
  }

  setTransmissionMode(mode) {
    const normalized = String(mode).toLowerCase();
    this.transmissionMode = normalized.startsWith('m') ? 'manual' : 'automatic';
    return this.transmissionMode;
  }

  shiftUp() {
    if (this.shiftCooldown > 0 || this.gear >= this.spec.gearRatios.length) return false;
    this.gear += 1;
    if (this.gear === 0) this.gear = 1;
    this._beginShift();
    return true;
  }

  shiftDown() {
    if (this.shiftCooldown > 0 || this.gear <= -1) return false;
    this.gear -= 1;
    this._beginShift();
    return true;
  }

  _beginShift() {
    this.shiftTimer = this.spec.shiftTime;
    this.shiftCooldown = this.spec.shiftTime + 0.08;
    this._events.push({ type: 'shift', gear: this.gear, time: this.time });
  }

  update(dt, input = {}, roadInfo = null, settings = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return this._state;
    const frameDt = Math.min(dt, 0.1);
    this.previousPosition.copy(this.position);
    this._events.length = 0;

    const mode = settings.transmissionMode ?? settings.gearbox ?? settings.transmission;
    if (mode) this.setTransmissionMode(mode);
    if (input.toggleAutomatic && !this._previousInput.toggleAutomatic) {
      this.setTransmissionMode(this.transmissionMode === 'automatic' ? 'manual' : 'automatic');
    }
    if (this.transmissionMode === 'manual') {
      if (input.shiftUp && !this._previousInput.shiftUp) this.shiftUp();
      if (input.shiftDown && !this._previousInput.shiftDown) this.shiftDown();
    }

    const controls = {
      throttle: clamp(finite(input.throttle ?? input.accelerate, 0), 0, 1),
      brake: clamp(finite(input.brake ?? input.reverse, 0), 0, 1),
      steer: clamp(finite(input.steer ?? input.steering, 0), -1, 1),
      handbrake: clamp(typeof input.handbrake === 'boolean' ? Number(input.handbrake) : finite(input.handbrake, 0), 0, 1),
      clutch: clamp(finite(input.clutch, 0), 0, 1),
    };
    this._lastThrottle = controls.throttle;

    if (settings.infiniteFuel || settings.adminInfiniteFuel) {
      this.fuel = this.spec.fuelCapacity;
      this.engineRunning = true;
    }

    const substeps = Math.max(1, Math.ceil(frameDt / (1 / 120)));
    const stepDt = frameDt / substeps;
    for (let i = 0; i < substeps; i += 1) this._step(stepDt, controls, roadInfo, settings);

    this.time += frameDt;
    this._contactCooldown = Math.max(0, this._contactCooldown - frameDt);
    this._postImpactTimer = Math.max(0, this._postImpactTimer - frameDt);
    this._yawKickCooldown = Math.max(0, this._yawKickCooldown - frameDt);
    this._safeTimer += frameDt;

    // Never let a NaN or an exploding integration leak into the renderer;
    // recover to the last known-good on-road pose instead.
    const speedSq = this.velocity.lengthSq();
    if (!Number.isFinite(this.position.x + this.position.y + this.position.z + this.heading + this.yawRate)
      || !Number.isFinite(speedSq) || speedSq > 250 * 250) {
      this.reset();
    }

    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    const forwardSpeed = this.velocity.dot(forward);
    const lateralSpeed = this.velocity.dot(right);
    if (this._safeTimer >= 1 && Math.abs(lateralSpeed) < 3 && Math.abs(this.bodyRoll) < 0.45) {
      const onRoad = roadInfo?.onRoad !== false && roadInfo?.isOnRoad !== false;
      if (onRoad) {
        this._safePosition.copy(this.position);
        this._safeHeading = this.heading;
        this._safeTimer = 0;
      }
    }

    this._previousInput = {
      shiftUp: Boolean(input.shiftUp),
      shiftDown: Boolean(input.shiftDown),
      toggleAutomatic: Boolean(input.toggleAutomatic),
    };
    this._refreshPublicState(forwardSpeed, lateralSpeed);
    return this._state;
  }

  _step(dt, input, roadInfo, settings) {
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);

    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    let u = this.velocity.dot(forward);
    let v = this.velocity.dot(right);
    const speed = Math.hypot(u, v);

    if (this.transmissionMode === 'automatic') this._automaticGearbox(input, u);

    const a = this.spec.wheelbase * (1 - this.spec.frontWeight);
    const b = this.spec.wheelbase * this.spec.frontWeight;
    const effectiveU = Math.max(2.2, Math.abs(u));
    const directionSign = u < -0.25 ? -1 : 1;

    // Axle loads and available grip are resolved before the steering, because
    // how far the wheel may be turned is a grip question, not a geometry one.
    const surface = this._readRoadSurface(roadInfo);
    this._surfaceGrip = surface.grip;
    const totalWeight = this.spec.mass * G;
    const longitudinalTransfer = this.spec.mass * this._longitudinalAcceleration * this.spec.cgHeight / this.spec.wheelbase;
    let frontLoad = totalWeight * this.spec.frontWeight - longitudinalTransfer;
    let rearLoad = totalWeight * (1 - this.spec.frontWeight) + longitudinalTransfer;
    frontLoad = clamp(frontLoad, totalWeight * 0.16, totalWeight * 0.84);
    rearLoad = totalWeight - frontLoad;

    const lateralTransferFraction = clamp(Math.abs(this._lateralAcceleration) * this.spec.cgHeight / (G * this.spec.trackWidth), 0, 0.42);
    const loadSensitivity = 1 - lateralTransferFraction * 0.14;
    const muFront = this.spec.tireGrip * surface.grip * loadSensitivity;
    let muRear = this.spec.tireGrip * surface.grip * loadSensitivity;
    if (input.handbrake > 0) muRear *= THREE.MathUtils.lerp(1, 0.28, input.handbrake);

    const suspensionFactor = clamp(this.spec.suspensionStiffness, 0.55, 1.65);
    const cornerFront = this.spec.cornerStiffnessFront * suspensionFactor;
    const cornerRear = this.spec.cornerStiffnessRear * suspensionFactor;
    const frontGripLimit = muFront * frontLoad;
    const rearGripLimit = muRear * rearLoad;
    const assist = clamp(finite(settings.drivingAssist ?? settings.assist, 1), 0, 1);

    // The rear slip angle does not depend on the steering, so it can be
    // measured first and used to decide how much help the driver gets back.
    const rearSlip = Math.atan2(v - b * this.yawRate, effectiveU);
    const frontVelocityAngle = Math.atan2(v + a * this.yawRate, effectiveU);
    const rearPeakSlip = Math.max(0.02, rearGripLimit / Math.max(1, cornerRear));
    const slide = smoothstep01((Math.abs(rearSlip) / rearPeakSlip - SLIDE_ONSET) / SLIDE_RANGE);

    // Steering, sized in grip rather than in degrees.
    //
    // `steerCommand` is the lock a held button may ask for: the angle a steady
    // corner at STEER_GRIP_BUDGET of the tires' limit needs, understeer
    // gradient included. It replaces a hand-tuned Ackermann fraction plus a
    // flat 0.024 rad allowance, which happened to land exactly on the limit for
    // one reference car and 20% PAST it for the lighter, softer starter car —
    // holding a turn there was already asking for more grip than existed.
    // The understeer gradient is taken from the STATIC axle weights, not from
    // the transferred ones. It is a property of the car, and feeding the
    // instantaneous loads into it made braking a steering aid: hard braking
    // moves ~1.9 kN forward, which drove the gradient up 5.8x and doubled the
    // lock a held button was allowed to ask for. Hitting the brake mid-corner
    // snapped the wheel wide open, which is the opposite of what the tires can
    // do while they are already spending their circle on stopping.
    const staticFront = totalWeight * this.spec.frontWeight;
    const understeerGradient = Math.max(0, staticFront / cornerFront - (totalWeight - staticFront) / cornerRear) / G;
    const budgetLateral = this.spec.tireGrip * surface.grip * G * STEER_GRIP_BUDGET;
    const steerSensitivity = clamp(finite(settings.steeringSensitivity, 1), 0.5, 1.6);
    // Turn-in. The steady-state angle alone reads as numb, because it is exactly
    // what the FINISHED corner needs and the car then has to wait for the yaw to
    // build — about 0.75 s to full grip at 200 km/h. Drivers turn in past the
    // steady angle and unwind as the grip arrives, so allow extra lock while the
    // lateral acceleration is still short of what was asked for. It closes
    // itself as the corner loads up and shuts off once the rear starts to slide,
    // so it sharpens the entry without raising the steady demand.
    // Compare the chassis load with the direction the driver is asking for,
    // not just with its absolute magnitude. On a quick left-right transition
    // the car can still be carrying a full leftward load while the wheel is
    // already pointed right. Treating that as "fully loaded" withheld all
    // turn-in authority at exactly the moment it was needed and made fast
    // direction changes feel rubbery. Opposite load is now a full deficit, so
    // the normal transient lock stays available until the new corner builds.
    const requestedTurn = Math.sign(input.steer) * directionSign;
    const directionalLoad = this._lateralAcceleration * requestedTurn;
    const lateralDeficit = clamp(1 - directionalLoad / Math.max(1, budgetLateral), 0, 1);
    const opposingLoad = clamp(-directionalLoad / Math.max(1, budgetLateral), 0, 1);
    const turnIn = 1 + (TURN_IN_BOOST * lateralDeficit + DIRECTION_CHANGE_BOOST * opposingLoad) * (1 - slide);
    const steerCommand = Math.min(
      this.spec.maxSteer,
      budgetLateral * (this.spec.wheelbase / Math.max(4, u * u) + understeerGradient) * steerSensitivity * turnIn,
    );

    // Once the rear is genuinely away, the budget is measured from where the
    // front tires are actually travelling instead of from the chassis
    // centreline, so the window opens by exactly the angle the slide is worth.
    // This is the whole reason opposite lock is possible at all: the old
    // symmetric cap allowed about 3 degrees of counter-steer at 100 km/h, so no
    // slide could ever be caught and the car left the road every time it
    // stepped out. It stays shut while the car is merely cornering hard —
    // opening it there would let a held turn ask for ever more lock as the car
    // rotated into it, which is a divergence, not a driving aid.
    const tracking = clamp(frontVelocityAngle * directionSign, -this.spec.maxSteer, this.spec.maxSteer);
    const counterReach = tracking * slide;
    const upperLimit = Math.min(this.spec.maxSteer, Math.max(0, counterReach) + steerCommand);
    const lowerLimit = Math.max(-this.spec.maxSteer, Math.min(0, counterReach) - steerCommand);
    let targetSteering = input.steer >= 0 ? input.steer * upperLimit : -input.steer * lowerLimit;

    // Counter-steer assist. A keyboard cannot feed in a precise opposite lock,
    // so part of the angle that would cancel the slide is dialled in for you
    // once the rear is genuinely away. Backed off to a token amount when the
    // driver is steering into the slide on purpose, so drifting still works.
    if (assist > 0 && slide > 0) {
      const provoking = clamp(-input.steer * Math.sign(tracking || 1), 0, 1);
      const help = tracking * slide * COUNTER_STEER_ASSIST * assist * (1 - provoking * 0.85);
      targetSteering = clamp(targetSteering + help, lowerLimit, upperLimit);
    }

    // Turn-in still ramps over ~0.26 s so binary input reads as a progressive
    // turn rather than a step; a large error (catching a slide) moves the wheel
    // proportionally faster, the way a driver's hands would.
    const steerRate = Math.max(0.55, steerCommand / 0.26, Math.abs(targetSteering - this.steering) * 4) * dt;
    this.steering += clamp(targetSteering - this.steering, -steerRate, steerRate);
    if (Math.abs(input.steer) < 0.02 && slide < 0.05) this.steering *= Math.exp(-dt * (5.5 + speed * 0.035));

    const frontSlip = frontVelocityAngle - this.steering * directionSign;
    this._frontSlip = frontSlip;
    this._rearSlip = rearSlip;

    const lowSpeedTireFactor = smoothstep01(speed / 2.2);
    let fyFront = saturate(-cornerFront * frontSlip * lowSpeedTireFactor, frontGripLimit);
    let fyRear = saturate(-cornerRear * rearSlip * lowSpeedTireFactor, rearGripLimit);

    const engine = this._engineForces(input, u, dt, settings);
    // Traction control. The starter car puts 168 hp through a 940 kg rear axle,
    // which in the lower gears asks for more than twice the grip the rear tires
    // have; the friction circle then pays for the excess out of the LATERAL
    // budget, which is exactly why squeezing the throttle mid-corner used to
    // snap the car sideways with no warning. Cap the drive force at what is
    // actually left once the corner is paid for, with headroom so power-on
    // rotation still exists. The handbrake bypasses it completely.
    let driveForce = engine.driveForce;
    if (assist > 0 && driveForce > 0 && input.handbrake < 0.1) {
      const spare = (limit, lateral) => Math.sqrt(Math.max(
        0,
        limit * limit - Math.min(Math.abs(lateral), limit * 0.98) ** 2,
      )) * TRACTION_HEADROOM;
      let tractionLimit;
      if (this.spec.drivetrain === 'FWD') tractionLimit = spare(frontGripLimit, fyFront);
      else if (this.spec.drivetrain === 'AWD' || this.spec.drivetrain === '4WD') {
        tractionLimit = Math.min(spare(frontGripLimit, fyFront) / 0.42, spare(rearGripLimit, fyRear) / 0.58);
      } else tractionLimit = spare(rearGripLimit, fyRear);
      driveForce = THREE.MathUtils.lerp(driveForce, Math.min(driveForce, tractionLimit), assist);
    }
    this._driveForce = driveForce;
    let driveFront = 0;
    let driveRear = 0;
    if (this.spec.drivetrain === 'FWD') driveFront = driveForce;
    else if (this.spec.drivetrain === 'AWD' || this.spec.drivetrain === '4WD') {
      driveFront = driveForce * 0.42;
      driveRear = driveForce * 0.58;
    } else driveRear = driveForce;

    const brakeDirection = Math.abs(u) > 0.25 ? Math.sign(u) : Math.sign(driveForce || 1);
    const serviceBrakeInput = this.gear < 0 ? input.throttle : input.brake;
    const serviceBrake = serviceBrakeInput * this.spec.brakeForce;
    // Road cars use ABS for the normal brake pedal. Previously the raw brake
    // force could exceed both axles' grip by 50-100%, `_gripCircle` marked all
    // four wheels as locked and removed most lateral authority. A tiny yaw
    // disturbance then grew into a full lane-crossing slide even in a straight
    // stop. Reserve enough of each friction circle for the current cornering
    // load and cap only the service-brake component; the handbrake deliberately
    // remains uncapped so it can still break the rear loose.
    const absLongitudinalCapacity = (limit, lateralForce) => Math.sqrt(Math.max(
      0,
      limit * limit - Math.min(Math.abs(lateralForce), limit * 0.97) ** 2,
    )) * 0.96;
    const frontBrake = Math.min(
      serviceBrake * this.spec.brakeBias,
      absLongitudinalCapacity(frontGripLimit, fyFront),
    );
    const rearBrake = Math.min(
      serviceBrake * (1 - this.spec.brakeBias),
      absLongitudinalCapacity(rearGripLimit, fyRear),
    );
    let fxFront = driveFront - brakeDirection * frontBrake;
    let fxRear = driveRear - brakeDirection * rearBrake;
    fxRear -= brakeDirection * input.handbrake * this.spec.brakeForce * 0.72;

    const frontCircle = this._gripCircle(fxFront, fyFront, frontGripLimit, 0);
    const rearCircle = this._gripCircle(fxRear, fyRear, rearGripLimit, input.handbrake * 0.7);
    fxFront = frontCircle.x;
    fyFront = frontCircle.y;
    fxRear = rearCircle.x;
    fyRear = rearCircle.y;
    this._frontSaturation = frontCircle.saturation;
    this._rearSaturation = rearCircle.saturation;
    this._frontLock = frontCircle.lock;
    this._rearLock = rearCircle.lock;
    this._wheelSpin = Math.max(frontCircle.spin, rearCircle.spin);

    const cosSteer = Math.cos(this.steering);
    const sinSteer = Math.sin(this.steering);
    const frontBodyX = fxFront * cosSteer - fyFront * sinSteer;
    const frontBodyY = fxFront * sinSteer + fyFront * cosSteer;
    let forceX = frontBodyX + fxRear;
    let forceY = frontBodyY + fyRear;

    // Street-car aero and rolling losses; neither creates meaningful downforce.
    forceX += -0.5 * 1.225 * this.spec.dragArea * u * Math.abs(u);
    forceY += -0.5 * 1.225 * this.spec.dragArea * 0.7 * v * Math.abs(v);
    if (speed > 0.08) {
      const rolling = this.spec.rollingResistance * totalWeight;
      forceX -= rolling * u / speed;
      forceY -= rolling * v / speed;
    }
    forceX -= this.spec.mass * G * Math.sin(surface.grade);

    if (speed < 1.2 && serviceBrakeInput > 0.2 && (this.gear < 0 ? input.brake : input.throttle) < 0.05) {
      const hold = Math.exp(-dt * 18 * serviceBrakeInput);
      this.velocity.multiplyScalar(hold);
      u *= hold;
      v *= hold;
    }

    const accelerationX = forceX / this.spec.mass;
    const accelerationY = forceY / this.spec.mass;
    this._longitudinalAcceleration = THREE.MathUtils.lerp(this._longitudinalAcceleration, accelerationX, 1 - Math.exp(-dt * 9));
    this._lateralAcceleration = THREE.MathUtils.lerp(this._lateralAcceleration, accelerationY, 1 - Math.exp(-dt * 9));

    this.velocity.addScaledVector(forward, accelerationX * dt);
    this.velocity.addScaledVector(right, accelerationY * dt);
    if (surface.velocity) this.velocity.lerp(surface.velocity, clamp(surface.velocityInfluence * dt, 0, 1));

    const inertia = this.spec.mass * (a * a + b * b) * 0.72;
    let yawMoment = a * frontBodyY - b * fyRear;
    // Stability control: bleed off the yaw the steering never asked for. It is
    // asleep during ordinary cornering (it only fades in past the rear tires'
    // slip peak) and is mostly stood down under the handbrake, so a deliberate
    // flick still rotates the car — it just stops a lift-off or a kerb turning
    // into a spin the driver has no way to answer.
    if (assist > 0 && slide > 0) {
      const gripYawRate = this.spec.tireGrip * surface.grip * G / Math.max(4, Math.abs(u));
      const referenceYaw = clamp(
        u * this.steering * directionSign / Math.max(1, this.spec.wheelbase + understeerGradient * u * u),
        -gripYawRate,
        gripYawRate,
      );
      const authority = slide * assist * (input.handbrake > 0.1 ? 0.25 : 1);
      yawMoment -= (this.yawRate - referenceYaw) * inertia * STABILITY_YAW_GAIN * authority;
    }
    const yawAcceleration = yawMoment / Math.max(1, inertia);
    this.yawRate += yawAcceleration * dt;
    // Heavier yaw damping right after an impact so wall/traffic hits shed
    // rotation in well under a second instead of an endless pirouette.
    const impactDamping = this._postImpactTimer > 0 ? 2.6 : 0;
    this.yawRate *= Math.exp(-dt * (0.32 + impactDamping + (speed < 1.5 ? 5 : 0)));
    // No car pirouettes at speed: the tires cannot hold the car on a radius
    // that tight. Past that rate the surplus is bled away rather than clipped,
    // so a big slide still looks like a slide instead of hitting a wall.
    const sustainableYaw = this.spec.tireGrip * surface.grip * G / Math.max(5, speed) * 1.7 + 0.22;
    if (Math.abs(this.yawRate) > sustainableYaw) {
      const surplus = Math.abs(this.yawRate) - sustainableYaw;
      this.yawRate = Math.sign(this.yawRate) * (sustainableYaw + surplus * Math.exp(-dt * 7));
    }
    this.yawRate = clamp(this.yawRate, -2.2, 2.2);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    const oldPosition = this.position.clone();
    this.position.addScaledVector(this.velocity, dt);
    this._distanceTravelled += oldPosition.distanceTo(this.position);
    this._applyRoadHeight(surface, dt);
    this._resolveRoadBounds(roadInfo, oldPosition, this.position);

    // Body attitude, as a suspension roll/pitch gradient rather than as the
    // load-transfer angle the old targets used. That angle is how much weight
    // moves across the track, not how far the shell leans: it reached 16
    // degrees of roll and 8 of dive, where a firmish road car does about 3.5
    // degrees per g of roll and 1.6 per g of dive. Stiffer suspension leans less.
    const pitchTarget = clamp(-this._longitudinalAcceleration / G * PITCH_GRADIENT / suspensionFactor, -0.055, 0.05);
    const rollTarget = clamp(-this._lateralAcceleration / G * ROLL_GRADIENT / suspensionFactor, -0.1, 0.1);
    const bodyResponse = 1 - Math.exp(-dt * (5 + suspensionFactor * 3));
    this.bodyPitch = THREE.MathUtils.lerp(this.bodyPitch, pitchTarget, bodyResponse);
    this.bodyRoll = THREE.MathUtils.lerp(this.bodyRoll, rollTarget, bodyResponse);
  }

  _readRoadSurface(roadInfo) {
    let info = roadInfo;
    if (typeof roadInfo === 'function') info = roadInfo(this.position, this._state) ?? {};
    if (roadInfo?.getRoadInfo) info = roadInfo.getRoadInfo(this.position, this._state) ?? roadInfo;
    else if (roadInfo?.sample) info = roadInfo.sample(this.position, this._state) ?? roadInfo;
    const grip = clamp(firstNumber(info, ['surfaceGrip', 'grip', 'friction'], info?.onRoad === false ? 0.55 : 1), 0.18, 1.5);
    let height = firstNumber(info, ['height', 'roadHeight', 'y'], NaN);
    if (!Number.isFinite(height) && typeof roadInfo?.heightAt === 'function') height = roadInfo.heightAt(this.position.x, this.position.z);
    return {
      info,
      grip,
      grade: firstNumber(info, ['grade', 'slope'], 0),
      height,
      normal: asVector3(info?.normal, new THREE.Vector3(0, 1, 0)).normalize(),
      snapHeight: info?.snapHeight !== false,
      velocity: info?.surfaceVelocity ? asVector3(info.surfaceVelocity) : null,
      velocityInfluence: firstNumber(info, ['surfaceVelocityInfluence'], 0),
    };
  }

  _applyRoadHeight(surface, dt) {
    if (!Number.isFinite(surface.height) || !surface.snapHeight) return;
    const target = surface.height + this.spec.rideHeight;
    const error = target - this.position.y;
    this._roadHeightVelocity += (error * 95 - this._roadHeightVelocity * 17) * dt;
    this.position.y += this._roadHeightVelocity * dt;
    if (Math.abs(error) < 0.002) {
      this.position.y = target;
      this._roadHeightVelocity = 0;
    }
  }

  _engineForces(input, forwardSpeed, dt, settings) {
    const engineThrottle = this.gear < 0 ? input.brake : input.throttle;
    this._lastThrottle = engineThrottle;
    const ratio = this._currentRatio();
    const wheelRPM = Math.abs(forwardSpeed) / Math.max(0.05, this.spec.wheelRadius) * 60 / TAU;
    const coupledRPM = wheelRPM * Math.abs(ratio) * this.spec.finalDrive;
    const clutchEngagement = ratio === 0 ? 0 : (1 - input.clutch) * smoothstep01((Math.abs(forwardSpeed) + 0.35) / 3.2);
    const freeRevTarget = this.spec.idleRPM + engineThrottle * (this.spec.redlineRPM - this.spec.idleRPM) * 0.72;
    let rpmTarget = ratio === 0
      ? freeRevTarget
      : Math.max(this.spec.idleRPM, THREE.MathUtils.lerp(freeRevTarget, coupledRPM, clutchEngagement));
    if (this.shiftTimer > 0) rpmTarget = Math.max(this.spec.idleRPM, coupledRPM);
    this.rpm += (rpmTarget - this.rpm) * (1 - Math.exp(-dt * (ratio === 0 ? 5.5 : 12)));
    this.rpm = clamp(this.rpm, this.spec.idleRPM * 0.82, this.spec.redlineRPM + 500);

    if (this.fuel <= 0) this.engineRunning = false;
    if (!this.engineRunning) {
      this.rpm = Math.max(0, this.rpm - dt * 1800);
      this._engineTorque = 0;
      this._driveForce = 0;
      return { driveForce: 0, torque: 0 };
    }

    const limiter = this.rpm >= this.spec.redlineRPM ? 0 : 1;
    const shiftCut = this.shiftTimer > 0 ? 0.06 : 1;
    const torque = curveTorque(this.spec.torqueCurve, this.rpm) * engineThrottle * limiter * shiftCut;
    this._engineTorque = torque;
    let driveForce = 0;
    if (ratio !== 0) {
      const launchClutch = THREE.MathUtils.lerp(0.42, 1, smoothstep01(Math.abs(forwardSpeed) / 4));
      driveForce = torque * ratio * this.spec.finalDrive * this.spec.efficiency / this.spec.wheelRadius * launchClutch * (1 - input.clutch);
      const engineBrakingTorque = (1 - engineThrottle) * Math.min(95, 18 + this.rpm * 0.009);
      if (Math.abs(forwardSpeed) > 0.3) driveForce -= Math.sign(forwardSpeed) * engineBrakingTorque * Math.abs(ratio) * this.spec.finalDrive / this.spec.wheelRadius;
    }
    this._driveForce = driveForce;

    if (!(settings.infiniteFuel || settings.adminInfiniteFuel)) {
      // Capacity-normalized consumption yields roughly 35-45 minutes at sustained hard use.
      const load = engineThrottle * (0.62 + 0.38 * clamp(this.rpm / this.spec.redlineRPM, 0, 1));
      const litersPerSecond = (0.00022 + this.spec.fuelCapacity / 2400 * load) * this.spec.fuelUseMultiplier;
      const used = Math.min(this.fuel, litersPerSecond * dt);
      this.fuel -= used;
      this._fuelUsed += used;
      if (this.fuel <= EPSILON) {
        this.fuel = 0;
        this.engineRunning = false;
        this._events.push({ type: 'fuelEmpty', time: this.time });
      }
    }
    return { driveForce, torque };
  }

  _currentRatio() {
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -this.spec.reverseRatio;
    return this.spec.gearRatios[clamp(this.gear - 1, 0, this.spec.gearRatios.length - 1)] ?? 0;
  }

  _automaticGearbox(input, forwardSpeed) {
    if (this.shiftCooldown > 0 || this.shiftTimer > 0) return;
    if (Math.abs(forwardSpeed) < 0.45) {
      if (this.gear >= 0 && input.brake > 0.35 && input.throttle < 0.05) {
        this.gear = -1;
        this._beginShift();
        return;
      }
      if (this.gear < 0 && input.throttle > 0.35) {
        this.gear = 1;
        this._beginShift();
        return;
      }
    }
    if (this.gear < 0) return;
    if (this.gear <= 0 && input.throttle > 0.05) this.gear = 1;
    const gearCount = this.spec.gearRatios.length;
    const upThreshold = this.spec.redlineRPM * THREE.MathUtils.lerp(0.72, 0.94, input.throttle);
    const downThreshold = this.spec.redlineRPM * THREE.MathUtils.lerp(0.31, 0.48, input.throttle);
    if (this.rpm > upThreshold && this.gear < gearCount) this.shiftUp();
    else if (this.rpm < downThreshold && this.gear > 1 && Math.abs(forwardSpeed) > 4) this.shiftDown();
  }

  _gripCircle(forceX, forceY, maximum, brakeDemand) {
    const requested = Math.hypot(forceX, forceY);
    if (maximum <= EPSILON || requested <= maximum) {
      return { x: forceX, y: forceY, saturation: requested / Math.max(1, maximum), lock: 0, spin: 0 };
    }
    const saturation = requested / maximum;
    let scale = maximum / requested;
    const lock = brakeDemand > 0.05 && Math.abs(forceX) > maximum * 0.72 ? clamp((saturation - 1) * 1.7 + brakeDemand * 0.18, 0, 1) : 0;
    const spin = brakeDemand <= 0.05 && Math.abs(forceX) > maximum * 0.75 ? clamp((saturation - 1) * 1.4, 0, 1) : 0;
    if (lock > 0) scale *= THREE.MathUtils.lerp(1, 0.78, lock); // Locked tires lose directional control.
    return { x: forceX * scale, y: forceY * scale * (1 - lock * 0.52), saturation, lock, spin };
  }

  _collisionWorldOffset(target = this._collisionOffsetScratch) {
    const rightX = Math.cos(this.heading);
    const rightZ = -Math.sin(this.heading);
    const forwardX = Math.sin(this.heading);
    const forwardZ = Math.cos(this.heading);
    return target.set(
      rightX * this.spec.collisionOffsetX + forwardX * this.spec.collisionOffsetZ,
      this.spec.collisionOffsetY,
      rightZ * this.spec.collisionOffsetX + forwardZ * this.spec.collisionOffsetZ,
    );
  }

  _resolveRoadBounds(roadInfo, from, to) {
    if (!roadInfo) return;
    let contact = null;
    const radius = Math.max(0.55, this.spec.width * 0.46);
    const offset = this._collisionWorldOffset();
    const collisionFrom = this._collisionFromScratch.copy(from).add(offset);
    const collisionTo = this._collisionToScratch.copy(to).add(offset);
    try {
      if (typeof roadInfo.sweepVehicle === 'function') {
        contact = roadInfo.sweepVehicle(collisionFrom, collisionTo, radius, this._state);
      } else if (typeof roadInfo.resolveVehicle === 'function') {
        contact = roadInfo.resolveVehicle(collisionFrom, collisionTo, radius, this._state);
      } else if (typeof roadInfo.sweep === 'function') {
        contact = roadInfo.sweep(collisionFrom, collisionTo, radius, this._state);
      }
    } catch (error) {
      console.warn('Road collision adapter failed:', error);
    }
    if (contact && !Array.isArray(contact)) {
      const correction = contact.correctedPosition
        ?? contact.resolvePosition
        ?? (contact.positionIsCorrection ? contact.position : null);
      if (correction) {
        contact = {
          ...contact,
          correctedPosition: asVector3(correction).sub(offset),
        };
      }
    }
    if (Array.isArray(contact)) {
      for (const item of contact) {
        const correction = item?.correctedPosition
          ?? item?.resolvePosition
          ?? (item?.positionIsCorrection ? item.position : null);
        this.resolveCollision(correction
          ? { ...item, correctedPosition: asVector3(correction).sub(offset) }
          : item);
      }
    } else if (contact && contact.hit !== false) {
      this.resolveCollision(contact);
    }

    const info = roadInfo.current ?? roadInfo;
    if (Number.isFinite(info.lateralOffset) && Number.isFinite(info.halfWidth)) {
      const roadRight = asVector3(
        info.right,
        new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)),
      ).normalize();
      const effectiveLateralOffset = info.lateralOffset + offset.dot(roadRight);
      const limit = Math.max(0, info.halfWidth - radius);
      if (Math.abs(effectiveLateralOffset) > limit) {
        const side = Math.sign(effectiveLateralOffset);
        const penetration = Math.abs(effectiveLateralOffset) - limit;
        this.position.addScaledVector(roadRight, -side * penetration);
        this.resolveCollision({ normal: roadRight.multiplyScalar(-side), penetration, position: this.position, kind: 'wall' });
      }
    }
  }

  resolveCollision(contact = {}, intensity = null) {
    if (contact?.isVector3 || Array.isArray(contact) || (Number.isFinite(contact?.x) && Number.isFinite(contact?.z) && !contact.normal && !contact.contactNormal)) {
      contact = { normal: contact, intensity };
    }
    if (contact.hit === false) return null;
    const normal = asVector3(contact.normal ?? contact.contactNormal, new THREE.Vector3(0, 0, 1));
    normal.y = 0;
    if (normal.lengthSq() < EPSILON) normal.set(0, 0, 1);
    normal.normalize();
    const otherVelocity = asVector3(contact.otherVelocity ?? contact.velocity, new THREE.Vector3());
    const relativeVelocity = this.velocity.clone().sub(otherVelocity);
    const normalSpeed = relativeVelocity.dot(normal);
    const restitution = clamp(firstNumber(contact, ['restitution'], 0.1), 0, 0.55);
    const friction = clamp(firstNumber(contact, ['friction'], 0.34), 0, 1);
    const preImpactTangent = normal.x * relativeVelocity.z - normal.z * relativeVelocity.x;

    if (normalSpeed < 0) {
      relativeVelocity.addScaledVector(normal, -(1 + restitution) * normalSpeed);
      const tangent = relativeVelocity.clone().addScaledVector(normal, -relativeVelocity.dot(normal));
      relativeVelocity.addScaledVector(tangent, -friction);
      this.velocity.copy(otherVelocity).add(relativeVelocity);
    }
    const penetration = Math.max(0, firstNumber(contact, ['penetration', 'depth'], 0));
    if (contact.correctedPosition || contact.resolvePosition || contact.positionIsCorrection) {
      this.position.copy(asVector3(contact.correctedPosition ?? contact.resolvePosition ?? contact.position));
    }
    if (penetration > 0) this.position.addScaledVector(normal, penetration + 0.015);

    const severity = Math.max(0, -normalSpeed);
    // Yaw kick only on a genuine impact and at most once per contact window;
    // continuous scrapes used to inject rotation every frame and spin the car.
    if (severity > 1.2 && this._yawKickCooldown <= 0) {
      const point = asVector3(contact.point ?? contact.contactPoint, this.position);
      const arm = point.sub(this.position);
      const kick = clamp((arm.x * normal.z - arm.z * normal.x) * severity * 0.03 + preImpactTangent * 0.006, -0.7, 0.7);
      this.yawRate = clamp(this.yawRate + kick, -1.6, 1.6);
      this._yawKickCooldown = 0.45;
      this._postImpactTimer = Math.max(this._postImpactTimer, 0.9);
    }
    const event = {
      type: 'collision',
      serial: ++this._collisionSerial,
      time: this.time,
      severity,
      normal: normal.clone(),
      position: this.position.clone(),
      kind: contact.kind ?? contact.type ?? 'impact',
      other: contact.other ?? null,
    };
    this._lastCollision = event;
    if (this._contactCooldown <= 0 || severity > 4) {
      this._events.push(event);
      this._contactCooldown = 0.2;
    }
    return event;
  }

  reset(position = this._safePosition, heading = this._safeHeading) {
    const target = position?.position ? position.position : position;
    const targetHeading = position?.heading ?? heading;
    this.position.copy(asVector3(target, this._safePosition));
    this.position.y += target === this._safePosition ? 0.12 : 0;
    this.previousPosition.copy(this.position);
    this.heading = wrapAngle(finite(targetHeading, this._safeHeading));
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.steering = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this._longitudinalAcceleration = 0;
    this._lateralAcceleration = 0;
    this._roadHeightVelocity = 0;
    this._postImpactTimer = 0;
    this._yawKickCooldown = 0;
    this.rpm = this.engineRunning ? this.spec.idleRPM : 0;
    this.gear = Math.max(1, this.gear);
    this._events.push({ type: 'reset', time: this.time, position: this.position.clone() });
    this._refreshPublicState(0, 0);
    return this._state;
  }

  refuel(liters = Infinity) {
    const amount = Math.min(Math.max(0, liters), this.spec.fuelCapacity - this.fuel);
    this.fuel += amount;
    if (this.fuel > 0) this.engineRunning = true;
    this._refreshPublicState();
    return amount;
  }

  consumeEvents() {
    const events = this._events.slice();
    this._events.length = 0;
    return events;
  }

  _refreshPublicState(forwardSpeed = null, lateralSpeed = null) {
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    const actualForward = forwardSpeed ?? this.velocity.dot(forward);
    const actualLateral = lateralSpeed ?? this.velocity.dot(right);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    Object.assign(this._state, {
      heading: this.heading,
      yaw: this.heading,
      yawRate: this.yawRate,
      speed,
      speedMS: speed,
      speedKmh: speed * 3.6,
      forwardSpeed: actualForward,
      lateralSpeed: actualLateral,
      steering: this.steering,
      gear: this.gear,
      rpm: this.rpm,
      fuel: this.fuel,
      fuelCapacity: this.spec.fuelCapacity,
      engineRunning: this.engineRunning,
      bodyRoll: this.bodyRoll,
      bodyPitch: this.bodyPitch,
      transmissionMode: this.transmissionMode,
    });

    const totalWeight = this.spec.mass * G;
    const longTransfer = this.spec.mass * this._longitudinalAcceleration * this.spec.cgHeight / this.spec.wheelbase;
    const frontLoad = clamp(totalWeight * this.spec.frontWeight - longTransfer, totalWeight * 0.16, totalWeight * 0.84);
    const rearLoad = totalWeight - frontLoad;
    const latTransferFront = this.spec.mass * this.spec.frontWeight * this._lateralAcceleration * this.spec.cgHeight / this.spec.trackWidth;
    const latTransferRear = this.spec.mass * (1 - this.spec.frontWeight) * this._lateralAcceleration * this.spec.cgHeight / this.spec.trackWidth;
    this._telemetry = {
      speed,
      speedKmh: speed * 3.6,
      forwardSpeed: actualForward,
      lateralSpeed: actualLateral,
      accelerationLongitudinal: this._longitudinalAcceleration,
      accelerationLateral: this._lateralAcceleration,
      gLongitudinal: this._longitudinalAcceleration / G,
      gLateral: this._lateralAcceleration / G,
      rpm: this.rpm,
      redline: this.spec.redlineRPM,
      redlineRPM: this.spec.redlineRPM,
      rpmNormalized: clamp(this.rpm / this.spec.redlineRPM, 0, 1.1),
      gear: this.gear,
      gearLabel: this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear),
      transmissionMode: this.transmissionMode,
      engineTorque: this._engineTorque,
      driveForce: this._driveForce,
      engineRunning: this.engineRunning,
      fuel: this.fuel,
      fuelCapacity: this.spec.fuelCapacity,
      fuelFraction: this.spec.fuelCapacity > 0 ? this.fuel / this.spec.fuelCapacity : 0,
      fuelUsed: this._fuelUsed,
      distanceTravelled: this._distanceTravelled,
      steeringAngle: this.steering,
      yawRate: this.yawRate,
      frontSlipAngle: this._frontSlip,
      rearSlipAngle: this._rearSlip,
      frontSlipDegrees: THREE.MathUtils.radToDeg(this._frontSlip),
      rearSlipDegrees: THREE.MathUtils.radToDeg(this._rearSlip),
      frontSaturation: this._frontSaturation,
      rearSaturation: this._rearSaturation,
      frontWheelLock: this._frontLock,
      rearWheelLock: this._rearLock,
      wheelSpin: this._wheelSpin,
      slip: Math.max(Math.abs(this._frontSlip), Math.abs(this._rearSlip)),
      slipAngle: Math.max(Math.abs(this._frontSlip), Math.abs(this._rearSlip)),
      throttle: this._lastThrottle,
      surfaceGrip: this._surfaceGrip,
      bodyRoll: this.bodyRoll,
      bodyPitch: this.bodyPitch,
      axleLoads: { front: frontLoad, rear: rearLoad },
      wheelLoads: {
        frontLeft: Math.max(0, frontLoad * 0.5 - latTransferFront * 0.5),
        frontRight: Math.max(0, frontLoad * 0.5 + latTransferFront * 0.5),
        rearLeft: Math.max(0, rearLoad * 0.5 - latTransferRear * 0.5),
        rearRight: Math.max(0, rearLoad * 0.5 + latTransferRear * 0.5),
      },
      lastCollision: this._lastCollision,
      spec: this.spec,
    };
  }

  get state() {
    return this._state;
  }

  get telemetry() {
    return this._telemetry;
  }

  getState() {
    return this._state;
  }

  getTelemetry() {
    return this._telemetry;
  }
}

export default VehiclePhysics;
