# Simulation Lab

Small worlds. Real systems. Running in your browser.

A collection of miniature real-time 3D simulations built directly on Three.js. The homepage is a grid of live previews; each card is the actual simulation at reduced complexity, not an image. Click one to open it full screen and change its parameters while it runs.

## Simulations

| | Simulation | What is computed |
|---|---|---|
| 01 | **Gear System** | A gear train grown as a tree from a seed. All gears share one module, so radius follows tooth count, meshed gears sit exactly `r1 + r2` apart, neighbours counter-rotate at the tooth-count ratio, and tooth phase is solved so teeth interlock. |
| 02 | **Heat Grid** | Explicit diffusion on a grid with cooling and held sources. Temperature is uploaded as one float texture; a shader displaces and colors the surface, with relief shading and isotherms. Paint and erase sources with the pointer. |
| 03 | **Rolling Road** | A seeded car on a chassis dynamometer. Engine torque curve, automatic gearbox, and tyre slip couple the driven wheels to rollers that apply road load (rolling resistance, drag, incline, inertia). A PI driver follows a drive cycle; a power run reports peak power. |
| 04 | **Factory Production** | A production line where each product carries its own state (raw → mixed → shaped → baking → cooling → packaged). Machines are small state machines; a busy or jammed machine backs the line up behind it. Failures are seeded and repairable by clicking. |
| 05 | **Server Rack** | A datacenter rack behind a workload scheduler. Jobs arrive into a queue and a least-loaded scheduler places them on the coolest free node, but only while the rack stays under its PDU budget. Busy nodes heat up, hot nodes throttle, and a node past its critical temperature crashes and returns its work to the queue. Power, heat and failure each back the queue up rather than dropping work silently. |
| 06 | **Orbital Mechanics** | A star and its planets under Newtonian gravity, integrated with velocity Verlet so orbits hold their shape rather than spiralling away. Every body pulls on every other; planets trace Kepler ellipses while perturbing one another, and the system conserves energy and angular momentum. The gravitational constant is live, and a launched comet falls through on a steep ellipse. |
| 07 | **Hydraulic Press** | A hydraulic ram descends on test subjects with up to 500 tons. Realistic material physics govern plastic buckling (soda can), elastic rebound (rubber ball), brittle fracture (glass cube), dense yield (tungsten cube), and catastrophic structural failure when the press stalls against the invincible Nokia 3310. |
| 08 | **Warehouse Robots** | A robot fleet filling orders on a seeded warehouse floor. Aisles are one-way, so traffic circulates and robots never meet head on. A dispatcher gives each order to the nearest free robot, which plans a shortest route with A*, loads a tote and carries it to the least busy packing station. Each floor cell is reserved by one robot at a time; a robot stuck in a queue replans around it. Batteries drain with distance and robots return to their docks to charge. |
| 09 | **Wind Tunnel** | A slice of incompressible air solved with the stable-fluids method on a staggered (MAC) grid: velocity is advected along itself, then projected so the flow through every cell balances. A solid model sits in the flow, smoke lines make it visible, and pressure on the model's surface gives lift and drag coefficients. The solver and the renderer share one outline, so the solid in the air is exactly the model on screen. |

## Run it

Needs Node 20.19 or newer (`.nvmrc` pins 22) and pnpm.

```bash
pnpm install
pnpm dev
```

```bash
pnpm test
```

```bash
pnpm build
```

`pnpm build` type-checks, bundles, and writes one HTML shell per route (`dist/simulations/gears/index.html`, …) with that route's title and description, so shared links unfurl correctly. Serve `dist` with a fallback to `index.html` for unknown paths.

## Architecture

```
src/
  app/            routing, hooks (useSimulation, stats store, page meta, visit counter)
  components/     cards, viewer, control panel, stats panel, debug panel
  data/           simulation registry (metadata + lazy loaders)
  pages/          home, index, simulation, about, not found
  simulations/
    core/         Simulation interface, BaseSimulation, seeded RNG, registry types
    gears/ heat/ dyno/ factory/ rack/ orbital/ press/
  three/          Stage (renderer + loop), cameras, lights, environment, disposal
```

### One renderer, one loop

`three/Stage.ts` owns the only `WebGLRenderer` and the only `requestAnimationFrame` loop in the app. A single canvas covers the viewport behind the DOM. Anything that shows a simulation registers a **slot** (a DOM element plus a simulation). Each frame the stage reads every visible slot's bounding rect and draws its scene there with `setViewport` / `setScissor`.

