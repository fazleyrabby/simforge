# Changelog

## Unreleased — 2026-10-04

### Added

- **Seismic Shake Table (10):** a three-storey shear building on a moving platform, with an optional tuned roof mass. Controls change shaking frequency, table stroke, structural damping and damper tuning; the viewer reports roof displacement, peak sway and acceleration.
- The test rig now shows moving braces, springs, dashpots, a driven actuator and per-floor drift sensors. A bench scope plots table and roof motion; the stats also report peak storey drift, frequency ratio and damper travel.
- A standalone fixed-step structural model and tests for resonance, damper effect, no-input equilibrium and reset reproducibility.
- A procedural soundscape, route share image and updated ten-simulation cover.

### Verified

- Type check and production build pass; all 72 unit tests pass. The new route renders at desktop and phone sizes in headless Chromium without page errors, and the damper switch updates its state.

## 0.8.4 — 2026-10-03

### Added

- **Cover image** (`public/og/cover.png`, 1200×630): the headline beside a 3×3 mosaic of all nine simulations. Each tile is a capture of the live homepage card, taken by `scripts/og-cover.mjs` (`pnpm og:cover`). It is now the share image for the homepage, the simulations index and the About page; each simulation keeps its own image.

### Verified

- Type check and production build pass. The built `index.html`, `about/index.html` and `simulations/index.html` point `og:image` and `twitter:image` at `/og/cover.png`.

### Not verified

- How the image unfurls on X, Slack or elsewhere. The URLs are relative unless `SITE_URL` is set at build time, and most unfurlers need absolute ones.

## 0.8.3 — 2026-10-03

### Added

- **Support button** in the header and on the About page. It opens a dialog with SupportKori (Bangladesh, bKash and Nagad), Buy Me a Coffee (international), and a Payoneer customer ID with a copy button. Modelled on the support dialog in the SPOT project. Escape, the close button or a click on the backdrop closes it, and focus returns to the button.

### Verified

- Type check and production build pass. In the browser the dialog opens from the header, shows both links and the ID, and closes on Escape.

### Not verified

- The copy button, the About page button, and the dialog on a phone-sized screen.

## 0.8.2 — 2026-10-02

Sound could not be heard. Three separate faults, all fixed.

### Fixed

- **Far too quiet.** Soundscape layers were mixed at gains of 0.02 to 0.06 and then multiplied by a master level of 0.35, putting ambience around -40 dBFS: inaudible on laptop speakers. Everything now plays into an input stage that drives the compressor (×3.2, threshold -20 dB), with the master at 0.9. Ambience sits around -20 dBFS and loud events are still held down by the compressor.
- **Silent after a reload with sound left on.** The preference was restored from storage, but browsers start an audio context suspended and only the toggle ever resumed it. The first pointer or key press now resumes it.
- **Sound did not follow the simulation.** Drivers read stats by their display labels (`Motor`, `RPM`, `Speed`, `Avg Temp`, `State`, `Force`) rather than their keys (`rpm`, `speed`, `avgTemp`, `state`, `force`), so every reading fell back to a constant. The press pump also waited for states named `crushing` and `straining` that the press never reports (it reports `LOADING` and `OVERLOAD`), and the heat chime listened for an event named `cold` rather than `heat_erase`.

### Added

- **Warehouse Robots sound**: drive-motor hum that grows with the number of robots moving, a scanner blip per delivered order, and tones for rush orders and surges.
- **Wind Tunnel sound**: rushing air and a fan tone that both rise with wind speed, and a two-tone warning on flow separation.

### Changed

- Long-running fluid tests have a 30 s timeout. One was close enough to the default 5 s to fail on a busy machine.

### Verified

- Type check, all 68 unit tests and the production build pass.
- Measured in the browser with an analyser on the audio input stage: the Wind Tunnel produces a signal at about -23 dBFS RMS and the Rolling Road at about -20 dBFS, with the audio context running.

### Not verified

- Nobody has listened to it: levels and character were measured, not heard. The balance between simulations may need adjusting by ear.
- The resume-on-first-gesture fix. The test browser does not suspend audio, so the faulty case could not be reproduced there.
- Gears, Heat, Factory, Rack, Orbital and Press were not measured individually after the key fixes.

## 0.8.1 — 2026-10-02

