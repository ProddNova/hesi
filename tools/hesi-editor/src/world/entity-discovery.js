import * as THREE from 'three';
import { chunkId, compareChunkKeys, deterministicEntityId, stableIndex, stableSlug } from './stable-id.js';
import { boxForInstance, boxForObject, instanceWorldMatrix, objectRenderMetadata, sourceTransform } from './world-metadata.js';

const MATERIAL_CLASS = Object.freeze({
  road: ['Roads', 'road-surface', 'Road surface'],
  roadAlt: ['Roads', 'road-surface', 'Alternate road surface'],
  roadService: ['Roads', 'service-road-surface', 'Service road surface'],
  marking: ['Road Markings', 'road-marking-batch', 'Road markings'],
  amber: ['Road Markings', 'amber-marking-batch', 'Amber road markings'],
  barrier: ['Barriers', 'barrier-batch', 'Concrete barriers'],
  railMetal: ['Guardrails', 'guardrail-batch', 'Metal guardrails'],
  fence: ['Barriers', 'fence-batch', 'Safety fence'],
  tunnelWall: ['Tunnels', 'tunnel-structure', 'Tunnel walls'],
  tunnelDark: ['Tunnels', 'tunnel-structure', 'Tunnel interior'],
  portal: ['Tunnels', 'tunnel-portal-batch', 'Tunnel portals'],
  // One per building type (js/building-types.js); the facade* fallback in
  // classifyMaterial covers any type added without touching this table.
  facadeShop: ['Buildings', 'building-batch', 'Shop rows'],
  facadeApartment: ['Buildings', 'building-batch', 'Apartment blocks'],
  facadeDark: ['Buildings', 'building-batch', 'Dark blocks'],
  facadeOffice: ['Buildings', 'building-batch', 'Office blocks'],
  facadeHotel: ['Buildings', 'building-batch', 'Hotel slabs'],
  facadeSlim: ['Buildings', 'building-batch', 'Slim towers'],
  facadeTower: ['Buildings', 'building-batch', 'Office towers'],
  facadeSky: ['Buildings', 'building-batch', 'Skyscrapers'],
  facadeIndustrial: ['Buildings', 'building-batch', 'Warehouses'],
  facadeDepot: ['Buildings', 'building-batch', 'Depot sheds'],
  building: ['Buildings', 'building-roof-batch', 'Building roofs'],
  ground: ['Terrain', 'terrain-batch', 'Ground terrain'],
  water: ['Terrain', 'water', 'Tokyo Bay water'],
  signGreen: ['Signs', 'route-sign', 'Route sign'],
  signBack: ['Signs', 'route-sign-structure', 'Route sign structure'],
  garage: ['Garage', 'garage-structure', 'Garage structure'],
});

function materialKeyFromName(name) {
  const match = String(name).match(/^chunk\s+[^ ]+\s+(.+)$/);
  return match?.[1] || 'unknown';
}

function classifyMaterial(materialKey) {
  if (MATERIAL_CLASS[materialKey]) return MATERIAL_CLASS[materialKey];
  if (materialKey.startsWith('facade')) return ['Buildings', 'building-batch', 'Generated buildings'];
  if (materialKey.includes('lamp') || materialKey.includes('lightPool') || materialKey.includes('lightStreak')) return ['Lamps', 'lamp-effect-batch', 'Lamp effects'];
  if (materialKey.includes('mark')) return ['Road Markings', 'road-marking-batch', 'Road markings'];
  if (materialKey.includes('tunnel')) return ['Tunnels', 'tunnel-fixture-batch', 'Tunnel fixtures'];
  return ['Props', 'generated-prop-batch', 'Generated props'];
}

function classifyDirect(object, materialKey) {
  const name = object.name || object.type;
  const lower = name.toLowerCase();
  if (object.isLight) return ['Lighting', 'world-light', name];
  if (lower.includes('sign')) return ['Signs', 'route-sign', name];
  if (lower.includes('garage') || lower.includes('refuel') || lower.includes(' pa ') || lower.endsWith(' deck')) return ['Garage', 'service-area-structure', name];
  if (lower.includes('terrain') || lower.includes('ground') || lower.includes('tokyo bay')) return ['Terrain', 'terrain-region', name];
  if (lower.includes('tower')) return ['Buildings', 'landmark-building', name];
  if (lower.includes('ferris')) return ['Props', 'landmark-prop', name];
  const classified = classifyMaterial(materialKey);
  return [classified[0], classified[1], name || classified[2]];
}