The homepage cards and the full-screen viewer are both just slots, so the app holds one WebGL context no matter how many simulations are on screen. Off-screen slots are skipped via `IntersectionObserver`.

### Simulation contract

```ts
interface Simulation {
  readonly scene: THREE.Scene
  readonly camera: THREE.Camera
  init(ctx: SimulationContext): Promise<void>
  step(dt: number): void        // fixed 1/60 s
  render(alpha: number): void   // interpolation factor
  setParam(key: string, value: ParamValue): void
  getStats(): Record<string, StatValue>
  reset(seed?: number): void
  dispose(): void
  // …
}
```

Simulations never create a renderer or a loop. `BaseSimulation` supplies the shared parts: seeded RNG, lighting rig, environment reflections, camera fitting, rebuild on reset, and disposal.

### Logic is separate from rendering

Each simulation's rules live in a plain class with no WebGL dependency (`GearGenerator`, `HeatGrid`, `DynoLogic`, `FactoryLogic`, `RackLogic`, `OrbitalSystem`, `PressLogic`, `WarehouseLogic`, `FluidGrid`). That is what the unit tests exercise: gear ratios and tooth interlock, heat conservation and symmetry, drivetrain steady state and slip limits, product lifecycle and backpressure, scheduler power caps and thermal throttling, Keplerian orbits with conserved energy and angular momentum, material stress responses, overload limits, one-way layouts and shortest paths with no shared cells or gridlock, fluid mass conservation with lift and drag behaviour, and same-seed reproducibility.

### Determinism

All randomness comes from a seeded mulberry32 generator and logic advances on a fixed timestep with a clamped frame delta. The same seed, parameters and number of steps give the same state. The seed lives in the URL (`/simulations/dyno?seed=2206`), so a link reproduces a world.

### Registry

`data/simulationMeta.ts` describes each simulation: text, parameter schema, stat schema, layout. `data/simulations.ts` adds a dynamic `import()` per simulation. The homepage grid, routes, control panel and statistics panel are generated from that list; adding a simulation means adding one entry and one folder.

### React's role

React handles routing, panels and application state only. Simulation entities are never in React state. Controls call `setParam` directly; statistics are polled at 5 Hz into a small external store, so nothing in React re-renders per frame.

## Controls

| Key | Action |
|---|---|
| Space | Pause / resume |
| R | Reset |
| F | Fullscreen |
| D | Debug overlay (also `?debug=true`) |
| Esc | Back to the lab |

Shortcuts are ignored while a control has focus or a modifier key is held.

## Performance notes

- Device pixel ratio capped at 2 (1.5 on touch devices).
- Previews run with fewer entities, no shadows and lower grid resolution.
- Repeated geometry is instanced (products, axles, conveyor legs, airflow streaks, smoke).
- Products and particles are pooled.
- Simulation code is split per simulation and loaded on demand; Three.js and React ship as their own long-cached chunks.
- The render scale drops automatically when the frame rate sags and recovers when there is headroom.
- Low-spec devices get no shadows, no multisampling and coarser simulations (for example a smaller wind tunnel grid).
- The Nokia model is Meshopt-compressed with WebP textures (0.7 MB instead of 3.1 MB).

## Open Graph images

Each route carries its own title, description and share image. The images under `public/og/` are real screenshots of each simulation, captured headlessly from a preview build:

```bash
pnpm build
pnpm preview --port 4173   # in one shell
pnpm og                    # in another — writes public/og/*.png, then rebuild
```

`pnpm og:cover` (same preview server) builds `public/og/cover.png`, the image used for the homepage and other non-simulation routes: the headline beside a mosaic of every simulation, each tile captured from its live homepage card.

`pnpm og` drives headless Chromium (Playwright) over each `/simulations/:id`, lets the world run for a few seconds, and writes a 1200×630 board. The build's route-shell step points each route's `og:image` at its file; set `SITE_URL` before `pnpm build` to make the URLs absolute for unfurlers.

## Credits
- "Nokia 3310" 3D model by [Artemecia](https://sketchfab.com/3d-models/nokia-3310-67ce77f111394e738ba1be94c146ef29) licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Sound

Every simulation has a procedural soundscape, synthesized with the Web Audio API (no audio files). It is off by default; use the Sound toggle in the header or the viewer toolbar.
