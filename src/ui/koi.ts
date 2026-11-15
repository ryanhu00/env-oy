import { backgroundFor, type Appearance } from './theme';

export type Rgb = readonly [number, number, number];

/** Largest fish count the settings allow. */
export const KOI_MAX_COUNT = 12;
type Tone = 'white' | 'red' | 'orange' | 'gold' | 'black';

/** Fish segments from head to tail fin. */
const SEGMENTS = 10;
/**
 * Pond pixels per "unit". A pixel is one column wide and half a row tall (a half-block
 * glyph), so pixels are small and square; one unit is twice that, which keeps the fish the
 * same on-screen size as their unit-based dimensions below.
 */
const U = 1.8;
/** Body radius of each segment: head, shoulders, belly, taper, then the tail fan. */
const RADII = [1.7, 2.2, 2.5, 2.4, 2.0, 1.6, 1.2, 1.5, 1.3, 0.8].map((r) => r * U);
/** Distance between neighbouring segment centres. */
const SPACING = 1.25 * U;
/** Fish colour strength over a blank cell vs. under text (kept low so text stays readable). */
const BLANK_ALPHA = 0.9;
const TEXT_ALPHA = 0.3;

/** Most ripples spreading at once. */
const MAX_RIPPLES = 3;
/** Ring radius as a fraction of the ripple's radius, and each ring's strength. */
const RIPPLE_RINGS: readonly (readonly [number, number])[] = [[1, 1], [0.68, 0.6], [0.42, 0.35]];
/** Half-width of a ring in pixels. */
const RIPPLE_THICKNESS = 1.5;
/** Quantised strengths (pixel-art steps) of a ripple pixel, faint to strong. */
const RIPPLE_LEVELS = [0.4, 0.7, 1] as const;
/** Water-highlight colour and maximum strength of a ripple, per appearance (kept subtle). */
const RIPPLE_TONE = {
  dark: { color: [150, 185, 215] as Rgb, alpha: 0.2 },
  light: { color: [96, 128, 160] as Rgb, alpha: 0.2 },
};

/** Colour pattern per koi variety, one tone per segment (head to tail). */
const PATTERNS: readonly (readonly Tone[])[] = [
  ['white', 'red', 'red', 'white', 'red', 'red', 'white', 'white', 'white', 'white'], // kohaku
  ['red', 'white', 'white', 'white', 'white', 'white', 'white', 'white', 'white', 'white'], // tancho
  ['gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold'], // ogon
  ['orange', 'orange', 'orange', 'orange', 'white', 'orange', 'orange', 'orange', 'orange', 'orange'], // orange
  ['white', 'red', 'white', 'black', 'red', 'red', 'white', 'black', 'white', 'white'], // sanke
  ['black', 'red', 'black', 'white', 'red', 'black', 'white', 'black', 'white', 'black'], // showa
];

interface Palette {
  tones: Record<Tone, Rgb>;
  eye: Rgb;
  /** Colour of the fish's shadow on the water. */
  shadow: Rgb;
}

interface Sprite {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Packed colours (see `pack`), 0 = transparent. */
  color: Int32Array;
}

const WHITE: Rgb = [255, 255, 255];
/** Deep blue-black used for outlines and the dark shading band. */
const DEEP: Rgb = [12, 18, 46];
/** Direction the light comes from (unit vector, top-left). */
const LIGHT = [-0.55, -0.83] as const;
/** Where a fish's shadow falls, in pond pixels. */
const SHADOW_OFFSET = [2, 3] as const;

/**
 * Packs a colour into the grid format.
 * @param c Colour.
 * @returns `(r << 16 | g << 8 | b) + 1`, so 0 can mean "water".
 */
function pack(c: Rgb): number {
  return ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) + 1;
}

/**
 * Reverses `pack`.
 * @param packed A non-zero packed colour.
 * @returns The colour.
 */
