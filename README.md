# SHUTOKO NIGHTS

A procedural, browser-based PSX night-highway driving game. No downloaded game assets and no build step.

## Start

Run `start-game.bat`, or start any static file server in this folder and open `http://localhost:8080`.

The game uses Three.js from a CDN. Once loaded over HTTPS, the service worker keeps the game files available for repeat visits and limited offline use.

## Deploy on Render

1. Put this folder in a GitHub or GitLab repository.
2. In Render choose **New > Blueprint** and select that repository.
3. Render reads `render.yaml` and publishes the current folder as a static site. No build command or server is required.

You can also create a **Static Site** manually with an empty build command and `.` as the publish directory. Render provides HTTPS automatically, which enables the installable web-app mode and service worker.

## Controls

- Drive: WASD or arrow keys
- Shift: Shift/E up, Ctrl/Q down
- Handbrake: Space
- Camera: C
- Phone: F
- Recover: R
- Garage: WASD + mouse, E interact, Esc release pointer/exit screens
- Diagnostics: `I` toggles the performance HUD, `P` starts/stops a structured recording (JSON download + clipboard summary), and `O` adds a manual marker
- Mobile driving: on-screen steering, pedals, handbrake, camera, gears, phone and reset
- Mobile garage: on-screen movement, drag the right side to look, USE to interact
- Admin unlock: enter `1997` in the phone Admin app

Progress is stored in localStorage.