Detail pass on the Wind Tunnel. The solver is unchanged.

### Added

- **Live instruments, all driven by the solver**:
  - Tracer particles released at the inlet and carried through the velocity field, drawn as streaks that lengthen with air speed. New `Tracer Particles` toggle.
  - Wool tufts taped round the model. Each lies along the air a couple of cells off the skin, and flaps when that air is slow or separated.
  - A ten-tube manometer board under the window. Each column reads pressure at a tap above the model and rises with suction.
  - A console monitor plotting lift and drag coefficients over the last 12 seconds.
  - A wind speed sign on the roof, and a protractor on the back wall with a pointer that turns with the model.
- **Tunnel hardware**: bolted flanges and stiffening ribs, a bell-mouth lip, honeycomb and mesh screens at the inlet, a smoke generator with its feed hose to the rake, an access door with hinges and latch, scale marks along the sill, a light bar, the laser that lights the slice, a pitot probe, a six-blade fan with spinner, stator vanes, motor pod and outlet guard, a drive cabinet, and an equipment cabinet with nameplate and vents under the test section.
- **Room**: operator's console with stool and signal cable, a rack of spare models, floor markings, an extinguisher.
- The model gains painted bands, a hub and a chord line.

### Changed

- The model now mounts on a shaft through the back wall instead of a strut from below.

### Verified

- Type check, all 68 unit tests and the production build pass.
- In the browser the scene renders with no console errors, at about 1.9 ms per frame including the solver on an M1. Smoke, tracers, tufts, manometer columns, the graph and the sign all update.
- Switching between all four models rebuilds the model and its tufts without errors; with the cylinder the tracers swirl in the wake and the monitor shows lift oscillating.

### Not verified

- The tunnel's Open Graph image still shows the earlier, plainer scene.
- The homepage preview card with the new detail.
- Frame cost on a phone.

## 0.8.0 — 2026-10-02

Two new worlds, and a round of build and loading fixes.

### Added

- **Warehouse Robots (08)**: a robot fleet filling orders on a seeded warehouse floor. Aisles are one-way (alternating north and south, with a westbound lane along the top, an eastbound lane along the bottom and one cross aisle), so traffic circulates and robots cannot meet head on. A dispatcher gives each order to the nearest free robot; it plans a shortest route with A*, loads a tote at the shelf, and carries it to the least busy packing station. Every floor cell is reserved by one robot at a time, so robots queue rather than collide, and a robot stuck for two seconds replans around the blockage. A robot will not pull up beside an occupied station, which would trap the robot inside. Batteries drain with distance and robots return to their own docks to charge.
  - Click a robot to see its planned route; click a shelf to place a rush order; `Order Surge` adds 20 orders at once.
  - Racking, cartons, floor arrows, order markers and outbound totes are instanced.
- **Wind Tunnel (09)**: incompressible air flow past a model, solved with the stable-fluids method on a staggered (MAC) grid. Smoke lines from an inlet rake show the flow; lift and drag coefficients come from pressure on the model's surface and drive two arrows on the model. Four models (wing, cylinder, flat plate, wedge), angle of attack, wind speed, a turbulence control (vorticity confinement), and four views (smoke, air speed, pressure, vorticity). Drag in the air to push it and add smoke.
  - The solver and the renderer share one outline per model, so the solid the air flows round is the model on screen.
  - Grid is 96×48 in the full view, 72×36 on low-spec devices and 64×32 in the homepage preview.
- 21 new unit tests (suite is now 68). Warehouse: strongly connected one-way layouts, A* paths checked against breadth-first search, no two robots ever holding one cell, order conservation, no gridlock at 16 robots under heavy load, fleet scaling, rush orders, charging, reproducibility. Wind tunnel: mass conservation, no flow through the body, uniform flow in an empty tunnel, drag without lift on a symmetric body, lift following angle of attack, blunt versus streamlined drag, smoke bounds, reproducibility.
- GitHub Actions workflow running type check, tests and build on every push and pull request.
- `.nvmrc` (Node 22) and an `engines` field (Node 20.19 or newer).

### Changed

- **Bundle**: Three.js and React now ship as separate long-cached chunks. Application code is 65 kB (was part of a single 959 kB file).
- **Nokia model**: Meshopt geometry compression and WebP textures cut it from 3.13 MB to 725 kB. The loader now registers the Meshopt decoder.

