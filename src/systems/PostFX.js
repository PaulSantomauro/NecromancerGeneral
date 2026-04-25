import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Post-processing pipeline — bloom + a subtle two-tone color grade.
//
// Chain (full quality):
//   RenderPass   — draws scene to a float buffer
//   UnrealBloomPass — isolates bright pixels (eyes, muzzle flashes, portals,
//                    soul streams, fog wall) and bleeds them into a glow
//   ColorGradePass — cool shadows + warm highlights, a touch of saturation
//   OutputPass   — sRGB conversion + tone map back to the canvas
//
// The quality toggle lets us scale down to a lighter chain (no bloom,
// cheaper grade) or off entirely (bypass the composer, use the old
// renderer.render path). Bloom fillrate is the usual mobile/iGPU
// bottleneck; capping the render target resolution is the single
// biggest knob.

const COLOR_GRADE_SHADER = {
  uniforms: {
    tDiffuse:   { value: null },
    uShadowHue: { value: new THREE.Color(0x2a2450) }, // cool violet shadow tint
    uMidHue:    { value: new THREE.Color(0xa08060) }, // warm mid-tone
    uHiHue:     { value: new THREE.Color(0xffe0a0) }, // warm highlight boost
    uShadowWt:  { value: 0.05 },
    uMidWt:     { value: 0.04 },
    uHiWt:      { value: 0.08 },
    uSaturation:{ value: 1.05 },
    uContrast:  { value: 1.02 },
    uVignette:  { value: 0.16 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3  uShadowHue, uMidHue, uHiHue;
    uniform float uShadowWt, uMidWt, uHiWt;
    uniform float uSaturation, uContrast, uVignette;
    varying vec2 vUv;

    vec3 applyGrade(vec3 c) {
      // Luminance (Rec. 709) drives which tint this pixel is biased toward.
      float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float shadowMask = smoothstep(0.55, 0.0,  L);
      float hiMask     = smoothstep(0.55, 1.0,  L);
      float midMask    = 1.0 - shadowMask - hiMask;
      c = mix(c, c * uShadowHue * 2.0, shadowMask * uShadowWt);
      c = mix(c, c * uMidHue    * 2.0, midMask    * uMidWt);
      c = mix(c, c * uHiHue     * 1.6, hiMask     * uHiWt);
      // Global saturation + contrast pivoting around mid-gray.
      float gray = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(gray), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      return c;
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = applyGrade(src.rgb);
      // Soft vignette — darkens the extreme corners to keep focus
      // centered. Cheap, purely a 2D falloff, no sampling noise.
      vec2 d = vUv - 0.5;
      float vig = smoothstep(0.80, 0.25, length(d));
      col *= mix(1.0 - uVignette, 1.0, vig);
      gl_FragColor = vec4(col, src.a);
    }
  `,
};

class _PostFX {
  constructor() {
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._composer = null;
    this._bloom = null;
    this._grade = null;
    this._quality = 'full';
    this._enabled = false;
  }

  init(renderer, scene, camera, { quality = 'full' } = {}) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this._build(quality);
  }

  // Construct (or rebuild) the composer chain for a given quality tier.
  // Called once at init, and again whenever setQuality flips us between
  // tiers — throwing away the old composer is cheap and avoids having
  // to juggle pass enable-flags.
  _build(quality) {
    this._quality = quality;
    if (quality === 'off') {
      this._composer = null;
      this._bloom = null;
      this._grade = null;
      this._enabled = false;
      return;
    }
    const composer = new EffectComposer(this._renderer);
    composer.setSize(window.innerWidth, window.innerHeight);
    composer.setPixelRatio(this._targetPixelRatio(quality));

    composer.addPass(new RenderPass(this._scene, this._camera));

    if (quality === 'full') {
      // Params tuned for the game's overall low-light palette — strength
      // low enough to not wash out the HUD, radius wide enough to feel
      // atmospheric, threshold biased so only genuine highlights
      // (eyes/muzzle/portals/souls) kick into bloom rather than every
      // mid-gray surface.
      this._bloom = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.45, // strength — softer pass, paired with brighter scene lights
        0.85, // radius
        0.82, // threshold — only genuinely hot pixels (eyes, muzzle,
              // soul orbs, portal cores) bloom; mid-tones don't bleed
      );
      composer.addPass(this._bloom);
    }

    this._grade = new ShaderPass(COLOR_GRADE_SHADER);
    if (quality === 'light') {
      // Light mode dials back everything the grade does — saves ALU on
      // weaker GPUs without losing the signature cool/warm split.
      this._grade.uniforms.uShadowWt.value = 0.08;
      this._grade.uniforms.uHiWt.value     = 0.06;
      this._grade.uniforms.uSaturation.value = 1.03;
      this._grade.uniforms.uVignette.value   = 0.22;
    }
    composer.addPass(this._grade);

    composer.addPass(new OutputPass());

    this._composer = composer;
    this._enabled = true;
  }

  // Cap the composer's backing render target resolution based on quality.
  // UnrealBloomPass allocates N mip levels of RTs; at devicePixelRatio 3
  // on a retina display that eats meaningful VRAM for minimal visual
  // benefit. The ceilings below match eyeball-tuned sweet spots.
  _targetPixelRatio(quality) {
    const dpr = window.devicePixelRatio || 1;
    if (quality === 'full')  return Math.min(dpr, 2);
    if (quality === 'light') return Math.min(dpr, 1.5);
    return 1;
  }

  setQuality(q) {
    if (q === this._quality) return;
    if (!this._renderer) { this._quality = q; return; }
    this._build(q);
  }

  onResize(w, h) {
    if (!this._composer) return;
    this._composer.setSize(w, h);
    if (this._bloom) this._bloom.setSize(w, h);
  }

  // Swap-in for renderer.render(scene, camera). Falls back to the raw
  // renderer when the composer is absent (quality='off' or init never
  // ran) so main.js can always call this regardless of mode.
  render() {
    if (this._enabled && this._composer) {
      this._composer.render();
    } else if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }
}

export const PostFX = new _PostFX();
