#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const input = process.argv[2];
if (!input || input === '--help' || input === '-h') {
  console.log('Usage: npm run diagnostics:analyze -- <hesi-diagnostic-*.json>');
  process.exit(input ? 0 : 1);
}

const path = resolve(input);
let report;
try {
  report = JSON.parse(await readFile(path, 'utf8'));
} catch (error) {
  console.error(`Could not read diagnostic report: ${error.message}`);
  process.exit(1);
}

if (report?.schema !== 'hesi.diagnostic-recording' || !report?.summary) {
  console.error('Unsupported file: expected a hesi.diagnostic-recording report.');
  process.exit(1);
}

const summary = report.summary;
const pacing = summary.frame_pacing;
const cpu = pacing.cpu_ms;
const subsystems = cpu.subsystems_average || {};
const environment = report.environment || {};
const game = report.game || {};
const eventCounts = summary.events || {};
const timelineColumns = report.timeline_columns || [];
const timelineIndex = Object.fromEntries(timelineColumns.map((name, index) => [name, index]));
const cell = (row, name) => row?.[timelineIndex[name]];
const value = (item, fallback = 'n/a') => item == null ? fallback : item;
const percent = (part, total) => total > 0 ? `${(part / total * 100).toFixed(1)}%` : '0.0%';
const tableSafe = (item) => String(value(item)).replaceAll('|', '\\|').replaceAll('\n', ' ');

const lines = [];
const add = (...items) => lines.push(...items);
const table = (headers, rows) => {
  add(`| ${headers.join(' | ')} |`);
  add(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) add(`| ${row.map(tableSafe).join(' | ')} |`);
};

add(
  `# HESI diagnostic analysis — ${basename(path)}`,
  '',
  `Session **${value(report.session?.id)}**, ${value(summary.duration_s)} s, ${value(pacing.frames, 0)} frames and ${value(summary.samples, 0)} timeline samples.`,
  '',
  `Device: **${value(environment.webgl?.gpu)}**; canvas ${value(environment.display?.canvas_internal)}; DPR ${value(environment.display?.device_pixel_ratio)}; quality ${value(report.initial_state?.quality)}.`,
  `Vehicle: **${value(game.vehicle?.name, game.vehicle?.id)}** (${value(game.vehicle?.power_hp)} hp, ${value(game.vehicle?.mass_kg)} kg); traffic density ${value(game.runtime_tuning?.traffic_density, 1)}.`,
  '',
  '## Executive signals',
  '',
);

for (const finding of summary.findings || []) {
  add(`- **${String(finding.severity || 'info').toUpperCase()} — ${finding.signal}:** ${finding.evidence}`);
}

add(
  '',
  '## Frame pacing',
  '',
);
table(
  ['Average FPS', 'Frame avg', 'p50', 'p95', 'p99', 'p99.9', 'Worst'],
  [[
    pacing.fps_average,
    `${pacing.frame_ms.average} ms`,
    `${pacing.frame_ms.p50} ms`,
    `${pacing.frame_ms.p95} ms`,
    `${pacing.frame_ms.p99} ms`,
    `${pacing.frame_ms.p99_9} ms`,
    `${pacing.frame_ms.max} ms`,
  ]],
);

add('');
table(
  ['>25 ms', '>33 ms', '>50 ms', '>100 ms', '>250 ms', 'Time beyond 16.67 ms'],
  [[
    pacing.slow_frames.over_25ms,
    `${pacing.slow_frames.over_33ms} (${pacing.slow_frames.percent_over_33ms}%)`,
    pacing.slow_frames.over_50ms,
    pacing.slow_frames.over_100ms,
    pacing.slow_frames.over_250ms,
    `${pacing.slow_frames.excess_time_over_16_67ms} ms`,
  ]],
);

add(
  '',
  '## CPU attribution',
  '',
  `Profiled CPU averages **${cpu.average} ms/frame**; the unprofiled rAF/vsync/GPU/OS gap averages **${cpu.raf_gap_average} ms/frame**.`,
  '',
);
table(
  ['Subsystem', 'Average ms/frame', 'Share of profiled CPU'],
  Object.entries(subsystems)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .map(([name, milliseconds]) => [name, milliseconds, percent(milliseconds, cpu.average)]),
);

