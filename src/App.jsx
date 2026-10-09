import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import BuyMeCoffeeButton from './BuyMeCoffee.jsx';
import './styles.css';

// ===== Model =====
// Downwards is positive throughout.
//   weight          W = m g
//   air resistance  D = k v |v|,  k = ½ ρ Cd A × (air resistance setting)
//   resultant       R = W − D (− normal contact force while in the helicopter)
//   acceleration    a = R / m
// Integrated in 1 ms steps, so the sudden jump in air resistance when the
// parachute opens stays stable.
const G = 9.8;                            // N/kg
const RHO = 1.2;                          // air density, kg/m³
const BODY = { area: 0.8, cd: 0.6 };      // spread-eagle skydiver
const CANOPY = { area: 20, cd: 1.45 };    // open round parachute
const MASS = { min: 50, max: 120, start: 75 };
const DRAG = { min: 0.5, max: 2, start: 1 };

// Sky panel (canvas units)
const SKY_W = 360;
const PX_PER_M = 5;                       // 10 m of sky = 50 units
const DIVER_X = 168;                      // the skydiver falls straight down this line (a little left of centre, to balance the labels on their right)
const HELI_FLOOR_Y = 178;                 // helicopter door sill
const STAND = 26;                         // body centre above the feet when standing
const ARROW = { perN: 0.085, max: Infinity };  // force arrow scale; set max (e.g. 230) to cap long arrows as "not to scale"
const BODY_TOP = 30;                      // top of the skydiver's body above its centre
const FIELD_DEPTH = 320;                   // how far the field's shading and tufts extend below its far edge
const GROUND_DEPTH = 18;                   // the skydiver lands this far in front of the far edge of the field
const T_GROUND = 40;                       // seconds after the jump when the ground comes into view
const CLOUD_DRIFT = 0.12;                 // clouds are distant, so they drift up far slower than the skydiver falls
const CHUTE_RANGE = [0.3, 0.8];           // the parachute opens between these fractions of the way down the sky panel (see planChuteY)
// On wide screens the whole page is drawn at this size (like a 90% browser zoom),
// and only smaller than this if it still doesn't fit the window
const PAGE_SCALE = 0.9;
const BUMP = { hold: 0.2, decay: 0.15, peak: 5, crash: 1000 };   // landing: the normal contact force is briefly 5 x weight (1000 x without a parachute), then settles back to the weight
const CHUTE_MARGIN = 50;                  // clear space (canvas units) kept below the weight arrow while the parachute opens
const NB = '\u00A0';                      // non-breaking space, so a value never gets split from its unit
const LABEL = { size: 25, line: 27 };     // force arrow labels (canvas units)

// How far the parachute, the arrows and their labels reach above and below the skydiver's centre
const reachUp = (s, F) => {
  const sc = bodyScale(s.mass);
  const top = s.chute ? 26 * sc + 128 * (0.35 + 0.65 * openFrac(s)) : 12 * sc;   // where the air resistance arrow starts
  return Math.max(BODY_TOP, top + Math.max(arrowLen(F.D) + 16, 4 * LABEL.line - 14));
};
const reachDown = (s, F) => 8 * bodyScale(s.mass) + Math.max(arrowLen(F.W) + 13, 2 * LABEL.line + 3) + 4;
// Is the whole skydiver (arrows and labels included) inside the sky panel?
// If they could never fit, say yes rather than wait for ever.
const onScreen = (s, F) => {
  const up = reachUp(s, F), down = reachDown(s, F), y = s.view.yc;
  return up + down > s.H || (y - up >= 0 && y + down <= s.H);
};
// Body size: doubling the mass makes the skydiver ∛2 times taller and wider
const bodyScale = m => Math.cbrt(m / MASS.start);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const arrowLen = F => Math.min(ARROW.max, F * ARROW.perN);
const fmtN = F => Math.round(F).toLocaleString('en-GB') + NB + 'N';
const fmtA = a => (Math.abs(a) >= 100 ? Math.round(Math.abs(a)).toLocaleString('en-GB') : Math.abs(a).toFixed(1));
const OPEN_TIME = 1;                      // seconds for the canopy to fill with air
// How far the canopy has opened: 0 = packed away, 1 = fully open
const openFrac = s => {
  if (!s.chute) return 0;
  const u = Math.min(1, Math.max(0, (s.t - s.chuteT) / OPEN_TIME));
  return u * u;                           // slow at first, then faster as air rushes in
};
const areaOf = s => BODY.area + (CANOPY.area - BODY.area) * openFrac(s);
const dragK = s => {
  const f = openFrac(s);
  return 0.5 * RHO * (BODY.cd * BODY.area * (1 - f) + CANOPY.cd * CANOPY.area * f) * s.dragF;
};

function forcesOf(s) {
  const W = s.mass * G;
  const k = dragK(s);
  const still = s.phase === 'heli' || s.phase === 'landed';
  const D = still ? 0 : k * s.v * Math.abs(s.v);
  let N = still ? W : 0;
  if (s.phase === 'landed' && s.landC0 !== undefined) {
    // hitting the ground: the normal contact force is briefly about 5 times the weight (1000 times with no parachute), then settles
    const a = s.clock - s.landC0;
    if (a < 1) N = W * (1 + ((s.chute ? BUMP.peak : BUMP.crash) - 1) * (a < BUMP.hold ? 1 : Math.exp(-(a - BUMP.hold) / BUMP.decay)));
  }
  const R = W - D - N;
  return { W, D, N, R, a: R / s.mass, vt: Math.sqrt(W / k) };
}

// ===== The walkthrough =====
// Each step runs time forward until its moment arrives (`until`) and the
// skydiver and their arrows are fully on screen (unless the step is `free`),
// then freezes time so the moment can be looked at. `action` happens as the step
// starts; `next` names the button that leaves the step; `mark` drops a
// numbered dot on the graph.
const STEPS = [
  { title: 'In the helicopter', next: 'Jump', mark: true },   // its dot sits at the origin of the graph
  { title: 'Leaving the helicopter', action: 'jump', until: s => s.t >= 0.8, mark: true },
  { title: 'Speeding up', until: (s, F) => F.D >= 0.5 * F.W, mark: true },
  { title: 'Terminal velocity', until: (s, F) => s.v >= 0.996 * F.vt, mark: true, next: 'Open parachute' },
  // pauses once the air resistance arrow fits above a skydiver in the middle of the sky
  { title: 'Parachute opens', action: 'deploy', until: (s, F) => s.chute && s.t >= s.chuteT + OPEN_TIME / 2 && reachUp(s, F) <= s.H / 2 - 8, mark: true,
    markAt: s => ({ t: s.chuteT, v: s.chuteV }) },   // the graph dot sits where the parachute started to open
  { title: 'Slowing down', until: (s, F) => F.D <= 2 * F.W, mark: true },
  // does not stop where the skydiver happens to be: they carry on falling until they next pass the middle of the sky
  { title: 'Lower terminal velocity', until: (s, F) => s.v <= 1.002 * F.vt && (s.view.mid || !!s.ground), free: true, mark: true },
];
const LAST = STEPS.length - 1;
const stepDone = (st, s, F) => st.until(s, F) && (st.free || onScreen(s, F));

// Which step describes what is happening right now (used when the
// walkthrough is off, and for anything the user does outside it). Step 2,
// 'Leaving the helicopter', is only part of the walkthrough.
function liveStage(s, F) {
  if (s.phase === 'heli') return 0;
  const r = F.D / F.W;
  if (s.chute && openFrac(s) < 1) return 4;
  if (r < 0.985) return 2;
  if (r <= 1.015) return s.chute ? 6 : 3;
  return 5;
}

function explainLanded(landV, chute) {
  const hit = `[[${landV.toFixed(1)}${NB}m/s]]`;
  return chute ? [
    `The skydiver has landed at ${hit}, slow enough to land safely. Their velocity drops to zero, as the graph shows.`,
    'As they touch down, the ground briefly pushes up with a normal contact force of about 5 times their weight, which stops them. Then the normal contact force settles to equal their weight. The forces are balanced, so they stay still.']
  : [
    `The skydiver hit the ground at ${hit} without opening their parachute. A landing at this speed would not be survivable, which is why the parachute is needed.`,
    'As they hit the ground, it briefly pushes up with a huge normal contact force, about 1,000 times their weight, which stops them abruptly. Then the normal contact force settles to equal their weight, so the forces are balanced.'];
}

// Text in [[double square brackets]] is a value, and text in {{double braces}} is an
// equation: both are drawn in a rounded box (see rich() below).
function explain(i, s, F, guided) {
  const vt = `[[${F.vt.toFixed(1)}${NB}m/s]]`;
  switch (i) {
    case 0: return [
      `The skydiver is standing in the helicopter. Their weight ([[${fmtN(F.W)}]]) pulls them down, and the floor pushes up with a normal contact force of the same size.`,
      'The forces are balanced, so the resultant force is zero and the skydiver stays still.'];
    case 1: return [
      'The skydiver has jumped. Nothing is pushing up on them now, so the normal contact force has gone.',
      `They are still moving slowly, so air resistance is tiny. The resultant force is almost equal to their weight, so they accelerate downwards at about [[9.8${NB}m/s²]].`];
    case 2: return [
      'As the skydiver speeds up, they hit more air particles every second, so air resistance increases.',
      '{{Resultant force = weight − air resistance}}, so the resultant force gets smaller and the acceleration decreases. The graph gets less steep.'];
    case 3: return [
      'Air resistance has increased until it equals the weight. The forces are balanced, so the resultant force is zero.',
      `The skydiver stops accelerating and falls at a steady ${vt}. This is their terminal velocity, and the graph reaches a plateau.`,
      ...(s.chute ? [] : ['Press the big red button to open the parachute.'])];
    case 4: return [
      `As the parachute fills with air, the surface area grows from [[${BODY.area}${NB}m²]] to [[${CANOPY.area}${NB}m²]]. In under a second, air resistance becomes much bigger than the weight.`,
      'The resultant force now acts upwards. The skydiver is still falling, but they are slowing down.',
      ...(F.D * ARROW.perN > ARROW.max ? ['The air resistance arrow is too long to draw to scale here.'] : [])];
    case 5: return [
      'As the skydiver slows down, they hit fewer air particles every second, so air resistance decreases.',
      'The upward resultant force gets smaller, so they slow down less quickly. The graph is still going down, but less steeply.'];
    default: return [
      `Air resistance has decreased until it equals the weight again. The forces are balanced, so the skydiver falls at a steady ${vt}.`,
      'This terminal velocity is much lower than before. The large parachute makes enough air resistance to balance the weight at a much lower speed, so the skydiver can land safely.',
      ...(guided ? ['The numbered dots on the graph show where time paused at each step.'] : [])];
  }
}

