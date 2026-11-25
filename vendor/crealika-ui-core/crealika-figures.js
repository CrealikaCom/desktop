/*
 * Crealika UI figures: a random look and drawing of a standing or walking little person on a
 * canvas. ES module; classic scripts get the same object as window.CrealikaFigures.
 *
 * A figure is described in metres from the point between the feet (y goes up) and drawn at
 * scale s (pixels per metre). Arms default to walking or standing; a scene can pass its own arm
 * poses and an item held in a hand. Layers: facing away, items -> arms -> hands -> body; facing
 * the viewer, body -> head -> arms -> items -> hands (a hand always holds the item on top).
 * An arm is never longer than ARM_REACH: a hand that cannot reach is pulled towards the shoulder.
 */
const SKIN = ['#f5d6bd', '#eebf9a', '#d9a07a', '#b97c55', '#8d5a3a', '#6b4128', '#f8e0cc'];
const HAIR = ['#2a1c13', '#3f2716', '#6e4322', '#a0652d', '#d2a556', '#e6cd8c', '#9c3a1f', '#151515', '#8e8a86', '#5b3a5e'];
const SHIRT = ['#c94f3d', '#3a5a90', '#e2a33a', '#5f8f69', '#8db3d8', '#d98c8c', '#6b4c7a', '#2f3b4b', '#f3efe7', '#b5643a', '#3d8c8a', '#e86f51'];
const PANTS = ['#2e3a55', '#3b3b3f', '#6a5944', '#4a5e79', '#2a2a2a', '#5c4a3d'];
const BAGS = ['#2f3d4f', '#7a3b2e', '#4e6b43', '#c48a35', '#55406a', '#1f2a24'];
const HATS = ['#f2b632', '#e8743b', '#d9483b', '#3a7bc8'];
// Hairstyles: women have long hair, a ponytail or a bun, men have short hair, so figures are easy
// to tell apart at a glance; most women also get a skirt, eyelashes and lips. scarf is a headscarf (colour cap).
const HAIR_STYLES = {
  female: ['long', 'long', 'long', 'ponytail', 'ponytail', 'bun', 'scarf'],
  male: ['short', 'short', 'curly', 'buzz', 'beanie'],
};
const SKIRTS = ['#c94f3d', '#3a5a90', '#6b4c7a', '#2f3b4b', '#d98c8c', '#5f8f69', '#e2a33a', '#3d8c8a'];
const SCARVES = ['#c94f3d', '#3a5a90', '#e2a33a', '#5f8f69', '#d98c8c', '#6b4c7a', '#3d8c8a', '#f3efe7'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const shade = (hex, f) => {
  const c = hexRgb(hex).map((v) => Math.round(clamp(f < 0 ? v * (1 + f) : v + (255 - v) * f, 0, 255)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.3, r), 0, Math.PI * 2);
  ctx.fill();
}

function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A random look. opts.bag is the chance of a backpack (0.6 by default), opts.hardhat the chance of a
 * hard hat instead of hair (0), opts.female the chance of a woman (0.5), opts.skirt the chance of a
 * skirt for a woman (0.8). A woman has long hair, a ponytail, a bun or a headscarf, eyelashes and
 * lips, and is slightly shorter and narrower in the shoulders; skirt is its colour, legs under it are
 * skin-coloured (trousers `pants` with a headscarf).
 */
function makeLook(opts = {}) {
  const shirt = pick(SHIRT);
  const hardhat = chance(opts.hardhat ?? 0);
  const female = chance(opts.female ?? 0.5);
  const skirt = female && chance(opts.skirt ?? 0.8) ? pick(SKIRTS.filter((c) => c !== shirt)) : null;
  const style = hardhat ? 'hardhat' : pick(HAIR_STYLES[female ? 'female' : 'male']);
  let cap;
  if (hardhat) cap = pick(HATS);
  else if (style === 'scarf') cap = pick(SCARVES.filter((c) => c !== shirt));
  else cap = pick(SHIRT);
  return {
    skin: pick(SKIN), hair: pick(HAIR), shirt, shirtDark: shade(shirt, -0.16),
    pants: pick(PANTS), bag: chance(opts.bag ?? 0.6) ? pick(BAGS) : null,
    style, cap,
    hf: female ? rand(0.94, 1.03) : rand(0.99, 1.1), bw: female ? rand(0.86, 0.98) : rand(0.96, 1.12),
    glasses: chance(0.25),
    female, skirt,
  };
}

/**
 * A skirt over the legs: waist to knee, wider at the hem, always symmetric. The hem width is constant
 * and covers the widest step, so legs never show at the sides and the skirt does not sway.
 */
function drawSkirt(ctx, look, X, Y, hip) {
  const top = hip + 0.04, hem = hip - 0.38;
  const half = 0.17 * look.bw;
  // Legs go from the pelvis (0.08·bw off the axis) to the foot; at the widest step the foot is 0.17 m further out.
  const stride = (bottom) => {
    const from = 0.08 * look.bw, foot = 0.085 * look.bw + 0.17;
    return from + (foot - from) * ((hip - bottom) / (hip - 0.06)) + 0.085;
  };
  const path = (bottom) => {
    const w = Math.max(0.25 * look.bw, stride(bottom));
    ctx.beginPath();
    ctx.moveTo(X(-half), Y(top));
    ctx.lineTo(X(half), Y(top));
    ctx.lineTo(X(w), Y(bottom));
    ctx.quadraticCurveTo(X(0), Y(bottom - 0.035), X(-w), Y(bottom));
    ctx.closePath();
  };
  ctx.fillStyle = shade(look.skirt, -0.18);
  path(hem);
  ctx.fill();
  ctx.fillStyle = look.skirt;
  path(hem + 0.035);
  ctx.fill();
}

const ARM_REACH = 0.6;             // shoulder to hand, m (scaled by height hf)

/** Shoulder height above the floor for a standing figure, m. */
const shoulderY = (look, hip = 0.84 * look.hf) => hip + 0.58 * look.hf - 0.06;

/** The hand pulled towards the shoulder when the arm cannot reach the point. */
function clampHand(look, side, x, y, hip) {
  const sx = side * (0.42 * look.bw / 2 - 0.04), sy = shoulderY(look, hip);
  const dx = x - sx, dy = y - sy, d = Math.hypot(dx, dy), max = ARM_REACH * look.hf;
  return d <= max ? { x, y } : { x: sx + dx * max / d, y: sy + dy * max / d };
}

/** Default arms: hanging loose, swinging while walking. */
function walkArms(look, pose) {
  const hip = pose.hip ?? 0.84 * look.hf;
  const sw = 0.42 * look.bw;
  const arms = [];
  for (const side of [-1, 1]) {
    const ph = (pose.phase || 0) + (side > 0 ? 0 : Math.PI);
    let x = side * (sw / 2 + 0.03), y = hip - 0.03;
    if (pose.walking && pose.facing === 'side') x += Math.sin(ph) * 0.12;
    else if (pose.walking) y += Math.sin(ph) * 0.04;
    arms.push({ side, x, y });
  }
  return arms;
}

/**
 * Draws a figure. pose: x, y is the point on the floor (px); s is px per metre;
 * facing is 'front' | 'back' | 'side'; dir is ±1, the direction when facing 'side';
 * phase is the step phase; walking; hip is the pelvis height in m (standing by default);
 * arms is [{side, x, y, hand, item(ctx, hx, hy)}] in metres from the feet;
 * armsBehind puts the arms under the body (default: when facing away);
 * face is {gaze, down, blink, talk}; shadow draws a shadow (true by default).
 */
function draw(ctx, look, pose) {
  const s = pose.s;
  const facing = pose.facing || 'front';
  const dir = pose.dir >= 0 ? 1 : -1;
  const walking = !!pose.walking;
  const hip = pose.hip ?? 0.84 * look.hf;
  const bob = walking ? Math.abs(Math.sin(pose.phase || 0)) * 0.035 : 0;
  const x0 = pose.x, y0 = pose.y - bob * s;
  const X = (dx) => x0 + dx * s;
  const Y = (h) => y0 - h * s;
  const torsoTop = hip + 0.58 * look.hf;
  const sw = 0.42 * look.bw, hw = 0.34 * look.bw;
  const R = 0.13 * look.hf * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const armsBehind = pose.armsBehind ?? facing === 'back';

  // Items: under the arms when facing away, over them when facing the viewer; hands always on top.
  const drawArms = () => {
    const arms = (pose.arms || walkArms(look, { ...pose, hip }))
      .map((a) => ({ ...a, ...clampHand(look, a.side, a.x, a.y, hip) }));
    const items = () => {
      for (const a of arms) if (a.item) a.item(ctx, X(a.x), Y(a.y));
      ctx.lineCap = 'round';
    };
    if (armsBehind) items();
    for (const a of arms) {
      ctx.strokeStyle = look.shirtDark;
      ctx.lineWidth = Math.max(1, 0.095 * s);
      ctx.beginPath();
      ctx.moveTo(X(a.side * (sw / 2 - 0.04)), Y(torsoTop - 0.06));
      ctx.lineTo(X(a.x), Y(a.y));
      ctx.stroke();
    }
    if (!armsBehind) items();
    ctx.fillStyle = look.skin;
    for (const a of arms) if (a.hand !== false) circle(ctx, X(a.x), Y(a.y), 0.045 * s);
  };

  if (pose.shadow !== false && hip > 0.6) {
    ctx.fillStyle = 'rgba(70, 45, 25, 0.16)';
    ctx.beginPath();
    ctx.ellipse(x0, pose.y, 0.3 * s, 0.07 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (armsBehind) drawArms();

  // legs
  if (hip > 0.58) {
    for (const side of [-1, 1]) {
      const ph = (pose.phase || 0) + (side > 0 ? Math.PI : 0);
      let fx = side * 0.085 * look.bw, lift = 0;
      if (walking) {
        if (facing === 'side') fx += Math.sin(ph) * 0.17;
        else lift = Math.max(0, Math.sin(ph)) * 0.08;
      }
      // Skin-coloured legs under a skirt; trousers under it with a headscarf.
      const bare = look.skirt && look.style !== 'scarf';
      ctx.strokeStyle = bare ? look.skin : look.pants;
      ctx.lineWidth = Math.max(1, (bare ? 0.11 : 0.14) * s);
      ctx.beginPath();
      ctx.moveTo(X(side * 0.08 * look.bw), Y(hip));
      ctx.lineTo(X(fx), Y(lift + 0.06));
      ctx.stroke();
      ctx.fillStyle = '#2b2522';
      ctx.beginPath();
      ctx.ellipse(X(fx + (facing === 'side' ? dir * 0.04 : 0)), Y(lift + 0.035), 0.075 * s, 0.04 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (look.skirt && hip > 0.58) drawSkirt(ctx, look, X, Y, hip);

  const hx = X(0);
  const hy = Y(torsoTop + 0.03) - R;

  // from the front, long hair shows behind the shoulders, so it goes before the body
  if (facing !== 'back' && look.style === 'long') {
    ctx.fillStyle = look.hair;
    rrect(ctx, hx - R * 1.12, hy - R * 0.9, R * 2.24, R * 2.55, R * 0.9);
    ctx.fill();
  }

  // body
  ctx.fillStyle = look.shirt;
  ctx.beginPath();
  ctx.moveTo(X(-sw / 2), Y(torsoTop - 0.06));
  ctx.quadraticCurveTo(X(-sw / 2), Y(torsoTop), X(-sw / 2 + 0.07), Y(torsoTop));
  ctx.lineTo(X(sw / 2 - 0.07), Y(torsoTop));
  ctx.quadraticCurveTo(X(sw / 2), Y(torsoTop), X(sw / 2), Y(torsoTop - 0.06));
  ctx.lineTo(X(hw / 2), Y(hip));
  ctx.lineTo(X(-hw / 2), Y(hip));
  ctx.closePath();
  ctx.fill();

  // backpack from behind / straps from the front
  if (look.bag) {
    if (facing === 'back') {
      ctx.fillStyle = look.bag;
      rrect(ctx, X(-0.15), Y(torsoTop - 0.05), 0.3 * s, 0.36 * s, 0.06 * s);
      ctx.fill();
      ctx.fillStyle = shade(look.bag, 0.18);
      rrect(ctx, X(-0.11), Y(torsoTop - 0.22), 0.22 * s, 0.12 * s, 0.03 * s);
      ctx.fill();
    } else {
      ctx.strokeStyle = look.bag;
      ctx.lineWidth = Math.max(0.8, 0.04 * s);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(X(side * 0.12), Y(torsoTop));
        ctx.lineTo(X(side * 0.1), Y(torsoTop - 0.3));
        ctx.stroke();
      }
    }
  }

  // neck
  ctx.fillStyle = shade(look.skin, -0.08);
  ctx.fillRect(X(-0.045), Y(torsoTop + 0.06), 0.09 * s, 0.08 * s);

  const face = pose.face || {};
  drawHead(ctx, hx, hy + (pose.headDy || 0) * s, R, look, facing, {
    gaze: face.gaze ?? (facing === 'side' ? dir : 0),
    down: face.down || 0,
    blink: !!face.blink,
    talk: face.talk || 0,
  });

  if (!armsBehind) drawArms();
}

/** Headscarf: covers head and ears, falls onto the shoulders, knot under the chin; the face is open. */
function drawScarf(ctx, hx, hy, R, color, facing) {
  ctx.fillStyle = shade(color, -0.12);
  ctx.beginPath();
  ctx.moveTo(hx - R * 1.12, hy - R * 0.1);
  ctx.quadraticCurveTo(hx - R * 1.3, hy + R * 1.2, hx - R * 0.9, hy + R * 1.45);
  ctx.lineTo(hx + R * 0.9, hy + R * 1.45);
  ctx.quadraticCurveTo(hx + R * 1.3, hy + R * 1.2, hx + R * 1.12, hy - R * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  circle(ctx, hx, hy - R * 0.05, R * 1.16);
  if (facing === 'back') return;
  // The open face is a skin oval over the scarf; the knot is under the chin.
  ctx.fillStyle = shade(color, -0.12);
  circle(ctx, hx, hy + R * 1.08, R * 0.24);
}

function drawHead(ctx, hx, hy, R, look, facing, face) {
  const style = look.style;
  if (style === 'scarf') {
    drawScarf(ctx, hx, hy, R, look.cap, facing);
    if (facing === 'back') return;
    ctx.fillStyle = look.skin;
    ctx.beginPath();
    ctx.ellipse(hx + (facing === 'side' ? (face.gaze || 0) * R * 0.12 : 0), hy + R * 0.12, R * 0.78, R * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();
    drawFace(ctx, hx, hy, R, look, face);
    return;
  }
  if (facing === 'back') {
    if (style === 'long') {
      ctx.fillStyle = look.hair;
      rrect(ctx, hx - R * 1.1, hy - R * 0.6, R * 2.2, R * 2.3, R * 0.9);
      ctx.fill();
    }
    ctx.fillStyle = look.skin;
    circle(ctx, hx, hy, R);
    if (style === 'hardhat') {
      ctx.fillStyle = look.hair;
      circle(ctx, hx, hy + R * 0.1, R * 0.98);
      drawHardhat(ctx, hx, hy, R, look.cap);
      return;
    }
    ctx.fillStyle = style === 'beanie' ? look.cap : look.hair;
    circle(ctx, hx, hy - R * 0.06, R * (style === 'buzz' ? 0.98 : 1.06));
    if (style === 'bun') circle(ctx, hx, hy - R * 1.02, R * 0.42);
    if (style === 'ponytail') {
      rrect(ctx, hx - R * 0.22, hy + R * 0.3, R * 0.44, R * 1.15, R * 0.22);
      ctx.fill();
    }
    return;
  }

  ctx.fillStyle = look.skin;
  circle(ctx, hx, hy, R);

  const hairline = { short: -0.3, long: -0.36, bun: -0.42, curly: -0.24, buzz: -0.64, beanie: -0.22, ponytail: -0.4, hardhat: -0.5 }[style];
  ctx.save();
  ctx.beginPath();
  ctx.arc(hx, hy, R * 1.07, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = style === 'beanie' ? look.cap : look.hair;
  ctx.fillRect(hx - R * 1.2, hy - R * 1.2, R * 2.4, R * (1.2 + hairline));
  ctx.restore();

  ctx.fillStyle = look.hair;
  if (style === 'long') {
    ctx.fillRect(hx - R * 1.08, hy - R * 0.4, R * 0.3, R * 1.5);
    ctx.fillRect(hx + R * 0.78, hy - R * 0.4, R * 0.3, R * 1.5);
  } else if (style === 'bun') {
    circle(ctx, hx, hy - R * 1.05, R * 0.42);
  } else if (style === 'curly') {
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI + i / 6 * Math.PI;
      circle(ctx, hx + Math.cos(a) * R * 0.95, hy + Math.sin(a) * R * 0.9, R * 0.33);
    }
  } else if (style === 'ponytail') {
    circle(ctx, hx + R * 0.95, hy - R * 0.55, R * 0.3);
  } else if (style === 'beanie') {
    ctx.fillStyle = shade(look.cap, -0.2);
    ctx.fillRect(hx - R * 1.07, hy - R * 0.36, R * 2.14, R * 0.22);
  } else if (style === 'hardhat') {
    drawHardhat(ctx, hx, hy, R, look.cap);
  }

  drawFace(ctx, hx, hy, R, look, face);
}

/** Eyes (with eyelashes for women), glasses and mouth over the head. */
function drawFace(ctx, hx, hy, R, look, face) {
  if (R < 2.2) return;
  const gx = (face.gaze || 0) * R * 0.24;
  const ey = hy + R * (0.1 + (face.down || 0) * 0.22);
  const ex = R * 0.38;
  ctx.fillStyle = '#2a211c';
  if (face.blink) {
    ctx.fillRect(hx - ex + gx - R * 0.1, ey, R * 0.2, Math.max(0.6, R * 0.05));
    ctx.fillRect(hx + ex + gx - R * 0.1, ey, R * 0.2, Math.max(0.6, R * 0.05));
  } else {
    circle(ctx, hx - ex + gx, ey, Math.max(0.7, R * 0.1));
    circle(ctx, hx + ex + gx, ey, Math.max(0.7, R * 0.1));
    if (look.female && R >= 4) {
      // Eyelashes: a short stroke up from the outer corner of each eye.
      ctx.strokeStyle = '#2a211c';
      ctx.lineWidth = Math.max(0.6, R * 0.06);
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(hx + side * ex + gx + side * R * 0.08, ey - R * 0.06);
        ctx.lineTo(hx + side * ex + gx + side * R * 0.22, ey - R * 0.2);
        ctx.stroke();
      }
    }
  }
  if (look.glasses) {
    ctx.strokeStyle = '#3a3029';
    ctx.lineWidth = Math.max(0.6, R * 0.07);
    ctx.beginPath();
    ctx.arc(hx - ex + gx, ey, R * 0.24, 0, Math.PI * 2);
    ctx.moveTo(hx + ex + gx + R * 0.24, ey);
    ctx.arc(hx + ex + gx, ey, R * 0.24, 0, Math.PI * 2);
    ctx.moveTo(hx - ex + gx + R * 0.24, ey);
    ctx.lineTo(hx + ex + gx - R * 0.24, ey);
    ctx.stroke();
  }
  if (R < 4) return;
  const lips = look.female ? '#b8414f' : '#7a3a2e';
  if (face.talk > 0) {
    ctx.fillStyle = lips;
    ctx.beginPath();
    ctx.ellipse(hx + gx * 0.6, hy + R * 0.52, R * 0.13, R * (0.03 + 0.09 * face.talk), 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (!face.down) {
    ctx.strokeStyle = look.female ? 'rgba(184, 65, 79, 0.9)' : 'rgba(90, 45, 30, 0.7)';
    ctx.lineWidth = Math.max(0.6, R * (look.female ? 0.08 : 0.06));
    ctx.beginPath();
    ctx.arc(hx + gx * 0.6, hy + R * 0.36, R * 0.18, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }
}

/** Hard hat: a dome with a ridge and a brim. */
function drawHardhat(ctx, hx, hy, R, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(hx, hy - R * 0.22, R * 1.02, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(color, -0.18);
  rrect(ctx, hx - R * 1.25, hy - R * 0.28, R * 2.5, R * 0.2, R * 0.1);
  ctx.fill();
  ctx.fillStyle = shade(color, 0.3);
  ctx.fillRect(hx - R * 0.1, hy - R * 1.2, R * 0.2, R * 0.92);
}

/** Drawing helpers that scenes use too. */
export const util = Object.freeze({ rand, pick, chance, clamp, shade, circle, rrect });

export { makeLook, draw, drawHead, walkArms, shoulderY, clampHand };

/** The whole engine as one object; classic scripts get it as window.CrealikaFigures. */
export const CrealikaFigures = Object.freeze({ makeLook, draw, drawHead, walkArms, shoulderY, clampHand, util });
if (typeof globalThis !== 'undefined' && !globalThis.CrealikaFigures) globalThis.CrealikaFigures = CrealikaFigures;
export default CrealikaFigures;
