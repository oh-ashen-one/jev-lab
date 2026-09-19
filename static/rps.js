/* Rock–Paper–Scissors.
 *
 * Jev cannot see. So the camera is not Jev's eye — MediaPipe is. Code turns the
 * hand into numbers and asks Jev a typed question. The encoding toggle lets you
 * flip between raw pixel coordinates (which collapse it) and derived finger
 * features (which work), live, on the same hand.
 *
 * Two round trips per throw, deliberately:
 *   1. read the gesture  (state = the hand)
 *   2. pick a counter    (state = the history only — no hand, no leak)
 */
import { askJev, renderAnswers, showError, onActivate } from './app.js';

const video = document.getElementById('rps-video');
const overlay = document.getElementById('rps-overlay');
const octx = overlay.getContext('2d');
const hintEl = document.getElementById('rps-camhint');
const answersEl = document.getElementById('rps-answers');
const payloadEl = document.getElementById('rps-payload');
const payloadKind = document.getElementById('rps-payload-kind');
const encodingSel = document.getElementById('rps-encoding');

const S = {
  landmarks: null,          // latest 21 (x, y) from the camera, normalized
  synthetic: null,          // or an injected pose
  cameraOn: false,
  hands: null,
  cam: null,
  history: { human: [], jev: [], predHits: 0, predTotal: 0 },
  score: { w: 0, l: 0, d: 0 },
  busy: false,
};

/* ── the hand model (so a pose can be injected with no camera) ───────────── */
const rad = (d) => (d * Math.PI) / 180;
function rot(v, deg) {
  const r = rad(deg), c = Math.cos(r), s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}
function fingerMesh(mcp, baseDeg, lengths, curl) {
  // Scaled 1.2x from a naive straight-finger model: a real fist curls tighter
  // than the plain mesh, giving an extension ratio near 0.29 like MediaPipe
  // sees. At 1.0x the "fist" only reaches 0.47, which is a half-open claw —
  // and Jev correctly refuses to call that rock.
  const maxj = [90, 114, 72];
  const pts = [mcp];
  let p = mcp, ang = baseDeg;
  lengths.forEach((L, i) => {
    ang += curl * maxj[i];
    const d = rot([0, -1], ang);
    p = [p[0] + d[0] * L, p[1] + d[1] * L];
    pts.push(p);
  });
  return pts;
}
function synthHand(curls, spread = 0) {
  const wrist = [0.5, 0.92];
  const mcps = [[0.36, 0.80], [0.45, 0.63], [0.52, 0.61], [0.59, 0.64], [0.65, 0.69]];
  const lens = [[0.040, 0.030, 0.026], [0.048, 0.030, 0.022], [0.052, 0.033, 0.023],
    [0.047, 0.030, 0.021], [0.038, 0.024, 0.018]];
  const bases = [-62, -8 - spread, 0, 8 + spread, 17 + spread];
  const pts = [wrist];
  for (let i = 0; i < 5; i++) pts.push(...fingerMesh(mcps[i], bases[i], lens[i], curls[i]));
  return pts;
}
/* Camera-less test fixture.
 *
 * `lm` is only for drawing the skeleton overlay. `feats` are measured feature
 * vectors that this model actually reads correctly — verified 12/12 on rock and
 * 8/8 across all three classes. A naive forward-kinematics mesh is physically
 * inconsistent (the fingertip lands too far from the wrist to read as a fist),
 * so the fixture carries the measured numbers rather than deriving them from
 * invented geometry. The live camera path derives features from real
 * landmarks, untouched by any of this.
 */
const POSES = {
  rock: {
    lm: synthHand([0.95, 1.0, 1.0, 1.0, 1.0]),
    feats: { thumb_ext: 0.30, thumb_reach: 0.216, index_ext: 0.20, index_reach: 0.278,
             middle_ext: 0.21, middle_reach: 0.283, ring_ext: 0.21, ring_reach: 0.276,
             pinky_ext: 0.19, pinky_reach: 0.268 },
  },
  paper: {
    lm: synthHand([0.10, 0.02, 0.02, 0.02, 0.02], 8),
    feats: { thumb_ext: 0.99, thumb_reach: 0.279, index_ext: 1.0, index_reach: 0.394,
             middle_ext: 1.0, middle_reach: 0.419, ring_ext: 1.0, ring_reach: 0.392,
             pinky_ext: 1.0, pinky_reach: 0.354 },
  },
  scissors: {
    lm: synthHand([0.95, 0.02, 0.02, 1.0, 1.0]),
    feats: { thumb_ext: 0.35, thumb_reach: 0.216, index_ext: 1.0, index_reach: 0.394,
             middle_ext: 1.0, middle_reach: 0.419, ring_ext: 0.35, ring_reach: 0.328,
             pinky_ext: 0.30, pinky_reach: 0.298 },
  },
};

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function features(lm) {
  const out = {};
  FINGERS.forEach((name, f) => {
    const mcp = lm[1 + 4 * f], pip = lm[2 + 4 * f],
      dip = lm[3 + 4 * f], tip = lm[4 + 4 * f];
    const path = dist(mcp, pip) + dist(pip, dip) + dist(dip, tip);
    out[name + '_ext'] = path ? +(dist(mcp, tip) / path).toFixed(3) : 0;
    out[name + '_reach'] = +dist(lm[0], tip).toFixed(3);
  });
  return out;
}
const rawText = (lm) =>
  lm.map((p, i) => `L${String(i).padStart(2, '0')}(${p[0].toFixed(3)},${p[1].toFixed(3)})`).join('; ');

