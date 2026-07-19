/**
 * Road centreline editing operations.
 *
 * Pure, dependency-free functions that mutate a route object's `points`
 * array of [x, y, z] triples (XZ plan + elevation Y). Shared by the editor's
 * road curve edit mode and unit tests; nothing here imports three.js or
 * touches the DOM so it can run under plain node:test.
 */

function requirePoints(route) {
  if (!route || !Array.isArray(route.points)) throw new TypeError('route.points must be an array');
  return route.points;
}

function requireIndex(points, index) {
  if (!Number.isInteger(index) || index < 0 || index >= points.length) {
    throw new RangeError(`Point index ${index} is out of range (0-${points.length - 1})`);
  }
}

function requireFinite(values, label) {
  if (!values.every(Number.isFinite)) throw new TypeError(`${label} must contain only finite numbers`);
}

/** Finds the route object with the given id inside a routes-smoothed document. */
export function findRoute(routeData, routeId) {
  return routeData?.routes?.find((route) => route.id === routeId) || null;
}

/** Moves one centreline point in the XZ plane; the elevation (y) is preserved. */
export function movePoint(route, index, [x, z]) {
  const points = requirePoints(route);
  requireIndex(points, index);
  requireFinite([x, z], 'movePoint position');
  const point = points[index];
  point[0] = x;
  point[2] = z;
  return point;
}

/**
 * Inserts a new [x, y, z] point after `index`. Passing the last index appends
 * to the end of the polyline. Returns the inserted point.
 */
export function insertPointAfter(route, index, [x, y, z]) {
  const points = requirePoints(route);
  requireIndex(points, index);
  requireFinite([x, y, z], 'insertPointAfter point');
  const point = [x, y, z];
  points.splice(index + 1, 0, point);
  return point;
}

/**
 * Removes the point at `index`. A centreline needs at least two points, so
 * the call refuses (returns false) instead of shortening a 2-point route.
 */
export function deletePoint(route, index) {
  const points = requirePoints(route);
  requireIndex(points, index);
  if (points.length <= 2) return false;
  points.splice(index, 1);
  return true;
}

/**
 * Finds the polyline segment whose projection is closest to (x, z) in the XZ
 * plane. Returns { index, point, distance } where `point` is the projected
 * [x, y, z] position on that segment with y interpolated linearly between the
 * segment endpoints, or null when the polyline has fewer than two points.
 */
export function nearestSegment(points, x, z) {
  if (!Array.isArray(points) || points.length < 2) return null;
  requireFinite([x, z], 'nearestSegment query');
  let best = null;
  let bestDistanceSq = Infinity;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const lengthSq = abx * abx + abz * abz;
    const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((x - a[0]) * abx + (z - a[2]) * abz) / lengthSq));
    const px = a[0] + abx * t;
    const pz = a[2] + abz * t;
    const dx = x - px;
    const dz = z - pz;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = { index, point: [px, a[1] + (b[1] - a[1]) * t, pz], distance: Math.sqrt(distanceSq) };
    }
  }
  return best;
}
