/** Dynamic VehiclePhysics traversal gate for every active progressive lane. */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';
import { VehiclePhysics } from '../js/physics.js';

const map = new HighwayMap(null, { addLighting: false, progressiveMerges: true });
const failures = [];
const wrapAngle = (value) => THREE.MathUtils.euclideanModulo(value + Math.PI, Math.PI * 2) - Math.PI;

for (const transition of map.progressiveTransitions) {
  const route = transition.sourceZone.branch;
  const lanes = transition.type === 'diverge'
    ? transition.branchExitLanes
    : Array.from({ length: route.lanes }, (_, lane) => lane);
  const start = transition.branchInterval[0] + 2;
  // Cross the ownership boundary and continue on the real branch. The old
  // version stopped two metres before transfer, so it could not prove that a
  // progressive lane actually became a branch lane.
  const end = transition.type === 'diverge'
    ? Math.min(route.length - 2, transition.transferCompleteBranch + 40)
    : transition.branchInterval[1] - 2;

  for (const laneIndex of lanes) {
    const first = map.sampleLane(route.id, start, laneIndex, 1);
    const vehicle = new VehiclePhysics({ fuel: 60 });
    vehicle.setPosition(
      first.position.x,
      first.center.y + vehicle.spec.rideHeight,
      first.position.z,
      first.heading,
    );
    vehicle.setSpeed(10);

    let preferredRouteId = route.id;
    let collisionEvents = 0;
    let maximumLaneError = 0;
    let maximumWallCorrection = 0;
    let reached = false;
    let finite = true;
    let lastDistance = start;
    const ownershipSequence = [];
    const adapter = {
      getRoadInfo(position) {
        const info = map.getRoadInfo(position, preferredRouteId);
        if (!info) return {
          onRoad: false,
          drivable: false,
          surfaceGrip: 0.55,
          snapHeight: false,
        };
        preferredRouteId = info.routeId;
        if (ownershipSequence.at(-1) !== info.routeId) ownershipSequence.push(info.routeId);
        return {
          ...info,
          height: info.height ?? info.point?.y,
          snapHeight: true,
          surfaceGrip: info.drivable === false ? 0.55 : (info.surfaceGrip ?? 1),
        };
      },
      sweep(from, to, radius) {
        const hit = map.sweepWallCollision(from, to, null, Math.max(0.62, radius), 1.5);
        if (!hit?.hit) return null;
        maximumWallCorrection = Math.max(maximumWallCorrection, hit.correctionDistance || 0);
        return {
          hit: true,
          normal: hit.normal,
          correctedPosition: hit.position,
          penetration: 0,
          kind: 'wall',
          restitution: 0.12,
          friction: 0.4,
        };
      },
    };

    // A conservative lane-following controller drives the real rigid-body
    // bicycle model at roughly 50 km/h. It only supplies throttle/steering;
    // road height and swept wall collision come from the production adapter.
    for (let step = 0; step < 60 * 35; step += 1) {
      const projection = map._projectToRoute(route, vehicle.position);
      lastDistance = projection.distance;
      const lane = map.sampleLane(route.id, projection.distance, laneIndex, 1);
      maximumLaneError = Math.max(
        maximumLaneError,
        Math.hypot(lane.position.x - vehicle.position.x, lane.position.z - vehicle.position.z),
      );
      if (lastDistance >= end) {
        reached = true;
        break;
      }

      const target = map.sampleLane(
        route.id,
        Math.min(end, projection.distance + 14),
        laneIndex,
        1,
      );
      const desiredHeading = Math.atan2(
        target.position.x - vehicle.position.x,
        target.position.z - vehicle.position.z,
      );
      const steer = THREE.MathUtils.clamp(wrapAngle(desiredHeading - vehicle.heading) * 3.2, -1, 1);
      const speed = vehicle.velocity.length();
      vehicle.update(1 / 60, {
        throttle: speed < 14 ? 0.65 : 0.12,
        brake: speed > 18 ? 0.15 : 0,
        steer,
      }, adapter, { automatic: true, infiniteFuel: true });
      for (const event of vehicle.consumeEvents()) {
        if (event.type === 'collision') collisionEvents += 1;
      }
      finite = Number.isFinite(
        vehicle.position.x + vehicle.position.y + vehicle.position.z + vehicle.heading,
      );
      if (!finite) break;
    }

    const label = `${transition.id}/branch:${laneIndex}`;
    if (!reached) failures.push(`${label}: stopped at ${lastDistance.toFixed(1)} / ${end.toFixed(1)} m`);
    if (!finite) failures.push(`${label}: non-finite vehicle state`);
    if (collisionEvents) failures.push(`${label}: ${collisionEvents} collision event(s)`);
    if (maximumWallCorrection > 0.001) {
      failures.push(`${label}: wall correction ${maximumWallCorrection.toFixed(3)} m`);
    }
    if (maximumLaneError > 1) failures.push(`${label}: lane error ${maximumLaneError.toFixed(2)} m`);
    const expectedOwners = transition.type === 'diverge'
      ? [transition.hostRouteId, transition.branchRouteId]
      : [transition.branchRouteId, transition.hostRouteId];
    if (ownershipSequence.join(',') !== expectedOwners.join(',')) {
      failures.push(`${label}: ownership ${ownershipSequence.join(' -> ') || 'none'}`);
    }

    console.log(
      `${label} ${reached ? 'PASS-CANDIDATE' : 'FAIL-CANDIDATE'} `
      + `drive=${(lastDistance - start).toFixed(1)}m laneError=${maximumLaneError.toFixed(2)}m `
      + `collisions=${collisionEvents} correction=${maximumWallCorrection.toFixed(3)}m `
      + `owners=${ownershipSequence.join(' -> ') || 'none'}`,
    );
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`PROGRESSIVE MERGE DRIVE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('PROGRESSIVE MERGE DRIVE: PASS');
}
