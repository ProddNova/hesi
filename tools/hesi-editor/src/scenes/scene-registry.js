/**
 * Editable scenes known to the HESI editor.
 *
 * `highway` is the real production HighwayMap; `garage` is the in-game garage
 * interior (js/garage.js) so it can be dressed and edited too. Each scene owns
 * its project file and its built-map output file under data/editor/.
 */
export const SCENES = Object.freeze({
  highway: Object.freeze({
    id: 'highway',
    label: 'Highway',
    description: 'Real Shutoko expressway map (production HighwayMap)',
    projectPath: 'data/editor/hesi-world-project.json',
    buildPath: 'data/editor/hesi-world-build.json',
    projectName: 'HESI Main World',
  }),
  garage: Object.freeze({
    id: 'garage',
    label: 'Garage',
    description: 'Wangan Works garage interior (js/garage.js)',
    projectPath: 'data/editor/garage-project.json',
    buildPath: 'data/editor/garage-build.json',
    projectName: 'HESI Garage Interior',
  }),
  tatsumi_pa: Object.freeze({
    id: 'tatsumi_pa',
    label: 'Tatsumi PA',
    description: 'Tatsumi No.1 PA walkable lot behind the lay-by gate (js/tatsumi-pa.js)',
    projectPath: 'data/editor/tatsumi-pa-project.json',
    buildPath: 'data/editor/tatsumi-pa-build.json',
    projectName: 'HESI Tatsumi PA',
  }),
});

/** Scenes whose entities are direct root children addressed by build index. */
export const CHILD_INDEXED_SCENE_IDS = Object.freeze(['garage', 'tatsumi_pa']);

export function isChildIndexedScene(id) {
  return CHILD_INDEXED_SCENE_IDS.includes(id);
}

export const DEFAULT_SCENE_ID = 'highway';

export function getScene(id) {
  return SCENES[id] || null;
}

export function sceneFromSearch(search) {
  const requested = new URLSearchParams(search || '').get('scene');
  return SCENES[requested] || SCENES[DEFAULT_SCENE_ID];
}

export function sceneList() {
  return Object.values(SCENES);
}
