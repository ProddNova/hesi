/**
 * "MOVIMENTI" — how the player's car MOVES, as one authored record.
 *
 * Everything that decides the way the shell and the chassis behave while
 * driving used to be a module constant in js/physics.js (ROLL_GRADIENT,
 * TURN_IN_BOOST, STABILITY_YAW_GAIN, …) or a bare number inside a substep
 * (`1 - Math.exp(-dt * (5 + suspensionFactor * 3))`). Every one of them is a
 * FEEL decision — how far the body leans in a corner, how fast it gets there,
 * how much the nose dives on the brakes, how quickly the wheel builds lock, how
 * hard the stability control leans on a slide — and a feel decision cannot be
 * tuned by reading source and reloading. This module is that list, with a
 * range, a unit and a default per entry, so:
 *
 *  - the playground panel (key 8) can drive them live while driving,
 *  - the values can be published in data/editor/custom-assets.json
 *    (`runtimeTuning.movement`) and ship with the site, exactly like the
 *    camera and the picture do (see js/playground-config.js), and
 *  - js/physics.js keeps ONE definition of each number instead of a constant
 *    here and a slider range there.
 *
 * Nothing in here is per-car. The car's own spec (mass, grip, brake force,
 * suspension rate…) stays in js/data.js and the Car Modeler; these are the
 * global gradients and response rates applied ON TOP of it, which is why so
 * many of them are multipliers. A default record therefore has to reproduce the
 * driving the game shipped with, and the probe
 * (.devtests/movement-tuning-probe.mjs) checks exactly that.
 *
 * Angles are authored in DEGREES because that is the only unit a lean or a dive
 * can be discussed in; physics converts with DEG at the point of use. Keys that
 * hold an angle say so (`…Deg`), so a radian/degree mix-up cannot hide.
 */

/** Degrees → radians. Physics multiplies the authored `…Deg` values by this. */
export const DEG = Math.PI / 180;

/**
 * Panel layout. The menu builds one collapsible section per group in this
 * order, so adding a dial is a single entry in MOVEMENT_FIELDS below.
 */
export const MOVEMENT_GROUPS = Object.freeze([
  {
    id: 'body',
    label: 'ASSETTO CARROZZERIA',
    hint: 'Quanto e quanto in fretta la scocca si inclina in curva, in frenata e in salita',
    note: 'INCLINAZIONE IN CURVA è il grado di rollio per ogni g di accelerazione laterale · un valore NEGATIVO fa piegare la macchina verso l\'interno della curva (look da moto) · REATTIVITÀ SCOCCA è la molla che porta la carrozzeria sul valore richiesto',
    open: true,
  },
  {
    id: 'ride',
    label: 'SOSPENSIONI & ALTEZZA',
    hint: 'Altezza da terra, durezza delle molle e come la macchina segue il manto',
    note: 'DUREZZA SOSPENSIONI moltiplica il valore della scheda auto: più alto = meno rollio e risposta più rapida · MOLLA / SMORZAMENTO MANTO sono l\'inseguitore che tiene le ruote sulla strada, valori bassi galleggiano, alti copiano ogni asperità',
  },
  {
    id: 'steering',
    label: 'STERZO',
    hint: 'Angolo di sterzata, velocità del volante e ritorno al centro',
    note: 'BUDGET ADERENZA STERZO è la frazione del grip che una sterzata tenuta può chiedere: sopra 1 ogni curva tenuta diventa una scivolata · INSERIMENTO dà angolo extra all\'ingresso, CAMBIO DIREZIONE nelle inversioni rapide',
  },
  {
    id: 'grip',
    label: 'ADERENZA GOMME',
    hint: 'Grip complessivo, bilanciamento avanti / dietro e freno a mano',
    note: 'RIGIDEZZA ANTERIORE / POSTERIORE è il bilanciamento: più anteriore = più sovrasterzo, più posteriore = più sottosterzo · FRENO A MANO è quanta aderenza resta al posteriore quando è tirato',
  },
  {
    id: 'slide',
    label: 'SCIVOLATE & AIUTI',
    hint: 'Quando la macchina conta come in scivolata e quanto viene aiutata',
    note: 'INIZIO SCIVOLATA è in multipli dell\'angolo di deriva di picco delle gomme, non in gradi · gli aiuti sono comunque scalati dall\'impostazione AIUTI ALLA GUIDA del giocatore: a 0 questi valori non fanno nulla',
  },
  {
    id: 'rotation',
    label: 'ROTAZIONE & IMPATTI',
    hint: 'Inerzia in imbardata, smorzamenti e contraccolpo negli urti',
    note: 'INERZIA più bassa = macchina che ruota più volentieri · LIMITE IMBARDATA impedisce la trottola a velocità alta: il surplus viene scaricato, non tagliato · SMORZAMENTO POST-URTO è quanto in fretta smette di girare dopo una botta',
  },
  {
    id: 'drive',
    label: 'FRENI, MOTORE & CAMBIO',
    hint: 'Forza frenante, freno motore, stacco della frizione e soglie del cambio',
    note: 'RIPARTIZIONE FRENI sposta il bias verso l\'anteriore (+) o il posteriore (−) rispetto alla scheda auto · SOGLIA SALITA / DISCESA MARCE moltiplica i giri a cui il cambio automatico interviene',
  },
  {
    id: 'resistance',
    label: 'ARIA & ATTRITI',
    hint: 'Resistenza aerodinamica, rotolamento e peso delle pendenze',
    note: 'RESISTENZA LATERALE è la frazione della resistenza aerodinamica che agisce di fianco: alza il valore e le derapate si fermano prima · PENDENZE è quanto le salite frenano e le discese spingono',
  },
]);

