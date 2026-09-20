/* Chess.
 *
 * Jev is a decision model, not a search engine — it cannot look ahead. So the
 * division of labour is explicit:
 *
 *   code   generates legal moves, and optionally filters to the tactically
 *          sane ones, so Jev can never hang a queen by arithmetic slip
 *   Jev    chooses among the survivors and expresses a PLAN (the intent
 *          selector), which is a decision-model strength
 *
 * Turn the candidate screen off and you can watch it play badly in a way that
 * is legible rather than mysterious.
 */
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';
import { askJev, renderAnswers, showError, setBusy } from './app.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const GLYPH = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};
const FILES = 'abcdefgh';
const MAX_CANDIDATES = 14;

const boardEl = document.getElementById('chess-board');
const answersEl = document.getElementById('chess-answers');
const movesEl = document.getElementById('chess-moves');
const payloadEl = document.getElementById('chess-payload');
const candsEl = document.getElementById('chess-cands');
const intentW = document.getElementById('chess-intent-w');
const intentB = document.getElementById('chess-intent-b');
const screenChk = document.getElementById('chess-screen');
const noteEl = document.getElementById('chess-note');
const narrEl = document.getElementById('chess-narr');
const tagW = document.getElementById('tag-w');
const tagB = document.getElementById('tag-b');
const autoBtn = document.getElementById('chess-auto');

let game = new Chess();
let selected = null;
let heat = {};          // {square: probability}
let busy = false;
let auto = false;

/* Pace = presentation theater, not Jev. The API call is ~300ms; the rest is
 * how long we hold the heatmap and pause between moves so people can read it. */
const PACE = {
  showcase: { hold: 1800, gap: 900 },
  normal:   { hold: 900,  gap: 400 },
  blitz:    { hold: 250,  gap: 80  },
};
const paceSel = document.getElementById('chess-pace');
const pace = () => PACE[paceSel.value] || PACE.normal;

const selFor = (side) => side === 'white' ? intentW : intentB;
const tagFor = (side) => side === 'white' ? tagW : tagB;
const intentName = (side) => selFor(side).options[selFor(side).selectedIndex].text;

/* ── shallow tactical screen (this is the part that must NOT be Jev) ─────── */
function screenScore(m) {
  let s = 0;
  const captured = m.captured ? VAL[m.captured] : 0;
  s += captured * 10;                       // take free material
  game.move(m.san);
  try {
    if (game.isCheckmate()) s += 10000;
    else if (game.inCheck()) s += 5;
    const replies = game.moves({ verbose: true });
    const hanging = replies.some((r) => r.to === m.to);
    if (hanging && VAL[m.piece] > captured) s -= (VAL[m.piece] - captured) * 8;
  } finally {
    game.undo();
  }
  if (['d4', 'e4', 'd5', 'e5'].includes(m.to)) s += 2;      // centre
  if (['n', 'b'].includes(m.piece) && m.from[1] === '1') s += 1.5;  // develop
  return s;
}