function unpack(packed: number): Rgb {
  const v = packed - 1;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Stable pseudo-random value for a fish-local coordinate, so colour patches keep their
 * shape while the fish moves instead of shimmering.
 * @param seed Per-fish seed.
 * @param a First coordinate (segment index).
 * @param b Second coordinate (lateral band).
 * @returns Float in [0, 1).
 */
function noise(seed: number, a: number, b: number): number {
  const n = Math.sin(seed * 12.9898 + a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Koi colours tuned per appearance: on black the whites are bright and the blacks lifted so
 * they stay visible; on white the whites are a pale blue-grey and the reds/golds deeper.
 * @param appearance Current light/dark appearance.
 * @returns Tone colours plus the eye colour.
 */
export function koiPalette(appearance: Appearance): Palette {
  return appearance === 'light'
    ? { tones: { white: [206, 218, 236], red: [208, 54, 54], orange: [232, 122, 32], gold: [214, 162, 34], black: [56, 64, 84] }, eye: [12, 12, 18], shadow: [214, 220, 230] }
    : { tones: { white: [236, 238, 246], red: [226, 72, 62], orange: [242, 142, 52], gold: [234, 192, 72], black: [84, 94, 124] }, eye: [14, 16, 24], shadow: [8, 12, 24] };
}

interface Point {
  x: number;
  y: number;
}

/** A ring of ripples spreading from a point and fading out. */
interface Ripple {
  x: number;
  y: number;
  age: number;
  life: number;
  /** Radius in pixels once fully spread. */
  radius: number;
}

interface Fish {
  x: number;
  y: number;
  heading: number;
  turn: number;
  turnTarget: number;
  turnTimer: number;
  speed: number;
  phase: number;
  scale: number;
  pattern: number;
  /** Seed for this fish's patch noise. */
  noise: number;
  spine: Point[];
}

/**
 * Small deterministic PRNG so ponds are reproducible in tests.
 * @param seed Any integer.
 * @returns Function returning floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Smallest signed difference between two angles.
 * @param to Target angle in radians.
 * @param from Current angle in radians.
 * @returns Value in [-π, π].
 */
function angleDiff(to: number, from: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * A pond of koi drawn on a fine pixel grid: one pixel is one terminal column wide and half a
 * row tall (painted with half-block glyphs), so pixels are small and square. Fish wander with smooth steering, avoid the edges, and wag their tails;
 * each frame is rasterised into a grid that `paintPond` composites behind terminal rows.
 */
export class KoiPond {
  private w = 0;
  private h = 0;
  private fish: Fish[] = [];
  private grid = new Int32Array(0);
  private rows = new Uint8Array(0);
  private appearance: Appearance = 'dark';
  private readonly random: () => number;
  /** Separate stream so ripples never change where the fish swim. */
  private readonly rippleRandom: () => number;
  private readonly ripplesOn: boolean;
  private ripples: Ripple[] = [];
  private rippleTimer: number;

  /**
   * @param options `seed` makes the pond reproducible; `count` fixes the number of fish
   * (default scales with the pond area); `ripples: false` turns the water ripples off.
   */
  constructor(options: { seed?: number; count?: number; ripples?: boolean } = {}) {
    const seed = options.seed ?? Date.now();
    this.random = mulberry32(seed);
    this.rippleRandom = mulberry32(seed ^ 0x9e3779b9);
    this.ripplesOn = options.ripples ?? true;
    this.rippleTimer = 0.4 + this.rippleRandom() * 1.2;
    this.fixedCount = options.count;
  }

  /** Number of fish when set; otherwise the count scales with the pond area. */
  private fixedCount: number | undefined;

  /**
   * Fixes the number of fish, or returns to the automatic count.
   * @param count Fish to keep (at least 1), or undefined for automatic.
   * @returns Nothing; fish are added or removed immediately.
   */
  setCount(count: number | undefined): void {
    this.fixedCount = count === undefined ? undefined : Math.max(1, Math.floor(count));
    if (this.w === 0) return;
    this.syncFish();
    this.rasterize();
  }

  /**
   * Adds or removes fish to reach the wanted count (new fish spawn inside the pond).
   * @returns Nothing.
   */
  private syncFish(): void {
    const want = this.fixedCount ?? clamp(Math.round((this.w * this.h) / 3600), 2, 6);
    this.fish = this.fish.slice(0, want);
    while (this.fish.length < want) this.fish.push(this.spawn(this.fish.length));
  }

  /** @returns Pond width in pixels (terminal columns). */
  get width(): number {
    return this.w;
  }

  /** @returns Pond height in pixels (terminal rows x 2). */
  get height(): number {
    return this.h;
  }

  /** @returns How many fish are swimming. */
  get fishCount(): number {
    return this.fish.length;
  }

  /** @returns How many ripples are currently spreading. */
  get rippleCount(): number {
    return this.ripples.length;
  }

  /**
   * Resizes the pond, adding or removing fish to suit the new area and re-homing any fish
   * left outside it.
   * @param width Pixels across.
   * @param height Pixels down.
   * @returns Nothing.
   */
  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.w && height === this.h) return;
    this.w = width;
    this.h = height;
    this.grid = new Int32Array(width * height);
    this.rows = new Uint8Array(height);
    this.syncFish();
    for (const f of this.fish) {
      if (f.x < 0 || f.x >= width || f.y < 0 || f.y >= height) this.place(f);
      this.layoutSpine(f);
    }
    this.rasterize();
  }

  /**
   * Switches the colour palette.
   * @param appearance Light or dark.
   * @returns Nothing.
   */
  setAppearance(appearance: Appearance): void {
    if (appearance === this.appearance) return;
    this.appearance = appearance;
    this.rasterize();
  }

  /**
   * Advances the simulation.
   * @param dt Elapsed seconds (callers clamp long gaps).
   * @returns Nothing.
   */
  step(dt: number): void {
    if (this.w === 0 || dt <= 0) return;
    const margin = Math.min(12 * U, Math.min(this.w, this.h) / 3);
    for (const f of this.fish) {
      f.turnTimer -= dt;
      if (f.turnTimer <= 0) {
        f.turnTarget = (this.random() * 2 - 1) * 0.7;
        f.turnTimer = 1.5 + this.random() * 3;
      }
      let target = f.turnTarget;
      if (f.x < margin || f.x > this.w - margin || f.y < margin || f.y > this.h - margin) {
        const desired = Math.atan2(this.h / 2 - f.y, this.w / 2 - f.x);
        target = clamp(angleDiff(desired, f.heading) * 1.6, -1.5, 1.5);
      }
      f.turn += (target - f.turn) * Math.min(1, dt * 2.5);
      f.heading += f.turn * dt;
      const speed = f.speed * (1 - 0.25 * Math.min(1, Math.abs(f.turn)));
      f.x += Math.cos(f.heading) * speed * dt;
      f.y += Math.sin(f.heading) * speed * dt;
      f.phase += dt * (5 + speed / U);
      f.spine[0] = { x: f.x, y: f.y };
      const spacing = SPACING * f.scale;
      for (let i = 1; i < SEGMENTS; i++) {
        const prev = f.spine[i - 1];
        const cur = f.spine[i];
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        const k = spacing / (Math.hypot(dx, dy) || 1e-6);
        cur.x = prev.x + dx * k;
        cur.y = prev.y + dy * k;
      }
    }
    this.stepRipples(dt);
    this.rasterize();
  }

  /**
   * Ages the ripples, drops finished ones, and starts a new one now and then.
   * @param dt Elapsed seconds.
   * @returns Nothing.
   */
  private stepRipples(dt: number): void {
    if (!this.ripplesOn) return;
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < r.life);
    this.rippleTimer -= dt;
    if (this.rippleTimer > 0) return;
    this.rippleTimer = 2.5 + this.rippleRandom() * 3.5;
    if (this.ripples.length >= MAX_RIPPLES) return;
    const r = this.rippleRandom;
    this.ripples.push({
      x: r() * this.w,
      y: r() * this.h,
      age: 0,
      life: 5.5 + r() * 2.5,
      radius: clamp(Math.min(this.w, this.h) * 0.5, 14, 48) * (0.7 + r() * 0.5),
    });
  }

  /**
   * Paints the ripple rings (concentric, pixel-stepped, fading as they spread) into the grid.
   * @param plot Writes one packed pixel.
   * @returns Nothing.
   */
  private drawRipples(plot: (px: number, py: number, packed: number) => void): void {
    if (this.ripples.length === 0) return;
    const water = backgroundFor(this.appearance);
    const tone = RIPPLE_TONE[this.appearance];
    for (const ripple of this.ripples) {
      const t = ripple.age / ripple.life;
      const spread = ripple.radius * (1 - (1 - t) * (1 - t));
      const fade = Math.pow(1 - t, 1.4);
      const x0 = Math.max(0, Math.floor(ripple.x - spread - 2));
      const x1 = Math.min(this.w - 1, Math.ceil(ripple.x + spread + 2));
      const y0 = Math.max(0, Math.floor(ripple.y - spread - 2));
      const y1 = Math.min(this.h - 1, Math.ceil(ripple.y + spread + 2));
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const d = Math.hypot(px + 0.5 - ripple.x, py + 0.5 - ripple.y);
          let strength = 0;
          for (const [k, weight] of RIPPLE_RINGS) {
            if (spread * k < 2) continue;
            strength = Math.max(strength, weight * (1 - Math.abs(d - spread * k) / RIPPLE_THICKNESS));
          }
          strength *= fade;
          if (strength <= 0.1) continue;
          const level = RIPPLE_LEVELS[strength > 0.55 ? 2 : strength > 0.3 ? 1 : 0];
          plot(px, py, pack(mix(water, tone.color, level * tone.alpha)));
        }
      }
    }
  }

  /**
   * Tells whether any pond pixel (fish, shadow or ripple) lies on a terminal row, a cheap
   * reject for the painter.
   * @param y Terminal row; covers pond pixel rows 2y and 2y+1.
   * @returns True when either pixel row has at least one pixel to draw.
   */
  rowHasPixels(y: number): boolean {
    return y >= 0 && 2 * y < this.h && (this.rows[2 * y] === 1 || this.rows[2 * y + 1] === 1);
  }

  /**
   * Reads one pond pixel.
   * @param px Pixel column.
   * @param py Pixel row.
   * @returns 0 for water, otherwise the packed colour `(r << 16 | g << 8 | b) + 1`.
   */
  rgbAt(px: number, py: number): number {
    return px >= 0 && px < this.w && py >= 0 && py < this.h ? this.grid[py * this.w + px] : 0;
  }

  private spawn(index: number): Fish {
    const r = this.random;
    const f: Fish = {
      x: 0,
      y: 0,
      heading: r() * Math.PI * 2,
      turn: 0,
      turnTarget: 0,
      turnTimer: r() * 3,
      speed: (2.2 + r() * 2) * U,
      phase: r() * Math.PI * 2,
      scale: 0.85 + r() * 0.35,
      pattern: (index + Math.floor(r() * PATTERNS.length)) % PATTERNS.length,
      noise: r() * 100,
      spine: Array.from({ length: SEGMENTS }, () => ({ x: 0, y: 0 })),
    };
    this.place(f);
    this.layoutSpine(f);
    return f;
  }

  private place(f: Fish): void {
    const m = Math.min(8 * U, Math.min(this.w, this.h) / 3);
    f.x = m + this.random() * Math.max(0, this.w - 2 * m);
    f.y = m + this.random() * Math.max(0, this.h - 2 * m);
  }

  private layoutSpine(f: Fish): void {
    const spacing = SPACING * f.scale;
    for (let i = 0; i < SEGMENTS; i++) {
      f.spine[i] = { x: f.x - Math.cos(f.heading) * spacing * i, y: f.y - Math.sin(f.heading) * spacing * i };
    }
  }

  /**
   * Draws every fish as pixel art: hard-edged silhouettes, a 1px dark outline, three-band
   * shading with dithered transitions, jagged colour patches, rayed tail fins, glossy eyes,
   * and a soft shadow on the water.
   */
  private rasterize(): void {
    this.grid.fill(0);
    this.rows.fill(0);
    const palette = koiPalette(this.appearance);
    const sprites = this.fish.map((f) => this.sprite(f, palette));
    const plot = (px: number, py: number, packed: number): void => {
      if (px < 0 || px >= this.w || py < 0 || py >= this.h) return;
      this.grid[py * this.w + px] = packed;
      this.rows[py] = 1;
    };
    this.drawRipples(plot); // water first: shadows and fish sit on top of it
    const shadow = pack(palette.shadow);
    const [sx, sy] = SHADOW_OFFSET;
    // shadows first so a fish never sits under another fish's shadow
    for (const s of sprites) {
      for (let ly = 0; ly < s.h; ly++) {
        for (let lx = 0; lx < s.w; lx++) if (s.color[ly * s.w + lx]) plot(s.x0 + lx + sx, s.y0 + ly + sy, shadow);
      }
    }
    for (const s of sprites) {
      for (let ly = 0; ly < s.h; ly++) {
        for (let lx = 0; lx < s.w; lx++) {
          const c = s.color[ly * s.w + lx];
          if (c) plot(s.x0 + lx, s.y0 + ly, c);
        }
      }
    }
  }

  /**
   * Renders one fish into a small local pixel buffer (positions relative to its bounding box).
   * @param f Fish to draw.
   * @param palette Current koi palette.
   * @returns The sprite's origin, size, and packed colours (0 = transparent).
   */
  private sprite(f: Fish, palette: Palette): Sprite {
    const pattern = PATTERNS[f.pattern];
    const forward: Point[] = [];
    const centres: Point[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      let fx = Math.cos(f.heading);
      let fy = Math.sin(f.heading);
      if (i > 0) {
        const dx = f.spine[i - 1].x - f.spine[i].x;
        const dy = f.spine[i - 1].y - f.spine[i].y;
        const len = Math.hypot(dx, dy) || 1;
        fx = dx / len;
        fy = dy / len;
      }
      forward.push({ x: fx, y: fy });
      // the tail swings more than the head: a travelling wave along the body
      const swing = 1.5 * U * f.scale * Math.pow(i / (SEGMENTS - 1), 1.4) * Math.sin(f.phase - i * 0.65);
      centres.push({ x: f.spine[i].x - fy * swing, y: f.spine[i].y + fx * swing });
    }
    const pad = Math.ceil(Math.max(...RADII) * f.scale + 3 * U);
    const x0 = Math.floor(Math.min(...centres.map((c) => c.x)) - pad);
    const y0 = Math.floor(Math.min(...centres.map((c) => c.y)) - pad);
    const w = Math.ceil(Math.max(...centres.map((c) => c.x)) + pad) - x0 + 1;
    const h = Math.ceil(Math.max(...centres.map((c) => c.y)) + pad) - y0 + 1;
    const part = new Uint8Array(w * h); // 0 water, 1 body, 2 fin
    const color = new Int32Array(w * h);
    const fill = (cx: number, cy: number, r: number, kind: number, colorOf: (px: number, py: number, dx: number, dy: number) => Rgb): void => {
      for (let py = Math.floor(cy - r); py <= Math.floor(cy + r); py++) {
        for (let px = Math.floor(cx - r); px <= Math.floor(cx + r); px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          const lx = px - x0;
          const ly = py - y0;
          if (dx * dx + dy * dy > r * r || lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
          part[ly * w + lx] = kind;
          color[ly * w + lx] = pack(colorOf(px, py, dx, dy));
        }
      }
    };
    // pectoral fins, behind the body
    const flap = 0.5 + 0.5 * Math.sin(f.phase * 0.6);
    const finBase = pattern[2] === 'black' ? palette.tones.white : palette.tones[pattern[2]];
    const finTone = mix(finBase, WHITE, 0.4);
    const finColor = (px: number, py: number): Rgb => ((px + py) & 1 ? finTone : mix(finTone, WHITE, 0.2));
    for (const side of [-1, 1]) {
      // a leaf: a rounded root on the body, and a smaller tip swept outward and back
      const reach = RADII[2] * f.scale + (0.3 + 0.5 * flap) * U;
      const fx = forward[2].x;
      const fy = forward[2].y;
      const px0 = centres[2].x - fy * side * reach - fx * 0.2 * U;
      const py0 = centres[2].y + fx * side * reach - fy * 0.2 * U;
      fill(px0, py0, 1.15 * U * f.scale, 2, finColor);
      fill(px0 - fy * side * 0.9 * U - fx * 1.3 * U, py0 + fx * side * 0.9 * U - fy * 1.3 * U, 0.85 * U * f.scale, 2, finColor);
    }
    // body, tail to head so the head sits on top
    for (let i = SEGMENTS - 1; i >= 0; i--) {
      const r = RADII[i] * f.scale;
      const nx = -forward[i].y;
      const ny = forward[i].x;
      fill(centres[i].x, centres[i].y, r, 1, (px, py, dx, dy) => {
        const lat = dx * nx + dy * ny;
        // jagged patch edges: neighbouring segments swap colour by a stable per-fish noise
        let j = i;
        if (i > 0 && i < SEGMENTS - 1) j = Math.max(0, Math.min(SEGMENTS - 1, Math.round(i + (noise(f.noise, i, Math.round(lat)) - 0.5) * 1.8)));
        let tone = palette.tones[pattern[j]];
        // posterised light from the top-left, dithered where the bands meet
        const s = -((dx / r) * LIGHT[0] + (dy / r) * LIGHT[1]);
        const dither = (px + py) & 1;
        let level = 0;
        if (s > 0.46) level = 1;
        else if (s > 0.3) level = dither ? 1 : 0;
        else if (s < -0.46) level = -1;
        else if (s < -0.3) level = dither ? -1 : 0;
        if (level === 1) tone = mix(tone, WHITE, 0.26);
        else if (level === -1) tone = mix(tone, DEEP, 0.34);
        // fin rays in the tail
        if (i >= 7 && Math.abs(Math.round(lat)) % 2 === 1) tone = mix(tone, WHITE, 0.22);
        return tone;
      });
    }
    // 1px outline where the silhouette meets water
    const out = color.slice();
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        const at = ly * w + lx;
        if (!part[at]) continue;
        const edge = lx === 0 || ly === 0 || lx === w - 1 || ly === h - 1 || !part[at - 1] || !part[at + 1] || !part[at - w] || !part[at + w];
        if (edge) out[at] = pack(mix(unpack(color[at]), DEEP, 0.62));
      }
    }
    // eyes with a glint
    for (const side of [-1, 1]) {
      const ex = centres[0].x + (forward[0].x * 0.5 - forward[0].y * side * 0.95) * U;
      const ey = centres[0].y + (forward[0].y * 0.5 + forward[0].x * side * 0.95) * U;
      for (let py = Math.floor(ey - 1.1); py <= Math.floor(ey + 1.1); py++) {
        for (let px = Math.floor(ex - 1.1); px <= Math.floor(ex + 1.1); px++) {
          const dx = px + 0.5 - ex;
          const dy = py + 0.5 - ey;
          const lx = px - x0;
          const ly = py - y0;
          if (dx * dx + dy * dy <= 1.1 * 1.1 && lx >= 0 && ly >= 0 && lx < w && ly < h) out[ly * w + lx] = pack(palette.eye);
        }
      }
      const gx = Math.floor(ex - 0.5) - x0;
      const gy = Math.floor(ey - 0.5) - y0;
      if (gx >= 0 && gy >= 0 && gx < w && gy < h && out[gy * w + gx] === pack(palette.eye)) out[gy * w + gx] = pack([244, 247, 255]);
    }
    return { x0, y0, w, h, color: out };
  }
}