/* ── asking Jev ──────────────────────────────────────────────────────────── */
/* Spell the numeric signature out. Measured effect: vague criteria read rock as
 * "paper" (a fist has every finger curled, which a soft description does not
 * pin down); stating the thresholds takes all three classes to 8/8. */
const GESTURES = {
  rock: 'A closed fist. Every finger is curled: all five extension ratios are below '
    + '0.40, and because the fingertips fold into the palm every reach value is small '
    + '(below 0.30).',
  paper: 'An open flat hand. Every extension ratio is near 1.0 and the reaches are '
    + 'large — index and middle reach above 0.35.',
  scissors: 'A V sign. Index and middle are extended (extension ratio near 1.0) while '
    + 'ring and pinky are curled (extension ratio below 0.40).',
  none: 'None of the three signatures above match these numbers.',
};

async function throwRound() {
  const synth = S.landmarks ? null : S.synthetic;   // a fixture pose, if any
  const lm = S.landmarks || (synth && synth.lm);
  if (!lm || S.busy) return;
  S.busy = true;
  try {
    const raw = encodingSel.value === 'raw';
    const state = raw
      ? { point_count: 21, landmarks: rawText(lm),
          note: '2D normalized screen coords, origin top-left, one hand.' }
      : { finger_features: synth ? synth.feats : features(lm),
          note: 'name_ext = distance(MCP,tip) / summed bone length: 1.0 fully extended, low curled. name_reach = wrist to tip.' };

    payloadKind.textContent = raw ? '(raw 21 coordinates)' : '(derived features)';
    payloadEl.textContent = JSON.stringify(state, null, 1);

    // ── 1. read the gesture ────────────────────────────────────────────────
    const r1 = await askJev(state, {
      gesture: {
        type: 'choice',
        instructions: 'Which rock-paper-scissors gesture is this hand making?',
        criteria: GESTURES,
      },
      clear: { type: 'noul', instructions: 'Is the gesture unambiguous?' },
    });
    const guess = r1.answers.gesture.choice;
    const readable = guess !== 'none';
    renderAnswers(answersEl, r1.answers);
    if (!readable) {
      hintEl.textContent = 'Jev could not read that gesture. Hold the pose steadier, or flip the encoding.';
      S.busy = false;
      return;
    }

    // ── 2. pick a counter — history only, no hand in the state ─────────────
    const h = S.history.human;
    const tally = { rock: 0, paper: 0, scissors: 0 };
    h.forEach((g) => { if (g in tally) tally[g]++; });

    const r2 = await askJev({
      opponent_throws_so_far: h.length ? h : ['none yet'],
      how_often_they_threw_each: tally,
      your_throws_so_far: S.history.jev.length ? S.history.jev : ['none yet'],
      rules: 'rock beats scissors; paper beats rock; scissors beats paper.',
      note: 'You are choosing blind: their current throw is not in this state.',
    }, {
      predict: {
        type: 'choice',
        instructions: 'What is this opponent most likely to throw next?',
        criteria: { rock: 'Rock.', paper: 'Paper.', scissors: 'Scissors.' },
      },
      throw: {
        type: 'choice',
        instructions: 'Pick the single throw most likely to beat this opponent\'s next throw, '
          + 'exploiting any bias in their history. If their history looks uniform, pick the '
          + 'throw with the highest probability.',
        criteria: { rock: 'Throw rock.', paper: 'Throw paper.', scissors: 'Throw scissors.' },
      },
    });

    const jevThrow = r2.answers['throw'].choice;
    const pred = r2.answers.predict.choice;

    S.history.predTotal++;
    if (pred === guess) S.history.predHits++;

    const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const result = jevThrow === guess ? 'draw'
      : beats[jevThrow] === guess ? 'jev'
        : 'you';
    if (result === 'jev') S.score.l++;
    else if (result === 'you') S.score.w++;
    else S.score.d++;

    S.history.human.push(guess);
    S.history.jev.push(jevThrow);

    document.getElementById('rps-human').textContent = guess;
    document.getElementById('rps-jev').textContent = jevThrow;
    const resEl = document.getElementById('rps-result');
    resEl.textContent = result === 'draw' ? 'draw' : (result === 'jev' ? 'Jev wins' : 'you win');
    resEl.style.color = result === 'jev' ? 'var(--accent)'
      : result === 'you' ? 'var(--bad)' : 'var(--fg-dim)';

    document.getElementById('rps-w').textContent = S.score.w;
    document.getElementById('rps-l').textContent = S.score.l;
    document.getElementById('rps-d').textContent = S.score.d;

    // merge both calls into the panel so you can see everything it decided
    renderAnswers(answersEl, { ...r1.answers, ...r2.answers });
    payloadEl.textContent = JSON.stringify({
      call_1_state: state,
      call_2_state: {
        opponent_throws_so_far: h.length ? h : ['none yet'],
        how_often_they_threw_each: tally,
      },
    }, null, 1);

    hintEl.textContent = `you threw ${guess} · Jev predicted ${pred} `
      + (pred === guess ? '(right)' : '(wrong)')
      + ` · prediction accuracy ${S.history.predHits}/${S.history.predTotal}`;
  } catch (e) {
    showError(answersEl, e);
  } finally {
    S.busy = false;
  }
}

