/* Shared: the Jev client, stats, tab routing, and answer rendering.
 *
 * The browser never sees the API key — every call goes through /api/ask on the
 * local server, which holds it.
 */

export const SESSION = { calls: 0, cost: 0, model: '—' };

/* ── talking to Jev ──────────────────────────────────────────────────────── */

export async function askJev(state, questions, opts = {}) {
  const t0 = performance.now();
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions, model: opts.model || 'jev-latest' }),
  });
  const data = await res.json();
  data.client_ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  if (data.totals) {
    SESSION.calls = data.totals.calls;
    SESSION.cost = data.totals.cost_usd;
    SESSION.model = data.model;
    paintStats(data);
  }
  return data;
}

function paintStats(last) {
  document.getElementById('stat-model').textContent = SESSION.model || '—';
  document.getElementById('stat-calls').textContent = SESSION.calls;
  const lat = document.getElementById('stat-latency');
  if (last) {
    lat.textContent = last.latency_ms + 'ms';
    lat.title = 'total ' + last.latency_ms + 'ms · model ' +
      (last.server_ms ?? '?') + 'ms · network ' +
      (last.latency_ms - (last.server_ms || 0)).toFixed(0) + 'ms';
  }
  document.getElementById('stat-cost').textContent = '$' + SESSION.cost.toFixed(6);
}

export function setBusy(el, busy) {
  if (!el) return;
  el.classList.toggle('busy', busy);
  el.classList.toggle('ok', !busy);
}

/* ── rendering answers ───────────────────────────────────────────────────── */

/* The three TypeSafe primitives, with their plain-English meaning. */
const TYPE_LABEL = { choice: 'choice', noul: 'noul · yes/no', score: 'score · rubric' };

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pct = (x) => (100 * x).toFixed(0) + '%';

/**
 * Paint a set of Jev answers into a container.
 * opts.order   — {questionName: [option, ...]} to force a display order
 * opts.threshold — draw an abstention marker on choice bars
 */
export function renderAnswers(container, answers, opts = {}) {
  if (!answers || !Object.keys(answers).length) {
    container.innerHTML = '<div class="q empty">no answers yet</div>';
    return;
  }
  container.innerHTML = Object.entries(answers).map(([name, a]) => {
    const head = `<div class="q-head">
        <span class="q-name">${esc(name)}</span>
        <span class="q-type">${esc(TYPE_LABEL[a.type] || a.type)}</span>
        ${a.confidence != null ? `<span class="q-conf" title="calibrated confidence — a separate quantity from the winning option's probability, so the two can differ">conf ${a.confidence.toFixed(2)}</span>` : ''}
      </div>`;

    if (a.type === 'choice' && a.probabilities) {
      let keys = Object.keys(a.probabilities);
      const forced = opts.order && opts.order[name];
      if (forced) keys = forced.filter((k) => k in a.probabilities);
      else keys.sort((x, y) => a.probabilities[y] - a.probabilities[x]);

      const bars = keys.map((k) => {
        const p = a.probabilities[k];
        const win = k === a.choice;
        return `<div class="bar ${win ? 'is-win' : ''}">
            <span class="bar-label">${esc(k)}</span>
            <span class="bar-track">
              <span class="bar-fill ${win ? 'win' : ''}" style="width:${(100 * p).toFixed(1)}%"></span>
            </span>
            <span class="bar-num">${pct(p)}</span>
          </div>`;
      }).join('');

      const abstained = opts.threshold != null && a.confidence < opts.threshold;
      const val = `<span class="q-val" style="color:${abstained ? 'var(--warn)' : 'var(--accent)'}">
          ${esc(a.choice)}${abstained ? ' · abstain' : ''}</span>`;
      return `<div class="q">${head}${val}${bars}</div>`;
    }

    if (a.type === 'noul') {
      const p = a.noul;
      return `<div class="q">${head}
          <span class="q-val" style="color:${p > 0.5 ? 'var(--accent)' : 'var(--fg-dim)'}">${p.toFixed(3)}</span>
          <div class="bar"><span class="bar-label">true</span>
            <span class="bar-track"><span class="bar-fill ${p > 0.5 ? 'win' : ''}" style="width:${(100 * p).toFixed(1)}%"></span></span>
            <span class="bar-num">${pct(p)}</span></div>
        </div>`;
    }

    if (a.type === 'score') {
      const probs = a.probabilities || {};
      const rows = Object.keys(probs).map((k, i) => `<div class="bar">
            <span class="bar-label" title="${esc(a.legend?.[i] ?? '')}">L${i}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(100 * probs[k]).toFixed(1)}%"></span></span>
            <span class="bar-num">${pct(probs[k])}</span>
          </div>`).join('');
      return `<div class="q">${head}
          <span class="q-val">${Number(a.score).toFixed(2)}</span>${rows}</div>`;
    }

    return `<div class="q">${head}<span class="q-val">—</span></div>`;
  }).join('');
}

export function showError(container, err) {
  container.innerHTML = `<div class="q empty err">${esc(err.message || err)}</div>`;
}

/** Pong/RPS use this: treat a low-confidence answer as an abstention. */
export function gated(answer, threshold) {
  if (!answer) return null;
  if (threshold != null && answer.confidence < threshold) return null;
  return answer.choice;
}

/* ── tabs ────────────────────────────────────────────────────────────────── */

const activators = {};
export function onActivate(tab, fn) { activators[tab] = fn; }

function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + tab));
  if (activators[tab]) activators[tab]();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});

/* ── small helpers ───────────────────────────────────────────────────────── */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Ask Jev, but never let two requests for the same loop overlap. */
export function createPoller(fn) {
  let inFlight = false;
  return async function tick() {
    if (inFlight) return;
    inFlight = true;
    try { await fn(); }
    catch (e) { console.warn('poll failed', e); }
    finally { inFlight = false; }
  };
}
