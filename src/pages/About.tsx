import { Link } from 'react-router-dom'
import { usePageMeta } from '../app/usePageMeta'
import { Footer } from '../components/Footer'
import { Header } from '../components/Header'
import { SupportButton } from '../components/SupportButton'
import { simulations } from '../data/simulations'
import { site } from '../data/site'

const techniques = [
  ['Three.js', 'Used directly, with no scene-graph wrapper. One renderer draws every world.'],
  ['WebGL', 'A single context for the whole site; cards are scissored regions of one canvas.'],
  ['Procedural generation', 'Gear trains, tracks and factory floors are grown from a seed.'],
  ['Physics', 'Kinematic gear meshing, tyre slip, heat diffusion, N-body gravity.'],
  ['Fluid dynamics', 'Incompressible air flow on a staggered grid, with lift and drag read from surface pressure.'],
  ['Robotics', 'Analytic inverse kinematics, with joint-space and straight-line moves eased inside joint limits.'],
  ['Rigid bodies', 'A 2D constraint solver (Planck.js) with pulley, prismatic and revolute joints driving a chain reaction.'],
  ['Puzzles', 'A cube solver for any size: parity fixes, then commutator three-cycles found by breadth-first search.'],
  ['Pathfinding', 'A* over one-way aisles, with cell reservation so a robot fleet queues instead of colliding.'],
  ['Shaders', 'The heat field is displaced and colored on the GPU from one float texture.'],
  ['Animation', 'Fixed 60 Hz simulation steps with interpolated rendering.'],
  ['Materials & Fracture', 'Plastic buckling, elastic rebound, brittle shattering, and structural hydraulic press failure.'],
  ['GPU optimization', 'Instanced meshes, pooled entities, paused off-screen worlds.'],
]

export function About() {
  usePageMeta('About')
  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="lab-label">About</p>
        <h1 className="mt-3 text-3xl font-medium leading-tight text-lab-bright sm:text-4xl">
          Simulation Lab is an experimental collection of procedural real-time simulations built with Three.js.
        </h1>
        <p className="mt-5 leading-relaxed text-lab-text">
          Nothing here is a recording. Every gear ratio, product, lap time and temperature is computed while you watch,
          and each world is rebuilt from its seed, so a link reproduces the same world on another machine.
        </p>

        <dl className="mt-10 border-t border-lab-line">
          {techniques.map(([name, detail]) => (
            <div key={name} className="grid gap-1 border-b border-lab-line py-4 sm:grid-cols-[14rem_1fr]">
              <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-amber">{name}</dt>
              <dd className="text-sm text-lab-text">{detail}</dd>
            </div>
          ))}
        </dl>

        <h2 className="lab-label mt-10">Simulations</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {simulations.map((simulation) => (
            <li key={simulation.id}>
              <Link to={`/simulations/${simulation.id}`} className="group flex items-baseline gap-3">
                <span className="font-mono text-xs text-amber">{simulation.index}</span>
                <span className="text-lab-bright underline-offset-4 group-hover:underline">{simulation.title}</span>
                <span className="text-sm text-lab-dim">{simulation.description}</span>
              </Link>
            </li>
          ))}
        </ul>

        <h2 className="lab-label mt-10">Credits & Assets</h2>
        <div className="mt-3 text-sm text-lab-dim">
          <p>
            Hydraulic Press 3D model:{' '}
            <a
              href="https://sketchfab.com/3d-models/nokia-3310-67ce77f111394e738ba1be94c146ef29"
              target="_blank"
              rel="noreferrer"
              className="text-amber underline-offset-4 hover:underline"
            >
              &quot;Nokia 3310&quot; by Artemecia
            </a>{' '}
            (CC BY 4.0).
          </p>
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          {site.githubUrl && (
            <a href={site.githubUrl} target="_blank" rel="noreferrer" className="lab-btn">
              View source on GitHub
            </a>
          )}
          <SupportButton variant="button" />
        </div>
      </main>
      <Footer />
    </>
  )
}