/**
 * One entry per dial.
 *
 * `min`/`max`/`step` are the panel's range AND the clamp the game applies on
 * load, so a hand-edited save or an old published document can never feed
 * physics a value the sliders could not have produced. `percent` shows the
 * value as a percentage, `zero` names the neutral end when 0 means "off".
 */
export const MOVEMENT_FIELDS = Object.freeze([
  // --- Body attitude -------------------------------------------------------
  { key: 'rollPerGDeg', group: 'body', label: 'INCLINAZIONE IN CURVA', min: -8, max: 20, step: 0.05, unit: '°/g' },
  // Step 0.05 like the gradients, so the shipped 5.75° shows as itself rather
  // than rounded to one decimal by the readout.
  { key: 'rollLimitDeg', group: 'body', label: 'ROLLIO MASSIMO', min: 0, max: 25, step: 0.05, unit: '°' },
  { key: 'divePerGDeg', group: 'body', label: 'BECCHEGGIO IN FRENATA', min: -6, max: 12, step: 0.05, unit: '°/g' },
  { key: 'diveLimitDeg', group: 'body', label: 'AFFONDO MASSIMO', min: 0, max: 12, step: 0.05, unit: '°' },
  { key: 'squatLimitDeg', group: 'body', label: 'CORICAMENTO MASSIMO', min: 0, max: 12, step: 0.05, unit: '°' },
  { key: 'bodyResponse', group: 'body', label: 'REATTIVITÀ SCOCCA', min: 0.5, max: 20, step: 0.1, unit: '/s' },
  { key: 'bodyResponseStiffness', group: 'body', label: 'REATTIVITÀ DA SOSPENSIONI', min: 0, max: 12, step: 0.1, unit: '/s' },
  { key: 'loadSmoothing', group: 'body', label: 'FILTRO CARICHI', min: 1, max: 30, step: 0.5, unit: '/s' },
  { key: 'slopeFollow', group: 'body', label: 'SEGUE LA PENDENZA', min: 0, max: 2, step: 0.05, percent: true, zero: 'PIATTA' },
  { key: 'slopeLimitDeg', group: 'body', label: 'PENDENZA MASSIMA SU SCOCCA', min: 0, max: 30, step: 0.5, unit: '°' },
  { key: 'slopeSmoothing', group: 'body', label: 'REATTIVITÀ PENDENZA', min: 0.5, max: 20, step: 0.1, unit: '/s' },

  // --- Ride ----------------------------------------------------------------
  { key: 'rideHeightDelta', group: 'ride', label: 'ALTEZZA DA TERRA', min: -0.18, max: 0.35, step: 0.005, unit: ' m', signed: true },
  { key: 'suspensionRate', group: 'ride', label: 'DUREZZA SOSPENSIONI', min: 0.4, max: 2.2, step: 0.01, unit: '×' },
  { key: 'surfaceSpring', group: 'ride', label: 'MOLLA MANTO', min: 20, max: 220, step: 1 },
  { key: 'surfaceDamping', group: 'ride', label: 'SMORZAMENTO MANTO', min: 4, max: 40, step: 0.5 },

  // --- Steering ------------------------------------------------------------
  { key: 'steerLock', group: 'steering', label: 'ANGOLO DI STERZO', min: 0.4, max: 2, step: 0.01, unit: '×' },
  { key: 'steerGripBudget', group: 'steering', label: 'BUDGET ADERENZA STERZO', min: 0.5, max: 1.15, step: 0.01, percent: true },
  { key: 'turnInBoost', group: 'steering', label: 'INSERIMENTO', min: 0, max: 1.6, step: 0.05, percent: true, zero: 'OFF' },
  { key: 'directionChangeBoost', group: 'steering', label: 'CAMBIO DIREZIONE', min: 0, max: 2, step: 0.05, percent: true, zero: 'OFF' },
  { key: 'steerBuildTime', group: 'steering', label: 'TEMPO PIENO STERZO', min: 0.05, max: 1.2, step: 0.01, unit: ' s' },
  { key: 'steerRateFloor', group: 'steering', label: 'VELOCITÀ MINIMA VOLANTE', min: 0.1, max: 4, step: 0.05, unit: ' rad/s' },
  { key: 'steerCatchGain', group: 'steering', label: 'PRONTEZZA CORREZIONI', min: 0.5, max: 12, step: 0.1, unit: '×' },
  { key: 'steerReturnRate', group: 'steering', label: 'RITORNO AL CENTRO', min: 0, max: 18, step: 0.1, unit: '/s', zero: 'MAI' },
  { key: 'steerReturnSpeedGain', group: 'steering', label: 'RITORNO EXTRA A VELOCITÀ', min: 0, max: 0.2, step: 0.005, unit: '/s per m/s' },

  // --- Grip ----------------------------------------------------------------
  { key: 'gripScale', group: 'grip', label: 'ADERENZA GENERALE', min: 0.5, max: 1.8, step: 0.01, unit: '×' },
  { key: 'frontCornerScale', group: 'grip', label: 'RIGIDEZZA ANTERIORE', min: 0.5, max: 1.8, step: 0.01, unit: '×' },
  { key: 'rearCornerScale', group: 'grip', label: 'RIGIDEZZA POSTERIORE', min: 0.5, max: 1.8, step: 0.01, unit: '×' },
  { key: 'loadSensitivity', group: 'grip', label: 'SENSIBILITÀ AL CARICO', min: 0, max: 0.5, step: 0.01, percent: true, zero: 'OFF' },
  { key: 'tireWarmSpeed', group: 'grip', label: 'SOGLIA GOMME FERME', min: 0.5, max: 8, step: 0.1, unit: ' m/s' },
  { key: 'handbrakeRearGrip', group: 'grip', label: 'ADERENZA CON FRENO A MANO', min: 0.05, max: 1, step: 0.01, percent: true },
  { key: 'handbrakeForce', group: 'grip', label: 'FORZA FRENO A MANO', min: 0, max: 1.6, step: 0.02, percent: true, zero: 'OFF' },

  // --- Slide and assists ---------------------------------------------------
  { key: 'slideOnset', group: 'slide', label: 'INIZIO SCIVOLATA', min: 0.3, max: 2.5, step: 0.05, unit: '× picco' },
  { key: 'slideRange', group: 'slide', label: 'AMPIEZZA SCIVOLATA', min: 0.2, max: 3, step: 0.05, unit: '× picco' },
  { key: 'counterSteerAssist', group: 'slide', label: 'CONTROSTERZO AUTOMATICO', min: 0, max: 1, step: 0.05, percent: true, zero: 'OFF' },
  { key: 'stabilityYawGain', group: 'slide', label: 'CONTROLLO STABILITÀ', min: 0, max: 6, step: 0.1, unit: '×', zero: 'OFF' },
  { key: 'tractionHeadroom', group: 'slide', label: 'MARGINE CONTROLLO TRAZIONE', min: 0.8, max: 2.5, step: 0.02, unit: '×' },

  // --- Rotation ------------------------------------------------------------
  { key: 'inertiaScale', group: 'rotation', label: 'INERZIA IN IMBARDATA', min: 0.3, max: 1.6, step: 0.01, unit: '×' },
  { key: 'yawDamping', group: 'rotation', label: 'SMORZAMENTO IMBARDATA', min: 0, max: 2, step: 0.02, unit: '/s', zero: 'OFF' },
  { key: 'impactYawDamping', group: 'rotation', label: 'SMORZAMENTO POST-URTO', min: 0, max: 8, step: 0.1, unit: '/s', zero: 'OFF' },
  { key: 'parkedYawDamping', group: 'rotation', label: 'SMORZAMENTO DA FERMO', min: 0, max: 14, step: 0.2, unit: '/s', zero: 'OFF' },
  { key: 'yawLimit', group: 'rotation', label: 'LIMITE IMBARDATA', min: 0.5, max: 4, step: 0.05, unit: '×' },
  { key: 'yawLimitFloor', group: 'rotation', label: 'IMBARDATA SEMPRE CONCESSA', min: 0, max: 1.5, step: 0.02, unit: ' rad/s' },
  { key: 'impactYawKick', group: 'rotation', label: 'CONTRACCOLPO NEGLI URTI', min: 0, max: 3, step: 0.05, percent: true, zero: 'OFF' },

  // --- Brakes, engine, gearbox --------------------------------------------
  { key: 'brakeScale', group: 'drive', label: 'FORZA FRENANTE', min: 0.4, max: 2, step: 0.01, unit: '×' },
  { key: 'brakeBiasDelta', group: 'drive', label: 'RIPARTIZIONE FRENI', min: -0.2, max: 0.2, step: 0.01, percent: true, signed: true, zero: 'SCHEDA AUTO' },
  { key: 'engineBraking', group: 'drive', label: 'FRENO MOTORE', min: 0, max: 3, step: 0.05, percent: true, zero: 'OFF' },
  { key: 'launchBite', group: 'drive', label: 'STACCO FRIZIONE', min: 0.1, max: 1, step: 0.01, percent: true },
  { key: 'shiftTimeScale', group: 'drive', label: 'DURATA CAMBIATA', min: 0.2, max: 2.5, step: 0.05, unit: '×' },
  { key: 'upshiftRPM', group: 'drive', label: 'SOGLIA SALITA MARCE', min: 0.6, max: 1.15, step: 0.01, unit: '×' },
  { key: 'downshiftRPM', group: 'drive', label: 'SOGLIA DISCESA MARCE', min: 0.5, max: 1.4, step: 0.01, unit: '×' },
  { key: 'rpmResponse', group: 'drive', label: 'PRONTEZZA GIRI MOTORE', min: 0.3, max: 3, step: 0.05, unit: '×' },

  // --- Resistances ---------------------------------------------------------
  { key: 'dragScale', group: 'resistance', label: 'RESISTENZA ARIA', min: 0, max: 2.5, step: 0.02, unit: '×', zero: 'OFF' },
  { key: 'lateralDrag', group: 'resistance', label: 'RESISTENZA LATERALE', min: 0, max: 3, step: 0.05, unit: '×', zero: 'OFF' },
  { key: 'rollingResistanceScale', group: 'resistance', label: 'ATTRITO DI ROTOLAMENTO', min: 0, max: 3, step: 0.05, unit: '×', zero: 'OFF' },
  { key: 'gradeForce', group: 'resistance', label: 'PESO DELLE PENDENZE', min: 0, max: 2.5, step: 0.05, unit: '×', zero: 'OFF' },
]);