// Turn a paragraph into text with its values and equations in rounded boxes
const rich = text => text.split(/(\[\[.+?\]\]|\{\{.+?\}\})/g).map((part, i) =>
  part.startsWith('[[') ? <span key={i} className="chip">{part.slice(2, -2)}</span>
  : part.startsWith('{{') ? <span key={i} className="chip eq">{part.slice(2, -2)}</span>
  : part);

// ===== Simulation (plain JS) =====
class Sim {
  constructor() {
    this.mass = MASS.start;
    this.dragF = DRAG.start;
    this.reset();
  }
  reset() {
    this.phase = 'heli';
    this.t = 0; this.v = 0; this.y = 0;
    this.chute = false; this.chuteT = null;
    this.pts = [{ t: 0, v: 0 }]; this.vMax = 0;
    this.markers = [];
    this.notes = [];          // what each walkthrough step said, kept for reviewing at the end
    this.moments = [];        // the state at each step, so the sky panel can show it again
    this.clock = 0;           // drives the rotor and hover; runs before the jump too
    this.startY = 0;
    this.cloudOff = 0;        // metres fallen since the jump, for the cloud drift
    this.cloudGnd = 0;        // how far (in canvas units) the clouds have moved up with the ground, once it is in view
    this.view = { yc: 0, lastY: 0, wrapped: false, period: 1000 };   // where the skydiver is drawn in the sky panel
    this.ground = null;          // { y, t0 } once the ground has come into view
    this.landV = 0;              // speed when they hit the ground
    this.pendingChute = false;   // parachute requested, waiting for the right moment to open
    this.chuteY = undefined; this.planT = undefined;   // where (down the sky panel) it will open, and when that was last worked out
    this.H = this.H || 720;      // sky panel height, set by the app
    this.guide = null;        // { i, running } during the walkthrough
  }
  bob() { return Math.sin(this.clock * 1.7) * 2.5; }
  jump() {
    if (this.phase !== 'heli') return;
    this.startY = HELI_FLOOR_Y + this.bob() - STAND * bodyScale(this.mass);
    this.phase = 'fall';
    this.t = 0; this.v = 0; this.y = 0;
    this.pts = [{ t: 0, v: 0 }];
    this.view = { yc: this.startY, lastY: 0, wrapped: false, period: 1000 };
  }
  // The parachute opens the next time the skydiver passes the height chosen by planChuteY
  requestChute() { if (this.phase === 'fall' && !this.chute) { this.pendingChute = true; this.planT = undefined; } }
  // Where the parachute should open. As the canopy fills, the air resistance arrow gets very long, so the
  // higher up the screen they open it, the more of that arrow is cut off at the top. But the skydiver also
  // keeps falling for a second or so, and their weight arrow must stay in view with some space beneath it.
  // So this runs the opening ahead of time (for this screen height, mass and speed) to see how far they
  // fall, and opens the parachute as low as that allows. A short screen cuts more off the top.
  planChuteY() {
    const H = this.H, m = this.mass, h = 0.002;
    let v = this.v, y = 0;
    for (let t = 0; t < OPEN_TIME + 0.5; t += h) {
      const f = Math.min(1, t / OPEN_TIME) ** 2;
      const k = 0.5 * RHO * (BODY.cd * BODY.area * (1 - f) + CANOPY.cd * CANOPY.area * f) * this.dragF;
      v += (G - (k * v * Math.abs(v)) / m) * h; y += v * h * PX_PER_M;
    }
    const lowest = H - (y + reachDown(this, { W: m * G }) + CHUTE_MARGIN);   // keeps the weight and some space under it in view
    return clamp(lowest, CHUTE_RANGE[0] * H, CHUTE_RANGE[1] * H);
  }
  deploy() {
    if (this.phase !== 'fall' || this.chute) return;
    this.pendingChute = false;
    this.chute = true; this.chuteT = this.t; this.chuteV = this.v;
    this.pts.push({ t: this.t, v: this.v });
  }
  step(h) {
    if (this.phase === 'landed') return;
    const k = dragK(this);
    this.v += (G - (k * this.v * Math.abs(this.v)) / this.mass) * h;
    // Within 0.4% of terminal velocity in freefall, snap to it exactly, so
    // air resistance reads exactly equal to the weight until the parachute opens
    if (!this.chute) {
      const vt = Math.sqrt((this.mass * G) / k);
      if (Math.abs(this.v - vt) <= 0.004 * vt) this.v = vt;
    }
    this.y += this.v * h; this.t += h; this.clock += h;
    // The clouds drift up slowly while the skydiver falls past them. Once the ground is in view and the
    // skydiver stays put on screen, they move up with the ground instead, so they don't move relative to it.
    const e = this.ground ? smooth((this.t - this.ground.t0) / 0.5) : 0;
    this.cloudOff += this.v * h * (1 - e); this.cloudGnd += this.v * h * PX_PER_M * e;
    if (this.v > this.vMax) this.vMax = this.v;
    const last = this.pts[this.pts.length - 1];
    if (this.t - last.t >= 0.2 || Math.abs(this.v - last.v) >= 0.2) this.pts.push({ t: this.t, v: this.v });
    this.updateView();
  }
  // Track where the skydiver is in the sky panel. As soon as their body has
  // fallen off the bottom, they start coming back in at the top (weight
  // arrow first), while the parachute and arrow above them finish leaving.
  updateView() {
    const vw = this.view, H = this.H, F = forcesOf(this);
    const down = reachDown(this, F);
    vw.period = H + BODY_TOP + down;
    vw.mid = false;           // set below when they pass the middle of the sky panel during this step
    const dy = (this.y - vw.lastY) * PX_PER_M; vw.lastY = this.y;
    const feet = (this.chute ? 28 : 6) * bodyScale(this.mass);
    if (this.ground) {
      // The view now follows the skydiver: they stay put on screen and the
      // ground rises towards them at exactly their falling speed
      // over the first half second the motion hands over smoothly from the
      // skydiver moving down the screen to the ground moving up
      const e = smooth((this.t - this.ground.t0) / 0.5);
      vw.yc += dy * (1 - e); this.ground.y -= dy * e; this.ground.land -= dy * e;
      if (this.pendingChute) this.deploy();
      if (vw.yc + feet >= this.ground.land) this.land();
      return;
    }
    if (this.pendingChute && (this.planT === undefined || this.t - this.planT > 0.25)) { this.chuteY = this.planChuteY(); this.planT = this.t; }
    const prev = vw.yc, target = this.chuteY ?? 0.5 * H;
    vw.yc += dy;
    if (prev < H / 2 && vw.yc >= H / 2) vw.mid = true;
    if (this.pendingChute && prev < target && vw.yc >= target) this.deploy();
    for (let k = 0; k < 1000 && vw.yc - BODY_TOP > H; k++) { vw.yc -= vw.period; vw.wrapped = true; }
    // After T_GROUND seconds, once the skydiver is about 2/3 of the way down
    // the panel, the view locks onto them and the ground comes up from below
    if (this.t >= T_GROUND && vw.yc >= 0.64 * H && vw.yc <= 0.72 * H) {
      this.ground = { y: H + 24, land: H + 24 + GROUND_DEPTH, t0: this.t };
      vw.wrapped = false;
    }
  }

  land() {
    const feet = (this.chute ? 28 : 6) * bodyScale(this.mass);
    this.ground.land = this.view.yc + feet; this.ground.y = this.ground.land - GROUND_DEPTH;
    this.landV = this.v;
    this.pts.push({ t: this.t, v: this.v }, { t: this.t, v: 0 });
    this.v = 0; this.phase = 'landed'; this.pendingChute = false; this.landC0 = this.clock;
  }
  frozen() { return !!this.guide && !this.guide.running; }
  update(dt) {
    if (this.frozen()) return;
    if (this.phase === 'heli' || this.phase === 'landed') {
      if (this.phase === 'landed' && this.guide && this.guide.running) this.completeStep();   // never leave the walkthrough waiting after landing
      this.clock += dt; return;
    }
    const n = Math.max(1, Math.ceil(dt / 0.001)), h = dt / n, g = this.guide;
    for (let i = 0; i < n; i++) {
      this.step(h);
      if (g && g.running && stepDone(STEPS[g.i], this, forcesOf(this))) { this.completeStep(); break; }
    }
  }
  // --- walkthrough ---
  startGuide() { this.reset(); this.enterStep(0); }
  enterStep(i) {
    const st = STEPS[i];
    if (st.action === 'jump') this.jump();
    if (st.action === 'deploy') this.requestChute();
    this.guide = { i, running: !!st.until };
    if (!st.until) {
      this.keepNote(i);
      if (st.mark) this.markers.push({ n: i + 1, t: this.t, v: this.v });
    } else if (stepDone(st, this, forcesOf(this))) this.completeStep();
  }
  capture() {
    const { phase, t, v, y, chute, chuteT, clock, startY, cloudOff, cloudGnd, mass, dragF, pendingChute } = this;
    return { phase, t, v, y, chute, chuteT, clock, startY, cloudOff, cloudGnd, mass, dragF, pendingChute, view: { ...this.view } };
  }
  keepNote(i) {
    this.moments[i] = this.capture();
    this.notes[i] = explain(i, this, forcesOf(this), true).filter(p => !p.startsWith('Press the big red button'));
  }
  completeStep() {
    const g = this.guide;
    g.running = false;
    this.keepNote(g.i);
    // The last moment ends the walkthrough: time stays stopped for reviewing
    if (g.i >= LAST) { g.done = true; g.view = LAST; }
    const st = STEPS[g.i];
    if (st.mark) this.markers.push({ n: g.i + 1, ...(st.markAt ? st.markAt(this) : { t: this.t, v: this.v }) });
  }
  fastForward() {
    const g = this.guide;
    if (!g || !g.running) return;
    const st = STEPS[g.i];
    for (let n = 0; n < 1e6 && this.phase !== 'landed' && !stepDone(st, this, forcesOf(this)); n++) this.step(0.001);
    this.completeStep();
  }
  next() {
    const g = this.guide;
    if (!g || g.done) return;
    if (g.running) { this.fastForward(); return; }
    // Finished: time stays stopped so every step can be read again
    if (g.i >= LAST) { g.done = true; g.view = LAST; return; }
    this.enterStep(g.i + 1);
  }
  skipToEnd() {
    if (!this.guide) return;
    this.fastForward();
    while (this.guide.i < LAST) { this.enterStep(this.guide.i + 1); this.fastForward(); }
  }
  snapshot() {
    return {
      phase: this.phase, t: this.t, v: this.v, chute: this.chute, chuteT: this.chuteT, ground: this.ground, landV: this.landV,
      pendingChute: this.pendingChute, pts: this.pts, vMax: this.vMax, markers: this.markers.slice(),
      guide: this.guide ? { ...this.guide } : null, notes: this.notes.slice(), moments: this.moments.slice(),
      F: forcesOf(this),
    };
  }
}

