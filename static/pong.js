/* Pong — Jev steers BOTH paddles. The ball, walls and scoring are code.
 *
 * Mirror match: one API call per tick carries the same typed question
 * (up / hold / down) for each side, over a state describing that side's own
 * view. Both paddles can abstain independently — and an abstention means the
 * stale order keeps running, on both ends of the court.
 */
import { askJev, renderAnswers, showError, onActivate, gated, setBusy } from './app.js';

const W = 880, H = 520;
const PAD_W = 13, PAD_H = 92, PAD_SPEED = 430;
const BALL_R = 9, BASE_SPEED = 300;
const DECIDE_EVERY_MS = 240;

const COL_L = '#8fa8ff';      // left Jev — violet
const COL_R = '#2ee6a8';      // right Jev — teal
const COL_ABSTAIN = '#ffb454';

const cv = document.getElementById('pong-canvas');
const ctx = cv.getContext('2d');
const tickEl = document.getElementById('pong-tick');
const answersEl = document.getElementById('pong-answers');

const TH = document.getElementById('pong-threshold');
const TH_OUT = document.getElementById('pong-threshold-out');
const SP = document.getElementById('pong-speed');
const SP_OUT = document.getElementById('pong-speed-out');
const NZ = document.getElementById('pong-noise');
const NZ_OUT = document.getElementById('pong-noise-out');

const mkPaddle = () => ({ y: H / 2, dir: 0, decidedAt: 0, decision: null });
const G = {
  ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
  left: mkPaddle(), right: mkPaddle(),   // dir: -1 up, 0 hold, +1 down
  agent: null,                          // last full answer set, for the panel
  score: { left: 0, right: 0, abstainL: 0, abstainR: 0 },
  serving: 'left',
  running: true,
};

/* ── physics ─────────────────────────────────────────────────────────────── */
function serve(towardRight) {
  G.serving = null;
  const speed = BASE_SPEED * parseFloat(SP.value);
  const ang = (Math.random() * 0.5 - 0.25) * Math.PI;   // mostly horizontal
  const dir = towardRight ? 1 : -1;
  G.ball.x = towardRight ? W * 0.32 : W * 0.68;
  G.ball.y = H * (0.25 + Math.random() * 0.5);
  G.ball.vx = Math.cos(ang) * speed * dir;
  G.ball.vy = Math.sin(ang) * speed;
}

/** Bounce-aware forward simulation: where will the ball cross x = targetX? */
function predictCrossY(targetX) {
  let { x, y, vx, vy } = G.ball;
  if (Math.abs(vx) < 1e-6) return y;
  let guard = 0;
  while (guard++ < 2000) {
    const t = (targetX - x) / vx;
    if (t > 0) {
      let ny = y + vy * t;
      // fold reflections back into [0, H]
      const span = 2 * H;
      ny = ((ny % span) + span) % span;
      return ny > H ? span - ny : ny;
    }
    // step to the next wall bounce
    const tw = vy > 0 ? (H - y) / vy : (vy < 0 ? (0 - y) / vy : 1e9);
    x += vx * tw; y += vy * tw; vy = -vy;
    if (tw <= 0 || tw > 1e9) break;
  }
  return y;
}

function step(dt) {
  const b = G.ball;
  b.x += b.vx * dt; b.y += b.vy * dt;

  if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
  if (b.y > H - BALL_R) { b.y = H - BALL_R; b.vy = -Math.abs(b.vy); }

  // both paddles are driven ONLY by Jev's last order for that side
  for (const side of ['left', 'right']) {
    const p = G[side];
    if (performance.now() - p.decidedAt < DECIDE_EVERY_MS * 1.6) {
      p.y = Math.max(0, Math.min(H - PAD_H, p.y + p.dir * PAD_SPEED * dt));
    }
  }

  // paddle collisions
  const hitL = b.x - BALL_R < 60 + PAD_W && b.x > 40 && b.vx < 0 &&
    b.y > G.left.y && b.y < G.left.y + PAD_H;
  if (hitL) {
    b.x = 60 + PAD_W + BALL_R;
    bounce(1, G.left.y + PAD_H / 2);
  }
  const hitR = b.x + BALL_R > W - 60 - PAD_W && b.x < W - 40 && b.vx > 0 &&
    b.y > G.right.y && b.y < G.right.y + PAD_H;
  if (hitR) {
    b.x = W - 60 - PAD_W - BALL_R;
    bounce(-1, G.right.y + PAD_H / 2);
  }

  // scoring: the ball leaving an edge means THAT side failed to return it,
  // so the point goes to the other paddle. Serve goes to the scorer.
  if (b.x < -30) { G.score.right++; serve(true); }
  if (b.x > W + 30) { G.score.left++; serve(false); }
  paintScore();
}