/**
 * The shipped movement — the driving the game had before this panel existed.
 *
 * Each value is the constant or literal it replaced in js/physics.js (or, for
 * the two slope entries, in game.js `updateBodyClimb`). The angles are the same
 * numbers rounded to the sliders' step: the roll gradient was 0.061 rad/g =
 * 3.4951°/g and is authored as 3.5, a 0.14% difference in lean angle, which is
 * well under a tenth of a degree at the roll limit.
 *
 * data/editor/custom-assets.json carries the published record under
 * `runtimeTuning.movement` once the playground has saved one; these are the
 * fallback for a fresh checkout, an offline boot or a failed fetch, so they
 * must be kept in step with it.
 */
export const DEFAULT_MOVEMENT = Object.freeze({
  // --- Body attitude -------------------------------------------------------
  // A firmish road car does about 3.5 degrees of roll per g and 1.6 of dive.
  // These are suspension gradients, NOT the load-transfer angle an earlier
  // version used: that angle is how much weight moves across the track, not how
  // far the shell leans, and it reached 16 degrees of roll and 8 of dive.
  rollPerGDeg: 3.5,
  rollLimitDeg: 5.75,
  divePerGDeg: 1.6,
  diveLimitDeg: 2.85,
  squatLimitDeg: 3.15,
  // The spring that chases those targets: a base rate plus a share of the
  // suspension rate, so a stiffer car both leans less and settles sooner.
  bodyResponse: 5,
  bodyResponseStiffness: 3,
  // How fast the sim's filtered accelerations follow the raw ones. Everything
  // that reads "how loaded is the car" reads them: the attitude, the weight
  // transfer and the steering budget.
  loadSmoothing: 9,
  // Shell pitch on a gradient. Read by game.js updateBodyClimb, measured from
  // the car's own motion rather than from a route tangent.
  slopeFollow: 1,
  slopeLimitDeg: 11.5,
  slopeSmoothing: 5,
  // --- Ride ---------------------------------------------------------------
  rideHeightDelta: 0,
  suspensionRate: 1,
  // The road-height follower: a spring at 95 with 17 of damping keeps the wheels
  // on a surface that is itself sampled per substep.
  surfaceSpring: 95,
  surfaceDamping: 17,
  // --- Steering ------------------------------------------------------------
  steerLock: 1,
  // How much of the tires' lateral grip a held steering input may ask for in a
  // steady corner. Deliberately below 1: the remainder is the margin the car
  // spends on bumps, on the throttle and on a lane change taken mid-corner. At
  // 1.0 every held turn is already a slide waiting for its trigger.
  steerGripBudget: 0.94,
  // Extra lock allowed on the way into a corner, before the lateral grip the
  // steering asked for has actually arrived. Fades to nothing as it loads.
  turnInBoost: 0.55,
  // A direction change must first unwind the lateral load from the previous
  // corner. That short transition gets more authority than a turn from
  // straight; it disappears with the old load and never raises steady lock.
  directionChangeBoost: 0.8,
  // Turn-in ramps over ~0.26 s so a binary key reads as a progressive turn; a
  // large error (catching a slide) moves the wheel proportionally faster, the
  // way a driver's hands would, and the floor keeps slow corners from crawling.
  steerBuildTime: 0.26,
  steerRateFloor: 0.55,
  steerCatchGain: 4,
  // Self-centring once the key is released, faster the quicker the car is going.
  steerReturnRate: 5.5,
  steerReturnSpeedGain: 0.035,
  // --- Grip ---------------------------------------------------------------
  gripScale: 1,
  frontCornerScale: 1,
  rearCornerScale: 1,
  // Tires lose a little mu as load piles onto the outside wheel.
  loadSensitivity: 0.14,
  // Below this speed the tires build force progressively, so a standing start
  // does not begin with a slip angle.
  tireWarmSpeed: 2.2,
  // The handbrake takes most of the rear's grip away and sends 72% of the brake
  // force to that axle; both halves are needed for a flick to work.
  handbrakeRearGrip: 0.28,
  handbrakeForce: 0.72,
  // --- Slide and assists ---------------------------------------------------
  // When the car counts as sliding, measured in multiples of the rear tires' own
  // peak slip angle rather than in degrees — a soft tire on a wet surface is
  // away at an angle a sticky one is still gripping at. Nothing below onset is
  // touched, so ordinary hard cornering never meets the assists.
  slideOnset: 1,
  slideRange: 1.15,
  // The fraction of the slide-cancelling steering angle handed to the driver (a
  // keyboard cannot feed in a precise opposite lock), and the surplus yaw rate
  // per second the stability control removes at full slide.
  counterSteerAssist: 0.55,
  stabilityYawGain: 2.6,
  // Drive force allowed past what is left of the driven axle's friction circle,
  // so power-on rotation still exists with traction control awake.
  tractionHeadroom: 1.18,
  // --- Rotation ------------------------------------------------------------
  inertiaScale: 0.72,
  yawDamping: 0.32,
  // Wall and traffic hits shed their rotation in well under a second instead of
  // an endless pirouette; a stationary car stops turning altogether.
  impactYawDamping: 2.6,
  parkedYawDamping: 5,
  // No car pirouettes at speed — the tires cannot hold a radius that tight.
  yawLimit: 1.7,
  yawLimitFloor: 0.22,
  impactYawKick: 1,
  // --- Brakes, engine, gearbox --------------------------------------------
  brakeScale: 1,
  brakeBiasDelta: 0,
  engineBraking: 1,
  // The clutch is only partly in at a standstill, so a launch does not dump the
  // whole first-gear torque into the tires.
  launchBite: 0.42,
  shiftTimeScale: 1,
  upshiftRPM: 1,
  downshiftRPM: 1,
  rpmResponse: 1,
  // --- Resistances ---------------------------------------------------------
  // Street-car aero and rolling losses; neither creates meaningful downforce.
  // The lateral share is what stops a slide from running forever.
  dragScale: 1,
  lateralDrag: 0.7,
  rollingResistanceScale: 1,
  gradeForce: 1,
});