add(
  '',
  '## Memory and browser stalls',
  '',
);
table(
  ['Heap start', 'Heap end', 'Heap peak', 'Heap growth', 'Long Tasks', 'Longest task'],
  [[
    `${value(summary.memory?.heap_start_mb)} MB`,
    `${value(summary.memory?.heap_end_mb)} MB`,
    `${value(summary.memory?.heap_peak_mb)} MB`,
    `${value(summary.memory?.heap_growth_mb)} MB`,
    `${value(summary.browser_long_tasks?.count, 0)} / ${value(summary.browser_long_tasks?.total_ms, 0)} ms`,
    `${value(summary.browser_long_tasks?.max_ms, 0)} ms`,
  ]],
);
add(
  '',
  `Renderer additions: \`${JSON.stringify(summary.memory?.renderer_resource_additions || {})}\`; removals: \`${JSON.stringify(summary.memory?.renderer_resource_removals || {})}\`.`,
);

const routes = (summary.routes || []).filter((route) => route.id !== 'unknown').slice(0, 12);
if (routes.length) {
  add('', '## Routes ranked by p95', '');
  table(
    ['Route', 'Frames', 'FPS', 'p95', 'p99', 'Worst', '>50 ms'],
    routes.map((route) => [
      route.id,
      route.frames,
      route.fps_average,
      `${route.frame_ms.p95} ms`,
      `${route.frame_ms.p99} ms`,
      `${route.frame_ms.max} ms`,
      route.slow_frames.over_50ms,
    ]),
  );
}

const worst = summary.worst_windows || [];
if (worst.length) {
  add('', '## Worst sampled windows', '');
  table(
    ['t', 'Route / position', 'Frame max', 'CPU max', 'Physics', 'Traffic', 'Map', 'Render', 'Save', 'Other', 'GPU Δ'],
    worst.slice(0, 12).map((row) => [
      `${row.time_s}s`,
      `${value(row.route_id)} @ ${value(row.pos_x)}, ${value(row.pos_z)}`,
      `${value(row.frame_ms_max)} ms`,
      `${value(row.cpu_ms_max)} ms`,
      value(row.worst_phys_ms),
      value(row.worst_traffic_ms),
      value(row.worst_map_ms),
      value(row.worst_render_ms),
      value(row.worst_save_ms),
      value(row.worst_other_ms),
      `${value(row.d_geometries, 0)}/${value(row.d_textures, 0)}/${value(row.d_programs, 0)}`,
    ]),
  );
}

const events = report.events || [];
if (events.length) {
  add('', '## Recorded events', '', `Counts: ${Object.entries(eventCounts).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}.`);
  const notable = events.filter((event) => [
    'manual_marker', 'collision', 'near_miss', 'recovery', 'run_wasted',
    'window_error', 'unhandled_rejection', 'resource_error',
  ].includes(event.type)).slice(0, 30);
  if (notable.length) {
    add('');
    table(
      ['t', 'Event', 'Route / position', 'Details'],
      notable.map((event) => [
        `${event.time_s}s`,
        event.type,
        `${value(event.context?.route_id)} @ ${value(event.context?.pos_x)}, ${value(event.context?.pos_z)}`,
        JSON.stringify(event.data || {}),
      ]),
    );
  }
}

// Use the raw timeline to identify sustained bad windows, not just isolated
// maxima. This is deliberately separate from the recorder's own summary.
const sustained = (report.timeline || [])
  .filter((row) => Number(cell(row, 'frame_ms_p95')) >= 25)
  .sort((a, b) => Number(cell(b, 'frame_ms_p95')) - Number(cell(a, 'frame_ms_p95')))
  .slice(0, 10);
if (sustained.length) {
  add('', '## Sustained slow windows', '');
  table(
    ['t', 'Route / position', 'p95', 'Average', 'FPS', 'Speed', 'Traffic', 'Draw calls', 'Heap'],
    sustained.map((row) => [
      `${cell(row, 'time_s')}s`,
      `${value(cell(row, 'route_id'))} @ ${value(cell(row, 'pos_x'))}, ${value(cell(row, 'pos_z'))}`,
      `${cell(row, 'frame_ms_p95')} ms`,
      `${cell(row, 'frame_ms_avg')} ms`,
      cell(row, 'fps'),
      `${value(cell(row, 'speed_kmh'))} km/h`,
      value(cell(row, 'traffic_active')),
      value(cell(row, 'draw_calls')),
      `${value(cell(row, 'heap_used_mb'))} MB`,
    ]),
  );
}

add(
  '',
  '## Interpretation guardrails',
  '',
  '- High profiled CPU time points to the named game-loop subsystem; compare it with the same row’s worst-frame breakdown.',
  '- A high `raf_gap` with low profiled CPU is not automatically a render bug: it can include vsync, GPU/driver waits, browser throttling, or OS contention.',
  '- Positive geometry/texture/program deltas during driving are strong evidence of lazy uploads, content streaming, or shader compilation.',
  '- Correlate repeated route and position clusters before optimizing a one-off spike.',
);

console.log(lines.join('\n'));
