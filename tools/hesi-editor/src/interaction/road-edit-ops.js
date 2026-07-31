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

/**
 * Moves one centreline point. A legacy [x, z] pair preserves elevation; a
 * full [x, y, z] triple edits elevation as well.
 */
export function movePoint(route, index, position) {
  const points = requirePoints(route);
  requireIndex(points, index);
  if (!Array.isArray(position) || (position.length !== 2 && position.length !== 3)) {
    throw new TypeError('movePoint position must be [x, z] or [x, y, z]');
  }
  requireFinite(position, 'movePoint position');
  const point = points[index];
  if (position.length === 3) {
    point[0] = position[0];
    point[1] = position[1];
    point[2] = position[2];
  } else {
    point[0] = position[0];
    point[2] = position[1];
  }
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

/**
 * Control-point indices whose position is DERIVED by the map generator rather
 * than authored here.
 *
 * `HighwayMap` rewrites the tail of a route anchored onto a host carriageway
 * (`_anchorEndpoint`) and publishes the stretch it owns as
 * `route.protectedSegments`: `{ span, anchor: {x, z}, reason }`. Dragging a
 * point inside that stretch does not move the road, it changes what the
 * derived alignment blends away from — so the editor locks those handles.
 *
 * A segment is located by the WORLD position of its terminal, not by an index
 * or an end name: the left-hand-traffic build reverses every route, so the
 * runtime tail is the source document's head and only geometry identifies the
 * same physical stretch in both point orders.
 *
 * Two points always stay free, so a protected span can never lock a whole
 * road out of the editor.
 */
export function protectedPointIndices(points, segments, { closed = false } = {}) {
  const locked = new Set();
  if (closed || !Array.isArray(points) || points.length < 3) return locked;
  const usable = (Array.isArray(segments) ? segments : []).filter((segment) => (
    segment && Number.isFinite(segment.span) && segment.span > 0
    && segment.anchor && Number.isFinite(segment.anchor.x) && Number.isFinite(segment.anchor.z)
  ));
  if (!usable.length) return locked;
  const arc = [0];
  for (let index = 1; index < points.length; index += 1) {
    arc.push(arc[index - 1] + Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][2] - points[index - 1][2],
    ));
  }
  const total = arc[arc.length - 1];
  for (const segment of usable) {
    const gap = (point) => Math.hypot(point[0] - segment.anchor.x, point[2] - segment.anchor.z);
    const fromHead = gap(points[0]) <= gap(points[points.length - 1]);
    for (let index = 0; index < points.length; index += 1) {
      const fromTerminal = fromHead ? arc[index] : total - arc[index];
      if (fromTerminal <= segment.span) locked.add(index);
    }
  }
  if (locked.size > points.length - 2) return new Set();
  return locked;
}
