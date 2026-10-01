import type { SimulationDefinition } from '../simulations/core/registry.ts'

export type SimulationMeta = Omit<SimulationDefinition, 'load'>

/**
 * Everything about each simulation except its code. Kept free of runtime
 * imports so the build script can read it for per-route HTML.
 * Order here is the order of the homepage grid.
 */
export const simulationMeta: SimulationMeta[] = [
  {
    id: 'gears',
    index: '01',
    title: 'Gear System',
    description: 'A procedural mechanical gear network.',
    summary:
      'A gear train grown from a seed. Every gear shares one module, so tooth counts set the radii, neighbours counter-rotate, and speed ratios follow the tooth counts through the whole tree.',
    category: 'Mechanical',
    camera: 'orthographic',
    params: [
      { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 120, step: 1, unit: 'rpm', default: 24 },
      { key: 'torque', label: 'Torque', type: 'range', min: 1, max: 100, step: 1, unit: 'N·m', default: 20 },
      { key: 'gearCount', label: 'Gear Count', type: 'range', min: 3, max: 24, step: 1, default: 11, previewDefault: 8 },
      { key: 'gearSize', label: 'Gear Size', type: 'range', min: 0.6, max: 1.4, step: 0.05, unit: '×', default: 1 },
    ],
    stats: [
      { key: 'rpm', label: 'RPM' },
      { key: 'torque', label: 'Torque', unit: 'N·m' },
      { key: 'power', label: 'Power', unit: 'W' },
      { key: 'gearCount', label: 'Gear Count' },
      { key: 'efficiency', label: 'System Efficiency', unit: '%' },
    ],
    previewStats: ['rpm', 'gearCount', 'efficiency'],
    actions: [],
    randomizeLabel: 'Randomize',
    previewSeed: 48291,
    layout: 'md:col-span-2 lg:col-span-4 h-[320px] sm:h-[360px] lg:h-[420px]',
  },
  {
    id: 'heat',
    index: '02',
    title: 'Heat Grid',
    description: 'Temperature spreading across a plate.',
    summary:
      'A grid of temperatures solved by diffusion: each cell drifts toward its neighbours and loses heat to the room. Paint heat sources onto the plate and watch the field rise and settle.',
    category: 'Thermal',
    camera: 'orthographic',
    params: [
      { key: 'heatSource', label: 'Heat Source', type: 'range', min: 200, max: 1000, step: 20, unit: '°C', default: 800 },
      { key: 'conductivity', label: 'Conductivity', type: 'range', min: 0.05, max: 1, step: 0.05, default: 0.6 },
      { key: 'cooling', label: 'Cooling', type: 'range', min: 0, max: 1, step: 0.05, default: 0.25 },
      { key: 'speed', label: 'Simulation Speed', type: 'range', min: 0.25, max: 4, step: 0.25, unit: '×', default: 1 },
      {
        key: 'resolution',
        label: 'Grid Resolution',
        type: 'select',
        options: [
          { value: '32', label: '32' },
          { value: '64', label: '64' },
          { value: '128', label: '128' },
          { value: '256', label: '256' },
        ],
        default: '128',
        previewDefault: '48',
      },
      {
        key: 'tool',
        label: 'Tool',
        type: 'select',
        options: [
          { value: 'paint', label: 'Paint' },
          { value: 'erase', label: 'Erase' },
          { value: 'camera', label: 'Camera' },
        ],
        default: 'paint',
      },
      { key: 'wander', label: 'Wandering Sources', type: 'toggle', default: true },
    ],
    stats: [
      { key: 'maxTemp', label: 'Max Temp', unit: '°C' },
      { key: 'avgTemp', label: 'Current Avg', unit: '°C' },
      { key: 'gridSize', label: 'Grid Size' },
      { key: 'simTime', label: 'Simulation Time' },
    ],
    previewStats: ['maxTemp', 'avgTemp'],
    actions: [],
    randomizeLabel: 'Randomize',
    previewSeed: 90417,
    layout: 'lg:col-span-2 h-[320px] sm:h-[360px] lg:h-[420px]',
    hint: 'Click or drag to paint heat. Right-drag erases. Hold Alt, or pick Camera, to orbit.',
  },
  {
    id: 'dyno',
    index: '03',
    title: 'Rolling Road',
    description: 'A car under test on a chassis dynamometer.',
    summary:
      'A car strapped to a rolling road. Engine torque passes through the gearbox to the tyres, the rollers push back with drag, incline and inertia, and the two meet only through tyre grip. Ask for more than the grip allows and the wheels spin.',
    category: 'Vehicle Testing',
    camera: 'orthographic',
    params: [
      {
        key: 'mode',
        label: 'Driver',
        type: 'select',
        options: [
          { value: 'cycle', label: 'Drive Cycle' },
          { value: 'manual', label: 'Manual' },
        ],
        default: 'cycle',
      },
      { key: 'throttle', label: 'Throttle (Manual)', type: 'range', min: 0, max: 100, step: 1, unit: '%', default: 40 },
      { key: 'grade', label: 'Incline', type: 'range', min: -5, max: 15, step: 0.5, unit: '%', default: 0 },
      { key: 'grip', label: 'Roller Grip', type: 'range', min: 0.15, max: 1.2, step: 0.05, unit: 'μ', default: 1 },
      { key: 'wind', label: 'Headwind', type: 'range', min: 0, max: 120, step: 5, unit: 'km/h', default: 0 },
    ],
    stats: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'speed', label: 'Speed', unit: 'km/h' },
      { key: 'rpm', label: 'Engine', unit: 'rpm' },
      { key: 'gear', label: 'Gear' },
      { key: 'power', label: 'Wheel Power', unit: 'kW' },
      { key: 'slip', label: 'Wheel Slip', unit: '%' },
      { key: 'peak', label: 'Peak Power', unit: 'kW' },
      { key: 'distance', label: 'Distance', unit: 'km' },
    ],
    previewStats: ['speed', 'rpm', 'gear'],
    actions: [{ key: 'powerRun', label: 'Power Run' }],
    randomizeLabel: 'Randomize Vehicle',
    previewSeed: 2206,
    layout: 'lg:col-span-2 h-[280px] sm:h-[320px] lg:h-[360px]',
    hint: 'Power Run holds full throttle through the gears and reports peak power. Drop Roller Grip to make the tyres spin.',
  },
  {
    id: 'factory',
    index: '04',
    title: 'Factory Production',
    description: 'A miniature automated production line.',
    summary:
      'Dough is dispensed, mixed, cut, baked, cooled and boxed. Every product carries its own state, machines queue and block each other, and a jam backs the whole line up behind it.',
    category: 'Industrial',
    camera: 'orthographic',
    params: [
      { key: 'spawnRate', label: 'Spawn Rate', type: 'range', min: 10, max: 120, step: 1, unit: '/min', default: 60, previewDefault: 32 },
      { key: 'conveyorSpeed', label: 'Conveyor Speed', type: 'range', min: 0.5, max: 4, step: 0.1, unit: 'm/s', default: 2 },
      { key: 'machineSpeed', label: 'Machine Speed', type: 'range', min: 0.5, max: 3, step: 0.1, unit: '×', default: 1 },
      { key: 'ovenTemp', label: 'Oven Temperature', type: 'range', min: 120, max: 260, step: 5, unit: '°C', default: 180 },
      { key: 'failures', label: 'Machine Failures', type: 'toggle', default: true },
      { key: 'mtbf', label: 'Time Between Failures', type: 'range', min: 10, max: 120, step: 5, unit: 's', default: 45 },
    ],
    stats: [
      { key: 'productionPerMin', label: 'Production' },
      { key: 'completed', label: 'Completed Products' },
      { key: 'active', label: 'Active Products' },
      { key: 'efficiency', label: 'Factory Efficiency', unit: '%' },
      { key: 'machines', label: 'Active Machines' },
      { key: 'downtime', label: 'Downtime' },
    ],
    previewStats: ['productionPerMin', 'machines', 'efficiency'],
    actions: [],
    randomizeLabel: 'Randomize',
    previewSeed: 7312,
    layout: 'md:col-span-2 lg:col-span-4 h-[260px] sm:h-[320px] lg:h-[360px]',
    hint: 'Click a jammed machine to repair it.',
  },
]
