import * as THREE from 'three';
import { PS2_FILTER_DEFAULTS, normalizePS2Filter, filterAffectsImage, ditherPatternCode } from './ps2-filter.js?v=48d2ded68c0c';

/**
 * A deliberately restrained VHS pass for the night highway.
 *
 * The scene is drawn into an offscreen buffer and presented through one
 * fullscreen quad that adds the artifacts a worn tape shows at normal playback
 * speed: a hair of chroma split toward the edges, field scanlines,
 * luminance-weighted grain, and a soft dark frame. Everything is scaled by
 * `amount` and tuned to stay under the threshold where it reads as a filter
 * rather than as the picture itself.
 *
 * The pass deliberately does NOT displace the picture. An earlier version had a
 * standing wobble and a tracking band that shifted whole rows sideways; over a
 * road rushing at the camera those read as the world flexing — waves — not as
 * tape, so every UV-warping artifact was removed. Each output pixel now samples
 * its own row.
 *
 * The one thing that does gather neighbouring pixels is the speed blur, and it
 * is not a tape artifact: it is a driving effect (`setSpeedBlur`), it samples
 * only along the line back to the centre of the frame, and it is zero in the
 * middle of the picture. Nothing is displaced — the sharp frame is still in
 * there, with a short trail behind it toward the edges.
 *
 * Colour management note, and the reason for the `isXRRenderTarget` flag below.
 * three.js normally renders into an offscreen target with LinearSRGB output and
 * tone mapping switched OFF, expecting an output pass to finish the job. That
 * would change the picture here: the night highway leans on additive lamp pools
 * and streaks, and letting them accumulate in linear HDR before a single late
 * ACES pass makes the road glow visibly hotter and redder than the tuned look.
 * It would also fork every shader program, because output colour space and tone
 * mapping are part of three.js' program cache key — the prewarm compiled for
 * the canvas would no longer cover the frames actually being drawn.
 *
 * Marking the buffer as an XR target is the one supported way to say "treat
 * this exactly like the canvas": three then tone-maps per material and encodes
 * to the texture's own colour space. With an sRGB byte texture the buffer holds
 * precisely the pixels the canvas would have shown, the program cache key is
 * unchanged, and the quad passes them through untouched apart from the tape
 * artifacts — which is why this shader includes no tone mapping or colour space
 * chunk of its own.
 *
 * The pass carries one more, unrelated look: the PS2 filter (js/ps2-filter.js,
 * dev panel key 9). It shares this quad rather than running as a second pass
 * because a second pass means a second full-resolution buffer for what amounts
 * to a UV snap, a floor() and a noise sample. Its three stages run in the order
 * the hardware produced them — the frame is pixelated BEFORE it is sampled
 * (that is what makes it a resolution rather than a blur), quantized and
 * dithered on the finished picture, and grained last, by the capture chain.
 */

const VERTEX_SHADER = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uTime;
uniform float uAmount;
uniform float uSpeedBlur;
uniform float uPixelLines;
uniform float uLevels;
uniform float uDither;
uniform float uDitherScale;
uniform float uDitherPattern;
uniform float uGrain;
uniform float uGrainScale;
uniform float uGrainSpeed;
uniform float uGrainShadows;
uniform float uGrainColor;
varying vec2 vUv;