// ===== Canvas drawing =====
const FONT = '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif';
const COL = {
  weight: '#c4400f', air: '#6a4fd6', normal: '#2e8a5a',
  suit: '#0f766e', suitDk: '#0b5a54', helmet: '#f7f7f5', visor: '#1f2937', skin: '#f0c8a8',
  pack: '#374151', boot: '#1f2937', canopy: '#d64545', gore: '#f7f3ec', lines: 'rgba(55,65,81,0.75)',
  heli: '#5b6672', heliDk: '#3b434c', glass: '#cfe3f5', stripe: '#e8a33a',
};
const CLOUDS = [
  { x: 58, f: 0.40, s: 1 }, { x: 300, f: 0.64, s: 0.85 }, { x: 92, f: 0.87, s: 1.2 },
  { x: 302, f: 0.06, s: 0.8 }, { x: 36, f: 0.10, s: 0.62 },
];

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function haloText(ctx, txt, x, y, col, lw = 3.5) {
  ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = lw; ctx.strokeText(txt, x, y);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
}
function limb(ctx, pts, w, col) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = col; ctx.stroke();
}
function circle(ctx, x, y, r, col) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }

function drawCloud(ctx, x, y, s) {
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  for (const [dx, dy, rx, ry] of [[-24, 2, 22, 11], [0, -6, 22, 15], [24, 3, 19, 10], [-2, 7, 36, 9]]) {
    ctx.beginPath(); ctx.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2); ctx.fill();
  }
}

function drawHelicopter(ctx, x, y, clock, tilt) {
  const c = Math.cos(clock * 28), s = Math.sin(clock * 28);
  ctx.save(); ctx.translate(x, y); ctx.scale(0.85, 0.85);
  ctx.translate(0, -40); ctx.rotate(tilt); ctx.translate(0, 40);
  // tail boom and fin
  ctx.fillStyle = COL.heli;
  ctx.beginPath(); ctx.moveTo(-66, -48); ctx.lineTo(-168, -40); ctx.lineTo(-168, -31); ctx.lineTo(-66, -24); ctx.closePath(); ctx.fill();
  ctx.fillStyle = COL.heliDk;
  ctx.beginPath(); ctx.moveTo(-160, -38); ctx.lineTo(-178, -72); ctx.lineTo(-167, -72); ctx.lineTo(-150, -38); ctx.closePath(); ctx.fill();
  // tail rotor
  ctx.save(); ctx.translate(-171, -52);
  ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(59,67,76,0.45)'; ctx.stroke();
  limb(ctx, [[-13 * c, -13 * s], [13 * c, 13 * s]], 2.5, COL.heliDk);
  ctx.restore();
  // skids
  ctx.strokeStyle = '#2b2f33'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-62, 18); ctx.lineTo(58, 18); ctx.quadraticCurveTo(70, 18, 72, 10);
  ctx.moveTo(-42, 2); ctx.lineTo(-46, 18); ctx.moveTo(40, 2); ctx.lineTo(44, 18); ctx.stroke();
  // body
  ctx.fillStyle = COL.heli;
  ctx.beginPath(); ctx.moveTo(-70, -8); ctx.lineTo(-70, -50); ctx.quadraticCurveTo(-70, -68, -50, -68); ctx.lineTo(38, -68);
  ctx.quadraticCurveTo(64, -68, 78, -44); ctx.quadraticCurveTo(88, -26, 82, -10); ctx.quadraticCurveTo(78, 2, 62, 2);
  ctx.lineTo(-62, 2); ctx.quadraticCurveTo(-70, 2, -70, -8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = COL.stripe; ctx.fillRect(-70, -30, 150, 6);
  ctx.fillStyle = COL.glass;
  ctx.beginPath(); ctx.moveTo(44, -63); ctx.quadraticCurveTo(63, -62, 74, -42); ctx.lineTo(48, -42); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 1.2; ctx.strokeStyle = COL.heliDk; ctx.stroke();
  rr(ctx, -58, -58, 22, 16, 4); ctx.fill();
  // open door
  ctx.fillStyle = '#262b30'; rr(ctx, -22, -64, 44, 64, 3); ctx.fill();
  // mast and main rotor
  ctx.fillStyle = COL.heliDk; ctx.fillRect(-4, -78, 8, 11);
  ctx.fillStyle = 'rgba(59,67,76,0.10)'; ctx.beginPath(); ctx.ellipse(0, -80, 118, 4, 0, 0, Math.PI * 2); ctx.fill();
  limb(ctx, [[-118 * c, -80], [118 * c, -80]], 3, COL.heliDk);
  ctx.globalAlpha = 0.7; limb(ctx, [[-118 * s, -80], [118 * s, -80]], 3, COL.heliDk); ctx.globalAlpha = 1;
  circle(ctx, 0, -80, 4, COL.heliDk);
  ctx.restore();
}

function drawHead(ctx, x, y, side) {
  circle(ctx, x, y, 7.5, COL.skin);
  ctx.fillStyle = COL.helmet; ctx.beginPath();
  if (side) ctx.arc(x, y, 8, Math.PI * 0.72, Math.PI * 1.95);
  else ctx.arc(x, y, 8, Math.PI, 0);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = COL.visor;
  if (side) rr(ctx, x + 2, y - 1, 6.5, 4, 2); else rr(ctx, x - 6, y - 1.5, 12, 4, 2);
  ctx.fill();
}
// Body centre at the origin throughout.
function drawStanding(ctx, sc, armsDown) {
  limb(ctx, [[-4, 8], [-5, 24]], 6.5, COL.suitDk);
  limb(ctx, [[4, 8], [5, 24]], 6.5, COL.suitDk);
  ctx.fillStyle = COL.boot; rr(ctx, -10, 22, 9, 4.5, 2); ctx.fill(); rr(ctx, 1, 22, 9, 4.5, 2); ctx.fill();
  ctx.fillStyle = COL.suit; rr(ctx, -9, -12, 18, 23, 7); ctx.fill();
  ctx.strokeStyle = COL.visor; ctx.lineWidth = 1.6; ctx.beginPath();
  ctx.moveTo(-6, -11); ctx.lineTo(-4, 9); ctx.moveTo(6, -11); ctx.lineTo(4, 9); ctx.stroke();
  limb(ctx, [[-8, -8], [-12, 6]], 5.5, COL.suit);
  if (armsDown) { limb(ctx, [[8, -8], [12, 6]], 5.5, COL.suit); drawHead(ctx, 0, -20, false); return; }
  // The other hand holds the door frame at a fixed point on the helicopter,
  // so the elbow bends to suit the skydiver's size
  ctx.save(); ctx.scale(1 / sc, 1 / sc);
  const S = [8 * sc, -8 * sc], T = [17, -45 + STAND * sc];
  const L1 = 10 * sc, L2 = 11.4 * sc;
  const dx = T[0] - S[0], dy = T[1] - S[1];
  const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 0.01, L1 + L2 - 0.01);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
  const px = S[0] + a * ux, py = S[1] + a * uy;
  const e1 = [px - hh * uy, py + hh * ux], e2 = [px + hh * uy, py - hh * ux];
  const E = e1[0] > e2[0] ? e1 : e2;   // elbow bends outwards
  limb(ctx, [S, E, [S[0] + d * ux, S[1] + d * uy]], 5.5 * sc, COL.suit);
  ctx.restore();
  drawHead(ctx, 0, -20, false);
}
function drawFalling(ctx) {
  limb(ctx, [[-12, 0], [-24, -8], [-31, -19]], 6, COL.suitDk);
  limb(ctx, [[8, -2], [12, -13], [22, -18]], 5, COL.suitDk);
  ctx.fillStyle = COL.suit; rr(ctx, -17, -6, 32, 12, 6); ctx.fill();
  ctx.fillStyle = COL.pack; rr(ctx, -12, -11, 19, 6, 2.5); ctx.fill();
  limb(ctx, [[-12, 2], [-26, -3], [-35, -13]], 6.5, COL.suit);
  circle(ctx, -35.5, -14, 3.6, COL.boot);
  limb(ctx, [[9, 0], [16, -9], [27, -11]], 5.5, COL.suit);
  drawHead(ctx, 21, -1, true);
}
function canopyPath(ctx, wob = 0, ph = 0) {
  ctx.beginPath(); ctx.moveTo(-78, -100);
  ctx.bezierCurveTo(-78, -136 + wob, -46, -154 + wob * 0.6, 0, -154 + wob * 0.3);
  ctx.bezierCurveTo(46, -154 - wob * 0.6, 78, -136 - wob, 78, -100);
  for (let k = 0; k < 6; k++) { const x0 = 78 - k * 26; ctx.quadraticCurveTo(x0 - 13, -107 + wob * Math.sin(k * 1.9 + ph), x0 - 26, -100); }
  ctx.closePath();
}
// Canopy fabric, gores and outline in the current transform
function fillCanopy(ctx, wob, ph) {
  canopyPath(ctx, wob, ph); ctx.fillStyle = COL.canopy; ctx.fill();
  ctx.save(); canopyPath(ctx, wob, ph); ctx.clip(); ctx.fillStyle = COL.gore;
  for (const xa of [-52, 0, 52]) { ctx.beginPath(); ctx.moveTo(0, -178); ctx.lineTo(xa - 26, -96); ctx.lineTo(xa, -96); ctx.closePath(); ctx.fill(); }
  ctx.restore();
  canopyPath(ctx, wob, ph); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(120,30,30,0.55)'; ctx.stroke();
}
function drawHanging(ctx, f, sc) {
  const g = 0.2 + 0.8 * f;
  ctx.save(); ctx.translate(0, -26 * sc); ctx.scale(g, 0.35 + 0.65 * f); ctx.translate(0, 26);
  ctx.strokeStyle = COL.lines; ctx.lineWidth = 0.9; ctx.beginPath();
  for (const x of [-78, -52, -26]) { ctx.moveTo(x, -100); ctx.lineTo(-9, -26); }
  for (const x of [26, 52, 78]) { ctx.moveTo(x, -100); ctx.lineTo(9, -26); }
  ctx.stroke();
  fillCanopy(ctx, 0, 0);
  ctx.restore();
  ctx.save(); ctx.scale(sc, sc);
  limb(ctx, [[-4, 8], [-6, 25]], 6.5, COL.suitDk);
  limb(ctx, [[4, 8], [7, 25]], 6.5, COL.suitDk);
  ctx.fillStyle = COL.boot; rr(ctx, -11, 23, 9, 4.5, 2); ctx.fill(); rr(ctx, 3, 23, 9, 4.5, 2); ctx.fill();
  ctx.fillStyle = COL.suit; rr(ctx, -9, -12, 18, 23, 7); ctx.fill();
  ctx.fillStyle = COL.pack; rr(ctx, -7, -10, 14, 5, 2); ctx.fill();
  limb(ctx, [[-8, -9], [-13, -18], [-9, -26]], 5.5, COL.suit);
  limb(ctx, [[8, -9], [13, -18], [9, -26]], 5.5, COL.suit);
  drawHead(ctx, 0, -20, false);
  ctx.restore();
}
// Scenery for the ground, scattered at random (but the same every time)
const seeded = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const TUFTS = (() => { const r = seeded(11); return Array.from({ length: 46 }, () => [r(), r(), r()]); })();
const TREES = (() => { const r = seeded(5); return Array.from({ length: 16 }, () => [r() * SKY_W, 3 + r() * 5, r()]); })();
const easeOut = u => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
const smooth = u => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };

