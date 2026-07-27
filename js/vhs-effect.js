import * as THREE from 'three';

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
varying vec2 vUv;

float tapeNoise(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main(){
  vec2 uv = vUv;

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
  constructor(renderer, { enabled = true, amount = DEFAULT_VHS_AMOUNT, samples = 4 } = {}) {
    this.renderer = renderer;
    this.enabled = !!enabled;
    this.amount = Math.max(0, Math.min(MAX_VHS_AMOUNT, Number(amount) || 0));
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
    };
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
   * The pass runs for the tape look OR for the speed blur: with VHS switched
   * off, a car doing 250 km/h still needs the buffer.
   */
  active() { return this.supported && (this.enabled || this.uniforms.uSpeedBlur.value > 0); }

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