float tapeNoise(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Ordered dither. bayer2 is the 2×2 matrix written as arithmetic (no array
// lookup, which older mobile GLSL compilers handle badly); the larger matrices
// are the standard recursive construction from it. All return [0,1).
float bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a){ return bayer2(a * 0.5) * 0.25 + bayer2(a); }
float bayer8(vec2 a){ return bayer4(a * 0.5) * 0.25 + bayer2(a); }

void main(){
  vec2 uv = vUv;

  // --- PS2 filter, stage 1: pixelation -------------------------------------
  // Snapping the sampling coordinate, not the finished picture, is what makes
  // this a resolution: every block takes ONE sample of the scene, exactly as a
  // smaller framebuffer would, instead of averaging a sharp frame into mush.
  // The grid is expressed in virtual scanlines so the look does not change with
  // the display, the device pixel ratio or the adaptive resolution governor.
  // pixelCoord is the integer coordinate of that virtual framebuffer, and the
  // dither and grain below are anchored to it — a console dithers at its own
  // framebuffer resolution, not at the resolution of the TV showing it.
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 pixelCoord = vUv * uResolution;
  if (uPixelLines > 0.0) {
    vec2 cells = vec2(max(floor(uPixelLines * aspect + 0.5), 1.0), uPixelLines);
    pixelCoord = floor(vUv * cells);
    uv = (pixelCoord + 0.5) / cells;
  }

  // The geometry of the frame is deliberately left alone: no standing wobble,
  // no crawling tracking band, nothing that moves a pixel off the row it was
  // rendered on. Those read as the picture bending rather than as tape, and
  // over a fast-moving road they turn into visible waves. What stays is the
  // colour/contrast side of a worn tape, which is fixed in place.

  // Chroma split: nothing in the centre, a fraction of a pixel at the edges.
  // Static — it does not breathe with time, so straight edges stay straight.
  float edge = abs(uv.x - 0.5) * 2.0;
  float split = (0.0005 + 0.0014 * edge * edge) * uAmount;
  vec3 colour = vec3(
    texture2D(tDiffuse, vec2(clamp(uv.x + split, 0.0, 1.0), uv.y)).r,
    texture2D(tDiffuse, uv).g,
    texture2D(tDiffuse, vec2(clamp(uv.x - split, 0.0, 1.0), uv.y)).b
  );

  // Speed blur. Four taps pulled straight toward the centre of the frame, so
  // the smear runs along the direction the world is actually flowing. It is
  // held at zero in the middle of the picture and only opens up toward the
  // edges: that keeps the road, the traffic ahead and the HUD-adjacent centre
  // readable, and it is the reason this does NOT read as the tape wobble that
  // was removed above — every sample still comes from the same radial line, so
  // nothing bends. uSpeedBlur is a fraction of the distance to the centre, fed
  // from road speed by the game.
  if (uSpeedBlur > 0.0005) {
    vec2 toCentre = uv - 0.5;
    float reach = uSpeedBlur * smoothstep(0.10, 0.62, length(toCentre));
    vec3 accumulated = colour;
    float weight = 1.0;
    for (int i = 1; i <= 4; i++) {
      float k = float(i) / 4.0;
      float w = 1.0 - 0.6 * k;
      vec2 tap = clamp(uv - toCentre * (reach * k), vec2(0.0), vec2(1.0));
      accumulated += texture2D(tDiffuse, tap).rgb * w;
      weight += w;
    }
    colour = accumulated / weight;
  }

  gl_FragColor = vec4(colour, 1.0);

  // Everything below runs on the finished, display-encoded picture — the same
  // place in the chain where a tape would pick these artifacts up.

  // Field scanlines. The pitch is derived from the framebuffer but clamped, so
  // the strength does not change when the render scale governor moves and the
  // lines never fall below ~3 px (which would alias into moiré).
  float lines = clamp(uResolution.y * 0.25, 120.0, 300.0);
  gl_FragColor.rgb *= 1.0 - 0.030 * uAmount * (0.5 + 0.5 * sin(uv.y * lines * 6.2831853));

  // Grain, weighted down where the picture is already bright: it lives in the
  // sky and the tunnel shadows instead of crawling over lit signs.
  float grain = tapeNoise(uv * uResolution + fract(uTime * 24.0) * 137.0) - 0.5;
  float luma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb += grain * 0.026 * uAmount * (1.0 - 0.65 * luma);

  // The soft dark frame of a tape dubbed one generation too many.
  float falloff = edge * 0.66 + abs(uv.y - 0.5) * 1.05;
  gl_FragColor.rgb *= 1.0 - 0.15 * uAmount * falloff * falloff * falloff;

  // --- PS2 filter, stage 2: colour quantization and dithering --------------
  // A 5-bit-per-channel framebuffer is 32 levels, and the console dithered on
  // the way into it because 32 levels across a night sky is visible banding.
  // The dither is added BEFORE the floor(), which is the whole point: it pushes
  // each pixel across the step boundary in a pattern, so a gradient that would
  // land on one flat level resolves into two interleaved ones and the eye
  // averages them back. Applied after the quantize it would just be noise.
  if (uLevels >= 2.0) {
    float steps = uLevels - 1.0;
    vec3 quantized = gl_FragColor.rgb;
    if (uDither > 0.0) {
      vec2 cell = pixelCoord / max(uDitherScale, 1.0);
      float pattern = uDitherPattern < 0.5
        ? bayer8(cell)
        : (uDitherPattern < 1.5 ? bayer4(cell) : tapeNoise(floor(cell) + 0.5));
      quantized += (pattern - 0.5) * (uDither / steps);
    }
    gl_FragColor.rgb = clamp(floor(quantized * steps + 0.5) / steps, 0.0, 1.0);
  }

  // --- PS2 filter, stage 3: film grain -------------------------------------
  // Independent of the tape grain above, which is tied to uAmount: this one is
  // the capture chain rather than the console, so it has to survive with the
  // VHS look switched off. uGrainSpeed quantizes time into steps so the noise
  // resamples at a fixed rate (a real grain plate runs at 24 fps, not at
  // whatever the GPU manages) — at 0 it is frozen, which is what a still
  // photograph of a CRT looks like.
  if (uGrain > 0.0) {
    vec2 grainCell = floor(pixelCoord / max(uGrainScale, 0.001));
    // uTime is seconds since the page loaded and grows without bound; wrapping
    // it first keeps the step count inside the range where a float can still
    // count whole numbers, however long the session runs. The sequence restarts
    // every 512 s, which is not something an eye can notice in noise.
    float grainStep = uGrainSpeed > 0.0 ? floor(mod(uTime, 512.0) * uGrainSpeed) : 0.0;
    // The time term is wrapped before it reaches the hash. tapeNoise() is the
    // usual sin(dot(...)) construction and it dies once its argument leaves the
    // range a 32-bit float can resolve — an unwrapped step * 137 is already
    // past that after a minute of play, at which point sin() returns the same
    // value everywhere and the grain silently freezes into a flat brightness
    // offset. Two coprime moduli keep the pair from repeating for ~77 minutes
    // at 30 Hz while the seed stays small.
    vec2 grainSeed = grainCell + vec2(mod(grainStep * 61.0, 419.0), mod(grainStep * 97.0, 331.0));
    float mono = tapeNoise(grainSeed) - 0.5;
    vec3 noise = vec3(
      mono,
      mix(mono, tapeNoise(grainSeed + 31.7) - 0.5, uGrainColor),
      mix(mono, tapeNoise(grainSeed + 71.3) - 0.5, uGrainColor)
    );
    // Grain lives in the shadows on real film and on real tape; at 0 it is
    // uniform across the frame, at 1 the highlights are left almost clean.
    float luma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor.rgb = clamp(gl_FragColor.rgb + noise * 0.09 * uGrain * (1.0 - uGrainShadows * luma), 0.0, 1.0);
  }
}
`;

export const DEFAULT_VHS_AMOUNT = 1;
// Ceiling of the tape dial. 1× is the authored look and 2× was the old cap;
// the headroom above that is deliberately past "tasteful" — it is there for
// people who want the picture visibly destroyed.
export const MAX_VHS_AMOUNT = 4;
// The tape look and the speed blur share this one pass, but they are separate
// dials: the blur is a driving effect, so it stays available with the tape
// switched off. MAX_SPEED_BLUR is the smear at the 100% setting — a hint of
// motion, not a zoom blur — and MAX_SPEED_BLUR_CEILING is the hard ceiling the
// dial can reach. The ceiling must track the dial's range: clamping both to the
// same number is what made the slider do nothing above 100% at top speed.
export const MAX_SPEED_BLUR = 0.09;
export const MAX_MOTION_BLUR_LEVEL = 4;
export const MAX_SPEED_BLUR_CEILING = MAX_SPEED_BLUR * MAX_MOTION_BLUR_LEVEL;

export class VHSEffect {
  constructor(renderer, { enabled = true, amount = DEFAULT_VHS_AMOUNT, samples = 4, filter = null } = {}) {
    this.renderer = renderer;
    this.enabled = !!enabled;
    this.amount = Math.max(0, Math.min(MAX_VHS_AMOUNT, Number(amount) || 0));
    this.filter = normalizePS2Filter(filter || PS2_FILTER_DEFAULTS);
    this.supported = VHSEffect.isSupported(renderer);
    // Multisampling moves off the canvas and into the buffer: without it the
    // one-pixel lamp posts and rail lines the desktop profile relies on start
    // crawling the moment the pass is switched on.
    this.samples = Math.max(0, Math.round(samples) || 0);
    this.width = 1;
    this.height = 1;
    this.target = null;
    this.uniforms = {
      tDiffuse: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uAmount: { value: this.enabled ? this.amount : 0 },
      uSpeedBlur: { value: 0 },
      uPixelLines: { value: 0 },
      uLevels: { value: 0 },
      uDither: { value: 0 },
      uDitherScale: { value: 1 },
      uDitherPattern: { value: 0 },
      uGrain: { value: 0 },
      uGrainScale: { value: 1 },
      uGrainSpeed: { value: 0 },
      uGrainShadows: { value: 0 },
      uGrainColor: { value: 0 },
    };
    this._writeFilterUniforms();
    this.material = new THREE.ShaderMaterial({
      name: 'vhsPresent',
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      // The buffer already holds finished, display-encoded pixels: any further
      // tone mapping or colour conversion here would double-process the frame.
      toneMapped: false,
    });
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(this.geometry, this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.Camera();
  }

  /**
   * A plain sRGB byte buffer needs nothing beyond a working context; the first
   * failed allocation flips this off permanently (see render()).
   */
  static isSupported(renderer) {
    return !!renderer;
  }

  /**
   * The pass runs for the tape look OR for the speed blur OR for the PS2
   * filter: with VHS switched off, a car doing 250 km/h still needs the buffer,
   * and so does a player who only wants the console picture.
   */
  active() {
    return this.supported && (this.enabled || this.uniforms.uSpeedBlur.value > 0 || filterAffectsImage(this.filter));
  }

  /**
   * Replaces the PS2 filter settings (js/ps2-filter.js). Accepts partial or
   * malformed input — it is normalized here, so the caller can hand over a
   * value straight from the save file.
   */
  setFilter(settings) {
    const wasActive = this.active();
    this.filter = normalizePS2Filter(settings);
    this._writeFilterUniforms();
    // Turning the filter off releases the buffer, exactly as switching the tape
    // look off does — a neutral filter must cost nothing at all.
    if (wasActive && !this.active()) this._disposeTarget();
    return this.filter;
  }

  /**
   * A disabled filter writes zeros rather than its stored values, so every
   * branch in the shader is skipped and the quad is a pure passthrough. The
   * settings themselves are kept intact for when it is switched back on.
   */
  _writeFilterUniforms() {
    const on = !!this.filter?.enabled;
    const f = this.filter || PS2_FILTER_DEFAULTS;
    const u = this.uniforms;
    u.uPixelLines.value = on ? f.pixelLines : 0;
    u.uLevels.value = on && f.colorLevels >= 2 ? f.colorLevels : 0;
    u.uDither.value = on ? f.dither : 0;
    u.uDitherScale.value = Math.max(1, f.ditherScale || 1);
    u.uDitherPattern.value = ditherPatternCode(f.ditherPattern);
    u.uGrain.value = on ? f.grain : 0;
    u.uGrainScale.value = Math.max(0.5, f.grainScale || 1);
    u.uGrainSpeed.value = Math.max(0, f.grainSpeed || 0);
    u.uGrainShadows.value = f.grainShadows;
    u.uGrainColor.value = f.grainColor;
  }

  setAmount(amount) {
    this.amount = Math.max(0, Math.min(MAX_VHS_AMOUNT, Number(amount) || 0));
    this.uniforms.uAmount.value = this.enabled ? this.amount : 0;
  }

  /** Radial smear, as a fraction of each pixel's distance to frame centre. */
  setSpeedBlur(blur) {
    const value = Math.max(0, Math.min(MAX_SPEED_BLUR_CEILING, Number(blur) || 0));
    if (value === this.uniforms.uSpeedBlur.value) return;
    const wasActive = this.active();
    this.uniforms.uSpeedBlur.value = value;
    // Falling back to a direct canvas render releases the buffer, exactly as
    // switching the tape look off does.
    if (wasActive && !this.active()) this._disposeTarget();
  }

  setEnabled(enabled) {
    enabled = !!enabled && this.supported;
    if (enabled === this.enabled) return false;
    this.enabled = enabled;
    this.uniforms.uAmount.value = enabled ? this.amount : 0;
    if (!this.active()) this._disposeTarget();
    return true;
  }

  setSize(width, height) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.uniforms.uResolution.value.set(width, height);
    if (this.target) this.target.setSize(width, height);
  }

  _ensureTarget() {
    if (this.target) return this.target;
    this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.samples,
    });
    // See the module header: this is what keeps the offscreen frame identical
    // to the canvas frame, in both pixels and compiled shader programs.
    this.target.isXRRenderTarget = true;
    // …and this pins both halves of the buffer to the same storage. An XR
    // target's multisample renderbuffer is allocated as plain RGBA8 (the shader
    // does the sRGB encode itself), while the resolve texture would otherwise
    // pick SRGB8_ALPHA8 from its colour space. The formats must match or
    // glBlitFramebuffer refuses to resolve and every frame lands black.
    this.target.texture.internalFormat = 'RGBA8';
    this.target.texture.name = 'vhsScene';
    this.target.texture.generateMipmaps = false;
    this.uniforms.tDiffuse.value = this.target.texture;
    return this.target;
  }

  /**
   * Draws `scene` through the pass. Returns false when the caller should fall
   * back to a plain renderer.render() — disabled, unsupported, or the buffer
   * could not be allocated on this GPU.
   */
  render(scene, camera, elapsedSeconds = performance.now() / 1000) {
    if (!this.active()) return false;
    let target;
    try { target = this._ensureTarget(); } catch (error) {
      console.warn('VHS pass unavailable', error);
      this.supported = false;
      return false;
    }
    this.uniforms.uTime.value = elapsedSeconds;
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(previous);
    this.renderer.render(this.quadScene, this.quadCamera);
    return true;
  }

  /**
   * Compiles the present shader up front. The scene's own programs are
   * prewarmed by the game, but they must be prewarmed through this pass:
   * offscreen rendering changes the output colour space and tone mapping flags,
   * which are part of three.js' program cache key.
   */
  prewarm() {
    if (!this.active()) return false;
    try {
      this._ensureTarget();
      this.renderer.render(this.quadScene, this.quadCamera);
      return true;
    } catch (error) {
      console.warn('VHS prewarm', error);
      return false;
    }
  }

  _disposeTarget() {
    this.target?.dispose();
    this.target = null;
    this.uniforms.tDiffuse.value = null;
  }

  dispose() {
    this._disposeTarget();
    this.geometry.dispose();
    this.material.dispose();
  }
}