// The field rises into view from below over a fraction of a second
function drawGround(ctx, sim, H) {
  const y = sim.ground.y;
  if (y >= H) return;
  // far hills, hazy with distance
  ctx.fillStyle = 'rgba(132,170,138,0.75)';
  ctx.beginPath(); ctx.moveTo(0, y);
  for (let x = 0; x <= SKY_W; x += 30) ctx.lineTo(x, y - 9 - 7 * Math.sin(x * 0.021 + 1.3) - 4 * Math.sin(x * 0.057));
  ctx.lineTo(SKY_W, y); ctx.closePath(); ctx.fill();
  // a line of distant trees
  for (const [tx, r, k] of TREES) { circle(ctx, tx, y - r * 0.6, r, k < 0.5 ? '#5d8a58' : '#6b9a63'); }
  // the field: lighter far away, deeper green close up, with faint mowing bands
  // (everything is placed at fixed distances from the far edge, so the
  // field moves as one piece rather than stretching)
  const g = ctx.createLinearGradient(0, y, 0, y + FIELD_DEPTH);
  g.addColorStop(0, '#a8cf74'); g.addColorStop(0.3, '#86b955'); g.addColorStop(1, '#4f8a2e');
  ctx.fillStyle = g; ctx.fillRect(0, y, SKY_W, H - y + 2);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let k = 0, yy = y + 6, hgt = 4; yy < H; k++, yy += hgt * 2, hgt *= 1.45) if (k % 2 === 0) ctx.fillRect(0, yy, SKY_W, hgt);
  ctx.fillStyle = 'rgba(255,255,240,0.35)'; ctx.fillRect(0, y, SKY_W, 1.5);
  // tufts get bigger the nearer they are
  ctx.strokeStyle = 'rgba(52,96,28,0.6)'; ctx.lineCap = 'round';
  for (const [fx, fy, fz] of TUFTS) {
    const depth = 5 + fy * fy * FIELD_DEPTH, yy = y + depth, sz = 0.45 + depth / 60 + fz * 0.3;
    if (yy - 12 * sz > H) continue;   // draw tufts partly below the edge too, so they slide into view
    const x = fx * SKY_W;
    ctx.lineWidth = 0.8 + sz * 0.5; ctx.beginPath();
    ctx.moveTo(x, yy); ctx.lineTo(x - 2.5 * sz, yy - 5 * sz);
    ctx.moveTo(x + 1.5 * sz, yy); ctx.lineTo(x + 1.5 * sz, yy - 6.5 * sz);
    ctx.moveTo(x + 3 * sz, yy); ctx.lineTo(x + 5.5 * sz, yy - 4.5 * sz);
    ctx.stroke();
  }
}
// The skydiver's shadow on the grass, darker and tighter as they get close
function drawShadow(ctx, sim, H, feetY) {
  const gl = sim.ground.land, d = Math.max(0, gl - feetY);
  const near = Math.max(0, 1 - d / 260);
  if (near <= 0) return;
  ctx.fillStyle = `rgba(30,55,20,${0.32 * near})`;
  ctx.beginPath(); ctx.ellipse(DIVER_X, gl + 2, 26 - 8 * near, 3 + 1.5 * near, 0, 0, Math.PI * 2); ctx.fill();
}
function drawDust(ctx, x, y, a, big) {
  const e = easeOut(a / 1.1);
  if (e >= 1) return;
  for (let i = 0; i < 9; i++) {
    const dir = i % 2 ? 1 : -1, sp = 0.4 + ((i * 37) % 10) / 10;
    ctx.fillStyle = `rgba(150,128,90,${(big ? 0.45 : 0.3) * (1 - e)})`;
    ctx.beginPath();
    ctx.arc(x + dir * (6 + (big ? 70 : 34) * sp * e), y - 3 - (big ? 22 : 10) * sp * e * (1 - 0.5 * e), 2.5 + (big ? 7 : 4) * e, 0, Math.PI * 2);
    ctx.fill();
  }
}
// Where a canopy point (in drawHanging's canopy coordinates) ends up
function canopyPoint(x, y, O, rot, sx, sy) {
  const lx = sx * x, ly = sy * (y + 26), c = Math.cos(rot), s = Math.sin(rot);
  return [O[0] + lx * c - ly * s, O[1] + lx * s + ly * c];
}
// The collapsed canopy as a pile of fabric on the grass, behind the skydiver
function drawHeap(ctx, gx, gy, hands, rip) {
  ctx.fillStyle = 'rgba(30,55,20,0.25)';
  ctx.beginPath(); ctx.ellipse(gx - 4, gy + 1, 48, 4, 0, 0, Math.PI * 2); ctx.fill();
  const lobes = [
    { x0: -62, x1: 28, h: 18, col: COL.canopy },
    { x0: -50, x1: 38, h: 26, col: COL.canopy },
    { x0: -30, x1: 46, h: 14, col: COL.canopy },
  ];
  lobes.forEach((L, li) => {
    const path = () => {
      ctx.beginPath(); ctx.moveTo(gx + L.x0, gy);
      const n = 5;
      for (let k = 0; k < n; k++) {
        const xa = gx + L.x0 + ((L.x1 - L.x0) * (k + 0.5)) / n, xb = gx + L.x0 + ((L.x1 - L.x0) * (k + 1)) / n;
        const hk = L.h * (0.6 + 0.4 * Math.sin(k * 2.3 + li)) + rip * Math.sin(k * 2 + li + rip * 9);
        ctx.quadraticCurveTo(xa, gy - hk * 1.6, xb, gy - (k === n - 1 ? 0 : hk * 0.55));
      }
      ctx.closePath();
    };
    path(); ctx.fillStyle = L.col; ctx.fill();
    ctx.save(); path(); ctx.clip(); ctx.fillStyle = COL.gore;
    for (let k = 0; k < 4; k++) {
      const x = gx + L.x0 + 6 + k * 19 + li * 5;
      ctx.beginPath(); ctx.moveTo(x, gy + 2); ctx.lineTo(x + 6, gy - 40); ctx.lineTo(x + 14, gy - 40); ctx.lineTo(x + 8, gy + 2); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = 'rgba(80,10,10,0.18)'; ctx.fillRect(gx + L.x0, gy - 4, L.x1 - L.x0, 4);
    ctx.restore();
    path(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(110,25,25,0.5)'; ctx.stroke();
  });
  // lines from the edge of the fabric back to the harness, sagging onto the grass
  ctx.strokeStyle = COL.lines; ctx.lineWidth = 0.9; ctx.beginPath();
  for (const dx of [36, 40, 44]) {
    ctx.moveTo(gx + dx, gy - 3);
    ctx.quadraticCurveTo((gx + dx + hands[0]) / 2, gy - 1, hands[0], hands[1]);
  }
  ctx.stroke();
}
// Lying awkwardly on the grass after landing without a parachute
function drawSprawled(ctx) {
  limb(ctx, [[-12, 2], [-24, -6], [-36, 2]], 6.5, COL.suitDk);
  limb(ctx, [[-12, 4], [-30, 5]], 6.5, COL.suit);
  circle(ctx, -37, 3, 3.6, COL.boot); circle(ctx, -32, 6, 3.6, COL.boot);
  ctx.fillStyle = COL.suit; rr(ctx, -16, -6, 30, 12, 6); ctx.fill();
  ctx.fillStyle = COL.pack; rr(ctx, -11, -10, 18, 5, 2.5); ctx.fill();
  limb(ctx, [[10, -2], [20, -12], [30, -8]], 5.5, COL.suit);
  limb(ctx, [[8, 3], [16, 6], [24, 4]], 5.5, COL.suitDk);
  ctx.save(); ctx.translate(22, 0); ctx.rotate(0.5); drawHead(ctx, 0, 0, true); ctx.restore();
}
function drawStreaks(ctx, sim) {
  const len = Math.min(110, 10 + sim.v * 1.8);
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.setLineDash([14, 12]);
  [-32, -20, 18, 31].forEach((dx, i) => {
    const y0 = -22 - (i % 2) * 8;
    ctx.lineDashOffset = -((sim.clock * sim.v * 7 + i * 9) % 26);
    ctx.beginPath(); ctx.moveTo(dx, y0); ctx.lineTo(dx, y0 - len); ctx.stroke();
  });
  ctx.restore();
}

// A vertical force arrow from (x, y). dir = 1 points down, -1 points up.
// The name can be split over several lines with \n.
function drawArrow(ctx, x, y, dir, F, col, name, side, dashed) {
  const raw = F * ARROW.perN, len = Math.min(ARROW.max, raw), broken = raw > ARROW.max;
  const tip = y + dir * len, head = Math.min(12, len), se = tip - dir * head;
  ctx.save();
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'butt';
  if (dashed) ctx.setLineDash([7, 5]);
  if (len > 1.5) {
    ctx.beginPath();
    if (broken) {
      const m = y + dir * len * 0.5;
      ctx.moveTo(x, y); ctx.lineTo(x, m - dir * 5); ctx.moveTo(x, m + dir * 5); ctx.lineTo(x, se); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1.8; ctx.beginPath();
      for (const o of [-5, 5]) { ctx.moveTo(x - 9, m + dir * o + 4); ctx.lineTo(x + 9, m + dir * o - 4); }
      ctx.stroke();
    } else { ctx.moveTo(x, y); ctx.lineTo(x, se); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(x - 7.5, se); ctx.lineTo(x + 7.5, se); ctx.lineTo(x, tip); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  const names = name.split('\n'), n = names.length + 1, { size, line } = LABEL;
  const lx = side === 'left' ? x - 12 : x + 12;
  // Up arrows hang their label from the tip, down arrows stand it on the tip; never on top of the skydiver
  const ly = dir < 0 ? Math.min(tip + 0.8 * size, y - 14 - (n - 1) * line) : Math.max(tip + 5 - (n - 1) * line, y + 22);
  ctx.textAlign = side === 'left' ? 'right' : 'left';
  ctx.font = `700 ${size}px ${FONT}`; names.forEach((t, i) => haloText(ctx, t, lx, ly + i * line, col, 6));
  ctx.font = `400 ${size}px ${FONT}`; haloText(ctx, fmtN(F), lx, ly + names.length * line, col, 6);
  if (broken) { ctx.font = `italic 400 ${Math.round(size * 0.88)}px ${FONT}`; haloText(ctx, 'not to scale', lx, ly + n * line, col, 6); }
}

function draw(ctx, sim, k, H, o) {
  // Reviewing a finished walkthrough: show the moment of the chosen step,
  // with the skydiver in the middle of the sky after they have left the helicopter
  const gd = sim.guide;
  if (gd && gd.done && sim.moments[gd.view]) {
    const m = Object.assign(Object.create(Sim.prototype), sim.moments[gd.view]);
    if (gd.view >= 2) m.view = { yc: H / 2, lastY: m.y, wrapped: false, period: 1e9 };
    m.guide = gd;
    sim = m;
  }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#9cc6ec'); g.addColorStop(1, '#e3f0fa');
  ctx.fillStyle = g; ctx.fillRect(0, 0, SKY_W, H);
  // Clouds drift upwards as the skydiver falls; bigger (nearer) clouds drift faster
  const span = H + 90;
  for (const c of CLOUDS) {
    const y0 = c.f * H - sim.cloudOff * PX_PER_M * CLOUD_DRIFT * c.s - (sim.cloudGnd || 0);
    drawCloud(ctx, c.x, (((y0 + 45) % span) + span) % span - 45, c.s);
  }

  const F = forcesOf(sim), falling = sim.phase === 'fall', bob = sim.bob();
  if (sim.ground) drawGround(ctx, sim, H);
  // The helicopter drifts away once the skydiver has gone
  // Once the skydiver has gone, the pilot tilts the nose up and the
  // helicopter backs away, tail first, climbing a little
  const tau = sim.phase !== 'heli' ? Math.max(0, sim.t - 0.4) : 0, u = Math.min(1, tau / 1.2);
  const tilt = -0.24 * u * u * (3 - 2 * u);
  const hx = DIVER_X - 15 * tau * tau;
  const hy = HELI_FLOOR_Y + bob - 11 * tau * tau;
  if (hx > -260) drawHelicopter(ctx, hx, hy, sim.clock, tilt);

  if (sim.phase === 'landed') {
    const sc = bodyScale(sim.mass), gl = sim.ground.land, a = sim.clock - sim.landC0;
    if (sim.chute) {
      // Knees bend as they touch down, then they stand; the canopy flutters,
      // tips over behind them and collapses onto the grass
      const dip = 6 * Math.sin(Math.PI * Math.min(1, a / 0.45)) * sc;
      const by = gl - STAND * sc + dip, hands = [DIVER_X - 7 * sc, by - 8 * sc];
      const c = Math.min(1, a / 2.2), e = smooth(c), heapX = DIVER_X - 62, f = openFrac(sim);
      if (c < 1) {
        const O = [DIVER_X - 62 * e * 0.85, (by - 26 * sc) + (gl - 6 - (by - 26 * sc)) * e];
        const rot = -1.52 * e, sx = (0.2 + 0.8 * f) * (1 - 0.82 * e), sy = (0.35 + 0.65 * f) * (1 - 0.4 * e);
        const wob = 7 * (1 - c) * Math.sin(a * 17), ph = a * 11;
        ctx.save(); ctx.globalAlpha = c > 0.8 ? 1 - (c - 0.8) / 0.2 : 1;
        ctx.strokeStyle = COL.lines; ctx.lineWidth = 0.9; ctx.beginPath();
        for (const x of [-78, -52, -26, 26, 52, 78]) { const [px, py] = canopyPoint(x, -100, O, rot, sx, sy); ctx.moveTo(px, py); ctx.lineTo(hands[0] + (x > 0 ? 14 * sc : 0), hands[1]); }
        ctx.stroke();
        ctx.translate(O[0], O[1]); ctx.rotate(rot); ctx.scale(sx, sy); ctx.translate(0, 26);
        fillCanopy(ctx, wob, ph);
        ctx.restore();
      }
      if (c > 0.8) { ctx.save(); ctx.globalAlpha = Math.min(1, (c - 0.8) / 0.2); drawHeap(ctx, heapX, gl, hands, 1.6 * Math.exp(-3 * Math.max(0, a - 2.2)) * Math.sin(a * 6)); ctx.restore(); }
      drawDust(ctx, DIVER_X, gl, a, false);
      ctx.save(); ctx.translate(DIVER_X, by);
      ctx.save(); ctx.scale(sc, sc); drawStanding(ctx, sc, true); ctx.restore();
      drawArrow(ctx, 0, 0, 1, F.W, COL.weight, 'Weight', 'right');
      drawArrow(ctx, -24 * sc, STAND * sc - dip, -1, F.N, COL.normal, 'Normal\ncontact\nforce', 'left');
      ctx.restore();
    } else {
      // A hard impact: a squash, a small bounce, then still; dust kicks up
      const bounce = a < 0.12 ? 0 : -10 * Math.exp(-5 * (a - 0.12)) * Math.abs(Math.sin((a - 0.12) * 9));
      drawDust(ctx, DIVER_X, gl, a, true);
      ctx.save(); ctx.translate(DIVER_X, gl - 6 * sc + bounce);
      ctx.save(); ctx.scale(sc, sc);
      if (a < 0.12) { ctx.scale(1.08, 0.8); drawFalling(ctx); } else drawSprawled(ctx);
      ctx.restore();
      drawArrow(ctx, 0, 0, 1, F.W, COL.weight, 'Weight', 'right');
      drawArrow(ctx, -30 * sc, 6 * sc - bounce, -1, F.N, COL.normal, 'Normal\ncontact\nforce', 'left');
      ctx.restore();
    }
  } else if (!falling) {
    const sc = bodyScale(sim.mass);
    ctx.save(); ctx.translate(DIVER_X, HELI_FLOOR_Y + bob - STAND * sc);
    ctx.save(); ctx.scale(sc, sc); drawStanding(ctx, sc); ctx.restore();
    drawArrow(ctx, 0, 0, 1, F.W, COL.weight, 'Weight', 'right');
    drawArrow(ctx, -24 * sc, STAND * sc, -1, F.N, COL.normal, 'Normal\ncontact\nforce', 'left');
    ctx.restore();
  } else {
    // As soon as the skydiver's body has fallen off the bottom, they start
    // coming back in at the top (weight arrow first), while the parachute
    // and air resistance arrow trailing above them finish leaving.
    const f = openFrac(sim);
    const sc = bodyScale(sim.mass);
    const airTop = sim.chute ? -26 * sc - 128 * (0.35 + 0.65 * f) : -12 * sc;
    const up = reachUp(sim, F);
    const vw = sim.view, period = vw.period;
    const copies = [vw.yc];
    // (the trailing copy is skipped while the arrow is longer than most of the screen, e.g. as the canopy
    // fills: it would only show the end of that arrow coming up from the bottom, over the weight label)
    if (vw.wrapped && up < 0.6 * H && vw.yc + period - up < H) copies.push(vw.yc + period);
    if (sim.ground) drawShadow(ctx, sim, H, vw.yc + (sim.chute ? 28 : 6) * sc);
    for (const y of copies) {
      ctx.save(); ctx.translate(DIVER_X, y);
      if (sim.chute) drawHanging(ctx, f, sc);
      else { if (sim.v > 2) drawStreaks(ctx, sim); ctx.save(); ctx.scale(sc, sc); drawFalling(ctx); ctx.restore(); }
      drawArrow(ctx, 0, 8 * sc, 1, F.W, COL.weight, 'Weight', 'right');
      drawArrow(ctx, 0, airTop, -1, F.D, COL.air, 'Air\nresistance', 'right');
      ctx.restore();
    }
  }

  // scale bar
  ctx.strokeStyle = 'rgba(24,35,43,0.75)'; ctx.lineWidth = 1.5; ctx.beginPath();
  const sb = H - 22, len = 10 * PX_PER_M;
  ctx.moveTo(16, sb); ctx.lineTo(16, sb - len); ctx.moveTo(11, sb); ctx.lineTo(21, sb); ctx.moveTo(11, sb - len); ctx.lineTo(21, sb - len); ctx.stroke();
  ctx.textAlign = 'left'; ctx.font = `700 11.5px ${FONT}`; haloText(ctx, '10 m', 25, sb - len / 2 + 4, '#25313a');
  ctx.font = `italic 400 11px ${FONT}`; haloText(ctx, 'not to scale', 9, sb + 14, '#25313a');

  // time chip
  const chip = o.frozen ? ['Time paused', '#c27a00'] : o.paused ? ['Paused', '#c27a00'] : null;
  if (chip) {
    ctx.font = `700 12.5px ${FONT}`;
    const w = ctx.measureText(chip[0]).width + 22;
    rr(ctx, 12, 12, w, 26, 13); ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = chip[1]; ctx.stroke();
    ctx.fillStyle = chip[1]; ctx.textAlign = 'left'; ctx.fillText(chip[0], 23, 29.5);
  }
  // (the "Press Jump to leave the helicopter" hint is an HTML overlay, so Jump can be a real button)
}

// ===== React UI =====
function Speedometer({ v }) {
  const cx = 110, cy = 100, sweep = 125, max = 100;
  const ang = x => -sweep + (2 * sweep * clamp(x, 0, max)) / max;
  const pt = (x, r) => { const a = (ang(x) * Math.PI) / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
  const ticks = [];
  for (let k = 0; k <= max; k += 2) {
    const major = k % 20 === 0, mid = k % 10 === 0;
    const [x1, y1] = pt(k, 84), [x2, y2] = pt(k, major ? 71 : mid ? 75 : 79);
    ticks.push(<line key={k} x1={x1} y1={y1} x2={x2} y2={y2} className={major ? 'tk major' : 'tk'} />);
  }
  const [ax, ay] = pt(0, 88), [bx, by] = pt(max, 88);
  return (
    <svg viewBox="0 0 220 194" className="meter" role="img" aria-label={`Speedometer reading ${v.toFixed(1)} metres per second`}>
      <path d={`M${ax},${ay} A88,88 0 1 1 ${bx},${by}`} className="dial" />
      {ticks}
      {[0, 20, 40, 60, 80, 100].map(k => { const [x, y] = pt(k, 59); return <text key={k} x={x} y={y + 4} className="dlab" textAnchor="middle">{k}</text>; })}
      <g transform={`rotate(${ang(v)} ${cx} ${cy})`}>
        <line x1={cx} y1={cy + 12} x2={cx} y2={cy - 76} className="needle" />
      </g>
      <circle cx={cx} cy={cy} r="6.5" className="hub" />
      <text x={cx} y={cy + 48} className="dval" textAnchor="middle">{v.toFixed(1)}</text>
      <text x={cx} y={cy + 66} className="dunit" textAnchor="middle">m/s</text>
      <text x={cx} y={cy + 86} className="dsub" textAnchor="middle">{Math.round(v * 3.6)} km/h</text>
    </svg>
  );
}

const Row = ({ sw, label, value, sub }) => (
  <div className="rrow">
    <dt>{sw && <span className={'fsw ' + sw} aria-hidden="true" />}{label}</dt>
    <dd><b>{value}</b>{sub && <small>{sub}</small>}</dd>
  </div>
);
function Readouts({ s, F }) {
  const heli = s.phase === 'heli', still = heli || s.phase === 'landed';
  const balanced = Math.abs(F.R) < 0.005 * F.W;
  const a = heli ? 0 : F.a;
  // The column is only as wide as its rows need (so the speedometer keeps as much room as it can,
  // and the gap between a label and its value stays small). Only if even that is more than there
  // is room for does the text shrink to fit, and it grows back when there is room again.
  const ref = useRef(null), [sc, setSc] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current, host = el.parentElement, cs = getComputedStyle(host);
    const inner = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const stacked = cs.gridTemplateColumns.split(' ').length < 2;
    let need = 0;
    for (const r of el.querySelectorAll('.rrow')) need = Math.max(need, (r.children[0].offsetWidth + r.children[1].offsetWidth) / sc + 0.6 * 16);
    const room = stacked ? inner : Math.min(300, inner - (parseFloat(cs.columnGap) || 0) - 130);
    const next = clamp(Math.floor((room / need) * 100) / 100, 0.6, 1);
    if (Math.abs(next - sc) >= 0.01) setSc(next);
  });
  return (
    <dl className="readouts" ref={ref} style={{ fontSize: 16 * sc + 'px' }}>
      {/* an invisible row with the longest label and a long value, so the column keeps one width */}
      <div className="rrow sizer" aria-hidden="true">
        <dt><span className="fsw n" />Normal contact force</dt>
        <dd><b>{'9,999' + NB + 'N'}</b></dd>
      </div>
      <Row sw="w" label="Weight" value={fmtN(F.W)} />
      {still
        ? <Row sw="n" label="Normal contact force" value={fmtN(F.N)} />
        : <Row sw="air" label="Air resistance" value={fmtN(F.D)} />}
      <Row label="Resultant force" value={balanced ? '0' + NB + 'N' : fmtN(Math.abs(F.R)) + (F.R > 0 ? ' ↓' : ' ↑')} />
      <Row label="Acceleration" value={`${fmtA(a)}${NB}m/s²`}
        sub={Math.abs(a) < 0.05 ? null : a > 0 ? 'speeding up' : 'slowing down'} />
      <Row label="Surface area" value={`${areaOf(s).toFixed(1)}${NB}m²`} />
    </dl>
  );
}

function VelocityGraph({ pts, now, v, vMax, falling, chuteT, markers, selected, onSelect }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  // The graph grows taller to fill whatever height the panel is given
  const [GH, setGH] = useState(226);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setGH(Math.round(clamp((640 * r.height) / r.width, 120, 700)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const L = 48, Rr = 628, Tp = 14, B = GH - 36;
  // The axes start at 30 s and 60 m/s, then grow to fit the data
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const span = Math.max(30, now * 1.03);
  const step = steps.find(st => span / st <= 7) || 3600;
  const xmax = Math.ceil(span / step) * step;
  const vm = Math.max(60, vMax * 1.05);
  // y gridlines at least ~22 units apart, so a short graph doesn't get cramped
  const ysteps = [10, 20, 50, 100, 200, 500];
  let yi = vm > 120 ? 2 : vm > 60 ? 1 : 0;
  while (yi < ysteps.length - 1 && ((B - Tp) * ysteps[yi]) / (Math.ceil(vm / ysteps[yi]) * ysteps[yi]) < 22) yi++;
  const ystep = ysteps[yi], ymax = Math.ceil(vm / ystep) * ystep;
  const xs = t => L + (t / xmax) * (Rr - L), ys = u => B - (clamp(u, 0, ymax) / ymax) * (B - Tp);
  const n = pts.length, k = Math.max(1, Math.ceil(n / 700));
  let d = '';
  for (let i = 0; i < n; i += k) d += (i ? 'L' : 'M') + xs(pts[i].t).toFixed(1) + ',' + ys(pts[i].v).toFixed(1);
  if (falling) d += 'L' + xs(now).toFixed(1) + ',' + ys(v).toFixed(1);
  const xt = []; for (let t = 0; t <= xmax + 1e-6; t += step) xt.push(t);
  const yt = []; for (let u = 0; u <= ymax + 1e-6; u += ystep) yt.push(u);
  const mins = step >= 60;
  const onMove = e => {
    const r = svgRef.current.getBoundingClientRect(), x = ((e.clientX - r.left) * 640) / r.width;
    if (x < L || x > Rr || !falling) { setHover(null); return; }
    const t = ((x - L) / (Rr - L)) * xmax;
    if (t > now) { setHover(null); return; }
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid; }
    setHover(pts[lo]);
  };
  let tip = null;
  if (hover) {
    const hx = xs(hover.t), hy = ys(hover.v), w = 122, h = 42;
    // Place the label beside the cursor, moving it left/right and up/down to
    // keep it off the velocity line and the numbered dots
    const linePts = [];
    for (let i = 0; i < n; i += k) linePts.push([xs(pts[i].t), ys(pts[i].v)]);
    if (falling) linePts.push([xs(now), ys(v)]);
    const cost = (x0, y0) => {
      let c = 0;
      for (const [px, py] of linePts) if (px > x0 - 4 && px < x0 + w + 4 && py > y0 - 4 && py < y0 + h + 4) c += 1;
      for (const m of markers) { const mx = xs(m.t), my = ys(m.v); if (mx + 10 > x0 && mx - 10 < x0 + w && my + 10 > y0 && my - 10 < y0 + h) c += 50; }
      return c;
    };
    let best = null;
    for (const x0 of [hx + 10, hx - 10 - w]) {
      if (x0 < L || x0 + w > Rr) continue;
      for (let y0 = Tp + 4; y0 <= B - h - 4; y0 += 8) {
        const sc = cost(x0, y0) * 1000 + Math.abs(y0 + h / 2 - hy) + (x0 < hx ? 30 : 0);
        if (!best || sc < best.sc) best = { x0, y0, sc };
      }
    }
    const bx = best ? best.x0 : Math.max(L, hx - w / 2), top = best ? best.y0 : Tp + 4;
    tip = (
      <g className="tip" pointerEvents="none">
        <line className="cross" x1={hx} x2={hx} y1={Tp} y2={B} />
        <circle cx={hx} cy={ys(hover.v)} r="4" fill="var(--accent)" stroke="var(--paper)" strokeWidth="2" />
        <rect className="tipbg" x={bx} y={top} width={w} height={h} rx="7" />
        <text x={bx + 10} y={top + 16} className="tt">{hover.t.toFixed(1)}{NB}s</text>
        <text x={bx + 10} y={top + 33}>Velocity</text>
        <text x={bx + w - 10} y={top + 33} textAnchor="end" fontWeight="700">{hover.v.toFixed(1)}{NB}m/s</text>
      </g>
    );
  }
  const chuteX = chuteT !== null ? xs(chuteT) : null;
  return (
    <div className="gwrap" ref={wrapRef}>
    <svg ref={svgRef} viewBox={`0 0 640 ${GH}`} className="tgraph" role="img"
      aria-label={falling ? `Velocity against time. After ${now.toFixed(1)} seconds the velocity is ${v.toFixed(1)} metres per second.` : 'Velocity against time. The graph starts when the skydiver jumps.'}
      onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {yt.map(u => (
        <g key={'y' + u}>
          <line x1={L} x2={Rr} y1={ys(u)} y2={ys(u)} className="grid" />
          <text x={L - 7} y={ys(u) + 4} className="tick" textAnchor="end">{u}</text>
        </g>
      ))}
      {xt.map(t => <text key={'x' + t} x={xs(t)} y={B + 16} className="tick" textAnchor="middle">{mins ? t / 60 : t}</text>)}
      <text x={(L + Rr) / 2} y={B + 33} className="atitle" textAnchor="middle">{mins ? 'Time (minutes)' : 'Time (seconds)'}</text>
      <text x={12} y={(Tp + B) / 2} className="atitle" textAnchor="middle" transform={`rotate(-90 12 ${(Tp + B) / 2})`}>Velocity (m/s)</text>
      {chuteX !== null && (
        <g>
          <line className="ev" x1={chuteX} x2={chuteX} y1={Tp} y2={B} />
          <text className="evl" x={chuteX > Rr - 110 ? chuteX - 5 : chuteX + 5} y={Tp + 11} textAnchor={chuteX > Rr - 110 ? 'end' : 'start'}>Parachute opens</text>
        </g>
      )}
      <path d={d} className="vline" />
      {falling && <circle cx={xs(now)} cy={ys(v)} r="4.5" className="vdot" />}
      {markers.map(m => {
        // the dot for the origin (step 1) sits just below and right of the corner, clear of both axes and of dot 2
        const ox = m.t === 0 && m.v === 0 ? 26 : 0, oy = ox ? 20 : 0;
        return (
        <React.Fragment key={m.n}>
        {ox > 0 && (() => {
          // a short arrow from the dot to the origin, so it is clear what the (1) refers to
          const len = Math.hypot(ox, oy), ux = ox / len, uy = oy / len;
          const tx = xs(m.t) + ux * 3, ty = ys(m.v) + uy * 3;          // tip, just off the corner
          const bx = xs(m.t) + ox - ux * 9, by = ys(m.v) + oy - uy * 9;  // starts at the dot's edge
          const hx = tx + ux * 7, hy = ty + uy * 7, px = -uy * 3.5, py = ux * 3.5;
          return (
            <g className="origin-arrow" pointerEvents="none">
              <line x1={bx} y1={by} x2={hx} y2={hy} />
              <polygon points={`${tx},${ty} ${hx + px},${hy + py} ${hx - px},${hy - py}`} />
            </g>
          );
        })()}
        <g className={'marker' + (m.n === selected ? ' sel' : '') + (onSelect ? ' pick' : '')}
          // hovering the (1) dot puts the cursor line on x = 0, where it points
          {...(ox ? { onPointerMove: e => { e.stopPropagation(); if (falling) setHover(pts[0]); } } : {})}
          {...(onSelect ? { role: 'button', tabIndex: 0, 'aria-label': `Step ${m.n}: ${STEPS[m.n - 1].title}`,
            onClick: () => onSelect(m.n - 1), onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(m.n - 1); } } } : {})}>
          <circle cx={xs(m.t) + ox} cy={ys(m.v) + oy} r="9" />
          <text x={xs(m.t) + ox} y={ys(m.v) + oy + 4} textAnchor="middle">{m.n}</text>
        </g>
        </React.Fragment>
        );
      })}
      {!falling && <text x={(L + Rr) / 2} y={(Tp + B) / 2} className="empty" textAnchor="middle">The graph starts when the skydiver jumps</text>}
      <line x1={L} x2={Rr} y1={B} y2={B} className="axis" />
      <line x1={L} x2={L} y1={Tp} y2={B} className="axis" />
      {tip}
    </svg>
    </div>
  );
}

// a panel that can be minimised to its title bar
function Panel({ title, open, onToggle, className, actions, children }) {
  return (
    <figure className={'fig' + (className ? ' ' + className : '') + (open ? '' : ' min')}>
      <div className="fighead">
        <h2>{title}</h2>
        <div className="headtools">
          {actions}
          {onToggle && (
            <button className="minbtn" aria-expanded={open} aria-label={(open ? 'Minimise ' : 'Restore ') + title}
              title={open ? 'Minimise' : 'Restore'} onClick={onToggle}>
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d={open ? 'M2 6 H10' : 'M6 2 V10 M2 6 H10'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {open && <div className="figbody">{children}</div>}
    </figure>
  );
}

function FullscreenButton() {
  const [isFull, setIsFull] = useState(false);
  const available = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  useEffect(() => {
    const on = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggle = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* some embedded browsers refuse full screen */ }
  };
  if (!available) return null;
  return (
    <button type="button" className="btn iconbtn" onClick={e => { toggle(); e.currentTarget.blur(); }}
      aria-label={isFull ? 'Exit full screen' : 'Enter full screen'} title={isFull ? 'Exit full screen' : 'Full screen'}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={isFull ? 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5' : 'M9 4H4v5 M15 4h5v5 M9 20H4v-5 M15 20h5v-5'} />
      </svg>
    </button>
  );
}

const Switch = ({ checked, onChange, label, title }) => (
  <label className="swgroup" title={title}>
    <span className="insw">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="track" aria-hidden="true" />
    </span>
    <span>{label}</span>
  </label>
);

function App() {
  const cvRef = useRef(null), simRef = useRef(null);
  if (!simRef.current) simRef.current = new Sim();
  const [ui, setUi] = useState(() => simRef.current.snapshot());
  const [paused, setPaused] = useState(false);
  const [mass, setMass] = useState(MASS.start);
  const [dragF, setDragF] = useState(DRAG.start);
  const [stepMode, setStepMode] = useState(false);
  const [graphOpen, setGraphOpen] = useState(true);
  const [storyOpen, setStoryOpen] = useState(true);
  const [advOpen, setAdvOpen] = useState(false);
  const optsRef = useRef({}), stageRef = useRef(null), hintRef = useRef(null), appRef = useRef(null);
  optsRef.current = { paused };
  const refresh = () => setUi(simRef.current.snapshot());


  useEffect(() => {
    const sim = simRef.current, cv = cvRef.current, ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    // The sky panel stretches to fill its box; the drawing keeps a width of
    // SKY_W units and its height in units follows the box's shape.
    const box = { w: 0, h: 0 };
    const measure = () => { const st = stageRef.current; box.w = st.clientWidth; box.h = st.clientHeight; };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(stageRef.current);
    let raf, last = performance.now(), sized = '';
    const loop = now => {
      const k = (box.w / SKY_W) * dpr, h = box.w ? (SKY_W * box.h) / box.w : 720;
      const key = box.w + 'x' + box.h;
      if (sized !== key) {
        cv.width = Math.round(box.w * dpr); cv.height = Math.round(box.h * dpr); sized = key;
        stageRef.current.style.setProperty('--k', box.w / SKY_W);   // canvas units to pixels, for the HTML overlay
      }
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
      const o = optsRef.current;
      sim.H = h;
      if (!o.paused) sim.update(dt);
      draw(ctx, sim, k, h, { ...o, frozen: sim.frozen(), reduced: rm.matches, now: now / 1000 });
      if (hintRef.current) hintRef.current.style.transform = `translateY(${rm.matches ? 0 : Math.sin((now / 1000) * 3) * 3 * (box.w / SKY_W)}px)`;
      setUi(sim.snapshot());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // Fit the whole page to the window (and to the screen in full screen), so it
  // never scrolls: the graph takes up any spare height, and on short windows
  // everything is zoomed down until it fits. Narrow (stacked) layouts scroll as normal.
  useLayoutEffect(() => {
    const app = appRef.current;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const vw = window.innerWidth, vh = window.innerHeight;
      const inst = app.querySelector('.instruments');
      if (inst) { inst.classList.remove('tall'); inst.style.zoom = ''; inst.style.width = ''; inst.style.flex = ''; }
      if (vw <= 900) { app.classList.remove('fit'); app.style.zoom = ''; app.style.height = ''; return; }
      app.classList.add('fit');
      let z = PAGE_SCALE;
      for (let i = 0; i < 5; i++) {
        app.style.zoom = String(z);
        app.style.height = vh / z + 'px';
        // how far the columns' contents run past the space they were given
        const over = Math.max(0, ...['.lab', '.sky'].map(q => { const e = app.querySelector(q); return e ? e.scrollHeight - e.clientHeight : 0; }));
        if (over <= 1) break;
        z = Math.max(0.4, vh / (vh / z + over));   // zoom out so the full height fits the window
      }
      growInstruments();
    };
    // With the graph or the explanation minimised, the speedometer, readouts and
    // buttons are enlarged into the freed-up height (the graph, if open, keeps a fair share)
    const growInstruments = () => {
      const lab = app.querySelector('.lab'), inst = app.querySelector('.instruments');
      const story = app.querySelector('.storyfig'), graph = app.querySelector('.graphfig');
      if (!lab || !inst || !story || !graph) return;
      const sMin = story.classList.contains('min'), gMin = graph.classList.contains('min');
      if (!sMin && !gMin) return;
      const R = e => e.getBoundingClientRect();
      const labR = R(lab), k = labR.width / lab.clientWidth;   // on-screen pixels per page pixel
      const gap = (parseFloat(getComputedStyle(lab).rowGap) || 14) * k;
      let graphKeep = R(graph).height;
      if (!gMin) { const gw = graph.querySelector('.gwrap'); graphKeep = graphKeep - R(gw).height + Math.max(220 * k, 0.3 * labR.height); }
      const room = labR.height - R(story).height - graphKeep - 2 * gap;
      // Try the cards side by side and stacked; keep whichever lets them grow more
      const tryLayout = tall => {
        inst.classList.toggle('tall', tall);
        inst.style.zoom = ''; inst.style.width = '';
        inst.style.flex = 'none';                // measure its natural height, not a stretched one
        const h0 = R(inst).height;
        const minW = 520;                        // keep the cards from getting cramped
        let z = Math.min(1.7, room / h0, lab.clientWidth / minW);
        for (let i = 0; i < 3 && z > 1.02; i++) {
          inst.style.zoom = String(z);
          inst.style.width = lab.clientWidth / z + 'px';
          const h = R(inst).height;
          if (h <= room + 1) break;
          z *= room / h;
        }
        return z;
      };
      // Zooming the side-by-side cards would squeeze the speedometer, so only the
      // stacked arrangement is enlarged, and only when that really makes it bigger
      const z = tryLayout(true);
      if (z <= 1.05) { inst.classList.remove('tall'); inst.style.zoom = ''; inst.style.width = ''; }
      inst.style.flex = '';
    };
    const later = () => { if (!raf) raf = requestAnimationFrame(fit); };
    fit();
    window.addEventListener('resize', later);
    document.addEventListener('fullscreenchange', later);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(later);
    return () => { window.removeEventListener('resize', later); document.removeEventListener('fullscreenchange', later); if (raf) cancelAnimationFrame(raf); };
  }, []);
  // Panels opening or closing change how much room is needed
  useLayoutEffect(() => { window.dispatchEvent(new Event('resize')); }, [storyOpen, graphOpen, advOpen, stepMode]);

  // Walkthrough keys: Enter, Space or → moves on. Outside it, Space pauses.
  useEffect(() => {
    const onKey = e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return;
      const sim = simRef.current;
      if (sim.guide && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight')) {
        e.preventDefault(); sim.next(); setUi(sim.snapshot());
      } else if (!sim.guide && e.key === ' ') {
        e.preventDefault(); setPaused(p => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const s = ui, F = s.F, g = s.guide;
  const done = !!(g && g.done);
  const landed = s.phase === 'landed';
  const stage = done ? g.view : g ? g.i : landed ? STEPS.length : liveStage(s, F);
  // While reviewing, the instruments show the chosen step's moment too
  const shownS = (done && s.moments[stage]) || s, shownF = shownS === s ? F : forcesOf(shownS);
  const canJump = g ? g.i === 0 && !g.running : s.phase === 'heli';
  const canChute = g ? g.i === 3 && !g.running : s.phase === 'fall' && !s.chute && !s.pendingChute;
  const chuteCaption = s.phase === 'landed' ? 'Landed' : s.chute ? 'Parachute open' : s.pendingChute ? 'Opening…' : s.phase === 'heli' ? 'Jump first'
    : g && !canChute ? 'Wait for terminal velocity' : 'Press to open';

  // Once landed (outside the walkthrough) Reset becomes "Jump again": back in the helicopter, ready to jump
  const again = !g && landed;
  const jump = () => {
    const sim = simRef.current;
    if (sim.guide) { if (canJump) sim.next(); } else sim.jump();
    setPaused(false); refresh();
  };
  const parachute = () => {
    const sim = simRef.current;
    if (sim.guide) { if (canChute) sim.next(); } else if (canChute) sim.requestChute();
    refresh();
  };
  const reset = () => {
    const sim = simRef.current;
    if (stepMode) sim.startGuide(); else sim.reset();
    setPaused(false); refresh();
  };
  const toggleStep = () => {
    const sim = simRef.current, on = !stepMode;
    setStepMode(on);
    if (on) { sim.startGuide(); setPaused(false); } else sim.guide = null;
    refresh();
  };
  const next = () => { simRef.current.next(); refresh(); };
  // After Finish, once the skydiver has landed, the numbers on the graph still open that step again
  const canReview = done || (!g && landed && s.notes.some(Boolean));
  const review = i => {
    const sim = simRef.current;
    if (!sim.notes[i]) return;
    if (!sim.guide && sim.phase === 'landed') sim.guide = { i: LAST, running: false, done: true, view: i };
    if (sim.guide && sim.guide.done) { sim.guide.view = i; refresh(); }
  };
  const runAgain = () => { simRef.current.startGuide(); setPaused(false); refresh(); };
  const exitGuide = () => { simRef.current.guide = null; refresh(); };
  const skip = () => { simRef.current.skipToEnd(); refresh(); };
  // Mass and air resistance sliders; drawn under the sky panel, or under the
  // controls card when everything stacks on a narrow screen
  const advanced = sfx => (
    <>
    <button className="advtoggle" aria-expanded={advOpen} aria-controls={"adv" + sfx} onClick={() => setAdvOpen(o => !o)}>
      <span>Advanced controls</span>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d={advOpen ? 'M2 6 H10' : 'M6 2 V10 M2 6 H10'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
    <div className="settings" id={"adv" + sfx} hidden={!advOpen}>
      <label className="slider" htmlFor={"mass" + sfx}>
        <span>Mass</span>
        <input id={"mass" + sfx} type="range" min={MASS.min} max={MASS.max} step="1" value={mass}
          onChange={e => { const v = Number(e.target.value); setMass(v); simRef.current.mass = v; refresh(); }} />
        <output htmlFor={"mass" + sfx}>{mass}{NB}kg</output>
      </label>
      <label className="slider" htmlFor={"drag" + sfx} title="Scales the air resistance at every speed, like a more or less streamlined body position">
        <span>Air resistance</span>
        <input id={"drag" + sfx} type="range" min={DRAG.min} max={DRAG.max} step="0.1" value={dragF}
          onChange={e => { const v = Number(e.target.value); setDragF(v); simRef.current.dragF = v; refresh(); }} />
        <output htmlFor={"drag" + sfx}>{'×'}{dragF.toFixed(1)}</output>
      </label>
    </div>
    </>
  );
  const nextLabel = !g ? '' : g.running ? 'Skip ahead' : g.i === LAST ? 'Finish' : STEPS[g.i].next || 'Next';
  const redNext = !!g && !g.running && nextLabel === 'Open parachute';   // hints at the big red button

  // Every text the explanation panel can show is laid out in the same spot, with only the current one
  // visible, so the panel keeps the height of the longest one instead of jumping about
  const landV = landed ? s.landV : 99.9;
  const expItems = [
    ...STEPS.map((st, i) => ({ key: i, title: st.title, paras: (done && s.notes[i]) || explain(i, s, F, !!g) })),
    { key: 'landed-chute', title: 'Landed', paras: explainLanded(landV, true) },
    { key: 'landed-hard', title: 'Landed', paras: explainLanded(landV, false) },
  ];
  const activeKey = g ? stage : landed ? (s.chute ? 'landed-chute' : 'landed-hard') : stage;

  return (
    <div className="app" ref={appRef}>
      <header className="top">
        <FullscreenButton />
        <a className="favicon-link" href="https://awm11.github.io/" target="_blank" rel="noopener noreferrer" aria-label="Visit awm11.github.io">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="favicon-img" />
        </a>
        <div className="title-block">
          <h1>Skydiving and terminal velocity</h1>
          <p className="lede">Jump from the helicopter, watch the forces change, then open the parachute.</p>
        </div>
      </header>

      <main className="layout">
        <section className="sky">
          <div className="stage" ref={stageRef}>
            <canvas ref={cvRef} role="img"
              aria-label={`Skydiver ${s.phase === 'heli' ? 'standing in a helicopter' : s.chute ? 'falling under an open parachute' : 'in freefall'}. Weight ${fmtN(F.W)}, air resistance ${fmtN(F.D)}.`} />
            {s.phase === 'heli' && !s.guide && (
              <div className="jumphint" ref={hintRef}>
                Press <button type="button" className="hintjump" onClick={jump}>Jump</button> to leave the helicopter
              </div>
            )}
          </div>
          <div className="adv adv-sky">{advanced('')}</div>
        </section>

        <section className="lab">


          <div className={'instruments' + (!graphOpen && !storyOpen ? ' stacked' : '')}>
            <figure className="fig gauges">
              <Speedometer v={shownS.v} />
              <Readouts s={shownS} F={shownF} />
            </figure>
            <div className="adv adv-lab">{advanced('-2')}</div>
            <div className="deck">
              <div className="chutefig">
                <span className="chute-ring">
                <button className={'chute-btn' + (s.chute ? ' pressed' : '') + (s.pendingChute ? ' armed' : canChute && (g || stage === 3) ? ' pulse' : '')}
                onClick={parachute} disabled={!canChute && !s.pendingChute} aria-label={s.pendingChute ? 'Parachute about to open' : 'Open the parachute'}>Parachute</button>
                </span>
                <p className="chute-cap">{chuteCaption}</p>
              </div>
              <div className="controls">
                <div className="pair">
                  {!again && <button className="btn primary" onClick={jump} disabled={!canJump}>{s.phase === 'heli' ? 'Jump' : 'Jumped'}</button>}
                  <button className={'btn ' + (again ? 'primary' : 'ghost')} onClick={reset}>{again ? 'Jump again' : 'Reset'}</button>
                </div>
                <button className={'btn pausebtn' + (paused ? ' on' : '')} aria-pressed={paused} onClick={() => setPaused(p => !p)}>
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d={paused ? 'M3 1.5 L10.5 6 L3 10.5 Z' : 'M2.5 1.5 h2.6 v9 h-2.6 z M6.9 1.5 h2.6 v9 h-2.6 z'} fill="currentColor" />
                  </svg>
                  {paused ? 'Play' : 'Pause'}
                </button>
                <Switch checked={stepMode} onChange={toggleStep} label="Step-by-step"
                title="Pause time at each key moment of the jump and explain it" />
              </div>
            </div>
          </div>

          <Panel title="What is happening" className="storyfig" open={storyOpen} onToggle={() => setStoryOpen(o => !o)}
            actions={!storyOpen && g && !done
              ? <button className={'btn primary sm' + (redNext ? ' chutego' : '')} onClick={next}>{nextLabel}</button> : null}>
          <div className="story">
            <ol className="steps">
              {STEPS.map((st, i) => done ? (
                <li key={i} className={i === stage ? 'now' : 'done'}>
                  <button className="steplink" onClick={() => review(i)} aria-pressed={i === stage}>
                    <span className="num">{i + 1}</span>{st.title}
                  </button>
                </li>
              ) : (
                <li key={i} className={i < stage ? 'done' : i === stage ? 'now' : ''}>
                  <span className="num">{i < stage ? '✓' : i + 1}</span>{st.title}
                </li>
              ))}
            </ol>
            <div className="explain" aria-live="polite">
              {g && <div className="stepcount">Step {stage + 1} of {STEPS.length}</div>}
              <div className="expstack">
                {expItems.map(it => (
                  <div key={it.key} className={'exp' + (it.key === activeKey ? '' : ' ghost')} aria-hidden={it.key !== activeKey}>
                    <h3>{it.title}</h3>
                    {it.paras.map((p, j) => <p key={j}>{rich(p)}</p>)}
                  </div>
                ))}
              </div>
              {done && (
                <div className="walkfoot">
                  <span className="walktip">Walkthrough finished. Click any step to read it again.</span>
                  <button className="btn ghost" onClick={exitGuide}>Finish</button>
                  <button className="btn primary" onClick={runAgain}>Run again</button>
                </div>
              )}
              {g && !done && (
                <div className="walkfoot">
                  {g.i < LAST && <button className="btn ghost" onClick={skip}>Skip to end</button>}
                  <button className={'btn primary' + (redNext ? ' chutego' : '')} onClick={next}>{nextLabel}</button>
                </div>
              )}
            </div>
          </div>
          </Panel>

          <Panel title="Velocity against time" className="graphfig" open={graphOpen} onToggle={() => setGraphOpen(o => !o)}>
            <VelocityGraph pts={s.pts} now={s.t} v={s.v} vMax={s.vMax} falling={s.phase !== 'heli'} chuteT={s.chuteT} markers={s.markers} selected={done ? stage + 1 : null} onSelect={canReview ? review : null} />
          </Panel>

        </section>
      </main>

      <div className="bottom-block">
        <div className="more-left">
          <a className="more-sims" href="https://awm11.github.io/" target="_blank" rel="noopener noreferrer">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="more-sims-icon" />
            <span>See other simulations</span>
          </a>
          <p className="more-sims-note">Click the icon above to explore other interactive physics simulations like this one, or <span className="side-right">on the right</span><span className="side-below">below</span> to support the project.</p>
        </div>
        <div className="coffee-row"><BuyMeCoffeeButton /></div>
      </div>

    </div>
  );
}

export default App;
