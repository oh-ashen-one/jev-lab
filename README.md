# Jev Lab

Three games driven by [TypeSafe Jev](https://docs.typesafe.ai) — a **System One
model** that does not write text. You send it a state and a set of typed
questions; it returns a choice, a score, or a probability. No prose, no parsing,
output tokens are free.

This lab exists to answer one question honestly: **what does a decision model
actually look like inside a running game?**

```
python3 server.py        # then open http://127.0.0.1:8770
```

The server holds the API key server-side and proxies every call. The browser
never sees it.

## The thing to understand first

**Jev cannot see.** Images, audio and video are not supported — TypeSafe says so
explicitly, and their own Doom demo notes it runs "on structured state as a data
structure with text, not on images."

So every visual demo here needs a *translator*: code that turns the world into
numbers. The translator is not a detail. It is most of the result.

## The three games

### Pong — difficulty is a confidence threshold, not a different model

Jev steers **both** paddles — a mirror match. One call per tick carries the same
typed question (`up / hold / down`) for each side, over a state describing that
side's own view. The ball, walls and scoring are ordinary code, and both sides
can abstain, so rallies run on whichever stale order happens to be right.

The knob that matters is the confidence gate. Below it a side **abstains**, and
abstaining means *no new order* — the paddle keeps executing its last command, so
the correction it failed to issue becomes a stale control input.

Measured when the left paddle was still a deterministic code bot (same game,
same physics):

| gate | code bot | Jev | abstentions |
|---|---|---|---|
| 0.50 | 1 | 0 | 9 |
| 0.88 | 3 | 0 | 21 |

Same model, same physics, same opponent. Only the threshold moved.

**Confidence tracks ambiguity properly.** Sweeping the paddle-to-intercept error
(0 = perfectly aligned), 1 = the whole field):

| error | choice | confidence | up / hold / down |
|---|---|---|---|
| 0.00 | hold | **0.91** | 0.01 / 0.94 / 0.05 |
| 0.01 | down | **0.52** | 0.07 / 0.25 / 0.68 |
| 0.04 | down | **0.55** | 0.16 / 0.15 / 0.69 |
| 0.30 | down | **0.91** | 0.05 / 0.00 / 0.95 |

It is confident when the answer is clear and collapses to a coin flip exactly
when the situation is ambiguous. The perception-noise slider degrades its view so
you can watch that happen.

### Rock–Paper–Scissors — the encoding is the whole result

The camera is **not** Jev's eye. MediaPipe hand-tracking is. Code reduces the
hand to numbers and asks Jev a typed question. Flip the encoding dropdown live,
on the same hand:

| encoding | accuracy | mean confidence |
|---|---|---|
| raw 21 (x, y) coordinates | **50%** | 0.07 – 0.20 |
| derived per-finger features | **100%** | 0.78 – 0.95 |

Three findings, each measured:

1. **Raw pixel coordinates do not work.** Jev answers "paper" for essentially
   everything and reports confidence near 0.1. It does not bluff — it tells you
   it cannot tell.
2. **`extension ratio` alone cannot identify a fist.** Sweeping it from 0.45 down
   to 0.15 (44 = wide open, 0 = fully curled) while holding paper and scissors
   fixed: rock was read as `paper` or `none` at *every* value. The fist signal is
   `reach` — the fingertip being close to the wrist — not the curl magnitude.
3. **Criteria wording is worth as much as the features.** Describing rock as
   "a closed fist: no fingers extended" reads as `paper`. Stating the numeric
   signature — all five extension ratios below 0.40 *and* every reach below 0.30 —
   takes all three classes to 8/8.

Round trips are deliberately split in two: one call reads the gesture (state = the
hand), a second picks a counter-throw (state = the history only, with the current
throw deliberately absent so there is no leak).

### Chess — code owns tactics, Jev owns judgment

Jev is a decision model, not a search engine. It cannot look ahead. So the
division of labour is explicit and visible in the UI:

- **code** generates legal moves and can filter to the tactically sane ones, so
  Jev can never see an illegal move or hang a piece by arithmetic slip
- **Jev** chooses among the survivors, and expresses a *plan* — which is where a
  decision model is genuinely strong

Its probability distribution is painted onto the board as a heatmap, so you can
see the shape of its thinking before the move lands. The **intent** dropdown
changes the same question on the same position: solid / aggressive / defensive /
greedy / chaotic. Turn off the candidate screen and you can watch it play badly
in a legible way.

Because the button plays whoever is to move, you can also just watch Jev play
itself.

## What the panel shows

Every panel is a live view of internals, not decoration: the full probability
distribution for each question, the calibrated confidence, whether a gated answer
was an abstention, the exact state payload that went over the wire, model
version, per-call latency split into model vs network, and a running cost total.

Note `confidence` is a **separate quantity** from the winning option's
probability — it is common to see `conf 0.12` over a 34% bar. That is the model
reporting calibration, not a bug.

## Measured, on real calls

- Model: `jev-1.13.0` (alias `jev-latest`)
- Median latency: **~170–370 ms** end to end; the API returns
  `x-envoy-upstream-service-time` so model time is separable from network
- A full session of ~1,000 decisions across all three games: **~$0.024**
  (input $0.042/MTok, output free)
- Pong at 4 decisions/second costs roughly **$0.0002/minute**

## Setup

Needs Python 3.9+ and a TypeSafe key from
[console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys).

The server looks for the key in `TYPESAFE_API_KEY`, then in
`~/.agents-md/.secrets/typesafe.env`. It is never logged, never sent to the
browser, and never placed in a URL or command-line argument. Nothing sensitive is
stored in this repo.

The only network dependencies at runtime are the MediaPipe Hands CDN scripts,
loaded on demand when you enable the camera; chess uses `chess.js` from jsDelivr.
Everything else is stdlib.

## Layout

```
server.py              local server: holds the key, proxies /api/ask
static/app.js          Jev client, answer rendering, stats, tab routing
static/pong.js         the confidence-gate demo
static/rps.js          MediaPipe → features → gesture → counter-throw
static/chessgame.js    legal-move generation, tactical screen, heatmap
```

## Caveats

- These are demos. Pong is now Jev vs Jev, so the score line reflects perception
  noise and abstention timing rather than a skill gap between opponents.
- The chess move distribution spreads over ~14 candidates, so per-move
  confidence is legitimately low (0.2–0.4). That is honest, not a defect.
- The RPS pose buttons inject *measured* feature vectors rather than deriving
  them from generated landmarks, because a naive forward-kinematics hand model is
  not physically consistent enough to read as a fist. The live camera path
  derives features from real landmarks and is unaffected.
- Vendor speed and cost claims were not independently reproduced; the numbers
  above are this app's own measurements on one machine.
