# Platoons

`/settings platoons set lobby: squadron: [channel:]` (`src/bot/platoons.ts`,
`src/platoons/`): a squadron's players gather in one voice channel, the lobby,
and play from the rooms beside it (the voice channels of its category, made by
the server's join-to-create hub or by hand). A post, edited in place in the
chosen channel (the lobby's chat by default; Test pechenka: `расписание-и-сборы`,
beside rulebot's gathering), suggests who should play where:
the most useful for the BR that plays now, not the first to arrive. The bot
moves nobody and creates no room (the owner's decision 2026-10-21: suggestions,
not seating; the field commander decides). Measured 2026-10-21 on the backup of
10:09 UTC: 64,290 squadron battles of 2026-07-15 – 10-21, all 8 v 8 (no
battles stored 2026-08-02 – 09-23).

## Strength

`strength.ts`: a player's logit contribution; a team's chance is the logistic
of its eight values' sum minus the enemy's. Rates from the player's stored
battles (any squadron), each weighted 2^(−j/100) for the j-th latest: wins,
kills (air + ground + naval), deaths, assists; the overall rate shrinks to the
population's by 15 battles, the rate at the current cap to the overall by 200;
plus the season PSR (`psr/1000`, `max(0, psr − 1400)/100`; 0 without a
snapshot, as fitted). Walk-forward over the 4 weeks after the gap (37,681
battles; weights refitted before each week):

| Signal | AUC | Log loss |
|---|---|---|
| rulebot's report rating, constants as published | 0.789 | 0.559 (slope 0.80: overconfident) |
| overall rates, refitted | 0.790 | 0.553 |
| + rate at the cap, recency (H 100, M 200) | 0.791 | 0.551 |
| + season PSR (**used**) | **0.797** | **0.544** |
| + captures and score | 0.798 | 0.543 |
| TrueSkill / Elo from outcomes | 0.791 / 0.790 | 0.550 / 0.551 |
| adjusted plus-minus (ridge, weekly) | 0.739 | 0.599 |
| per-class rates | 0.790 | 0.553 |
| recency by days (14 d) instead of battles | 0.782 | 0.561 |

Calibrated within 1.5 points in every decile (ECE 0.008). TrueSkill, Elo and
plus-minus need every player's history, not one player's rows; adding the
TrueSkill logit to the used formula reaches only 0.813 / 0.526 (weeks 1–3,
where it scores 0.811 / 0.527). PSR snapshots exist from 2026-09-28: its gain
is measured on weeks 1–3 and may be inflated by the storage gap (in the 215
battles where all 16 players had 50+ stored battles it added nothing).

**Cold start** (penalties against the rating, 95% CI): no battle at the cap yet
(players with 10+ stored battles, 3.2% of rows) −0.043 [−0.059, −0.025]; 1–2
battles there −0.021; 3–9 −0.008 (not significant); under 10 stored battles at
all (12.9% of rows) −0.075 [−0.088, −0.062]. As large in a stage's first two
days as later; players with 30+ battles win 2.9 ± 0.4 points less in their
first battle at a new cap.

**Not used:** losing streaks (2+ losses −0.002, z −0.7), a session's first
battle (−0.012), 7+ days away (−0.028, CI touching 0), the session's 7th+
battle (+0.014: squadrons keep playing while they win), disconnects; familiarity
(+0.006 per unit of mean ln(1 + battles shared with today's teammates): a
regular instead of a stranger ≈ +1.4 points) is left for later.

## Does choosing matter

- Within one squadron at one cap (squadron × cap fixed effects, 932 groups,
  32,068 battles) the rating sum's slope is **0.74** [0.66, 0.78] of the pooled
  1.05: a squadron's stronger lineups beat its weaker ones. The median spread
  of a squadron's lineup sums is 0.37 logit: its 75th-percentile lineup beats
  its 25th by 9.7 points against an even opponent.
- **Best 8 against a random 8** of the players a squadron fielded in a week at
  a cap (720 pools of 12–20 players): +0.56 logit, +8.3 points against its real
  opponents (×0.74). One session's players (4,081 sessions of 9+): +5.0 points;
  9–12 players: +3.5. WLILY (12 sessions): +6.1 points. The lineups squadrons
  field now are as good as random (−0.01 logit).
- WLILY's roster on the backup (72 members, 52 with stored battles, none at
  cap 6.0 yet): rated in 52 ms; of 12 waiting in roster order the suggested
  eight beat the first eight by 0.52 logit (+9.5 points even).

## Composition

Strength-controlled logistic regression, every full battle (63,171): the
class composition adds nothing out of sample (test from 2026-10-06: AUC 0.809
with strength alone, 0.808 with composition). In sample: a team without SPAA
gains +0.30 logit against an enemy without air and loses 0.156 per enemy
aircraft or helicopter (cap 6.0: +0.89 and −0.30, break-even at 3 aircraft,
which 89% of 6.0 teams spawn); 0–1 own aircraft do better than 2 (+0.37 / +0.23),
3+ no better than 2. Teams choose their setup themselves, so these are
associations. Players' lineups hold SPAA in 39–61% and aircraft in 50–68% of
battles (by cap); 13.4% switch class between consecutive battles; a player's
kills per spawn correlate 0.35 between tank and SPAA, 0.38 between ground and
air. So the suggestions go by strength alone and show each player's likely
vehicle (`/scout`'s vehicle model at the cap) to let the platoon agree on roles.

## Cases

`plan.ts` (tests: `plan.test.ts`), over the voice state at each pass. Idle
players: the lobby's, not deafened, and a room's players beyond eight.

| Case | What the post suggests |
|---|---|
| fewer than 8 idle | the next platoon so far, the next to play first |
| 8 idle | a new platoon of the strongest eight: it needs a room (the server's hub or by hand) |
| 16 idle | two new platoons, the stronger eight first |
| a room short of players | the strongest idle players to call in, then the strongest of a later short room (two short teams cannot play, one full can) |
| a full room, a stronger player idle | a swap for the room's weakest when the gain is ≥ `SWAP_MIN_GAIN` (0.15, ~2.8 points) and the player would not play otherwise: idle players who make a platoon of their own play anyway |
| two full rooms, one stronger | nothing: a swap between them moves strength from one team to the other, and the squadron wins no more |
| more than 8 in a room | its 8 strongest play, the rest are the reserve, idle for other rooms |
| self-deafened | in the lobby: not placed, listed; in a room: plays |
| a squadron outsider (last battle for another squadron within 30 days) | never placed, listed |
| an unknown nick | after every member; never offered as a swap |
| a nick with a typo | taken for the one roster nick it matches whole (`src/nick-search.ts`), shown |
| a room the bot cannot see | left out |
| a stored battle | strengths are read again (30 s debounce) |
| the BR stage changes (14:00 UTC) | strengths at the new cap at the next read (10 min cache) |
| other messages came after the post (a gathering's replies, screenshots) | its next change, while someone is in voice, is sent anew at the channel's bottom and the old post deleted (`sinksPost`); with nobody in voice it is edited where it is |
| the bot restarts | the post is edited again (its ID in bot_state); missing members are fetched before the first pass |
| the lobby or the post's channel deleted | the suggestions switch off |
| `/settings platoons remove` | the suggestions stop, the post goes |
