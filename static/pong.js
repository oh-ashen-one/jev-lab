/* Pong — Jev steers the right paddle. The ball, walls and scoring are code.
 *
 * The point: difficulty is not a different model, it's a confidence threshold.
 * Below it Jev abstains and the paddle hesitates.
 */
import { askJev, renderAnswers, showError, onActivate, gated, setBusy } from './app.js';

const W = 880, H = 520;
const PAD_W = 13, PAD_H = 92, PAD_SPEED = 430;
const BALL_R = 9, BASE_SPEED = 300;
const DECIDE_EVERY_MS = 240;

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

const G = {
  ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
  left: { y: H / 2 }, right: { y: H / 2 },
  rightDir: 0,            // -1 up, 0 hold, +1 down  (Jev's last command)
  rightDecidedAt: 0,
  agent: null,            // last full answer set, for the panel
  score: { code: 0, jev: 0, abstain: 0 },
  lastDecision: null,
  confidence: null,
  serving: 'left',
  running: true,
};

/* ── physics ─────────────────────────────────────────────────────────────── */
function serve(towardJev) {
  G.serving = null;
  const speed = BASE_SPEED * parseFloat(SP.value);
  const ang = (Math.random() * 0.5 - 0.25) * Math.PI;   // mostly horizontal
  const dir = towardJev ? 1 : -1;
  G.ball.x = towardJev ? W * 0.32 : W * 0.68;
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

  // left paddle: perfect deterministic bot — the baseline Jev is judged against
  const codeTarget = predictCrossY(60) - PAD_H / 2;
  G.left.y += Math.max(-PAD_SPEED * dt, Math.min(PAD_SPEED * dt,
    (codeTarget - G.left.y) * 8));

  // right paddle: driven ONLY by Jev's decision, refreshed every decision
  if (performance.now() - G.rightDecidedAt < DECIDE_EVERY_MS * 1.6) {
    G.right.y = Math.max(0, Math.min(H - PAD_H, G.right.y + G.rightDir * PAD_SPEED * dt));
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
  // so the point goes to the other paddle.
  if (b.x < -30) { G.score.jev++; serve(true); }      // code bot missed
  if (b.x > W + 30) { G.score.code++; serve(false); } // jev missed
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
function draw() {
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);

  // center dashed line
  ctx.strokeStyle = '#1a2029'; ctx.lineWidth = 3; ctx.setLineDash([11, 15]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.setLineDash([]);

  const abstaining = G.lastDecision && G.lastDecision.abstained;

  // left / code bot
  ctx.fillStyle = '#465063';
  ctx.fillRect(60, G.left.y, PAD_W, PAD_H);

  // right / Jev
  ctx.shadowBlur = 22;
  ctx.shadowColor = abstaining ? '#ffb454' : '#2ee6a8';
  ctx.fillStyle = abstaining ? '#ffb454' : '#2ee6a8';
  ctx.fillRect(W - 60 - PAD_W, G.right.y, PAD_W, PAD_H);
  ctx.shadowBlur = 0;

  // ball
  ctx.shadowBlur = 18; ctx.shadowColor = '#8fd6ff';
  ctx.fillStyle = '#dcefff';
  ctx.beginPath(); ctx.arc(G.ball.x, G.ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // Jev's predicted intercept — so you can see what it was told
  if (G.lastDecision && G.lastDecision.intercept != null && G.ball.vx > 0) {
    ctx.strokeStyle = 'rgba(46,230,168,.35)'; ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(W - 60 - PAD_W, G.lastDecision.intercept);
    ctx.lineTo(W, G.lastDecision.intercept);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.font = '600 13px ui-monospace, monospace';
  ctx.fillStyle = '#3d4756';
  ctx.fillText('code bot', 24, 26);
  ctx.textAlign = 'right';
  ctx.fillStyle = abstaining ? '#ffb454' : '#2ee6a8';
  ctx.fillText(abstaining ? 'jev · ABSTAIN' : 'jev', W - 24, 26);
  ctx.textAlign = 'left';

  if (abstaining) {
    ctx.font = '700 15px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,180,84,.85)';
    ctx.fillText('?', W - 44 - PAD_W, G.right.y + PAD_H / 2 + 5);
  }
}

function paintScore() {
  document.getElementById('pong-you').textContent = G.score.code;
  document.getElementById('pong-jev').textContent = G.score.jev;
  document.getElementById('pong-abstain').textContent = G.score.abstain;
}

/* ── the decision loop ───────────────────────────────────────────────────── */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function buildState() {
  const b = G.ball;
  const noise = parseFloat(NZ.value);
  const approaching = b.vx > 0;
  const targetX = W - 60 - PAD_W;
  const tts = approaching ? Math.max(0, (targetX - b.x) / b.vx) : null;
  const trueIntercept = predictCrossY(targetX);
  const sentIntercept = Math.max(0, Math.min(H, trueIntercept + gauss() * noise * H));
  const padCenter = G.right.y + PAD_H / 2;

  return {
    state: {
      ball_y: +(b.y / H + gauss() * noise * 0.5).toFixed(3),
      ball_x: +(b.x / W).toFixed(3),
      ball_moving_toward_you: approaching,
      ball_vertical_speed: +(b.vy / H + gauss() * noise).toFixed(3),
      seconds_until_it_reaches_you: tts == null ? null : +tts.toFixed(2),
      predicted_intercept_y: +(sentIntercept / H).toFixed(3),
      your_paddle_center_y: +(padCenter / H).toFixed(3),
      error: +((sentIntercept - padCenter) / H).toFixed(3),
      paddle_height: +(PAD_H / H).toFixed(3),
      note: 'y grows downward. negative error means you must move up.',
    },
    trueIntercept,
  };
}

async function decide() {
  setBusy(tickEl, true);
  const { state, trueIntercept } = buildState();
  try {
    const res = await askJev(state, {
      move: {
        type: 'choice',
        instructions: 'Your paddle must intercept the ball. Which way should it move now?',
        criteria: {
          up: 'Move the paddle upward, toward decreasing y.',
          hold: 'Do not move; the paddle is already positioned well enough.',
          down: 'Move the paddle downward, toward increasing y.',
        },
      },
      threat: {
        type: 'score',
        instructions: 'How likely is it that the paddle fails to intercept?',
        criteria: ['comfortably on target', 'tight, could go either way',
          'very likely to miss'],
      },
    });
    G.agent = res.answers;

    const threshold = parseFloat(TH.value);
    const mv = res.answers.move;
    const chosen = gated(mv, threshold);
    const abstained = chosen == null;

    // Abstaining means NO NEW ORDER: the paddle keeps executing the previous
    // one for another interval. That is what abstention actually costs inside a
    // control loop — the correction you failed to issue is a stale input.
    if (abstained) {
      G.rightDecidedAt = performance.now();
    } else {
      G.rightDir = chosen === 'up' ? -1 : chosen === 'down' ? 1 : 0;
      G.rightDecidedAt = performance.now();
    }
    G.confidence = mv.confidence;
    G.lastDecision = { choice: chosen, abstained, intercept: trueIntercept,
      confidence: mv.confidence, latency: res.latency_ms };
    if (abstained) G.score.abstain++;

    renderAnswers(answersEl, G.agent, {
      order: { move: ['up', 'hold', 'down'] },
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