function candidates() {
  const all = game.moves({ verbose: true });
  if (!screenChk.checked) return all.slice(0, MAX_CANDIDATES);
  return all.map((m) => ({ m, s: screenScore(m) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.m);
}

function describe(m) {
  const bits = [];
  if (m.captured) bits.push(`captures the ${m.captured}`);
  if (m.promotion) bits.push('promotes');
  if (m.san.includes('+')) bits.push('gives check');
  if (m.san.includes('#')) bits.push('checkmate');
  if (m.san.startsWith('O-O')) bits.push('castles');
  const pieceName = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[m.piece];
  return `${pieceName} ${m.from} to ${m.to}` + (bits.length ? ', ' + bits.join(', ') : '');
}

function material() {
  let w = 0, b = 0;
  game.board().flat().forEach((sq) => {
    if (!sq) return;
    if (sq.color === 'w') w += VAL[sq.type]; else b += VAL[sq.type];
  });
  return { white: w, black: b, balance_for_white: w - b };
}

/* ── rendering ───────────────────────────────────────────────────────────── */
function render() {
  const grid = game.board();
  const legal = selected ? game.moves({ square: selected, verbose: true }) : [];
  boardEl.innerHTML = '';

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = grid[r][f];
      const name = FILES[f] + (8 - r);
      const el = document.createElement('div');
      el.className = 'sq ' + ((r + f) % 2 === 0 ? 'light' : 'dark');
      el.dataset.square = name;
      if (selected === name) el.classList.add('sel');
      const target = legal.find((m) => m.to === name);
      if (target) el.classList.add(target.captured ? 'capture' : 'hintmove');

      if (heat[name]) {
        const h = document.createElement('span');
        h.className = 'heat';
        // sqrt so the long tail of the distribution is still visible, instead of
        // only the one or two squares Jev actually favours
        h.style.opacity = Math.min(0.80, Math.sqrt(heat[name]) * 1.15).toFixed(2);
        el.appendChild(h);
      }
      if (sq) {
        const p = document.createElement('span');
        p.className = 'piece ' + sq.color;
        p.textContent = GLYPH[sq.color + sq.type];
        el.appendChild(p);
      }
      if (heat[name] > 0.03) {
        const l = document.createElement('span');
        l.className = 'heatlabel';
        l.textContent = Math.round(heat[name] * 100) + '%';
        el.appendChild(l);
      }
      // board coordinates on the edges
      if (r === 7) {
        const f2 = document.createElement('span');
        f2.className = 'coord file';
        f2.textContent = FILES[f];
        el.appendChild(f2);
      }
      if (f === 0) {
        const rk = document.createElement('span');
        rk.className = 'coord rank';
        rk.textContent = 8 - r;
        el.appendChild(rk);
      }
      el.addEventListener('click', () => onSquare(name, sq));
      boardEl.appendChild(el);
    }
  }
  renderMoves();
  updateTurnLabel();
}

function updateTurnLabel() {
  const side = game.turn() === 'w' ? 'white' : 'black';
  const btn = document.getElementById('chess-jev');
  const box = document.getElementById('chess-turn');
  if (btn) btn.textContent = game.isGameOver() ? 'Game over' : 'Jev moves (' + side + ')';
  if (box) {
    box.textContent = game.isGameOver() ? 'game over' : side + ' to move';
    box.style.color = side === 'white' ? 'var(--fg-dim)' : 'var(--accent)';
  }
}

function renderMoves() {
  const hist = game.history({ verbose: true });
  movesEl.innerHTML = hist.map((m, i) => {
    const white = i % 2 === 0;
    return `<span class="ply">${white ? (Math.floor(i / 2) + 1) + '.' : ''}</span>`
      + `<span class="${!white && m.color === 'b' ? 'jev' : ''}">${m.san}</span>`;
  }).join('');
}

function onSquare(name, sq) {
  if (game.isGameOver() || busy || auto) return;
  if (game.turn() !== 'w') return;
  if (sq && sq.color === 'w') { selected = name; heat = {}; render(); return; }
  if (selected) {
    const mv = game.moves({ square: selected, verbose: true }).find((m) => m.to === name);
    if (mv) {
      game.move(mv.san);
      selected = null; heat = {};
      render();
      checkOver();
      return;
    }
  }
  selected = null; render();
}

function checkOver() {
  if (!game.isGameOver()) return;
  if (game.isCheckmate()) {
    const winner = game.turn() === 'w' ? 'black' : 'white';
    noteEl.textContent = `Checkmate — ${winner} wins.`;
    narrEl.textContent = `checkmate — ${winner} jev (${intentName(winner)}) wins`;
  } else {
    const why = game.isDrawByFiftyMoves?.() ? 'fifty-move' : 'stalemate/insufficient material';
    noteEl.textContent = 'Draw (' + why + ').';
    narrEl.textContent = 'draw — ' + why;
  }
}

