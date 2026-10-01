# Changelog

## 0.5.0 — 2026-10-01

Detail and interaction pass on the Server Rack and Orbital Mechanics, plus performance scaling.

### Added

- **Server Rack hardware**: four server types with different front panels (compute with drive bays and vent, storage with bays across, GPU with fan grilles and accent strip, blade with vertical sleds). Each cabinet also carries a patch panel, switch with link LEDs, firewall, 2U UPS, 1U PDU and (full view) a storage shelf. Colored patch leads run up the right rail to the switch, blue management leads down the left, and jumpers loop from patch panel to switch. Casters, rail mounting holes, a roof router, a perforated mesh door, raised-floor tiles with cold-air grates, a room cooling unit that follows the Cooling control, a crash cart, spare servers and an extinguisher.
- **Server Rack interaction**: hover outlines a server; click pulls it out on its rails and shows its state, temperature and jobs; click again pushes it back. `Power Selected` switches the pulled-out server off or on (its jobs return to the queue). Clicking a crashed server restarts it. Clicking the door swings it.
- **Orbital Mechanics detail**: animated shader surface and pulsing corona on the star, procedurally textured planets with axial tilt and spin, atmospheres, ringed gas giants, fading trails, dashed reference orbits, an asteroid belt of test particles on Keplerian orbits, a gravity-well grid that bends toward every mass, comet tails that point away from the star, and a drifting layered starfield. New `Gravity Well` toggle and `Fastest Planet` stat.
- **Dynamic resolution**: the stage lowers the render scale when the frame rate stays under 48 FPS and raises it again when there is headroom. The debug overlay shows the current render scale.
- **Low-spec profile** for phones, tablets and machines with few cores or little memory: no shadows, no multisampling, a lower resolution ceiling, and lighter worlds.
- `three/merge.ts`: collapses static meshes into one mesh per material. Applied to the rack.
- Render-time extrapolation for dyno wheels, rollers and fan, and for orbital bodies, so they move smoothly on displays faster than 60 Hz.

### Fixed

- **Orbital**: the system no longer drifts out of view. The star now starts with the recoil that cancels the planets' momentum.
- **Orbital**: comets could pass through the star and be flung out with a large energy gain. They now launch on a Kepler ellipse with a perihelion outside the star, relative to the star's current position and velocity.
- **Orbital**: stepping is now adaptive across every pair of bodies, so close passes get finer steps.
- **Rack**: exhaust streaks were drawn offset from the cabinets (rack offset applied twice).
- **Rack**: roof fans kept spinning while paused and ran faster on high-refresh displays; they now advance in the simulation step.
- **Rack**: the wall display was hidden behind the cabinets; it now sits above them.

### Changed

- `spec.md` is no longer tracked; it stays local.
- Only the end cabinet has a door. A door between two cabinets hid its neighbour from the camera.
- Rack power is now a toolbar action rather than a second click.

### Verified

- Type check, 40 unit tests and the production build pass. New tests: operator power switch on the rack, comet perihelion and energy.
- In the browser: rack renders with all hardware; select, power off, and push-back clicks behave as described; draw calls for the rack fell from 962 to 560 after merging. Orbital renders and stays bound through a comet pass (total energy stays negative).

### Not verified

- Dynamic resolution and the low-spec profile on real low-end hardware. The logic is in place but was not exercised on a slow device, and the test browser pane throttles frames.
- Smoothness on a 120 Hz display.
- Rack hover outline, door click, and the homepage previews of the rack and orbital after these changes.
- Open Graph images were not regenerated; the rack and orbital images show the earlier visuals.

## 0.4.0 — 2026-10-01

Closes the last open item from the spec's Definition of Done: Open Graph images (§51).

### Added