function pickRecord(index, object) {
  if (!index.has(object)) index.set(object, { instances: new Map(), fallback: null });
  return index.get(object);
}

function registerPick(index, object, entity, instanceIndex = null) {
  if (!object) return;
  const record = pickRecord(index, object);
  if (Number.isInteger(instanceIndex)) record.instances.set(instanceIndex, entity);
  else record.fallback = entity;
}

function routeContext(map, position, maxDistance = 800) {
  // Far from every route bucket, getNearestRoute falls back to a full scan
  // of every polyline — with tens of thousands of individual instances that
  // fallback dominates discovery time, so skip the lookup outright there.
  if (typeof map._candidateRoutes === 'function' && map._candidateRoutes(position).size === 0) {
    return { routeId: null, routeName: null, routeDistance: null, worldDistance: null };
  }
  const nearest = map.getNearestRoute?.(position, { maxDistance });
  if (!nearest) return { routeId: null, routeName: null, routeDistance: null, worldDistance: null };
  return {
    routeId: nearest.route.id,
    routeName: nearest.route.name,
    routeDistance: nearest.distance,
    worldDistance: nearest.worldDistance,
  };
}

function makeInstanceProxy(mesh, instanceIndex, name) {
  const matrix = instanceWorldMatrix(mesh, instanceIndex);
  const proxy = new THREE.Object3D();
  matrix.decompose(proxy.position, proxy.quaternion, proxy.scale);
  proxy.name = name;
  proxy.userData.editorInstanceProxy = true;
  proxy.userData.editorHelper = true;
  proxy.updateMatrixWorld(true);
  return proxy;
}

function instanceKind(type, proxy) {
  const [geometry, material] = type.split(':');
  if (geometry === 'lamppost') return { individual: true, kind: 'lamp', layer: 'Lamps', type: 'highway-lamp', label: 'Highway lamp' };
  if (material === 'garage') return { individual: true, kind: 'garage', layer: 'Garage', type: 'garage-structure', label: 'Garage structure' };
  if (material === 'vending' || material === 'konbini' || material === 'canopy') return { individual: true, kind: 'prop', layer: 'Props', type: 'service-area-prop', label: 'Service-area prop' };
  const pillarShape = geometry === 'box' && proxy.scale.y > 4 && proxy.scale.x < 6 && proxy.scale.z < 6;
  if ((material === 'concreteDark' || material === 'concrete') && pillarShape) {
    return { individual: true, kind: 'pillar', layer: 'Pillars', type: 'structural-support', label: 'Concrete support' };
  }
  // Every instanced piece is exposed as its own editable entity — no more
  // per-chunk "instance batch" groups: each barrier block, marking line,
  // rail, sign and prop can be selected and moved on its own. Lamp glow
  // components stay aliased to their lamppost so a lamp still moves as one
  // physical asset.
  if (material === 'barrier' || material === 'fence') return { individual: true, kind: 'barrier', layer: 'Barriers', type: 'barrier-piece', label: 'Barrier piece' };
  if (material === 'marking' || material === 'amber') return { individual: true, kind: 'marking', layer: 'Road Markings', type: 'marking-line', label: 'Marking line' };
  if (material === 'railMetal' || geometry === 'jetfan' || material.includes('tunnel')) return { individual: true, kind: 'tunnel', layer: 'Tunnels', type: 'tunnel-fixture', label: 'Tunnel fixture' };
  if (material === 'exitGreen' || material === 'chevron') return { individual: true, kind: 'sign', layer: 'Signs', type: 'sign-fixture', label: 'Sign fixture' };
  if (material === 'lampSodium' || material === 'lightPool' || material === 'lightStreak') return { individual: false, aliasLamp: true, kind: 'lamp', layer: 'Lamps', type: 'lamp-component-batch', label: 'Lamp components' };
  return { individual: true, kind: 'prop', layer: 'Props', type: 'prop-piece', label: 'Prop' };
}

