/**
 * Heat surface shaders. Temperature arrives as a single-channel float texture.
 * The vertex stage lifts the surface by temperature; the fragment stage maps
 * temperature to color and adds relief shading, cell lines and isotherms, so
 * the field reads by shape and contour as well as by color.
 */
export const heatVertexShader = /* glsl */ `
  uniform sampler2D uTemperature;
  uniform float uHeight;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    float temperature = texture2D(uTemperature, uv).r;
    vec3 displaced = position + vec3(0.0, 0.0, temperature * uHeight);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

export const heatFragmentShader = /* glsl */ `
  uniform sampler2D uTemperature;
  uniform float uSize;
  uniform float uSlope;
  varying vec2 vUv;

  vec3 ramp(float t) {
    vec3 c0 = vec3(0.030, 0.045, 0.085);
    vec3 c1 = vec3(0.150, 0.090, 0.400);
    vec3 c2 = vec3(0.760, 0.150, 0.270);
    vec3 c3 = vec3(1.000, 0.560, 0.110);
    vec3 c4 = vec3(1.000, 0.960, 0.780);
    t = clamp(t, 0.0, 1.0);
    if (t < 0.25) return mix(c0, c1, t / 0.25);
    if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
    return mix(c3, c4, (t - 0.75) / 0.25);
  }

  void main() {
    float t = texture2D(uTemperature, vUv).r;
    float texel = 1.0 / uSize;

    // Relief shading from the temperature gradient.
    float dx = texture2D(uTemperature, vUv + vec2(texel, 0.0)).r - texture2D(uTemperature, vUv - vec2(texel, 0.0)).r;
    float dy = texture2D(uTemperature, vUv + vec2(0.0, texel)).r - texture2D(uTemperature, vUv - vec2(0.0, texel)).r;
    vec3 normal = normalize(vec3(-dx * uSlope, -dy * uSlope, 1.0));
    float light = 0.7 + 0.3 * dot(normal, normalize(vec3(0.45, 0.5, 0.75)));
    vec3 color = ramp(t) * light;

    // Cell lines, faded out once cells are too small on screen to resolve.
    vec2 cell = abs(fract(vUv * uSize) - 0.5);
    float cellWidth = fwidth(vUv.x * uSize) + fwidth(vUv.y * uSize);
    float line = smoothstep(0.5 - cellWidth, 0.5, max(cell.x, cell.y)) * clamp(1.0 - cellWidth * 2.2, 0.0, 1.0);
    color = mix(color, color * 0.5 + vec3(0.02, 0.025, 0.035), line * 0.7);

    // Isotherm contours.
    float bands = t * 8.0;
    float contour = 1.0 - smoothstep(0.0, fwidth(bands) * 1.6, abs(fract(bands + 0.5) - 0.5));
    color += vec3(0.16) * contour * step(0.04, t);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`
