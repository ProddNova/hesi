import * as THREE from 'three';

/**
 * PS2-era post pipeline, no addons: scene → MSAA render target, quarter-res
 * bright pass + two separable blur taps for the classic convolution-bloom
 * halo, then one composite pass with a warm sodium grade, vignette and a 4×4
 * ordered dither (kills banding in the dark sky gradients the way console
 * dithering did). All passes run at reduced resolution; the whole pipeline
 * costs a few fullscreen quads.
 */

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D tScene;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    // max-channel keeps saturated tail lights and sodium lamps blooming even
    // though their luma is low
    float peak = max(max(c.r, c.g), c.b);
    float gain = smoothstep(uThreshold, uThreshold + uKnee, peak);
    gl_FragColor = vec4(c * gain, 1.0);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uDirection; // texel-space step
  varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tInput, vUv).rgb * 0.227027;
    vec2 off1 = uDirection * 1.3846154;
    vec2 off2 = uDirection * 3.2307692;
    sum += texture2D(tInput, vUv + off1).rgb * 0.3162162;
    sum += texture2D(tInput, vUv - off1).rgb * 0.3162162;
    sum += texture2D(tInput, vUv + off2).rgb * 0.0702703;
    sum += texture2D(tInput, vUv - off2).rgb * 0.0702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloomStrength;
  uniform vec3 uWarmTint;
  uniform float uVignette;
  varying vec2 vUv;

  float bayer2(vec2 p) {
    // 2x2 Bayer cell [[0,2],[3,1]] via mod arithmetic (no branches)
    return mod(mod(p.x, 2.0) * 2.0 + mod(p.y, 2.0) * 3.0, 4.0);
  }
  float bayer4(vec2 p) {
    // recursive 4x4 ordered dither, normalized 0..1
    return (bayer2(floor(p * 0.5)) * 4.0 + bayer2(p)) / 16.0;
  }

  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    c += texture2D(tBloom, vUv).rgb * uBloomStrength;
    // sodium-vapor cast over the whole frame
    c *= uWarmTint;
    // soft shoulder above 0.7 so bloom + emissives roll off instead of clip
    vec3 s = max(c - 0.7, vec3(0.0));
    c = min(c, vec3(0.7)) + s / (1.0 + s * 3.4);
    // vignette pulls the eye onto the road, very GT4 photo-mode
    float d = distance(vUv, vec2(0.5, 0.46));
    c *= 1.0 - smoothstep(0.42, 0.92, d) * uVignette;
    // ordered dither breaks the dark-gradient banding
    c += (bayer4(gl_FragCoord.xy) - 0.5) * (2.0 / 255.0);
    gl_FragColor = vec4(max(c, 0.0), 1.0);
    #include <colorspace_fragment>
  }
`;

export class RetroPost {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this._quality = 'medium';
    this._width = 2;
    this._height = 2;

    const rtOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.sceneTarget = new THREE.WebGLRenderTarget(2, 2, {
      ...rtOptions,
      depthBuffer: true,
      // 2x MSAA: visually near-identical to 4x at this internal resolution
      // and roughly halves the multisample resolve cost.
      samples: renderer.capabilities.isWebGL2 ? 2 : 0,
    });
    this.brightTarget = new THREE.WebGLRenderTarget(2, 2, rtOptions);
    this.blurTargetA = new THREE.WebGLRenderTarget(2, 2, rtOptions);
    this.blurTargetB = new THREE.WebGLRenderTarget(2, 2, rtOptions);

    this.brightMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        uThreshold: { value: 0.55 },
        uKnee: { value: 0.3 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      uniforms: {
        tInput: { value: null },
        uDirection: { value: new THREE.Vector2(0, 0) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: {
        tScene: { value: this.sceneTarget.texture },
        tBloom: { value: this.blurTargetB.texture },
        uBloomStrength: { value: 0.62 },
        uWarmTint: { value: new THREE.Vector3(1.04, 0.995, 0.93) },
        uVignette: { value: 0.34 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);
    this._resizeBloom();
  }

  setSize(width, height) {
    this._width = Math.max(2, width);
    this._height = Math.max(2, height);
    this.sceneTarget.setSize(this._width, this._height);
    this._resizeBloom();
  }

  setQuality(quality) {
    if (quality === this._quality) return;
    this._quality = quality;
    this._resizeBloom();
  }

  _resizeBloom() {
    // Low quality drops the bloom chain to 1/8 res and one blur iteration.
    const divisor = this._quality === 'low' ? 8 : 4;
    const w = Math.max(2, Math.round(this._width / divisor));
    const h = Math.max(2, Math.round(this._height / divisor));
    this.brightTarget.setSize(w, h);
    this.blurTargetA.setSize(w, h);
    this.blurTargetB.setSize(w, h);
    this._blurTexel = new THREE.Vector2(1 / w, 1 / h);
  }

  _pass(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._quadCamera);
  }

  render(scene, camera) {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(scene, camera);

    this._pass(this.brightMaterial, this.brightTarget);
    const iterations = this._quality === 'low' ? 1 : 2;
    let input = this.brightTarget;
    for (let i = 0; i < iterations; i += 1) {
      const spread = 1 + i * 0.75; // widen the halo on the second tap
      this.blurMaterial.uniforms.tInput.value = input.texture;
      this.blurMaterial.uniforms.uDirection.value.set(this._blurTexel.x * spread, 0);
      this._pass(this.blurMaterial, this.blurTargetA);
      this.blurMaterial.uniforms.tInput.value = this.blurTargetA.texture;
      this.blurMaterial.uniforms.uDirection.value.set(0, this._blurTexel.y * spread);
      this._pass(this.blurMaterial, this.blurTargetB);
      input = this.blurTargetB;
    }

    this._pass(this.compositeMaterial, null);
  }

  dispose() {
    for (const target of [this.sceneTarget, this.brightTarget, this.blurTargetA, this.blurTargetB]) target.dispose();
    for (const material of [this.brightMaterial, this.blurMaterial, this.compositeMaterial]) material.dispose();
    this._quad.geometry.dispose();
  }
}

export default RetroPost;