/* ── Jev's move ──────────────────────────────────────────────────────────── */
async function jevMove() {
  if (busy || game.isGameOver()) return;
  busy = true;
  setBusy(document.getElementById('chess-tick'), true);
  try {
    const cands = candidates();
    if (!cands.length) return;
    const criteria = {};
    cands.forEach((m) => { criteria[m.san] = describe(m); });

    const side = game.turn() === 'w' ? 'white' : 'black';
    tagFor(side).classList.add('thinking');
    narrEl.textContent = `${side} jev (${intentName(side)}) is weighing ${cands.length} moves…`;
    const state = {
      position_fen: game.fen(),
      you_are: side,
      material: material(),
      in_check: game.inCheck(),
      legal_moves_available: cands.length,
      candidate_moves: cands.map((m) => `${m.san} — ${describe(m)}`),
      intent: intentName(side),
      move_notation: 'SAN. Board files are a-h left to right, ranks 1-8 bottom to top.',
      note: 'Choose exactly one candidate move.',
    };
    candsEl.textContent = `(${cands.length} candidates)`;
    payloadEl.textContent = JSON.stringify(state, null, 1);

    const res = await askJev(state, {
      move: {
        type: 'choice',
        instructions: 'Play the move that best serves your intent. Choose exactly one candidate.',
        criteria,
      },
      plan: {
        type: 'choice',
        instructions: 'What is your plan over the next few moves?',
        criteria: {
          develop: 'Bring pieces out and get the king safe.',
          attack: 'Target the enemy king.',
          defend: 'Consolidate and protect weaknesses.',
          trade: 'Exchange pieces to simplify.',
          grab_material: 'Win material.',
          hold_position: 'Make a quiet, solid move.',
        },
      },
      worried: {
        type: 'noul',
        instructions: 'Is your own king in immediate danger right now?',
      },
    });

    const chosenSan = res.answers.move.choice;
    const mv = cands.find((m) => m.san === chosenSan);
    if (!mv) throw new Error('Jev returned a move that was not offered: ' + chosenSan);

    // paint its distribution on the destination squares before moving
    heat = {};
    Object.entries(res.answers.move.probabilities || {}).forEach(([san, p]) => {
      const c = cands.find((m) => m.san === san);
      if (c) heat[c.to] = (heat[c.to] || 0) + p;
    });
    render();
    renderAnswers(answersEl, res.answers);

    // narrate the pick in plain terms while the heatmap is on screen
    const moveProb = (res.answers.move.probabilities || {})[chosenSan];
    const plan = res.answers.plan && res.answers.plan.choice;
    const worry = res.answers.worried && res.answers.worried.noul;
    const num = Math.floor(game.history().length / 2) + 1;
    narrEl.textContent =
      `${num}${side === 'white' ? '.' : '…'} ${chosenSan}` +
      (moveProb != null ? ` — ${Math.round(moveProb * 100)}% of its attention` : '') +
      (plan ? ` · plan: ${plan}` : '') +
      (worry != null ? ` · king-worry ${worry.toFixed(2)}` : '');

    await new Promise((r) => setTimeout(r, pace().hold));   // hold so the heatmap reads

    game.move(mv.san);
    heat = {};
    selected = null;
    render();
    checkOver();
  } catch (e) {
    showError(answersEl, e);
    if (auto) setAuto(false);   // don't keep burning calls on a dead link
  } finally {
    busy = false;
    tagW.classList.remove('thinking');
    tagB.classList.remove('thinking');
    setBusy(document.getElementById('chess-tick'), false);
    if (auto) {
      if (game.isGameOver()) setAuto(false);
      else setTimeout(() => { if (auto) jevMove(); }, pace().gap);
    }
  }
}

/* ── wiring ──────────────────────────────────────────────────────────────── */
function resetGame() {
  game = new Chess(); heat = {}; selected = null; render();
  answersEl.innerHTML = '<div class="q empty">no answers yet</div>';
  payloadEl.textContent = '—';
  noteEl.textContent = 'New game. You play white — or press ▶ and watch Jev vs Jev.';
  narrEl.textContent = 'press ▶ — jev plays both sides, each with its own intent';
}

function setAuto(on) {
  auto = on;
  autoBtn.textContent = on ? '⏸ pause' : '▶ jev vs jev';
  if (on) {
    if (game.isGameOver()) resetGame();
    narrEl.textContent = 'jev vs jev — every move is a live API call';
    if (!busy) jevMove();
  } else {
    narrEl.textContent = 'paused — the board is yours';
  }
}

function paintTags() {
  tagW.textContent = 'jev · white · ' + intentName('white');
  tagB.textContent = 'jev · black · ' + intentName('black');
}

autoBtn.addEventListener('click', () => setAuto(!auto));
document.getElementById('chess-jev').addEventListener('click', jevMove);
document.getElementById('chess-undo').addEventListener('click', () => {
  setAuto(false);
  game.undo(); game.undo(); heat = {}; selected = null; render();
  noteEl.textContent = 'Position rewound.';
});
document.getElementById('chess-reset').addEventListener('click', () => {
  setAuto(false); resetGame();
});
intentW.addEventListener('change', paintTags);
intentB.addEventListener('change', paintTags);

paintTags();
render();