/**
 * Starting points, applied as a whole record: anything a preset does not name
 * goes back to its default, so a preset is a complete answer rather than a
 * patch on whatever was on the dials a minute ago.
 *
 * `stock` is the shipped record, and doubles as the panel's reset.
 */
export const MOVEMENT_PRESETS = Object.freeze({
  stock: { ...DEFAULT_MOVEMENT },
  // A soft road car: it leans, it dives, it takes its time about both.
  morbido: {
    rollPerGDeg: 6.4, rollLimitDeg: 9, divePerGDeg: 2.8, diveLimitDeg: 4.6, squatLimitDeg: 4.8,
    bodyResponse: 3.4, bodyResponseStiffness: 2, loadSmoothing: 7,
    suspensionRate: 0.78, rideHeightDelta: 0.03, surfaceSpring: 68, surfaceDamping: 13,
    steerBuildTime: 0.34, steerReturnRate: 4.6, frontCornerScale: 0.94,
  },
  // Track-day stiff: almost flat, immediate, and it copies the road surface.
  rigido: {
    rollPerGDeg: 1.5, rollLimitDeg: 3, divePerGDeg: 0.8, diveLimitDeg: 1.6, squatLimitDeg: 1.7,
    bodyResponse: 9, bodyResponseStiffness: 4.5, loadSmoothing: 13,
    suspensionRate: 1.5, rideHeightDelta: -0.05, surfaceSpring: 145, surfaceDamping: 22,
    steerBuildTime: 0.18, steerCatchGain: 5.5, frontCornerScale: 1.12,
  },
  // Loose rear, assists mostly out of the way, plenty of handbrake.
  drift: {
    rollPerGDeg: 4.6, rollLimitDeg: 7,
    rearCornerScale: 0.8, handbrakeRearGrip: 0.14, handbrakeForce: 1,
    slideOnset: 0.75, slideRange: 1.5, counterSteerAssist: 0.2, stabilityYawGain: 0.5,
    tractionHeadroom: 1.7, yawDamping: 0.2, inertiaScale: 0.62, steerBuildTime: 0.2,
  },
  // Forgiving and quick-witted: grip up, wheel fast, assists awake.
  arcade: {
    rollPerGDeg: 2.6, divePerGDeg: 1.2, bodyResponse: 7,
    gripScale: 1.18, steerBuildTime: 0.16, steerCatchGain: 6, steerGripBudget: 1,
    counterSteerAssist: 0.85, stabilityYawGain: 3.6, tractionHeadroom: 1.05, yawDamping: 0.5,
  },
  // Nothing between the driver and the tires. Also the honest test of the sim.
  crudo: {
    counterSteerAssist: 0, stabilityYawGain: 0, tractionHeadroom: 2.5,
    steerGripBudget: 1.05, turnInBoost: 0.3, directionChangeBoost: 0.35, steerBuildTime: 0.2,
  },
});