/**
 * Display width of one code point (0 for combining marks, 2 for wide CJK/emoji, else 1).
 * @param cp Unicode code point.
 * @returns Terminal columns the character occupies.
 */
function cellWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Composites the pond behind one rendered screen row. Each cell holds two stacked pond pixels:
 * blank cells become half-block glyphs (`▀`/`▄`, or a plain background when both halves
 * match) coloured per pixel; cells with text keep their character and only get a faint
 * background tint, so the text stays readable. Cells that are highlighted (explicit
 * background) or inverse are left alone. When the row ends in an erase-to-end-of-line, the
 * remainder is filled explicitly so fish can swim through it.
 * @param row ANSI row string (SGR sequences, text, optional trailing `ESC[K`).
 * @param y Terminal row; covers pond pixel rows 2y and 2y+1.
 * @param pond Pond to draw.
 * @param bg Theme background colour, used as the "water" and for blending.
 * @param totalWidth Visible width of the row in columns.
 * @returns The row with fish composited in (the same string when no fish is on this row).
 */
export function paintPond(row: string, y: number, pond: KoiPond, bg: Rgb, totalWidth: number): string {
  if (!pond.rowHasPixels(y)) return row;
  let out = '';
  let x = 0;
  let i = 0;
  let state: string[] = [];
  let bgExplicit = false;
  let inverse = false;
  // colour overrides currently active on the terminal ('' = the row's own colour)
  let curFg = '';
  let curBg = '';
  const restore = (): void => {
    if (curFg || curBg) {
      out += '\x1b[0m' + state.join('');
      curFg = '';
      curBg = '';
    }
  };
  const blend = (packed: number, alpha: number): string => {
    const c = packed - 1;
    return `${Math.round(bg[0] + (((c >> 16) & 255) - bg[0]) * alpha)};${Math.round(bg[1] + (((c >> 8) & 255) - bg[1]) * alpha)};${Math.round(bg[2] + ((c & 255) - bg[2]) * alpha)}`;
  };
  /** Emits one cell with the requested colour overrides, touching the terminal state as little as possible. */
  const put = (ch: string, fg: string, background: string, fgMatters: boolean): void => {
    if ((!background && curBg) || (fgMatters && !fg && curFg)) restore();
    const parts: string[] = [];
    if (background && background !== curBg) {
      parts.push(`48;2;${background}`);
      curBg = background;
    }
    if (fgMatters && fg && fg !== curFg) {
      parts.push(`38;2;${fg}`);
      curFg = fg;
    }
    if (parts.length) out += `\x1b[${parts.join(';')}m`;
    out += ch;
  };
  /** Draws the cell at column `col` (a space or a text character) over the pond. */
  const cell = (col: number, ch: string, isSpace: boolean): void => {
    const top = pond.rgbAt(col, 2 * y);
    const bottom = pond.rgbAt(col, 2 * y + 1);
    if (!top && !bottom) {
      restore();
      out += ch;
    } else if (!isSpace) {
      // text: tint the background with the average of both halves
      const t = top ? blend(top, TEXT_ALPHA) : bg.join(';');
      const b = bottom ? blend(bottom, TEXT_ALPHA) : bg.join(';');
      const [tr, tg, tb] = t.split(';').map(Number);
      const [br, bgn, bb] = b.split(';').map(Number);
      put(ch, '', `${Math.round((tr + br) / 2)};${Math.round((tg + bgn) / 2)};${Math.round((tb + bb) / 2)}`, true);
    } else if (top && bottom) {
      const t = blend(top, BLANK_ALPHA);
      const b = blend(bottom, BLANK_ALPHA);
      if (t === b) put(' ', '', b, false);
      else put('▀', t, b, true);
    } else if (top) put('▀', blend(top, BLANK_ALPHA), '', true);
    else put('▄', blend(bottom, BLANK_ALPHA), '', true);
  };
  while (i < row.length) {
    if (row.charCodeAt(i) === 0x1b && row[i + 1] === '[') {
      let j = i + 2;
      while (j < row.length && (row.charCodeAt(j) < 0x40 || row.charCodeAt(j) > 0x7e)) j++;
      const seq = row.slice(i, j + 1);
      const final = row[j];
      const body = row.slice(i + 2, j);
      i = j + 1;
      restore();
      if (final === 'm') {
        const params = body.split(';').map((p) => (p === '' ? 0 : Number(p)));
        let reset = false;
        for (let k = 0; k < params.length; k++) {
          const p = params[k];
          if (p === 0) {
            reset = true;
            bgExplicit = false;
            inverse = false;
          } else if (p === 7) inverse = true;
          else if (p === 27) inverse = false;
          else if (p === 49) bgExplicit = false;
          else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) bgExplicit = true;
          else if (p === 38 || p === 48) {
            const mode = params[k + 1];
            if (mode === 2) {
              if (p === 48) bgExplicit = !(params[k + 2] === bg[0] && params[k + 3] === bg[1] && params[k + 4] === bg[2]);
              k += 4;
            } else if (mode === 5) {
              if (p === 48) bgExplicit = true;
              k += 2;
            }
          }
        }
        state = reset ? [seq] : [...state, seq];
      } else if (final === 'K' && x < totalWidth && !bgExplicit && !inverse) {
        for (; x < totalWidth; x++) cell(x, ' ', true);
        restore();
      }
      out += seq;
      continue;
    }
    const cp = row.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const width = cellWidth(cp);
    if (width === 0) {
      out += ch;
    } else if (!bgExplicit && !inverse) {
      cell(x, ch, cp === 32);
      x += width;
    } else {
      restore();
      out += ch;
      x += width;
    }
  }
  restore();
  return out;
}