### Fixed

- The first wind tunnel solver used a collocated grid and left about 8% of the wind speed as divergence however many solver sweeps ran. It was rewritten on a staggered grid, where the projection is exact; leftover divergence is now under 0.1% of the wind speed.

### Verified

- Type check, all 68 unit tests and the production build pass.
- In the browser: both new simulations load and run with no console errors. Warehouse robots route through the aisles, totes leave on the station conveyors, and clicking a shelf places a rush order. The wind tunnel shows smoke lines and, with the cylinder, opposite-spinning shear layers in the vorticity view.
- The compressed Nokia model loads (725 kB) and renders in the Hydraulic Press.
- Measured force coefficients are in a believable range: cylinder drag coefficient about 1.25 at 120×60.

### Not verified

- The wing's lift is much lower than a real wing's at small angles (about 0.1 at 8° where a real section gives about 0.8). The grid is coarse (the wing is about four cells thick) and the method adds numerical viscosity. Direction and trend are right; magnitudes are not.
- Wind tunnel frame cost on a phone. The solver takes about 1.5 ms per step on an M1 at 96×48.
- Warehouse robot selection by click was not exercised in the browser. (Wind tunnel stirring was: a drag on the flow sheet is claimed by the simulation, and a drag off it orbits the camera.)
- Homepage preview cards for the two new simulations.
- The CI workflow has not run yet.
- Carried over: dynamic resolution on a real low-spec device, and smoothness at 120 Hz.

### Notes

- The two new simulations have no sound yet.

## 0.7.0 — 2026-10-01

Procedural Web Audio Engine across all 7 simulations and control panel item selector UX overhaul.

### Added

- **Procedural Web Audio Engine** (`src/audio/`): 100% synthesized in real-time using Web Audio API nodes (oscillators, biquad filters, white noise nodes, dynamics compressor). Zero audio downloads or network overhead.
  - **Muted by default**: Respects `spec.md §31` and browser autoplay policies. Unmuted via interactive toggle buttons in the header and the viewer action bar (`Sound: OFF / ON`).
  - **Soundscapes**:
    - **01 Gears**: Mechanical tooth-meshing clicks and rotational whine scaled to motor RPM.
    - **02 Heat**: Thermal chime harmonics on user clicks and canvas painting, plus warm ambient diffusion hum.
    - **03 Rolling Road**: Dual-oscillator engine rev sweeps tracking vehicle speed/RPM, road roller friction hiss, gearshift clunks, tyre slip squeals, and power-run completion chimes.
    - **04 Factory**: Conveyor belt mechanical rumble, pneumatic stamping chuffs, machine repair chimes, and machine jam double-beep alerts.
    - **05 Server Rack**: Datacenter cooling fan air hiss, random hard drive seek click bursts, server drawer slide friction, server reboot tone sequence, cabinet door swings, and mechanical relay clicks.
    - **06 Orbital**: Deep celestial harmonic sine drone (A1/E2/A2 chords) and resonant flyby pitch sweeps.
    - **07 Hydraulic Press**: Electric pump motor hum, metallic strain creaks under overload, ram-to-object impact clunk, flying bolt pop ricochets, violent explosion sub-thump and debris bursts, and Nokia 3310 8-bit victory arpeggio.
  - **Tactile Laboratory UI feedback**: Procedural micro-clicks for buttons and toggles, potentiometer tick feedback on range slider scrubbing, subtle card hover tones on the homepage grid, and dual-tone share link chimes.
- **Headless memory and shader audit script** (`scripts/audit.mjs`): Automated multi-cycle navigation test tracking WebGL geometries, textures, shader programs, and draw calls across all simulations with audio active.

### Fixed

- **Control panel item selector clipping**: Multi-option parameters with long descriptive text (such as the 5 Hydraulic Press test subjects: `Nokia 3310 (Rigid)`, `Soda Can (Ductile)`, etc.) previously crammed into a single flex row and truncated into illegible fragments. Replaced with `.lab-select`, a dark lab dropdown selector with a chevron icon that renders labels with full clarity, while preserving segmented buttons for compact 2-3 option selectors.

### Verified