- Open Graph and Twitter card images for every route, committed under `public/og/` as real 1200×630 screenshots of each simulation. `scripts/og.mjs` (run as `pnpm og`) drives headless Chromium over a preview build, lets each world run a few seconds, and captures its board; this doubles as the first in-browser render check of the Server Rack and Orbital Mechanics scenes, both confirmed drawing correctly (planets, trails and star for orbital; heat-glow servers, exhaust fans and the power-vs-cap wall graph for rack).
- `og:image`, `og:image:width/height`, `og:site_name`, `og:url` and the full `twitter:*` card set in `index.html`. The build's route-shell step now rewrites `og:image`, `twitter:image` and `og:url` per route from the registry, and `usePageMeta` keeps the share image in sync client-side. Set `SITE_URL` before `pnpm build` to emit absolute image URLs for unfurlers.
- Playwright as a dev dependency and an `og` npm script.

### Verified

- Type check, all 38 unit tests and the production build pass.
- Every route shell contains its own `og:image`/`twitter:image`/`og:url`; all seven boards render real content (100–219 kB) and were eyeballed — no blank canvases.
- `dist/og/` is populated by the build from `public/og/`.

### Notes

- Audio remains deferred by the spec (§31); simulations still only emit named events. Easter eggs (§50) are explicitly post-V1 and out of the Definition of Done. With Open Graph images in place, every in-scope §60 item is now met.

## 0.3.0 — 2026-10-01

Adds a sixth world: a physics simulation to sit alongside the mechanical and systems ones.

### Added

- **Orbital Mechanics**: a star and its planets under Newtonian gravity. Every body attracts every other (all-pairs), and the state advances with velocity Verlet — a symplectic integrator that conserves energy over long runs, so orbits keep their shape instead of spiralling in or out. A planet launched at the circular speed √(G·M/r) holds its radius; planets trace Kepler ellipses while perturbing one another. The gravitational constant is a live control, `Launch Comet` drops an eccentric body in from the edge, and Total Energy and Angular Momentum are shown as stats precisely because they stay put. Rendered on a seeded starfield with the star as the scene's own point light and a fading trail behind each body.
- 7 unit tests on `OrbitalSystem`: circular launch speed, a circular orbit holding its radius over many revolutions, Kepler's third law (T² ∝ a³) across two radii, energy conservation and angular-momentum conservation over long integrations, gravity actually pulling an at-rest body inward, and same-seed reproducibility. Suite is now 38 tests.

### Changed

- The homepage grid is now three full rows of six columns: gears + heat, rolling road + factory, server rack + orbital (the rack card moved from full width to a half).

### Verified

- Type check, all 38 unit tests and the production build pass.
- `OrbitalSimulation` ships as its own lazily loaded chunk; the `/simulations/orbital` route shell is written with its own title and description.

### Not verified

- In-browser rendering and playback of the orbital scene: the physics is tested, but the Three.js scene, trails, starfield, the live gravity control, `Launch Comet` and the homepage preview were not opened in a real browser in this change.
- Long-run visual stability at high Time Scale (the integrator substeps to keep each step ≤ 1/60 s, but this was checked numerically, not watched).

## 0.2.0 — 2026-10-01

Adds the fifth world named in 0.1.0's "Next".

### Added

- **Server Rack**: a datacenter rack behind a workload scheduler. Jobs arrive into one queue; a least-loaded scheduler places each on the coolest node with a free slot, but only while the rack stays under its PDU budget. Busy nodes heat up on an explicit thermal model, hot nodes throttle (doing less work, drawing less power, cooling themselves), and a node past its critical temperature crashes and returns its work to the queue. Power, heat and failure each back the queue up, and an overflowing backlog sheds load. Rendered as one or two cabinets of 1U servers with per-node status lamps, heat glow, activity flicker, roof exhaust fans, rising hot-air streaks and a wall monitor graphing rack power against the PDU cap. `Traffic Burst` injects a spike; a click restarts a crashed node.
- 9 unit tests on `RackLogic`: job conservation across arrivals, predicted steady-state temperature under held load, the PDU budget never being exceeded, load shedding on backlog overflow, overheating with and without cooling, crash/requeue/reboot, and same-seed reproducibility with failures on. Suite is now 31 tests.