function bounce(dir, padCenter) {
  const b = G.ball;
  const off = (b.y - padCenter) / (PAD_H / 2);           // -1..1
  const speed = Math.min(BASE_SPEED * parseFloat(SP.value) * 1.55,
    Math.hypot(b.vx, b.vy) * 1.045);
  const ang = off * 0.9;                                  // radians
  b.vx = Math.cos(ang) * speed * dir;
  b.vy = Math.sin(ang) * speed;
}

/* ── rendering ───────────────────────────────────────────────────────────── */
function drawPaddle(x, paddle, color, abstaining) {
  ctx.shadowBlur = 22;
  ctx.shadowColor = abstaining ? COL_ABSTAIN : color;
  ctx.fillStyle = abstaining ? COL_ABSTAIN : color;
  ctx.fillRect(x, paddle.y, PAD_W, PAD_H);
  ctx.shadowBlur = 0;
}

function draw() {
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);

  // center dashed line
  ctx.strokeStyle = '#1a2029'; ctx.lineWidth = 3; ctx.setLineDash([11, 15]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.setLineDash([]);

  const abstL = !!(G.left.decision && G.left.decision.abstained);
  const abstR = !!(G.right.decision && G.right.decision.abstained);

  drawPaddle(60, G.left, COL_L, abstL);
  drawPaddle(W - 60 - PAD_W, G.right, COL_R, abstR);

  // ball
  ctx.shadowBlur = 18; ctx.shadowColor = '#8fd6ff';
  ctx.fillStyle = '#dcefff';
  ctx.beginPath(); ctx.arc(G.ball.x, G.ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // each side's predicted intercept — so you can see what it was told
  const hint = (x0, x1, y, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.setLineDash([]);
  };
  if (G.left.decision && G.left.decision.intercept != null && G.ball.vx < 0)
    hint(0, 60 + PAD_W, G.left.decision.intercept, 'rgba(143,168,255,.35)');
  if (G.right.decision && G.right.decision.intercept != null && G.ball.vx > 0)
    hint(W - 60 - PAD_W, W, G.right.decision.intercept, 'rgba(46,230,168,.35)');

  ctx.font = '600 13px ui-monospace, monospace';
  ctx.fillStyle = abstL ? COL_ABSTAIN : COL_L;
  ctx.fillText(abstL ? 'jev L · ABSTAIN' : 'jev L', 24, 26);
  ctx.textAlign = 'right';
  ctx.fillStyle = abstR ? COL_ABSTAIN : COL_R;
  ctx.fillText(abstR ? 'jev R · ABSTAIN' : 'jev R', W - 24, 26);
  ctx.textAlign = 'left';

  ctx.font = '700 15px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(255,180,84,.85)';
  if (abstL) ctx.fillText('?', 60 + PAD_W + 14, G.left.y + PAD_H / 2 + 5);
  if (abstR) ctx.fillText('?', W - 44 - PAD_W, G.right.y + PAD_H / 2 + 5);
}

function paintScore() {
  document.getElementById('pong-left').textContent = G.score.left;
  document.getElementById('pong-right').textContent = G.score.right;
  document.getElementById('pong-abstain-l').textContent = G.score.abstainL;
  document.getElementById('pong-abstain-r').textContent = G.score.abstainR;
}

/* ── the decision loop ───────────────────────────────────────────────────── */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

/** One side's view of the world — the numbers Jev actually gets for it. */
function sideView(side) {
  const b = G.ball;
  const noise = parseFloat(NZ.value);
  const right = side === 'right';
  const targetX = right ? W - 60 - PAD_W : 60 + PAD_W;
  const approaching = right ? b.vx > 0 : b.vx < 0;
  const tts = approaching ? Math.max(0, (targetX - b.x) / b.vx) : null;
  const trueIntercept = predictCrossY(targetX);
  const sentIntercept = Math.max(0, Math.min(H, trueIntercept + gauss() * noise * H));
  const padCenter = G[side].y + PAD_H / 2;

  return {
    trueIntercept,
    view: {
      ball_y: +(b.y / H + gauss() * noise * 0.5).toFixed(3),
      ball_x: +(b.x / W).toFixed(3),
      ball_moving_toward_you: approaching,
      ball_vertical_speed: +(b.vy / H + gauss() * noise).toFixed(3),
      seconds_until_it_reaches_you: tts == null ? null : +tts.toFixed(2),
      predicted_intercept_y: +(sentIntercept / H).toFixed(3),
      your_paddle_center_y: +(padCenter / H).toFixed(3),
      error: +((sentIntercept - padCenter) / H).toFixed(3),
      paddle_height: +(PAD_H / H).toFixed(3),
    },
  };
}

async function decide() {
  setBusy(tickEl, true);
  const L = sideView('left'), R = sideView('right');
  const moveQ = (sideName) => ({
    type: 'choice',
    instructions: `You control the ${sideName} paddle. It must intercept the ball. Which way should it move now?`,
    criteria: {
      up: 'Move the paddle upward, toward decreasing y.',
      hold: 'Do not move; the paddle is already positioned well enough.',
      down: 'Move the paddle downward, toward increasing y.',
    },
  });
  try {
    const res = await askJev(
      {
        note: 'y grows downward. negative error means that paddle must move up.',
        left_paddle: L.view,
        right_paddle: R.view,
      },
      {
        left: moveQ('LEFT'),
        right: moveQ('RIGHT'),
        threat: {
          type: 'score',
          instructions: 'How likely is it that the next return is missed by either paddle?',
          criteria: ['comfortably on target', 'tight, could go either way',
            'very likely to miss'],
        },
      });
    G.agent = res.answers;

    const threshold = parseFloat(TH.value);
    for (const side of ['left', 'right']) {
      const mv = res.answers[side];
      const chosen = gated(mv, threshold);
      const p = G[side];
      const abstained = chosen == null;

      // Abstaining means NO NEW ORDER: the paddle keeps executing the previous
      // one for another interval. That is what abstention actually costs inside a
      // control loop — the correction you failed to issue is a stale input.
      if (!abstained) p.dir = chosen === 'up' ? -1 : chosen === 'down' ? 1 : 0;
      p.decidedAt = performance.now();
      p.decision = {
        choice: chosen, abstained,
        intercept: side === 'left' ? L.trueIntercept : R.trueIntercept,
        confidence: mv && mv.confidence, latency: res.latency_ms,
      };
      if (abstained) side === 'left' ? G.score.abstainL++ : G.score.abstainR++;
    }

    renderAnswers(answersEl, G.agent, {
      order: { left: ['up', 'hold', 'down'], right: ['up', 'hold', 'down'] },
      threshold,
    });
  } catch (e) {
    showError(answersEl, e);
  } finally {
    setBusy(tickEl, false);
  }
}

/* ── wiring ──────────────────────────────────────────────────────────────── */
TH.addEventListener('input', () => { TH_OUT.value = parseFloat(TH.value).toFixed(2); });
SP.addEventListener('input', () => { SP_OUT.value = parseFloat(SP.value).toFixed(1) + '×'; });
NZ.addEventListener('input', () => { NZ_OUT.value = parseFloat(NZ.value).toFixed(2); });

let raf = null, last = 0, decTimer = null;

function loop(ts) {
  const dt = Math.min(0.033, (ts - last) / 1000 || 0);
  last = ts;
  step(dt);
  draw();
  raf = requestAnimationFrame(loop);
}

onActivate('pong', () => {
  if (raf == null) { serve(false); last = performance.now(); raf = requestAnimationFrame(loop); }
  if (decTimer == null) decTimer = setInterval(decide, DECIDE_EVERY_MS);
  decide();
});

// start the game immediately (pong is the default tab)
serve(false);
last = performance.now();
raf = requestAnimationFrame(loop);
decTimer = setInterval(decide, DECIDE_EVERY_MS);
decide();