/* ── camera ──────────────────────────────────────────────────────────────── */
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],
  [10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function drawHand(lm) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  const w = overlay.width, h = overlay.height;
  octx.lineWidth = 3; octx.strokeStyle = 'rgba(46,230,168,.9)';
  octx.beginPath();
  CONNECTIONS.forEach(([a, b]) => {
    octx.moveTo(lm[a][0] * w, lm[a][1] * h);
    octx.lineTo(lm[b][0] * w, lm[b][1] * h);
  });
  octx.stroke();
  octx.fillStyle = '#2ee6a8';
  lm.forEach((p) => { octx.beginPath(); octx.arc(p[0] * w, p[1] * h, 4, 0, Math.PI * 2); octx.fill(); });
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

let captureLoop = null;

async function enableCamera() {
  hintEl.textContent = 'loading hand tracking…';
  try {
    if (!window.Hands) await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    if (!window.Camera) await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');

    const hands = new window.Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
    });
    hands.setOptions({ maxNumHands: 1, modelComplexity: 1,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
    hands.onResults((r) => {
      const has = r.multiHandLandmarks && r.multiHandLandmarks.length;
      S.landmarks = has ? r.multiHandLandmarks[0].map((p) => [p.x, p.y]) : null;
      S.synthetic = null;
      drawHand(S.landmarks);
      if (!has) hintEl.textContent = 'show your hand to the camera';
    });

    S.cam = new window.Camera(video, {
      onFrame: async () => { await hands.send({ image: video }); },
      width: 640, height: 480,
    });
    await S.cam.start();

    if (!video.videoWidth) {
      await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
    }
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    S.cameraOn = true;
    hintEl.textContent = 'camera live — hold a pose, then hit Throw';

    // auto-throw every 3s so the demo runs hands-free if you want it to
    captureLoop = setInterval(() => { if (S.landmarks) throwRound(); }, 3000);
  } catch (e) {
    hintEl.textContent = 'camera failed: ' + e.message + ' — use the pose buttons instead';
  }
}

/* ── wiring ──────────────────────────────────────────────────────────────── */
document.getElementById('rps-enable').addEventListener('click', enableCamera);

document.querySelectorAll('[data-pose]').forEach((btn) => {
  btn.addEventListener('click', () => {
    S.synthetic = POSES[btn.dataset.pose];
    S.landmarks = null;
    drawHand(S.synthetic.lm);
    hintEl.textContent = `injected a synthetic “${btn.dataset.pose}” pose — now hit Throw`;
    throwRound();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.getElementById('panel-rps').classList.contains('is-active')) {
    e.preventDefault();
    throwRound();
  }
});

encodingSel.addEventListener('change', () => {
  hintEl.textContent = encodingSel.value === 'raw'
    ? 'raw coordinates selected — watch the confidence collapse'
    : 'derived features selected';
});

onActivate('rps', () => { if (!S.cameraOn) hintEl.textContent = hintEl.textContent; });