const FIELD_BY_KEY = new Map(MOVEMENT_FIELDS.map((field) => [field.key, field]));

const number = (value, fallback) => (Number.isFinite(+value) ? +value : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Clamps one dial to its declared range. Unknown keys pass through unchanged. */
export function clampMovementValue(key, value) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return value;
  return clamp(number(value, DEFAULT_MOVEMENT[key]), field.min, field.max);
}

/**
 * Turns anything — a partial preset, an older save, a published document, a
 * `null` — into a complete, in-range record. Never throws: this runs on load,
 * before the player can see an error, and physics must never be handed a NaN.
 */
export function normalizeMovement(value = null) {
  const input = value && typeof value === 'object' ? value : {};
  const movement = {};
  for (const field of MOVEMENT_FIELDS) movement[field.key] = clampMovementValue(field.key, input[field.key]);
  return movement;
}

/** True when the record is the shipped one, dial for dial. */
export function isDefaultMovement(value) {
  const movement = normalizeMovement(value);
  return MOVEMENT_FIELDS.every((field) => movement[field.key] === DEFAULT_MOVEMENT[field.key]);
}

/** How many dials sit away from the shipped record; shown in the panel header. */
export function movementChangeCount(value) {
  const movement = normalizeMovement(value);
  return MOVEMENT_FIELDS.filter((field) => movement[field.key] !== DEFAULT_MOVEMENT[field.key]).length;
}