export function discoverHesiEntities(map) {
  const entities = [];
  const pickIndex = new WeakMap();
  const counters = new Map();
  const routeEntities = new Map();
  const add = (entity) => { entities.push(entity); return entity; };
  const nextIndex = (key) => {
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return next;
  };

  for (const [groupId, group] of [...map.groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    add({
      id: `road-group:${stableSlug(groupId)}`,
      name: group.name || groupId,
      type: 'route-group', layer: 'Roads', object3D: null, source: 'data/routes-smoothed.json',
      editable: false, generated: true, assetId: null, parentId: null,
      metadata: { groupId, static: true, semanticOnly: true, sourceKind: 'PROCEDURAL RULE' },
    });
  }

  for (const route of [...map.routes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = `road:${stableSlug(route.id)}`;
    const entity = add({
      id, name: `${route.code ? `${route.code} · ` : ''}${route.name}`, type: route.kind === 'service' ? 'service-route' : 'road-route',
      layer: 'Roads', object3D: null,
      source: route.synthetic ? 'js/map.js:runtime synthetic route' : 'data/routes-smoothed.json', editable: true, generated: true,
      assetId: null, parentId: route.group ? `road-group:${stableSlug(route.group)}` : null,
      metadata: {
        routeId: route.id, routeName: route.name, groupId: route.group || null, code: route.code || null,
        kind: route.kind, lanes: route.lanes, laneWidth: route.laneWidth, speedLimit: route.speedLimit,
        runtimeSynthetic: Boolean(route.synthetic),
        lengthMetres: route.length, closed: route.closed, static: true, semanticOnly: true,
        collisionAvailable: true, collisionSource: 'HighwayMap analytic route corridor', collisionType: 'analytic swept corridor',
        sourceKind: 'PROCEDURAL RULE',
      },
    });
    routeEntities.set(route.id, entity);
  }

  const wallsByRoute = new Map();
  for (const wall of map.wallSegments || []) {
    if (!wallsByRoute.has(wall.routeId)) wallsByRoute.set(wall.routeId, []);
    wallsByRoute.get(wall.routeId).push(wall);
  }
  for (const [routeId, walls] of [...wallsByRoute.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
    const route = map.routes.get(routeId);
    add({
      id: `guardrail:${stableSlug(routeId)}`, name: `${route?.name || routeId} guardrail metadata`, type: 'analytic-guardrail-system',
      layer: 'Guardrails', object3D: null, source: 'js/map.js:wallSegments', editable: false, generated: true,
      assetId: null, parentId: routeEntities.get(routeId)?.id || null,
      metadata: { routeId, segmentCount: walls.length, static: true, semanticOnly: true, collisionAvailable: true, collisionSource: 'HighwayMap.wallSegments', collisionType: 'analytic wall segments', sourceKind: 'PROCEDURAL RULE' },
    });
    add({
      id: `collision:${stableSlug(routeId)}`, name: `${route?.name || routeId} analytic collision`, type: 'analytic-route-collision',
      layer: 'Collisions', object3D: null, source: 'js/map.js:corridor union + wallSegments', editable: false, generated: true,
      assetId: null, parentId: routeEntities.get(routeId)?.id || null,
      metadata: { routeId, wallSegmentCount: walls.length, static: true, semanticOnly: true, collisionAvailable: true, collisionSource: 'runtime analytic corridor and wall metadata', collisionType: 'analytic corridor', sourceKind: 'PROCEDURAL RULE' },
    });
  }

  for (const route of [...map.routes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const tunnels = route.tunnelZones || route.tunnels || [];
    tunnels.forEach((tunnel, index) => add({
      id: `tunnel:${stableSlug(route.id)}:${stableIndex(index + 1)}`,
      name: tunnel.name || `${route.name} tunnel ${index + 1}`,
      type: 'tunnel-span', layer: 'Tunnels', object3D: null, source: 'data/routes-smoothed.json + js/map.js', editable: false,
      generated: true, assetId: null, parentId: routeEntities.get(route.id)?.id || null,
      metadata: { routeId: route.id, startDistance: tunnel.start ?? tunnel[0] ?? null, endDistance: tunnel.end ?? tunnel[1] ?? null, static: true, semanticOnly: true, sourceKind: 'PROCEDURAL RULE' },
    }));
  }

  for (const area of [...(map.serviceAreas || [])].sort((a, b) => a.id.localeCompare(b.id))) {
    add({
      id: `service-area:${stableSlug(area.id)}`, name: area.name, type: area.hasGarage ? 'garage-service-area' : 'service-area',
      layer: area.hasGarage ? 'Garage' : 'Props', object3D: null, source: 'data/routes-smoothed.json:serviceAreas', editable: false,
      generated: true, assetId: null, parentId: routeEntities.get(area.routeId)?.id || null,
      metadata: { serviceAreaId: area.id, routeId: area.routeId, width: area.width, length: area.length, hasGarage: Boolean(area.hasGarage), static: true, semanticOnly: true, sourceKind: 'PROCEDURAL RULE' },
    });
  }

  const chunks = [...(map._chunks?.values?.() || [])].sort((a, b) => compareChunkKeys(a.key, b.key));
  for (const chunk of chunks) {
    const cid = chunkId(chunk.key);
    const children = chunk.group.children.map((object, originalIndex) => ({ object, originalIndex }))
      .sort((a, b) => a.object.name.localeCompare(b.object.name) || a.originalIndex - b.originalIndex);
    const lampEntities = [];
    const lampAliases = [];
    for (const { object, originalIndex } of children) {
      const materialKey = materialKeyFromName(object.name);
      if (!object.isInstancedMesh) {
        const [layer, type, label] = classifyMaterial(materialKey);
        const id = deterministicEntityId(type, `${cid}-${materialKey}-${object.name || 'unnamed'}-${originalIndex}`);
        const entity = add({
          id, name: `${label} · chunk ${chunk.key}`, type, layer, object3D: object,
          source: `js/map.js:chunk bucket:${materialKey}`, editable: ['Buildings', 'Barriers', 'Guardrails', 'Road Markings', 'Props'].includes(layer),
          generated: true, assetId: null, parentId: null, visibilityObjects: [object],
          getWorldBounds: () => boxForObject(object),
          metadata: { chunk: chunk.key, materialKey, static: true, instanced: false, sourceKind: 'PROCEDURAL RULE', render: objectRenderMetadata(object), sourceTransform: sourceTransform(object) },
        });
        registerPick(pickIndex, object, entity);
        continue;
      }

      const infoProbe = makeInstanceProxy(object, 0, object.name);
      const info = instanceKind(materialKey, infoProbe);
      if (info.aliasLamp) { lampAliases.push({ mesh: object, type: materialKey }); continue; }
      if (!info.individual) {
        const entity = add({
          id: deterministicEntityId(info.type, `${cid}-${materialKey}`), name: `${info.label} · chunk ${chunk.key} · ${object.count} instances`,
          type: info.type, layer: info.layer, object3D: object, source: `js/map.js:_instance:${materialKey}`, editable: false,
          generated: true, assetId: `hesi:${materialKey}`, parentId: null, visibilityObjects: [object],
          getWorldBounds: () => boxForObject(object),
          metadata: { chunk: chunk.key, instanceType: materialKey, instanceCount: object.count, static: true, instanced: true, sourceKind: 'PROCEDURAL RULE', render: objectRenderMetadata(object) },
        });
        registerPick(pickIndex, object, entity);
        continue;
      }

      for (let instanceIndex = 0; instanceIndex < object.count; instanceIndex += 1) {
        const proxy = makeInstanceProxy(object, instanceIndex, `${info.label} ${instanceIndex + 1}`);
        const sourceWorldMatrix = instanceWorldMatrix(object, instanceIndex).toArray();
        const route = routeContext(map, proxy.position);
        const context = route.routeId || `chunk-${cid}`;
        const counterKey = `${info.kind}:${context}`;
        const ordinal = nextIndex(counterKey);
        const id = deterministicEntityId(info.kind, context, ordinal);
        const entity = add({
          id, name: `${info.label} ${stableIndex(ordinal)}${route.routeName ? ` · ${route.routeName}` : ''}`,
          type: info.type, layer: info.layer, object3D: proxy, pickObject3D: object,
          source: `js/map.js:_instance:${materialKey}`, editable: true, generated: true,
          assetId: `hesi:${materialKey}`, parentId: routeEntities.get(route.routeId)?.id || null, visibilityObjects: [object],
          getWorldBounds: () => boxForInstance(object, instanceIndex),
          metadata: {
            routeId: route.routeId, routeName: route.routeName, routeDistance: route.routeDistance,
            distanceFromRoute: route.worldDistance, chunk: chunk.key, instanceType: materialKey,
            instanceIndex, instanceMesh: object, static: true, instanced: true, instanceEligible: true,
            sourceWorldMatrix,
            instanceComponents: [{ mesh: object, instanceIndex, sourceWorldMatrix }],
            sourceKind: 'INSTANCE', collisionAvailable: false,
            render: objectRenderMetadata(object, { instance: true, repeatedAssetCount: object.count }),
            sourceTransform: sourceTransform(proxy),
          },
        });
        registerPick(pickIndex, object, entity, instanceIndex);
        if (info.kind === 'lamp') lampEntities[instanceIndex] = entity;
      }
    }
    for (const { mesh } of lampAliases) {
      if (mesh.count !== lampEntities.length) continue;
      lampEntities.forEach((entity, instanceIndex) => {
        if (!entity) return;
        entity.visibilityObjects.push(mesh);
        entity.metadata.instanceComponents.push({
          mesh,
          instanceIndex,
          sourceWorldMatrix: instanceWorldMatrix(mesh, instanceIndex).toArray(),
        });
        registerPick(pickIndex, mesh, entity, instanceIndex);
      });
    }
  }

  const chunkGroups = new Set(chunks.map((chunk) => chunk.group));
  const direct = map.group.children.filter((object) => !chunkGroups.has(object))
    .map((object, index) => ({ object, index }))
    .sort((a, b) => a.object.name.localeCompare(b.object.name) || a.index - b.index);
  direct.forEach(({ object }, index) => {
    const materialEntry = Object.entries(map.materials || {}).find(([, material]) => material === object.material);
    const materialKey = materialEntry?.[0] || 'unknown';
    const [layer, type, label] = classifyDirect(object, materialKey);
    const entity = add({
      id: `${stableSlug(type)}:${stableSlug(object.name || materialKey)}:${stableIndex(index + 1)}`,
      name: label, type, layer, object3D: object, source: `js/map.js:direct:${object.name || materialKey}`,
      editable: !object.isLight || Boolean(object.position), generated: true, assetId: object.isMesh ? `hesi:direct:${stableSlug(object.name || materialKey)}` : null,
      parentId: null, visibilityObjects: [object], getWorldBounds: () => boxForObject(object),
      metadata: { materialKey, static: !object.isLight, instanced: false, sourceKind: object.isLight ? 'PROCEDURAL RULE' : 'INSTANCE', render: objectRenderMetadata(object), sourceTransform: object.position ? sourceTransform(object) : null },
    });
    object.traverse((child) => { if (child.isMesh || child.isLight) registerPick(pickIndex, child, entity); });
    if (object.isMesh || object.isLight) registerPick(pickIndex, object, entity);
  });

  const resolveSelection = (object, instanceId = null) => {
    let current = object;
    while (current) {
      const record = pickIndex.get(current);
      if (record) return (Number.isInteger(instanceId) ? record.instances.get(instanceId) : null) || record.fallback || null;
      current = current.parent;
    }
    return null;
  };
  const registerEditorEntity = (entity) => {
    if (!entity?.object3D) return entity;
    registerPick(pickIndex, entity.object3D, entity);
    entity.object3D.traverse?.((child) => registerPick(pickIndex, child, entity));
    return entity;
  };
  const layerCounts = Object.fromEntries(entities.reduce((counts, entity) => counts.set(entity.layer, (counts.get(entity.layer) || 0) + 1), new Map()));
  return { entities, resolveSelection, registerEditorEntity, layerCounts, pickIndex };
}