### Verified

- Type check, all 31 unit tests and the production build pass.
- `RackSimulation` ships as its own lazily loaded chunk; the `/simulations/rack` route shell is written with its own title and description.
- The homepage grid stays a full 6-column bento (the new card is the trailing full-width row).

### Not verified

- In-browser rendering and playback of the rack: the logic is tested, but the Three.js scene, the wall-display canvas graph, click-to-restart and the homepage preview were not opened in a real browser in this change.
- Resource counts after repeated open/close navigation were not re-measured with the fifth simulation present.

## 0.1.0 — 2026-10-01

First version. Four simulations, a live homepage grid and a shared full-screen viewer.

### Added

**Engine**
- One `WebGLRenderer` and one animation loop for the whole app (`three/Stage.ts`). Homepage cards and the viewer are scissored regions of a single canvas.
- `Simulation` contract and `BaseSimulation`: seeded RNG, lighting rig, shared reflection environment, camera fitting, rebuild on reset, disposal.
- Fixed 1/60 s timestep with clamped frame delta and render interpolation.
- Registry-driven UI: grid, routes, control panel and statistics panel are generated from `data/simulationMeta.ts`. Each simulation loads as its own chunk.

**Simulations**
- **Gear System**: seeded gear tree with shared module, exact centre distances, counter-rotation at tooth-count ratios, solved tooth phase.
- **Heat Grid**: CPU diffusion with cooling and held sources, float texture, displacement and color shader with isotherms, paint and erase by pointer, wandering emitters, resolution change that keeps the field.
- **Rolling Road**: seeded vehicle on a chassis dynamometer. Torque curve, automatic gearbox, tyre slip against rollers, road load, drive-cycle driver, power run. Detailed procedural car, airflow streaks, tyre smoke, live speed graph on a wall display.
- **Factory Production**: two lanes, six machine types, per-product state, backpressure, seeded machine failures with click-to-repair, pallets that fill.

**Application**
- Routes: `/`, `/simulations`, `/simulations/:id`, `/about`, not-found.
- Viewer: pause, reset, randomize, reset camera, fullscreen, copy link, orbit/pan/zoom, alerts, keyboard shortcuts, debug overlay (`D` or `?debug=true`).
- Seed in the URL; a link reproduces a world.
- Loading and error states per card and per viewer.
- Visit counter in the footer using the shared views service (one hit per session, none on localhost or for bots).
- Build step that writes one HTML shell per route with its own title and description.
- 22 unit tests on simulation logic, including same-seed reproducibility for gears, factory and dyno.

### Changed from the original spec

- Racing was replaced by Rolling Road. Racing read as a game rather than a lab system.
- The factory preview runs one full lane (six machines) instead of three machines.
- Audio, easter eggs and analytics beyond the visit counter are deferred.

### Verified

- Type check, unit tests and production build pass.
- All four simulations render and advance on the homepage and in the viewer (desktop and a 375 px viewport), with no console errors in the final state.
- Heat painting by pointer drag works.
- After 12 open/close navigations, geometry and texture counts return to the homepage baseline and one canvas exists.

### Not verified

- Smooth real-time playback. The test browser pane throttles animation frames, so simulations were advanced with a stepped loop rather than watched at 60 FPS. Frame rate on real hardware is unmeasured.
- Shader program count rose from 9 to 17 across the navigation test and was not re-checked for further growth.
- Visit counting against the live service. On localhost it only reads, and showed 0.
- In-browser behaviour of: click-to-repair, heat erase, keyboard shortcuts, fullscreen, copy link, card-to-viewer transition, reduced-motion mode, and touch input on a real device.

### Known gaps

- No Open Graph images.
- Hidden-tab pausing relies on the browser withholding animation frames; there is no explicit pause.
- WebGL context loss relies on Three.js restoring resources; simulations are not re-initialized.
- Main bundle is 899 kB (246 kB gzipped), almost all Three.js.

### Next

- Homelab / server rack simulation as a fifth world.