/** The value shown next to a slider, e.g. `3.50°/g`, `94%`, `OFF`, `+0.03 m`. */
export function formatMovementValue(key, value) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return String(value);
  const amount = number(value, DEFAULT_MOVEMENT[key]);
  if (field.zero && amount === 0) return field.zero;
  if (field.percent) return `${field.signed && amount > 0 ? '+' : ''}${Math.round(amount * 100)}%`;
  const decimals = field.step >= 1 ? 0 : field.step >= 0.1 ? 1 : field.step >= 0.01 ? 2 : 3;
  const sign = field.signed && amount > 0 ? '+' : '';
  return `${sign}${amount.toFixed(decimals)}${field.unit || ''}`;
}

/**
 * A stable id for one published record, so a client adopts published values
 * exactly once instead of on every boot — the same contract as
 * `pictureSignature` in js/playground-config.js, and for the same reason: a
 * live tuning panel has to be able to hold a value across a reload, and a
 * deploy still has to reach players who have driven before.
 *
 * FNV-1a over a key-ordered serialization, matching the editor's own
 * `fnv1a32:` draft signatures.
 */
export function movementSignature(value) {
  const movement = normalizeMovement(value);
  const text = MOVEMENT_FIELDS.map((field) => `${field.key}=${movement[field.key]}`).join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * The published record, or null when the document carries none. Null, not a
 * default: the caller has to be able to tell "nothing was published" from "the
 * defaults were published".
 */
export function movementFromDocument(document) {
  const movement = document?.runtimeTuning?.movement;
  return movement ? normalizeMovement(movement) : null;
}

export function setDocumentMovement(document, movement) {
  if (!document.runtimeTuning || typeof document.runtimeTuning !== 'object') document.runtimeTuning = {};
  document.runtimeTuning.movement = normalizeMovement(movement);
  return document.runtimeTuning.movement;
}