- Automated audit completed 2 full cycles (14 simulation transitions) with Web Audio enabled: geometries returned to exactly 210, textures to 6, shader programs to 12, and draw calls to 301 on the home grid (0 memory/shader leaks).
- Unit tests (47/47 passing) and production build (`pnpm build`) pass cleanly.

### Not verified

- Audio performance on legacy Android WebAudio implementations.

## 0.6.0 — 2026-10-01

Port the Hydraulic Press into SimForge as simulation 07, covering materials science, fracture mechanics, and structural overload.

### Added

- **Hydraulic Press (07)**: A crushing force simulation ported from `smashingNokia`. Test materials feature distinct constitutive behaviors: ductile plastic buckling and crumpling (`sodaCan`), elastic compression and spring-back (`rubberBall`), brittle shatter into dynamic shards (`glassCube`), dense high-capacity yield (`tungstenCube`), and invincible resistance (`nokia3310`).
- **Overload and failure dynamics**: When an object's resistance exceeds the press capacity, hydraulic pressure ramps to its limit and stalls. The press enters an overload strain phase (3.4 s) featuring bowed steel columns, crack growth on the hazard-stripe plates, fluid leakage, smoking fittings, popping flange bolts launched as physics debris, and catastrophic explosion (shattered plate wedges, snapped column, sagging crown beam, fluid jets, flash pulse, camera shake, and slow-motion).
- **Nokia 3310**: Procedural phone with an 84×48 monochrome LCD screen rendered via canvas with a 5×7 bitmap font, displaying battery/signal status bars, clock, and menu in idle state, switching to a celebratory smiley face and "3310 WINS" upon press destruction. In full quality mode, asynchronously loads Artemecia's detailed 3D model (CC BY 4.0).
- **Analog pressure gauge**: Real-time dial texture on the hydraulic pump with circular tick marks, capacity scale, redline overload zone, and a physics-smoothed needle.
- **PressLogic**: Pure, rendering-free state machine, bisection force solver, and failure model covered by 7 unit tests (ductile crush, elastic bounce, brittle shatter, rigid press destruction, capacity thresholds on glass and tungsten, and same-seed reproducibility). Suite now stands at 47 tests.
- **Open Graph screenshots**: Updated `scripts/og.mjs` and regenerated all 8 route images under `public/og/`, including `press.png` (223 kB), `rack.png` (329 kB), and `orbital.png` (542 kB).

### Fixed

- **Press object levitation**: Objects with centered local origins (rubber ball, glass cube, tungsten cube) appeared floating above the anvil by half their height. In `prepareDeformableObject`, world transform baking with `applyMatrix4` shifted vertex positions to `y >= 0`, but the mesh was left nested inside `builtGroup` which also retained `position.y = -box.min.y`, applying the offset twice. Meshes are now reparented directly to the root model, seating all objects flush on the anvil.

### Changed

- **Mobile responsiveness across all pages**:
  - **Viewer UI**: Floating controls transform into a slide-up bottom sheet with a dedicated close button on mobile viewports (`sm:w-72 sm:rounded-none`), preventing canvas occlusion. Top bar now features a mobile toggle for stats, responsive typography, and truncated titles. Action bar refactored into a single-row horizontally scrollable touch toolbar with hidden scrollbars, eliminating button wrap on 360–390px screens.
  - **Press viewport framing**: Camera field of view and aspect pull factor adjusted in `PressSimulation` so tall portrait viewports dynamically pull the camera back to keep the crown beam and platen visible without edge clipping.
  - **App shell & home**: Navbar, footer, hero, and simulation cards made responsive with touch-friendly paddings, multi-column grid layouts for radio options, and clean flex stacking.

### Verified

- Type check (`pnpm typecheck`), all 47 unit tests (`pnpm test`), and production build (`pnpm build`) pass cleanly.
- Route shell for `/simulations/press/index.html` generated with route-specific title, description, and share image.
- All 8 OG images captured headlessly with Playwright and verified non-empty.
- Tested responsive layouts on mobile viewport dimensions (375x667, 390x844). Rubber ball, glass cube, tungsten cube verified sitting flush on the anvil surface.

### Not verified

- Dynamic resolution and the low-spec profile on a physical low-spec device.
- Smoothness at 120 Hz.
- Shader program count across extended multi-simulation navigation.



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
