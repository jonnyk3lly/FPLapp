"""
FPL Analysis Dashboard — Flask backend
Run with: python app.py  (or double-click launch.bat on Windows)
Then open http://localhost:5000
"""

import os
from flask import Flask, jsonify, render_template, request
import requests, time, webbrowser, threading
import panel as _panel

app = Flask(__name__)

# Set FPL_DEBUG=1 in the environment to see full stack traces (local dev only).
# Off by default so a public deployment never shows visitors internal file
# paths or code — they just get a plain error message.
DEBUG_ERRORS = os.environ.get("FPL_DEBUG") == "1"

@app.errorhandler(Exception)
def handle_exception(e):
    import traceback
    if DEBUG_ERRORS:
        traceback.print_exc()
    payload = {"error": str(e)}
    if DEBUG_ERRORS:
        payload["detail"] = traceback.format_exc()
    return jsonify(payload), 500

# ---------------------------------------------------------------------------
# FPL API session + cache
# ---------------------------------------------------------------------------

BASE = "https://fantasy.premierleague.com/api"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://fantasy.premierleague.com/",
    "Origin": "https://fantasy.premierleague.com",
}
_session = requests.Session()
_session.headers.update(HEADERS)
_cache   = {}
CACHE_TTL = 300

def fpl_get(path):
    url = BASE + path
    now = time.time()
    if url in _cache and now - _cache[url]["ts"] < CACHE_TTL:
        return _cache[url]["data"]
    r = _session.get(url, timeout=15)
    if r.status_code == 404:
        raise ValueError(f"Not found: {path}")
    r.raise_for_status()
    data = r.json()
    _cache[url] = {"data": data, "ts": now}
    return data

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POS_MAP     = {1:"GKP", 2:"DEF", 3:"MID", 4:"FWD"}
FIX_WEIGHTS = [0.35, 0.25, 0.20, 0.12, 0.08]
CS_PTS      = {"GKP":6, "DEF":6, "MID":1, "FWD":0}
DEF_THRESH  = {"DEF":10, "MID":12, "FWD":None, "GKP":None}

def shirt_url(code):
    return f"https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_{code}-110.png"

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def captain_score(p):
    """
    Score a player for captaincy.
    Based on analysis of top 100 managers vs model (season 2024/25):
    - v1 (composite × FDR dominant): -142pts/season gap, 13% agreement
    - v2 (xGI/form primary, FDR small modifier): -21pts/season gap, 34% agreement
    - v3 (+ consistency/rotation penalties): -30pts — overcorrected, reverted
    - v4 (+ team attacking quality): adds team xG/g modifier to penalise
      players on weak attacking teams (B.Fernandes / Man Utd pattern)

    Top-100 data showed B.Fernandes recommended in GW5,16,17,26,27 — all
    100 managers disagreed each time. His xGI is genuine but Man Utd's
    overall attacking quality is poor — individual returns are volatile.
    """
    xgi_score  = min((p.get("xgi90") or 0) / 1.5, 1) if p.get("has_xg") and p.get("starts", 0) >= 5 else 0
    form_score = min((p.get("form") or 0) / 12, 1)
    atk_score  = xgi_score * 0.6 + form_score * 0.4
    fixes      = p.get("fixes", [])
    fix1       = fixes[0] if fixes else None
    fdr_mod    = 1.0 + ((6 - fix1["fdr"]) / 5) * 0.15 if fix1 else 1.0
    dgw_mult   = 1.20 if p.get("is_dgw_imminent") else 1.08 if p.get("has_dgw_next") else 1.0
    inj_mod    = p.get("availability", 1.0)
    pos_mod    = 1.05 if p.get("pos") == "FWD" else 1.0 if p.get("pos") == "MID" else 0.75

    # Team attacking quality modifier — penalises players on weak attacking teams.
    # Poor teams produce volatile individual returns even for good players.
    # League average xG/game ≈ 1.3. Scale: weak (0.9) → average (1.0) → strong (1.1)
    team_xg_pg = p.get("team_xg_pg", 1.3)
    team_atk_mod = max(0.85, min(1.15, team_xg_pg / 1.3))

    return atk_score * fdr_mod * dgw_mult * inj_mod * pos_mod * team_atk_mod


def weighted_fdr(fixes):
    return round(sum(
        (fixes[i]["fdr"] if i < len(fixes) else 3) * w
        for i, w in enumerate(FIX_WEIGHTS)
    ), 2)

# FDR -> expected points multiplier
FDR_MOD = {1: 1.25, 2: 1.10, 3: 1.00, 4: 0.80, 5: 0.65}

def project_gw_points(p, target_gw):
    """
    Estimate FPL points for a player in a specific upcoming GW.
    Returns blank projection for GWs beyond 38 (end of season).
    """
    MAX_GW = 38
    if target_gw > MAX_GW:
        return {"gw": target_gw, "proj": 0.0, "blank": True,
                "dgw": False, "fixes": [], "beyond_season": True}
    fixes    = p.get("fixes", [])
    gw_fixes = [f for f in fixes if f["gw"] == target_gw]

    if not gw_fixes:
        return {"gw": target_gw, "proj": 0.0, "blank": True,
                "dgw": False, "fixes": []}

    starts    = p.get("starts", 0) or 0
    pts_start = p.get("pts_per_start", 4.0) or 4.0
    pos       = p.get("pos", "MID")
    pos_avg   = {"GKP": 4.0, "DEF": 4.0, "MID": 4.5, "FWD": 4.5}.get(pos, 4.0)

    # Small sample blending — weight actual pts_per_start up as starts accumulate
    if starts == 0:
        base = pos_avg
    elif starts < 4:
        blend = starts / 4.0
        base  = pts_start * blend + pos_avg * (1 - blend)
    else:
        base = pts_start

    # xGI adjustment for players with 5+ starts
    if p.get("has_xg") and starts >= 5:
        xgi90    = p.get("xgi90") or 0
        xgi_base = pos_avg + xgi90 * 20
        base     = base * 0.6 + xgi_base * 0.4

    base = max(2.0, min(base, 12.0))

    is_dgw = len(gw_fixes) >= 2

    if is_dgw:
        mods = [FDR_MOD.get(f["fdr"], 1.0) for f in gw_fixes[:2]]
        proj = base * mods[0] + base * mods[1] * 0.85
    else:
        proj = base * FDR_MOD.get(gw_fixes[0]["fdr"], 1.0)

    proj *= p.get("availability", 1.0)

    return {
        "gw":    target_gw,
        "proj":  round(proj, 1),
        "blank": False,
        "dgw":   is_dgw,
        "fixes": gw_fixes,
    }

def build_fix_map(fixtures_raw, teams, current_gw):
    fix_map = {}
    for f in fixtures_raw:
        if f["event"] is None or not (current_gw <= f["event"] < current_gw + 8):
            continue
        for tid, opp_id, home, diff in [
            (f["team_h"], f["team_a"], True,  f["team_h_difficulty"]),
            (f["team_a"], f["team_h"], False, f["team_a_difficulty"]),
        ]:
            fix_map.setdefault(tid, []).append({
                "gw": f["event"], "opp": teams[opp_id]["short_name"],
                "opp_id": opp_id, "home": home, "fdr": diff,
            })
    return fix_map

def get_dgw_map(fix_map, current_gw):
    """team_id -> set of GWs where they have 2+ fixtures. Capped at GW38."""
    from collections import Counter
    result = {}
    for tid, fixes in fix_map.items():
        counts = Counter(f["gw"] for f in fixes if f["gw"] <= 38)
        result[tid] = {gw for gw, n in counts.items() if n >= 2}
    return result

def get_bgw_set(fix_map, current_gw):
    """GWs where 4+ teams have no fixture. Capped at GW38."""
    bgw = set()
    for gw in range(current_gw, min(current_gw + 6, 39)):
        playing = sum(1 for fixes in fix_map.values() if any(f["gw"] == gw for f in fixes))
        if 20 - playing >= 4:
            bgw.add(gw)
    return bgw

def build_team_stats(players_raw):
    """Per-team attacking/defensive strength from season player totals."""
    from collections import defaultdict
    raw = defaultdict(lambda: {"goals":0, "conceded":0, "xg":0.0, "xgc":0.0, "games":0})
    for p in players_raw.values():
        tid = p["team"]
        if POS_MAP.get(p["element_type"]) == "GKP":
            raw[tid]["games"] = max(raw[tid]["games"], max(1, round(p.get("minutes",0)/90)))
        raw[tid]["goals"]    += p.get("goals_scored", 0)
        raw[tid]["conceded"] += p.get("goals_conceded", 0)
        raw[tid]["xg"]       += float(p.get("expected_goals") or 0)
        raw[tid]["xgc"]      += float(p.get("expected_goals_conceded") or 0)
    result = {}
    for tid, s in raw.items():
        g = max(s["games"], 1)
        result[tid] = {
            "goals_pg":    round(s["goals"]    / g, 2),
            "conceded_pg": round(s["conceded"] / g, 2),
            "xg_pg":       round(s["xg"]       / g, 2),
            "xgc_pg":      round(s["xgc"]      / g, 2),
        }
    return result

# ---------------------------------------------------------------------------
# Player enrichment
# ---------------------------------------------------------------------------

def enrich(p_raw, teams, fix_map, dgw_map, team_stats, pick=None):
    fixes     = sorted(fix_map.get(p_raw["team"], []), key=lambda x: x["gw"])
    pos       = POS_MAP[p_raw["element_type"]]
    price     = p_raw["now_cost"] / 10
    form      = float(p_raw.get("form") or 0)
    total_pts = p_raw.get("total_points", 0)
    value     = round(total_pts / price, 1) if price > 0 else 0
    team_id   = p_raw["team"]

    wfdr    = weighted_fdr(fixes)
    fdr_avg = round(sum(f["fdr"] for f in fixes[:5]) / min(len(fixes), 5), 2) if fixes else 3.0

    # Near-term fixture score — GW+1 (60%) and GW+2 (40%) only
    # Lower = easier run in the next 2 weeks. Used as a secondary transfer signal.
    near_fixes = fixes[:2]
    if len(near_fixes) == 2:
        near_fdr = round(near_fixes[0]["fdr"] * 0.6 + near_fixes[1]["fdr"] * 0.4, 2)
    elif len(near_fixes) == 1:
        near_fdr = float(near_fixes[0]["fdr"])
    else:
        near_fdr = 3.0
    # Convert to 0-100 ease score (5=hardest→0, 1=easiest→100)
    near_fix_score = round((6 - near_fdr) / 5 * 100)

    # ── Double gameweek ────────────────────────────────────────────────────
    my_dgws       = dgw_map.get(team_id, set())
    # has_dgw_next: true if DGW is in the next 3 GWs (not just next GW)
    # This ensures badges, captain bonus and planner all fire correctly
    next_3_gws    = {f["gw"] for f in fixes[:6]}  # up to 3 GWs worth of fixtures
    dgw_in_next3  = sorted(my_dgws & next_3_gws)
    has_dgw_next  = len(dgw_in_next3) > 0
    dgw_next_gw   = dgw_in_next3[0] if dgw_in_next3 else None  # which GW the DGW is
    is_dgw_imminent = fixes[0]["gw"] in my_dgws if fixes else False  # strictly next GW
    dgw_gws       = sorted(my_dgws)
    n_dgw_in_5    = sum(1 for f in fixes[:5] if f["gw"] in my_dgws)
    # DGW composite bonus: extra fixture ≈ +50% pts, distance-weighted
    dgw_bonus = min(sum(FIX_WEIGHTS[i] * 0.5 for i, f in enumerate(fixes[:5])
                        if f["gw"] in my_dgws), 0.25)

    # ── Rotation risk ──────────────────────────────────────────────────────
    # Two signals: European competition membership + fixture congestion
    # European clubs 2024/25 — UCL, UEL, UECL participants (by FPL short name)
    EUROPEAN_CLUBS = {
        # Champions League
        "Man City", "Arsenal", "Liverpool", "Aston Villa",
        # Europa League
        "Man Utd", "Chelsea", "Spurs", "Rangers",
        # Conference League
        "Chelsea",   # already in EL but some years split
    }
    # Match against team short name
    team_short = teams.get(team_id, {}).get("short_name", "")
    in_europe  = team_short in EUROPEAN_CLUBS

    # Fixture congestion: count fixtures in next 6 GWs from fix_map
    # Normal = 6 (one per GW). 7+ implies at least one midweek game not in FPL
    team_fixes_6 = fix_map.get(team_id, [])
    fix_count_6  = len(team_fixes_6)  # fix_map already limited to 8 GWs ahead
    congested    = fix_count_6 >= 8   # 8+ in 8-GW window = clear congestion

    # Only flag rotation risk for positions that actually rotate
    # GKPs almost never rotate; FWDs less so; MID/DEF more susceptible at big clubs
    rotation_positions = {"DEF", "MID", "FWD"} if in_europe else {"MID", "FWD"}
    has_rotation_risk  = (in_europe or congested) and pos in rotation_positions

    if in_europe and congested:
        rotation_risk       = "both"
        rotation_risk_label = f"⚠ European club + congested schedule"
    elif in_europe:
        rotation_risk       = "european"
        rotation_risk_label = f"⚠ European club — rotation possible"
    elif congested:
        rotation_risk       = "congested"
        rotation_risk_label = f"⚠ Congested schedule — fatigue risk"
    else:
        rotation_risk       = None
        rotation_risk_label = ""

    # ── Playing time reliability ───────────────────────────────────────────
    # Measures two things separately:
    #   1. starts_reliability  — how often they actually start (not sub appearances)
    #   2. mins_per_start_norm — whether they complete games when they do start
    # Combined these give a true picture of FPL value: a player who starts 90%
    # of games and plays 85 mins each time is far more valuable than one with
    # the same raw minutes split across 15 sub appearances.
    season_mins  = p_raw.get("minutes", 0)
    starts_raw   = int(p_raw.get("starts") or 0)
    starts       = max(1, starts_raw)   # floor for division safety only

    # Estimate games available — January signings penalised less
    gws_available = max(starts_raw, max(5, round(season_mins / 90))) if season_mins > 0 else 5
    gws_available = min(gws_available, 38)

    # ── Starts reliability ─────────────────────────────────────────────────
    # Three tiers based on evidence:
    #   0 starts (pure sub / unused) → very low prior (0.20)
    #   1-4 starts (new/rotation)    → neutral prior (0.70) — not enough data
    #   5+ starts                    → use actual ratio
    if starts_raw == 0:
        starts_reliability = 0.20   # barely plays — strong penalty
    elif starts_raw < 5:
        starts_reliability = 0.70   # new signing / early season prior
    else:
        starts_reliability = min(starts_raw / gws_available, 1.0)

    # Minutes per start — use season_mins / starts_raw if they have starts,
    # else use season_mins directly as a proxy (all sub minutes)
    if starts_raw > 0:
        mins_per_start      = season_mins / starts_raw
        mins_per_start_norm = min(mins_per_start / 90, 1.0)
    else:
        # Pure sub: penalise — sub minutes don't reflect starting ability
        mins_per_start      = season_mins / max(1, int(p_raw.get("total_points", 0) > 0))
        mins_per_start_norm = min(season_mins / 900, 0.3)   # cap at 0.3 for pure subs

    # Combined playing time score
    playing_time_norm = starts_reliability * 0.65 + mins_per_start_norm * 0.35

    # ── Injury discount ────────────────────────────────────────────────────
    status      = p_raw.get("status", "a")
    chance_next = p_raw.get("chance_of_playing_next_round")
    chance_this = p_raw.get("chance_of_playing_this_round")
    chance      = chance_next if chance_next is not None else chance_this
    news        = p_raw.get("news", "") or ""

    # Availability discount — based on chance_of_playing.
    # Test data showed 75% players average MORE form than fully fit (2.17 vs 1.13)
    # because FPL tags returning stars (Haaland etc) as 75% when they're fine.
    # Reduce 75% penalty significantly; keep larger discounts for 50% and below.
    if chance is None or chance >= 100:
        availability = 1.00
    elif chance >= 75:
        availability = 0.92   # was 0.78 — very mild discount, usually starts
    elif chance >= 50:
        availability = 0.60   # was 0.55 — genuine doubt
    elif chance >= 25:
        availability = 0.30   # unchanged
    else:
        availability = 0.15   # unchanged

    # ── xG metrics (native FPL API) ────────────────────────────────────────
    def _f(k): return float(p_raw.get(k) or 0)
    xg90        = _f("expected_goals_per_90")
    xa90        = _f("expected_assists_per_90")
    xgi90       = _f("expected_goal_involvements_per_90")
    xgc90       = _f("expected_goals_conceded_per_90")
    xg_overperf = round(_f("goals_scored") - _f("expected_goals"), 2)
    has_xg      = season_mins >= 90 and xgi90 > 0

    # ── Opponent adjustment ─────────────────────────────────────────────────
    opp_adj = 0.0
    if fixes:
        opp_id = fixes[0].get("opp_id")
        if opp_id and opp_id in team_stats:
            opp   = team_stats[opp_id]
            avg_c = 1.3   # EPL avg goals conceded/game
            avg_g = 1.3   # EPL avg goals scored/game
            if pos in ("MID", "FWD"):
                opp_adj = (opp["conceded_pg"] - avg_c) / avg_c * 0.08
            elif pos in ("GKP", "DEF"):
                opp_adj = -(opp["goals_pg"] - avg_g) / avg_g * 0.08
            opp_adj = max(-0.10, min(0.10, opp_adj))

    # ── BPS defensive contribution ─────────────────────────────────────────
    bps_total    = _f("bps")
    bps_per_game = round(bps_total / starts_raw, 2) if starts_raw > 0 else 0.0
    def_threshold = DEF_THRESH.get(pos)
    def_contrib_norm = (min(bps_per_game / def_threshold, 1.5) / 1.5
                        if def_threshold and bps_per_game > 0 else 0.0)

    # ── Expected clean sheets ──────────────────────────────────────────────
    # Three-factor model:
    #   1. Base CS probability from team's own defensive record (xGC/90)
    #   2. Opponent threat: are they generating more/less xG than average?
    #   3. Opponent regression: scoring above xG (lucky, will cool) = better
    #      for CS. Scoring below xG (due goals) = worse for CS.
    cs_pts = CS_PTS.get(pos, 0)
    if xgc90 > 0 and cs_pts > 0:
        base_cs_prob = max(0.0, min(0.38, 0.5 / max(xgc90, 0.1)))

        opp_id = fixes[0].get("opp_id") if fixes else None
        if opp_id and opp_id in team_stats:
            opp = team_stats[opp_id]
            league_avg_xg  = 1.2
            opp_threat     = opp["xg_pg"] / max(league_avg_xg, 0.1)
            opp_regression = max(0.75, min(1.30,
                                 opp["goals_pg"] / max(opp["xg_pg"], 0.1)))
            opp_threat_adj = max(0.70, min(1.30, opp_threat / opp_regression))
            cs_prob = round(max(0.0, min(0.38, base_cs_prob / opp_threat_adj)), 3)
        else:
            cs_prob = round(min(base_cs_prob, 0.38), 3)

        xcs_pts_per_game = round(cs_prob * cs_pts, 2)
        xcs_norm = (min(xcs_pts_per_game / 4.0, 1.0) if pos in ("GKP","DEF")
                    else min(xcs_pts_per_game / 0.5, 1.0))
    else:
        cs_prob = xcs_pts_per_game = xcs_norm = 0.0

    # ── Price change momentum ──────────────────────────────────────────────
    transfers_in  = p_raw.get("transfers_in_event", 0)
    transfers_out = p_raw.get("transfers_out_event", 0)
    net_transfers = transfers_in - transfers_out
    price_change  = p_raw.get("cost_change_event", 0)
    price_rising  = net_transfers >  50000 and price_change == 0
    price_falling = net_transfers < -50000 and price_change == 0

    # ── Composite score ────────────────────────────────────────────────────
    # Weights: (form, xGI/90, pts/start, wFDR, playing_time, BPS/start, xCS)
    # Recalibrated from backtest correlation analysis (season 2024/25):
    #   - xGI/90 is the strongest individual signal (r=0.074 overall, higher for FWDs)
    #   - pts/start near-zero correlation (r=0.007) — demoted to tiebreaker
    #   - DEF/GKP composite driven by CS probability — fixture/xCS weighted up
    #   - FWD composite was working (r=0.121) — increase xGI weight further
    W = {
        "GKP": (0.15, 0.00, 0.05, 0.20, 0.15, 0.05, 0.40),
        "DEF": (0.15, 0.10, 0.05, 0.30, 0.10, 0.10, 0.20),
        "MID": (0.25, 0.40, 0.05, 0.15, 0.10, 0.05, 0.00),
        "FWD": (0.20, 0.50, 0.05, 0.15, 0.10, 0.00, 0.00),
    }

    # ── Attacking MID role detection ───────────────────────────────────────
    # Some FPL midfielders play in a forward/attacking role (Mbeumo, Saka,
    # Salah, Diaz etc). Detect by high xGI/90 + low BPS contribution.
    # Score them with FWD-like weights to reflect their actual role.
    effective_pos = pos
    if pos == "MID" and has_xg and starts_raw >= 5:
        goals   = float(p_raw.get("goals_scored") or 0)
        assists = float(p_raw.get("assists") or 0)
        # Attacking MID criteria: high xGI AND more goals than assists (finisher)
        # OR very high xGI (≥0.5/90) regardless of goals/assists split
        if xgi90 >= 0.50:
            effective_pos = "ATK_MID"   # pure attacker in MID shirt
        elif xgi90 >= 0.35 and goals > 0 and goals >= assists:
            effective_pos = "ATK_MID"   # goal-threat MID
    if effective_pos == "ATK_MID":
        # Blend MID and FWD weights — these players earn points like FWDs
        # but still have some midfield utility
        w_mid = W["MID"]
        w_fwd = W["FWD"]
        w = tuple(round(w_mid[i]*0.35 + w_fwd[i]*0.65, 3) for i in range(7))
    else:
        w = W.get(pos, W["MID"])

    # ── FDR threshold model ────────────────────────────────────────────────
    # Data shows FDR is non-linear: FDR5 has strong signal (W=0-12% for that team)
    # but FDR2-4 is near coin-flip. Apply as threshold flag not continuous weight.
    # FDR5 next fixture = hard penalty regardless of other signals.
    # FDR1 = small bonus. FDR2-4 = near-neutral with slight gradient.
    next_fdr_val = fixes[0]["fdr"] if fixes else 3
    if next_fdr_val == 5:
        fdr_score = 0.20    # explicit penalty — FDR5 data shows near-zero win rate
    elif next_fdr_val == 4:
        fdr_score = 0.45    # slightly below neutral
    elif next_fdr_val == 3:
        fdr_score = 0.55    # neutral
    elif next_fdr_val == 2:
        fdr_score = 0.65    # slightly above neutral
    else:                   # FDR1 — rare, strong signal
        fdr_score = 0.80
    # wFDR (5-game weighted) still used for longer-term fixture run assessment
    # but next-fixture threshold is the primary signal in composite
    form_norm = min(form / 12, 1)
    # pts_per_start: only reliable with 3+ starts
    # Below 3 starts: blend with form to avoid small-sample inflation
    # 0 starts: use form only (no start data at all)
    pts_per_start = round(total_pts / starts_raw, 2) if starts_raw > 0 else 0.0
    if starts_raw >= 5:
        pts_per_start_norm = min(pts_per_start / 10, 1.0)
    elif starts_raw >= 3:
        # Blend: 50% actual pts/start, 50% form proxy — reduces small-sample noise
        pts_per_start_norm = min((pts_per_start / 10 * 0.5 + form_norm * 0.5), 1.0)
    elif starts_raw >= 1:
        # Very few starts — weight form heavily, pts/start lightly
        pts_per_start_norm = min((pts_per_start / 10 * 0.2 + form_norm * 0.8), 1.0)
    else:
        pts_per_start_norm = form_norm * 0.5   # no starts at all — pure form proxy at half weight
    xgi_norm  = min(xgi90 / 1.5, 1) if (has_xg and starts_raw >= 5) else form_norm * 0.75
    xg_adj    = max(-0.08, min(0.08, -(xg_overperf / 10))) if has_xg else 0

    # ── Form trend adjustment ──────────────────────────────────────────────
    # Compares current form (rolling 5-game avg) against season pts/start.
    # Rising form = player scoring above their own baseline → small bonus
    # Falling form = scoring well below baseline → small penalty
    # Only applied when we have reliable season data (5+ starts)
    form_trend = 0.0
    form_trend_label = "→"   # neutral default
    if starts_raw >= 5 and pts_per_start > 0:
        trend_ratio = form / pts_per_start if pts_per_start > 0 else 1.0
        if trend_ratio >= 1.3:
            form_trend = 0.03    # clearly above season avg — accelerating
            form_trend_label = "↑↑"
        elif trend_ratio >= 1.1:
            form_trend = 0.015   # slightly above — rising
            form_trend_label = "↑"
        elif trend_ratio <= 0.6:
            form_trend = -0.03   # well below season avg — declining badly
            form_trend_label = "↓↓"
        elif trend_ratio <= 0.8:
            form_trend = -0.015  # below — cooling
            form_trend_label = "↓"
        # else neutral — form_trend stays 0.0, label stays →

    raw_score = (
        form_norm          * w[0] +
        xgi_norm           * w[1] +
        pts_per_start_norm * w[2] +
        fdr_score          * w[3] +
        playing_time_norm  * w[4] +
        def_contrib_norm   * w[5] +
        xcs_norm           * w[6] +
        xg_adj + dgw_bonus + opp_adj + form_trend
    )
    composite = max(0, min(100, round(raw_score * 100 * availability)))

    return {
        "id": p_raw["id"], "name": p_raw["web_name"],
        "full_name": f'{p_raw["first_name"]} {p_raw["second_name"]}',
        "team": team_id, "team_name": teams[team_id]["short_name"],
        "team_xg_pg": team_stats.get(team_id, {}).get("xg_pg", 1.3),
        "team_code": teams[team_id]["code"], "pos": pos,
        "price": price, "form": form, "total_pts": total_pts, "value": value,
        "pts_per_start": round(pts_per_start, 2),
        "pts_per_start_norm": round(pts_per_start_norm, 3),
        "fdr_avg": fdr_avg, "wfdr": wfdr, "near_fdr": near_fdr, "near_fix_score": near_fix_score, "composite": composite,
        "has_xg": has_xg, "xg90": xg90, "xa90": xa90, "xgi90": xgi90,
        "effective_pos": effective_pos,
        "xg_overperf": xg_overperf,
        "bps_per_game": bps_per_game, "def_contrib_norm": round(def_contrib_norm, 3),
        "def_threshold": def_threshold,
        "xgc90": round(xgc90, 3), "cs_prob": cs_prob, "xcs_pts_per_game": xcs_pts_per_game,
        "minutes": season_mins, "starts": starts_raw,
        "starts_reliability": round(starts_reliability, 3),
        "mins_per_start": round(mins_per_start, 1),
        "playing_time_norm": round(playing_time_norm, 3),
        "status": status, "news": news, "chance": chance, "availability": round(availability, 2),
        "has_dgw_next": has_dgw_next, "dgw_next_gw": dgw_next_gw,
        "is_dgw_imminent": is_dgw_imminent, "dgw_gws": dgw_gws, "n_dgw": n_dgw_in_5,
        "rotation_risk": rotation_risk, "rotation_risk_label": rotation_risk_label,
        "price_rising": price_rising, "price_falling": price_falling,
        "net_transfers": net_transfers, "price_change": round(price_change / 10, 1),
        "ownership": float(p_raw.get("selected_by_percent") or 0),
        "differential_score": round(composite * (1 - min(float(p_raw.get("selected_by_percent") or 0), 100) / 100) ** 0.4, 1),
        "shirt": shirt_url(teams[team_id]["code"]),
        "multiplier": pick["multiplier"] if pick else 1,
        "is_sub": (pick["position"] > 11) if pick else False,
        "pick_pos": pick["position"] if pick else 0,
        "fixes": fixes, "opp_adj": round(opp_adj, 3),
        "form_trend": round(form_trend, 3), "form_trend_label": form_trend_label,
    }

# ---------------------------------------------------------------------------
# Transfer & combo logic
# ---------------------------------------------------------------------------

def build_transfer_groups(my_squad, all_players, bank, free_transfers, current_gw):
    my_ids = {p["id"] for p in my_squad}
    groups = []
    for pos in ["DEF", "MID", "FWD"]:
        my_in_pos = sorted(
            [p for p in my_squad if p["pos"] == pos and not p["is_sub"]],
            key=lambda x: x["composite"]
        )
        available = sorted(
            [p for p in all_players if p["pos"] == pos and p["id"] not in my_ids
             and p["status"] == "a" and (p["chance"] is None or p["chance"] >= 75)
             and p.get("starts", 0) >= 5],   # raised from 2 — test showed small-sample players (Beto etc) dominate worst calls
            key=lambda x: -x["composite"]
        )
        for out_p in my_in_pos:
            options = []
            for in_p in available[:40]:   # scan top 40 by composite, not just first few
                extra = round(in_p["price"] - out_p["price"], 1)
                if max(0.0, extra) > bank + 0.05:
                    continue
                gain = in_p["composite"] - out_p["composite"]
                form_gain = round(in_p["form"] - out_p["form"], 1)
                fdr_gain  = round(out_p["wfdr"] - in_p["wfdr"], 2)
                bank_used = round(min(bank, max(0, extra)), 1)
                uses_free = free_transfers > 0
                hit_cost  = 0 if uses_free else 4

                # Primary gate: use projected pts gain — composite alone misses BGW/DGW
                in_proj3   = round(sum(project_gw_points(in_p,  current_gw+i)["proj"] for i in range(3)), 1)
                out_proj3  = round(sum(project_gw_points(out_p, current_gw+i)["proj"] for i in range(3)), 1)
                proj_gain3 = round(in_proj3 - out_proj3, 1)

                # Skip only if BOTH projected AND composite gain are clearly negative
                # Allows recommending a lower-composite player who plays over a blanking one
                if proj_gain3 < -1.0 and gain < 5:
                    continue

                # Skip incoming players overperforming xG significantly —
                # test showed these dominate worst calls (Beto pattern)
                in_overperf_val = in_p.get("xg_overperf", 0) or 0
                if in_overperf_val >= 3:
                    continue  # regression likely, don't recommend regardless of composite

                # Breakeven in GWs: hit_cost / avg_pts_gained_per_gw
                avg_pts_gained = proj_gain3 / 3
                breakeven = round(hit_cost / avg_pts_gained, 1) if hit_cost > 0 and avg_pts_gained > 0 else None
                # Hit is worth it if: BE ≤ 2 GWs, incoming has easy run, clear pts gain
                hit_worth = (breakeven is not None and breakeven <= 2.0
                             and in_p["wfdr"] <= 2.5 and proj_gain3 > 5.0)

                # Verdict uses BOTH composite gain AND projected pts gain.
                # Test data showed composite-only verdicts are only 35% correct.
                # proj_gain3 is more grounded — use it as primary gating signal.
                if uses_free:
                    # Raised thresholds from test data (old gain>=20 was 35% correct)
                    # Also gate on proj_gain3 being non-negative — don't suggest if
                    # incoming player projects fewer pts despite composite gain
                    if gain >= 22 and proj_gain3 >= 0:
                        verdict = "Strong"
                    elif gain >= 12 and proj_gain3 >= -1.0:
                        verdict = "Good"
                    else:
                        verdict = "Marginal"
                else:
                    verdict = "Strong" if (gain >= 28 and hit_worth and proj_gain3 >= 2.0) \
                         else "Consider hit" if hit_worth else "Risky hit"

                parts = []
                # ── Regression / availability signals ───────────────────
                out_overperf = out_p.get("xg_overperf", 0) or 0
                in_overperf  = in_p.get("xg_overperf",  0) or 0
                if out_overperf >= 3:
                    parts.append(f"⚠ selling: xG overperf +{out_overperf:.1f} — regression likely")
                if in_overperf <= -2:
                    parts.append(f"✅ buying: xG underperf {in_overperf:.1f} — goals due")
                if out_p.get("chance") is not None and out_p["chance"] < 100:
                    parts.append(f"⚠ outgoing {out_p['chance']}% fit")
                # ── Standard signals ────────────────────────────────────
                if form_gain > 0:   parts.append(f"form +{form_gain:.1f}")
                elif form_gain < 0: parts.append(f"form {form_gain:.1f}")
                if in_p.get("xgi90") and out_p.get("xgi90"):
                    d = round(in_p["xgi90"] - out_p["xgi90"], 2)
                    if abs(d) >= 0.1: parts.append(f"xGI/90 {d:+.2f}")
                if fdr_gain > 0.2: parts.append(f"easier run (wFDR {in_p['wfdr']} vs {out_p['wfdr']})")
                # Near-term fixture signal — GW+1/+2 comparison
                in_near  = in_p.get("near_fdr",  3.0)
                out_near = out_p.get("near_fdr", 3.0)
                near_diff = round(out_near - in_near, 1)
                if near_diff >= 1.0:
                    parts.append(f"📅 much easier next 2 GWs (near FDR {in_near} vs {out_near})")
                elif near_diff >= 0.5:
                    parts.append(f"📅 easier near-term (near FDR {in_near} vs {out_near})")
                elif near_diff <= -1.0:
                    parts.append(f"⚠ harder next 2 GWs (near FDR {in_near} vs {out_near})")
                if in_p.get("is_dgw_imminent"): parts.append("🔥 DGW next GW")
                elif in_p.get("has_dgw_next"): parts.append(f"🔥 DGW in GW{in_p.get('dgw_next_gw','')}")
                if (in_p.get("value") or 0) > (out_p.get("value") or 0) + 1:
                    parts.append(f"better value ({in_p.get('value','?')} vs {out_p.get('value','?')})")
                if in_p.get("price_rising"):  parts.append("📈 price rise imminent")
                if in_p.get("opp_adj", 0) > 0.03: parts.append("weak opponent next")
                # Differential flag — low ownership + strong composite
                in_own = in_p.get("ownership", 100)
                if in_own <= 5 and gain >= 10:
                    parts.append(f"🎯 differential — only {in_own:.1f}% owned")
                elif in_own <= 10 and gain >= 15:
                    parts.append(f"low ownership ({in_own:.1f}%)")
                # Form trend signals
                in_trend  = in_p.get("form_trend_label",  "→")
                out_trend = out_p.get("form_trend_label", "→")
                if in_trend == "↑↑":   parts.append("📈 form accelerating strongly")
                elif in_trend == "↑":  parts.append("↑ form rising")
                if out_trend == "↓↓":  parts.append("📉 selling: form declining badly")
                elif out_trend == "↓": parts.append("↓ seller cooling")
                # Rotation risk on incoming player — flag as a caution
                in_rot = in_p.get("rotation_risk")
                if in_rot:
                    parts.append(f"⚠ {in_p.get('rotation_risk_label','rotation risk')}")
                # Rotation risk on outgoing — acts as extra sell signal
                out_rot = out_p.get("rotation_risk")
                if out_rot and out_rot in ("european", "both"):
                    parts.append("✅ selling: European rotation risk removed")
                if uses_free: parts.append("free transfer")
                elif breakeven: parts.append(f"4pt hit · BE ~{breakeven} GWs {'✓' if hit_worth else '⚠'}")
                if bank_used > 0: parts.append(f"costs £{bank_used:.1f}m bank")

                next_fix = in_p["fixes"][0] if in_p["fixes"] else None
                # 3-GW projected points comparison
                in_proj  = [project_gw_points(in_p,  current_gw + i) for i in range(3)]
                out_proj = [project_gw_points(out_p, current_gw + i) for i in range(3)]
                in_proj3   = round(sum(p["proj"] for p in in_proj),  1)
                out_proj3  = round(sum(p["proj"] for p in out_proj), 1)
                proj_gain3 = round(in_proj3 - out_proj3, 1)
                in_has_dgw   = any(p["dgw"]   for p in in_proj)
                out_has_blank = any(p["blank"] for p in out_proj)
                # Update snippet flags with horizon-aware info
                if in_has_dgw and "DGW next GW" not in " ".join(parts):
                    parts.append("🔥 DGW in next 3 GWs")
                if out_has_blank:
                    parts.append("⚠ outgoing player blanks")
                # ── Timing recommendation ──────────────────────────────────
                # Synthesises all signals into a single "act now / hold / consider" sentence.
                act_reasons  = []
                hold_reasons = []

                # Act now signals
                if in_p.get("has_dgw_next"):
                    act_reasons.append("incoming player has a DGW next GW")
                if any(p["dgw"] for p in in_proj):
                    act_reasons.append("DGW coming in next 3 GWs")
                if in_p.get("price_rising"):
                    act_reasons.append("price rise imminent — buy before it happens")
                if (out_p.get("xg_overperf") or 0) >= 3:
                    act_reasons.append("seller overperforming xG — regression due")
                if out_has_blank:
                    act_reasons.append("seller blanks in next 3 GWs")
                if out_p.get("chance") is not None and out_p["chance"] <= 75:
                    act_reasons.append("seller has injury doubt")
                in_trend  = in_p.get("form_trend_label",  "→")
                out_trend = out_p.get("form_trend_label", "→")
                if in_trend in ("↑↑",):
                    act_reasons.append("incoming player's form is accelerating")
                if out_trend in ("↓↓",):
                    act_reasons.append("seller's form is declining badly")
                if out_p.get("rotation_risk") in ("european", "both"):
                    act_reasons.append("seller has European rotation risk")
                if in_p.get("rotation_risk") in ("european", "both"):
                    hold_reasons.append("incoming player also has European rotation risk")

                # Hold signals
                if out_p.get("wfdr", 3) <= 2.0 and not out_has_blank:
                    hold_reasons.append(f"seller has an easy run (wFDR {out_p['wfdr']})")
                if not uses_free and not hit_worth:
                    hold_reasons.append("hit cost not justified by projected gain")
                if in_p.get("next_fdr", 3) >= 4:
                    hold_reasons.append(f"incoming player faces a tough opener (FDR {in_p.get('next_fdr',3)})")
                if proj_gain3 < 1.0 and not act_reasons:
                    hold_reasons.append("minimal projected points gain over 3 GWs")

                # Build timing sentence
                if act_reasons:
                    timing_verdict = f"Act now — {act_reasons[0]}."
                    if len(act_reasons) > 1:
                        timing_verdict += f" Also: {act_reasons[1]}."
                elif hold_reasons:
                    timing_verdict = f"Consider holding — {hold_reasons[0]}."
                else:
                    timing_verdict = "No strong timing signal — standard transfer."

                options.append({
                    "in": {k: in_p.get(k) for k in ["id","name","team_name","price","form","wfdr",
                                                      "composite","xgi90","cs_prob","has_dgw_next",
                                                      "price_rising","availability","chance",
                                                      "form_trend_label","ownership","differential_score","rotation_risk","rotation_risk_label","near_fdr","near_fix_score"]},
                    "in_fixes":   in_p["fixes"][:5],
                    "in_proj3":   in_proj3,
                    "out_proj3":  out_proj3,
                    "proj_gain3": proj_gain3,
                    "in_proj_gws": [{"gw":p["gw"],"proj":p["proj"],"dgw":p["dgw"],"blank":p["blank"]}
                                    for p in in_proj],
                    "gain": gain, "verdict": verdict,
                    "timing_verdict": timing_verdict,
                    "snippet": " · ".join(parts) or "Marginal improvement",
                    "uses_free": uses_free, "hit_cost": hit_cost,
                    "extra": extra, "bank_used": bank_used,
                    "remaining_bank": round(bank - bank_used, 1),
                    "form_gain": form_gain, "fdr_gain": fdr_gain,
                    "breakeven": breakeven, "hit_worth": hit_worth,
                    "next_fix": (f'{next_fix["opp"]} ({"H" if next_fix["home"] else "A"})'
                                 if next_fix else "TBC"),
                    "next_fdr": next_fix["fdr"] if next_fix else 3,
                })
                if len(options) >= 3:
                    break
            if options:
                vord = {"Strong":0,"Good":1,"Consider hit":2,"Marginal":3,"Risky hit":4}
                options.sort(key=lambda x: (vord.get(x["verdict"],5), -x["gain"]))
                # Regression alert on outgoing player — shown as banner on transfer card
                out_regression_alert = None
                if (out_p.get("xg_overperf") or 0) >= 3:
                    out_regression_alert = f'Overperforming xG by {out_p.get("xg_overperf", 0):.1f} this season — returns likely to regress'
                elif (out_p.get("xg_overperf") or 0) >= 2:
                    out_regression_alert = f'Slight xG overperformance ({out_p.get("xg_overperf", 0):.1f}) — worth monitoring'

                groups.append({
                    "out": {k: out_p.get(k) for k in ["id","name","team_name","price","form",
                                                        "wfdr","composite","pos","has_dgw_next",
                                                        "chance","availability","news",
                                                        "xg_overperf"]},
                    "out_regression_alert": out_regression_alert,
                    "out_fixes": out_p["fixes"][:5],
                    "pos": pos, "options": options,
                    "best_verdict": options[0]["verdict"],
                })
    vord = {"Strong":0,"Good":1,"Consider hit":2,"Marginal":3,"Risky hit":4}
    groups.sort(key=lambda g: (vord.get(g["best_verdict"],5), -g["options"][0]["gain"]))
    return groups

def build_combos(my_squad, all_players, bank, free_transfers, current_gw=1):
    my_ids   = {p["id"] for p in my_squad}
    starters = [p for p in my_squad if not p["is_sub"]]
    all_moves = []

    for out_p in starters:
        if out_p["pos"] == "GKP": continue
        # When a DGW is imminent, sort candidates by DGW projected pts first
        # Derive next DGW from players' own projections — no dgw_map needed
        next_dgw_gw = None
        for _cp in all_players[:50]:
            for _proj in (_cp.get("projections") or []):
                if _proj.get("dgw") and _proj["gw"] >= current_gw:
                    if next_dgw_gw is None or _proj["gw"] < next_dgw_gw:
                        next_dgw_gw = _proj["gw"]
            if next_dgw_gw:
                break

        def cand_sort_key(p):
            if next_dgw_gw:
                dgw_proj = next((x["proj"] for x in (p.get("projections") or [])
                                 if x["gw"] == next_dgw_gw), 0)
                return (-dgw_proj, -p["composite"])
            return (-p["composite"],)

        cands = sorted(
            [p for p in all_players if p["pos"] == out_p["pos"] and p["id"] not in my_ids
             and p["status"] == "a" and (p["chance"] is None or p["chance"] >= 75)
             and p.get("starts", 0) >= 5],
            key=cand_sort_key
        )[:30]
        for in_p in cands:
            comp_gain = in_p["composite"] - out_p["composite"]
            comp_gain = in_p["composite"] - out_p["composite"]
            # Use proj_gain as primary gate — composite misses BGW/DGW
            in_proj3  = round(sum(project_gw_points(in_p,  current_gw+i)["proj"] for i in range(3)), 1)
            out_proj3 = round(sum(project_gw_points(out_p, current_gw+i)["proj"] for i in range(3)), 1)
            proj_gain3 = round(in_proj3 - out_proj3, 1)
            # Skip only if both composite AND projected gain are clearly negative
            if comp_gain < -15 and proj_gain3 < -2: continue
            all_moves.append({
                "out": out_p, "in": in_p,
                "gain": comp_gain,
                "proj_gain": proj_gain3,
                "price_delta": round(in_p["price"] - out_p["price"], 1),
            })
    singles, doubles = [], []
    for m in all_moves:
        ba = round(bank - max(0, m["price_delta"]), 1)
        if ba < -0.05: continue
        hit = 0 if free_transfers >= 1 else 4
        net_comp = m["gain"] - hit
        net_proj = round(m["proj_gain"] - hit, 1)
        if net_comp < 5: continue
        singles.append({
            "type":"single","moves":[m],
            "gain":m["gain"],"proj_gain":m["proj_gain"],
            "net_gain":net_comp,"net_proj":net_proj,
            "hit_pts":hit,"bank_after":ba,
        })
    # Sort singles by projected gain primarily, composite secondarily
    singles.sort(key=lambda x: (-x["net_proj"], -x["net_gain"]))

    # ── Doubles, triples, quads ─────────────────────────────────────────────
    # Sort moves by combined value descending for pairing
    top  = sorted(all_moves, key=lambda x: -(x["proj_gain"] + x["gain"]))[:50]
    seen = set()
    doubles, triples, quads = [], [], []

    def try_combo(moves):
        """Validate a combination of moves: check IDs unique, bank flows, compute metrics."""
        all_ids = [m["out"]["id"] for m in moves] + [m["in"]["id"] for m in moves]
        if len(set(all_ids)) < len(all_ids):
            return None   # duplicate player
        n = len(moves)
        # Simulate bank after each transfer in order
        bank_state = bank
        for m in moves:
            bank_state = round(bank_state + m["out"]["price"] - m["in"]["price"], 1)
            if bank_state < -0.05:
                return None   # can't afford in this order
        # Also check buy-first order (may be different)
        # Hits: transfers beyond free_transfers each cost 4pts
        hits     = max(0, n - free_transfers)
        hit_pts  = hits * 4
        # Risk label by hit count
        risk = {0:"Standard", 1:"1 hit", 2:"2 hits", 3:"3 hits"}[min(hits,3)]

        total_gain     = sum(m["gain"]      for m in moves)
        total_proj     = sum(m["proj_gain"] for m in moves)
        net_gain       = total_gain - hit_pts
        net_proj       = round(total_proj   - hit_pts, 1)

        if net_gain < max(5, hits * 8): return None   # hits must be clearly worthwhile

        # Sort moves within combo by composite gain desc (best move first)
        moves_sorted = sorted(moves, key=lambda x: -x["gain"])

        freed = round(moves[0]["out"]["price"] - moves[0]["in"]["price"], 1)
        both_dgw = all(m["in"].get("has_dgw_next") for m in moves)
        synergy  = freed > 0.4 and any(m["price_delta"] > 0 for m in moves[1:])

        return {
            "type": {2:"double",3:"triple",4:"quad"}[n],
            "n": n,
            "moves": moves_sorted,
            "gain": total_gain,
            "proj_gain": total_proj,
            "net_gain": net_gain,
            "net_proj": net_proj,
            "hit_pts": hit_pts,
            "hits": hits,
            "risk": risk,
            "bank_after": round(bank_state, 1),
            "synergy": synergy,
            "both_dgw": both_dgw,
            "freed_by_m1": max(0, freed),
        }

    for i, m1 in enumerate(top):
        for j, m2 in enumerate(top):
            if j <= i: continue
            # Double
            ids2 = frozenset([m1["out"]["id"],m1["in"]["id"],m2["out"]["id"],m2["in"]["id"]])
            if len(ids2) == 4 and ids2 not in seen:
                c = try_combo([m1, m2])
                if c:
                    seen.add(ids2)
                    doubles.append(c)

            # Triple — pair with a third move
            for k, m3 in enumerate(top):
                if k <= j: continue
                ids3 = frozenset([m1["out"]["id"],m1["in"]["id"],
                                   m2["out"]["id"],m2["in"]["id"],
                                   m3["out"]["id"],m3["in"]["id"]])
                if len(ids3) == 6 and ids3 not in seen:
                    c = try_combo([m1, m2, m3])
                    if c:
                        seen.add(ids3)
                        triples.append(c)

                        # Quad — pair with a fourth move (only try top 20 for performance)
                        if i < 20:
                            for l, m4 in enumerate(top):
                                if l <= k: continue
                                ids4 = frozenset([m1["out"]["id"],m1["in"]["id"],
                                                   m2["out"]["id"],m2["in"]["id"],
                                                   m3["out"]["id"],m3["in"]["id"],
                                                   m4["out"]["id"],m4["in"]["id"]])
                                if len(ids4) == 8 and ids4 not in seen:
                                    c = try_combo([m1, m2, m3, m4])
                                    if c:
                                        seen.add(ids4)
                                        quads.append(c)

    doubles.sort(key=lambda x: (-x["net_proj"], -x["net_gain"]))
    triples.sort(key=lambda x: (-x["net_proj"], -x["net_gain"]))
    quads.sort(key=lambda x: (-x["net_proj"], -x["net_gain"]))
    return singles[:10], doubles[:6], triples[:4], quads[:2]

# ---------------------------------------------------------------------------
# Chip analysis
# ---------------------------------------------------------------------------

def compute_chip_scores(my_squad, all_players, fix_map, dgw_map, bgw_set,
                        chips_used, active_chip, bank, free_transfers, current_gw):
    starters = sorted([p for p in my_squad if not p["is_sub"]], key=lambda x: x["pick_pos"])
    subs     = sorted([p for p in my_squad if p["is_sub"]],     key=lambda x: x["pick_pos"])
    my_ids   = {p["id"] for p in my_squad}

    def next_fdr(p, n=1):
        f = p["fixes"][:n]
        return round(sum(x["fdr"] for x in f)/len(f), 2) if f else 3.0

    # Triple Captain
    tc_cands = sorted(
        [p for p in starters if p["pos"] in ("MID","FWD")],
        key=lambda p: (
            p["composite"] * 0.35 + (6-next_fdr(p,1))*10 +
            (p.get("xgi90") or 0)*20 + (5 if p["fixes"] and p["fixes"][0]["home"] else 0) +
            (25 if p.get("has_dgw_next") else 0)   # heavily weight DGW for TC
        ), reverse=True
    )
    tc     = tc_cands[0] if tc_cands else None
    tc_fix = tc["fixes"][0] if tc and tc["fixes"] else None
    tc_fdr = tc_fix["fdr"] if tc_fix else 3
    tc_dgw = tc.get("has_dgw_next", False) if tc else False
    tc_score = min(100, round(
        (tc["composite"]/100*30) + ((6-tc_fdr)/5*25) +
        (min((tc.get("xgi90") or 0)/1.5,1)*25) + (20 if tc_dgw else 0)
    )) if tc else 0

    # Bench Boost
    bench_dgws = sum(1 for p in subs if p.get("has_dgw_next"))
    avg_bc = round(sum(p["composite"] for p in subs)/max(len(subs),1), 1)
    avg_bf = round(sum(next_fdr(p,1) for p in subs)/max(len(subs),1), 2)
    bb_score = min(100, round(avg_bc*0.50 + (6-avg_bf)/5*30 + bench_dgws*15))

    # Wildcard
    weak = [p for p in starters if p["composite"] < 40]
    upgrades = []
    for pos in ["GKP","DEF","MID","FWD"]:
        best = sorted([p for p in all_players if p["pos"]==pos and p["id"] not in my_ids
                       and p["status"]=="a"], key=lambda x: -x["composite"])
        worst = sorted([p for p in starters if p["pos"]==pos], key=lambda x: x["composite"])
        if best and worst:
            g = best[0]["composite"] - worst[0]["composite"]
            if g > 0:
                upgrades.append({"pos":pos,"out":worst[0]["name"],
                                  "in":best[0]["name"],"gain":g,
                                  "in_dgw":best[0].get("has_dgw_next",False)})
    wc_score = min(100, round(
        (len(weak)/max(len(starters),1))*50 +
        min(sum(u["gain"] for u in upgrades)/100,1)*50
    ))

    # Free Hit — value spikes during blank GWs
    teams_now  = sum(1 for f in fix_map.values() if any(x["gw"]==current_gw   for x in f))
    teams_nxt  = sum(1 for f in fix_map.values() if any(x["gw"]==current_gw+1 for x in f))
    blank_now  = max(0, 20 - teams_now)
    blank_next = max(0, 20 - teams_nxt)
    dgw_now    = sum(1 for f in fix_map.values() if sum(1 for x in f if x["gw"]==current_gw)>=2)
    dgw_next   = sum(1 for f in fix_map.values() if sum(1 for x in f if x["gw"]==current_gw+1)>=2)
    blankers   = [p["name"] for p in starters if not any(f["gw"]==current_gw   for f in p["fixes"])]
    blankers_n = [p["name"] for p in starters if not any(f["gw"]==current_gw+1 for f in p["fixes"])]
    fh_score   = min(100, round(
        min(blank_now/10,1)*55 + min(dgw_next/10,1)*25 + min(len(blankers)/5,1)*20
    ))

    return {
        "3xc": {
            "score":tc_score,"pick":tc["name"] if tc else None,
            "pick_team":tc["team_name"] if tc else None,"fdr":tc_fdr,
            "xgi90":tc.get("xgi90") if tc else None,"has_dgw":tc_dgw,
            "composite":tc["composite"] if tc else 0,
            "next_opp":f'{tc_fix["opp"]} ({"H" if tc_fix["home"] else "A"})' if tc_fix else "TBC",
        },
        "bboost": {
            "score":bb_score,"avg_comp":avg_bc,"avg_fdr":avg_bf,"bench_dgws":bench_dgws,
            "bench":[{"name":p["name"],"pos":p["pos"],"team":p["team_name"],
                       "form":p["form"],"composite":p["composite"],
                       "has_dgw":p.get("has_dgw_next",False)} for p in subs],
        },
        "wildcard": {
            "score":wc_score,"weak_count":len(weak),
            "weak":[p["name"] for p in weak],"upgrades":upgrades,
        },
        "freehit": {
            "score":fh_score,"blanking_now":blank_now,"blanking_next":blank_next,
            "dgw_now":dgw_now,"dgw_next":dgw_next,
            "my_blankers":blankers,"my_blankers_next":blankers_n,
        },
    }

def serialize_player(p):
    base = {k: p.get(k) for k in [
        "id","name","team","team_name","pos","price","form","value","wfdr","near_fdr","near_fix_score","composite",
        "has_xg","xgi90","xg90","xa90","xgc90","xg_overperf","bps_per_game","def_threshold","def_contrib_norm","effective_pos","team_xg_pg",
        "cs_prob","xcs_pts_per_game",
        "minutes","starts","starts_reliability","mins_per_start","playing_time_norm",
        "pts_per_start","pts_per_start_norm",
        "status","news","chance","availability","has_dgw_next","dgw_next_gw","is_dgw_imminent","dgw_gws","n_dgw",
        "price_rising","price_falling","net_transfers","price_change",
        "ownership","differential_score","opp_adj","form_trend","form_trend_label",
        "rotation_risk","rotation_risk_label","fixes",
    ]}
    # Add 4-GW projections — used for DGW sort and planner
    if "projections" not in p:
        p["projections"] = None  # computed below if needed
    base["projections"] = p.get("projections")
    return base

# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")

def build_demo_picks(players_raw):
    """
    Synthesize a realistic-looking 15-man squad from live player data,
    so the dashboard can be previewed before any real picks exist yet.
    The FPL picks endpoint returns nothing for a gameweek until it
    actually kicks off — this lets you check layout/styling before then
    without waiting on that. Not a real squad, just plausible filler.
    """
    by_pos = {1: [], 2: [], 3: [], 4: []}
    for p in players_raw.values():
        if p.get("status") == "a":
            by_pos[p["element_type"]].append(p)
    for pos in by_pos:
        by_pos[pos].sort(key=lambda p: -p.get("total_points", 0))

    need = {1: 2, 2: 5, 3: 5, 4: 3}
    team_counts = {}
    squad = []
    for pos, count in need.items():
        picked = 0
        for p in by_pos[pos]:
            if picked >= count:
                break
            if team_counts.get(p["team"], 0) >= 3:  # keep it looking like a real squad
                continue
            squad.append(p)
            team_counts[p["team"]] = team_counts.get(p["team"], 0) + 1
            picked += 1

    # 4-4-2 starting XI, rest to bench
    starters, bench = [], []
    xi_need = {1: 1, 2: 4, 3: 4, 4: 2}
    xi_have = {1: 0, 2: 0, 3: 0, 4: 0}
    for p in squad:
        pos = p["element_type"]
        (starters if xi_have[pos] < xi_need[pos] else bench).append(p)
        if xi_have[pos] < xi_need[pos]:
            xi_have[pos] += 1

    captain = max(starters, key=lambda p: p.get("total_points", 0))
    picks = [
        {"element": p["id"], "position": i, "multiplier": 2 if p is captain else 1,
         "is_captain": p is captain, "is_vice_captain": False}
        for i, p in enumerate(starters + bench, start=1)
    ]

    total_cost = sum(p["now_cost"] for p in squad) / 10
    bank_m     = max(round(100 - total_cost, 1), 0)

    return {
        "picks": picks,
        "entry_history": {"bank": int(round(bank_m * 10)), "value": int(round(total_cost * 10))},
        "active_chip": None,
    }


@app.route("/api/load", methods=["POST"])
def api_load():
    data           = request.json
    demo_mode      = bool(data.get("demo"))
    team_id        = int(data.get("team_id", 0) or 0)
    free_transfers = int(data.get("free_transfers", 1))
    target_gw      = data.get("gameweek")

    try:
        boot     = fpl_get("/bootstrap-static/")
        fixtures = fpl_get("/fixtures/")
    except Exception as e:
        return jsonify({"error": f"Could not reach FPL API: {e}"}), 500

    teams       = {t["id"]: t for t in boot["teams"]}
    players_raw = {p["id"]: p for p in boot["elements"]}
    events      = boot["events"]

    if target_gw:
        current_gw = int(target_gw)
    else:
        gw_obj = (next((e for e in events if e.get("is_next")), None) or
                  next((e for e in events if e.get("is_current")), None))
        if gw_obj:
            current_gw = gw_obj["id"]
        else:
            # Fallback: last finished GW + 1
            finished = sorted([e["id"] for e in events if e.get("finished")], reverse=True)
            current_gw = (finished[0] + 1) if finished else 1

    if demo_mode:
        manager, team_name = "Preview Manager", "Sample Squad Preview"
    else:
        try:
            entry = _session.get(f"{BASE}/entry/{team_id}/", timeout=15)
            if entry.status_code == 404:
                return jsonify({"error": f"Team ID {team_id} not found."}), 404
            entry.raise_for_status()
            ej        = entry.json()
            manager   = f'{ej.get("player_first_name","")} {ej.get("player_last_name","")}'.strip()
            team_name = ej.get("name","")
        except Exception as e:
            return jsonify({"error": f"Could not verify team: {e}"}), 500

    fix_map    = build_fix_map(fixtures, teams, current_gw)
    dgw_map    = get_dgw_map(fix_map, current_gw)
    bgw_set    = get_bgw_set(fix_map, current_gw)
    team_stats = build_team_stats(players_raw)

    # Fetch user history first — we need it to identify any Free Hit GWs
    # before deciding which picks GW to load from
    chips_used, user_gw_history = set(), []
    freehit_gws = set()
    hist = {}
    if not demo_mode:
        try:
            hist            = fpl_get(f"/entry/{team_id}/history/")
            chips_used      = {c.get("name","") for c in hist.get("chips",[])}
            user_gw_history = hist.get("current", [])
            # Build set of GWs where Free Hit was played — picks from these GWs
            # reflect a temporary squad and should never be used as the real team
            freehit_gws = {
                c.get("event") for c in hist.get("chips", [])
                if c.get("name") == "freehit"
            }
        except Exception:
            pass

    # Find the most recent GW that has picks AND was not a Free Hit
    if demo_mode:
        picks_data = build_demo_picks(players_raw)
    else:
        picks_data = None
        for gw_try in [current_gw, current_gw - 1, current_gw - 2, current_gw - 3]:
            if gw_try < 1:
                continue
            if gw_try in freehit_gws:
                continue   # skip — squad from this GW is temporary
            try:
                picks_data = fpl_get(f"/entry/{team_id}/event/{gw_try}/picks/")
                break
            except Exception:
                continue
    if not picks_data:
        return jsonify({"error": f"Could not load picks for GW{current_gw}"}), 500

    bank        = picks_data.get("entry_history", {}).get("bank",  0) / 10
    squad_value = picks_data.get("entry_history", {}).get("value", 0) / 10
    active_chip = picks_data.get("active_chip")

    try:
        my_squad = [
            enrich(players_raw[pk["element"]], teams, fix_map, dgw_map, team_stats, pk)
            for pk in picks_data["picks"] if pk["element"] in players_raw
        ]
        # Add 4-GW point projections to each squad player
        for p in my_squad:
            p["projections"] = [
                project_gw_points(p, current_gw + i)
                for i in range(4)
            ]

        all_players = [
            enrich(p, teams, fix_map, dgw_map, team_stats)
            for p in players_raw.values()
            if p.get("status") not in ("u",) and p.get("minutes", 0) > 0
            and float(p.get("form") or 0) > 0
        ]
    except Exception as e:
        import traceback
        return jsonify({"error": f"Failed to process squad data: {e}",
                        "detail": traceback.format_exc()}), 500

    try:
        groups           = build_transfer_groups(my_squad, all_players, bank, free_transfers, current_gw)
        singles, doubles, triples, quads = build_combos(my_squad, all_players, bank, free_transfers, current_gw)
    except Exception as e:
        import traceback
        return jsonify({"error": f"Failed to build transfer suggestions: {e}",
                        "detail": traceback.format_exc()}), 500

    event_bm = {
        ev["id"]: {
            "avg":    ev.get("average_entry_score",0),
            "highest":ev.get("highest_score",0),
            "top_id": (ev.get("top_element_info") or {}).get("id"),
            "top_pts":(ev.get("top_element_info") or {}).get("points",0),
        }
        for ev in events if ev.get("finished")
    }
    gw_history_enriched = [
        {**row,
         "avg":     event_bm.get(row["event"],{}).get("avg",0),
         "highest": event_bm.get(row["event"],{}).get("highest",0)}
        for row in user_gw_history
    ]

    fixture_table = sorted([
        {"team":t["short_name"],"full":t["name"],
         "wfdr":weighted_fdr(sorted(fix_map.get(t["id"],[]),key=lambda x:x["gw"])),
         "fixes":sorted(fix_map.get(t["id"],[]),key=lambda x:x["gw"]),
         "dgw_gws":sorted(dgw_map.get(t["id"],set()))}
        for t in teams.values()
    ], key=lambda x: x["wfdr"])

    chip_analysis = compute_chip_scores(
        my_squad, all_players, fix_map, dgw_map, bgw_set,
        chips_used, active_chip, bank, free_transfers, current_gw
    )

    dgw_summary = {
        str(gw): sorted([teams[tid]["short_name"]
                          for tid, gws in dgw_map.items() if gw in gws])
        for gw in range(current_gw, current_gw + 5)
    }

    # Compute 4-GW projections for all players (used for DGW sort, planner)
    for _p in all_players:
        _p["projections"] = [project_gw_points(_p, current_gw+i)
                             for i in range(4) if current_gw+i <= 38]
    all_players_serialized = [serialize_player(_p) for _p in all_players]

    _response = jsonify({
        "meta": {
            "team_id":team_id,"team_name":team_name,"manager":manager,
            "current_gw":current_gw,"bank":bank,"squad_value":squad_value,
            "free_transfers":free_transfers,"active_chip":active_chip,
            "overall_rank": hist.get("entry", {}).get("summary_overall_rank"),
            "deadline_time": next((e["deadline_time"] for e in events
                                   if e["id"]==current_gw), None),
            "chips_used":list(chips_used),
            "available_gws":[e["id"] for e in events
                              if e.get("finished") or e.get("is_current")],
        },
        "squad":         my_squad,
        "all_players":   all_players_serialized,
        "transfers":     groups,
        "combos":        {"singles":singles,"doubles":doubles,"triples":triples,"quads":quads},
        "fixtures":      fixture_table,
        "gw_history":    gw_history_enriched,
        "chip_analysis": chip_analysis,
        "dgw_summary":   dgw_summary,
        "bgw_gws":       sorted(bgw_set),
        "teams":         {str(k):{"name":v["name"],"short_name":v["short_name"],"code":v["code"]}
                          for k,v in teams.items()},
        "team_stats":    {str(k):v for k,v in team_stats.items()},
    })
    _panel.trigger(
        current_gw, fpl_get, enrich, build_fix_map, get_dgw_map,
        build_team_stats, captain_score, build_transfer_groups, POS_MAP,
        players_raw, teams, fix_map, dgw_map, team_stats, all_players
    )
    return _response

@app.route("/api/transfer_impact/<int:team_id>")
def transfer_impact(team_id):
    """
    Fetches full transfer history for a team and scores each transfer:
    - OUT player actual pts over next 3 GWs
    - IN player actual pts over next 3 GWs
    - Net gain/loss
    - Cumulative rank impact (approximated)
    """
    try:
        transfers_raw = fpl_get(f"/entry/{team_id}/transfers/")
        if not transfers_raw:
            return jsonify({"transfers": [], "summary": {}})

        boot        = fpl_get("/bootstrap-static/")
        players_raw = {p["id"]: p for p in boot["elements"]}
        events      = boot["events"]
        finished_gws = {e["id"] for e in events if e.get("finished")}

        # Only score transfers where we have 3 GWs of data after
        results = []
        for t in transfers_raw:
            gw        = t.get("event")
            in_id     = t.get("element_in")
            out_id    = t.get("element_out")
            in_cost   = (t.get("element_in_cost") or 0) / 10
            out_cost  = (t.get("element_out_cost") or 0) / 10
            if not gw or not in_id or not out_id:
                continue

            in_raw  = players_raw.get(in_id,  {})
            out_raw = players_raw.get(out_id, {})

            # Check if we have enough data to score (need gw+1, gw+2, gw+3 finished)
            scoreable = all(gw+i in finished_gws for i in range(1, 4))
            partially_scored = not scoreable and (gw+1 in finished_gws)

            entry = {
                "gw":        gw,
                "in_id":     in_id,
                "in_name":   in_raw.get("web_name", f"Player {in_id}"),
                "in_team":   in_raw.get("team", 0),
                "in_cost":   in_cost,
                "out_id":    out_id,
                "out_name":  out_raw.get("web_name", f"Player {out_id}"),
                "out_team":  out_raw.get("team", 0),
                "out_cost":  out_cost,
                "cost_diff": round(in_cost - out_cost, 1),
                "scoreable": scoreable,
                "partially_scored": partially_scored,
                # Composite differential — current values used as proxy for historical
                # From next season, panel snapshots will store the real value at decision time
                "comp_gain": round(
                    float(in_raw.get("ep_next") or 0) - float(out_raw.get("ep_next") or 0), 1
                ),
                "in_pts_gws":  [],
                "out_pts_gws": [],
                "in_pts3":     None,
                "out_pts3":    None,
                "net_gain":    None,
                "verdict":     None,
            }
            results.append(entry)

        # Fetch histories for all unique player IDs
        all_ids = set()
        for e in results:
            all_ids.add(e["in_id"])
            all_ids.add(e["out_id"])

        histories = {}
        for pid in all_ids:
            try:
                s = fpl_get(f"/element-summary/{pid}/")
                histories[pid] = {r["round"]: r["total_points"]
                                  for r in s.get("history", [])}
            except Exception:
                histories[pid] = {}
            time.sleep(0.05)

        # Score each transfer
        for e in results:
            gw = e["gw"]
            n_gws = 3 if e["scoreable"] else sum(1 for i in range(1,4) if gw+i in finished_gws)
            if n_gws == 0:
                continue

            in_hist  = histories.get(e["in_id"],  {})
            out_hist = histories.get(e["out_id"], {})

            in_pts_gws  = [in_hist.get(gw+i, 0)  for i in range(1, n_gws+1)]
            out_pts_gws = [out_hist.get(gw+i, 0) for i in range(1, n_gws+1)]

            e["in_pts_gws"]  = in_pts_gws
            e["out_pts_gws"] = out_pts_gws
            e["in_pts3"]     = sum(in_pts_gws)
            e["out_pts3"]    = sum(out_pts_gws)
            e["net_gain"]    = e["in_pts3"] - e["out_pts3"]
            e["n_gws_scored"] = n_gws

            if e["net_gain"] >= 8:
                e["verdict"] = "very_good"
            elif e["net_gain"] >= 3:
                e["verdict"] = "good"
            elif e["net_gain"] >= -2:
                e["verdict"] = "average"
            elif e["net_gain"] >= -7:
                e["verdict"] = "bad"
            else:
                e["verdict"] = "very_bad"

        # Summary stats
        scored = [e for e in results if e["net_gain"] is not None]
        summary = {}
        if scored:
            gains     = [e["net_gain"] for e in scored]
            total_gain = sum(gains)
            summary = {
                "n_scored":    len(scored),
                "n_total":     len(results),
                "total_gain":  round(total_gain, 0),
                "avg_gain":    round(total_gain / len(scored), 1),
                "very_good":   sum(1 for e in scored if e["verdict"] == "very_good"),
                "good":        sum(1 for e in scored if e["verdict"] == "good"),
                "average":     sum(1 for e in scored if e["verdict"] == "average"),
                "bad":         sum(1 for e in scored if e["verdict"] == "bad"),
                "very_bad":    sum(1 for e in scored if e["verdict"] == "very_bad"),
                "best":        max(scored, key=lambda x: x["net_gain"]),
                "worst":       min(scored, key=lambda x: x["net_gain"]),
            }

        # Attach team short names
        teams = {t["id"]: t["short_name"] for t in boot["teams"]}
        for e in results:
            e["in_team_name"]  = teams.get(e["in_team"],  "")
            e["out_team_name"] = teams.get(e["out_team"], "")

        return jsonify({
            "transfers": sorted(results, key=lambda x: -x["gw"]),
            "summary":   summary,
        })

    except Exception as ex:
        import traceback
        return jsonify({"error": str(ex), "detail": traceback.format_exc()}), 500


@app.route("/api/panel_report")
def panel_report():
    try:
        return jsonify(_panel.get_report())
    except Exception as e:
        return jsonify({"status":"error","message":str(e)}), 500


@app.route("/api/panel_init")
def panel_init():
    """Synchronous panel initialisation — call once to fetch top-100 manager IDs."""
    try:
        ids = _panel.ensure_panel(fpl_get)
        return jsonify({
            "status":     "ok",
            "panel_size": len(ids),
            "message":    f"Panel initialised with {len(ids)} managers",
            "sample_ids": ids[:5],
        })
    except Exception as e:
        import traceback
        return jsonify({
            "status":  "error",
            "message": str(e),
            "detail":  traceback.format_exc(),
        }), 500


@app.route("/api/player_history/<int:player_id>")
def player_history(player_id):
    try:
        data = fpl_get(f"/element-summary/{player_id}/")
        cumul, hist = 0, []
        for row in data.get("history", []):
            cumul += row.get("total_points", 0)
            hist.append({
                "gw":row.get("round"),"pts":row.get("total_points",0),"cumulative":cumul,
                "mins":row.get("minutes",0),"goals":row.get("goals_scored",0),
                "assists":row.get("assists",0),"cs":row.get("clean_sheets",0),
                "bonus":row.get("bonus",0),"bps":row.get("bps",0),
                "xgi":float(row.get("expected_goal_involvements") or 0),
                "xg": float(row.get("expected_goals") or 0),
                "xa": float(row.get("expected_assists") or 0),
                "was_home":row.get("was_home"),"opponent":row.get("opponent_team"),
                "value":(row.get("value") or 0)/10,
            })
        return jsonify({"history": hist})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/captain_history/<int:team_id>")
def captain_history_route(team_id):
    records = []
    try:
        hist    = fpl_get(f"/entry/{team_id}/history/")
        boot    = fpl_get("/bootstrap-static/")
        events  = {e["id"]: e for e in boot["events"] if e.get("finished")}
        players = {p["id"]: p["web_name"] for p in boot["elements"]}
        for row in hist.get("current", []):
            gw = row["event"]
            try:
                picks = fpl_get(f"/entry/{team_id}/event/{gw}/picks/")
                cap   = next((pk for pk in picks.get("picks",[]) if pk.get("multiplier",1)>=2), None)
                ev    = events.get(gw,{})
                top_id  = (ev.get("top_element_info") or {}).get("id")
                top_pts = (ev.get("top_element_info") or {}).get("points",0)
                if cap:
                    records.append({
                        "gw":gw,"captain_id":cap["element"],
                        "captain":players.get(cap["element"],"?"),
                        "multiplier":cap["multiplier"],
                        "top_id":top_id,
                        "top_name":players.get(top_id,"?") if top_id else "?",
                        "top_pts_raw":top_pts,
                    })
            except Exception:
                pass
    except Exception as e:
        return jsonify({"error":str(e)}), 500
    return jsonify({"records": records})

# ---------------------------------------------------------------------------
# Launch — auto-opens browser
# ---------------------------------------------------------------------------

@app.route("/api/team_comparison/<int:team_a_id>/<int:team_b_id>")
def team_comparison_route(team_a_id, team_b_id):
    """
    Compare two FPL teams (clubs, not managers).
    Uses the GKP element-summary trick: one GKP per team gives us
    the full GW-by-GW defensive record (goals conceded, xGC, clean sheets).
    Season attack stats come from build_team_stats via bootstrap.
    """
    try:
        boot        = fpl_get("/bootstrap-static/")
        players_raw = {p["id"]: p for p in boot["elements"]}
        teams       = {t["id"]: t for t in boot["teams"]}
        team_stats  = build_team_stats(players_raw)

        result = {}
        for tid in [team_a_id, team_b_id]:
            if tid not in teams:
                return jsonify({"error": f"Team ID {tid} not found"}), 404

            t = teams[tid]
            ts = team_stats.get(tid, {})

            # Find starting GKP for this team (most minutes)
            gkps = sorted(
                [p for p in players_raw.values()
                 if p["team"] == tid and POS_MAP.get(p["element_type"]) == "GKP"
                 and p.get("minutes", 0) > 0],
                key=lambda x: -x.get("minutes", 0)
            )
            gw_history = []
            if gkps:
                try:
                    summary = fpl_get(f"/element-summary/{gkps[0]['id']}/")
                    for row in summary.get("history", []):
                        gw_history.append({
                            "gw":        row.get("round"),
                            "conceded":  row.get("goals_conceded", 0),
                            "xgc":       float(row.get("expected_goals_conceded") or 0),
                            "cs":        row.get("clean_sheets", 0),
                            "was_home":  row.get("was_home"),
                            "opponent":  row.get("opponent_team"),
                            "minutes":   row.get("minutes", 0),
                        })
                except Exception:
                    pass

            # Attack history — sum all outfield player xG + goals per GW
            # Approximate from season totals split evenly (no per-GW breakdown
            # without many API calls). Use season pg stats as the trend line.
            games = max(ts.get("games", 1), 1) if "games" in ts else max(
                round(gkps[0].get("minutes", 0) / 90) if gkps else 1, 1
            )

            result[str(tid)] = {
                "name":       t["name"],
                "short_name": t["short_name"],
                "code":       t["code"],
                "season": {
                    "goals_pg":    ts.get("goals_pg", 0),
                    "xg_pg":       ts.get("xg_pg", 0),
                    "conceded_pg": ts.get("conceded_pg", 0),
                    "xgc_pg":      ts.get("xgc_pg", 0),
                    "games":       games,
                },
                "gw_history": gw_history,   # defensive record per GW from GKP
            }

        return jsonify(result)
    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "detail": traceback.format_exc()}), 500


@app.route("/api/backtest")
def backtest():
    """
    Runs a retrospective signal accuracy test.
    For each completed GW, scores players using rolling stats up to that point
    and measures how well the composite components predicted the next GW's actual return.
    Fetches element-summary for top 150 players by season total points.
    Results cached for the session.
    """
    try:
        boot        = fpl_get("/bootstrap-static/")
        players_raw = boot["elements"]
        events      = [e for e in boot["events"] if e.get("finished")]
        if len(events) < 4:
            return jsonify({"error": "Not enough completed gameweeks for backtesting yet"}), 400

        finished_gws = sorted(e["id"] for e in events)

        # Take top 150 by season total_points — players managers actually care about
        top_players = sorted(
            [p for p in players_raw if p.get("total_points", 0) > 0],
            key=lambda x: -x.get("total_points", 0)
        )[:150]

        # Fetch GW histories for all of them
        all_histories = {}
        for p in top_players:
            try:
                summary = fpl_get(f"/element-summary/{p['id']}/")
                all_histories[p["id"]] = summary.get("history", [])
            except Exception:
                all_histories[p["id"]] = []

        # For each GW (except the last), compute rolling signals and compare
        # to next-GW actual return
        records = []   # {gw, player_id, name, pos, composite_est, next_pts, form_roll, xgi_roll}

        pos_map = {1:"GKP", 2:"DEF", 3:"MID", 4:"FWD"}

        for gw_idx, gw in enumerate(finished_gws[:-1]):
            next_gw = finished_gws[gw_idx + 1]

            for p in top_players:
                pid  = p["id"]
                hist = all_histories.get(pid, [])
                pos  = pos_map.get(p["element_type"], "MID")

                # GW history up to and including current GW
                up_to    = [r for r in hist if r.get("round", 0) <= gw]
                next_row = next((r for r in hist if r.get("round") == next_gw), None)
                if not up_to or next_row is None:
                    continue

                next_pts = next_row.get("total_points", 0)
                # Only consider players who actually played next GW
                if next_row.get("minutes", 0) == 0:
                    continue

                # Rolling stats — last 5 GWs for form, all for xGI/90
                last5  = up_to[-5:]
                form_roll = round(sum(r.get("total_points", 0) for r in last5) / len(last5), 2)

                total_mins = sum(r.get("minutes", 0) for r in up_to)
                total_xgi  = sum(float(r.get("expected_goal_involvements") or 0) for r in up_to)
                xgi_roll   = round((total_xgi / total_mins * 90) if total_mins >= 90 else 0, 3)

                starts     = sum(1 for r in up_to if r.get("minutes", 0) >= 45)
                total_pts_up = sum(r.get("total_points", 0) for r in up_to)
                pts_per_start = round(total_pts_up / max(starts, 1), 2)

                # Composite estimate using recalibrated weights
                # xGI/90 is primary signal (r=0.074), form secondary, pts/start demoted
                W = {"GKP": (0.15, 0.60), "DEF": (0.15, 0.55),
                     "MID": (0.25, 0.60), "FWD": (0.20, 0.65)}
                form_w, xgi_ratio = W.get(pos, (0.25, 0.60))
                xgi_w  = (1 - form_w) * xgi_ratio if pos in ("MID","FWD","ATK_MID") else 0
                pts_w  = max(0, 1 - form_w - xgi_w)

                composite_est = round((
                    min(form_roll/12, 1) * form_w +
                    min(xgi_roll/1.5, 1) * xgi_w +
                    min(pts_per_start/10, 1) * pts_w
                ) * 100)

                records.append({
                    "gw":            gw,
                    "pid":           pid,
                    "name":          p.get("web_name", ""),
                    "pos":           pos,
                    "composite_est": composite_est,
                    "form_roll":     form_roll,
                    "xgi_roll":      xgi_roll,
                    "pts_per_start": pts_per_start,
                    "next_pts":      next_pts,
                })

        if not records:
            return jsonify({"error": "No backtest data generated"}), 400

        # ── Aggregate results ───────────────────────────────────────────
        # 1. By GW: top 20 vs bottom 20 by composite — avg next-GW points
        gw_summary = {}
        for gw in finished_gws[:-1]:
            gw_recs = sorted([r for r in records if r["gw"] == gw],
                             key=lambda x: -x["composite_est"])
            if len(gw_recs) < 10:
                continue
            top20  = gw_recs[:20]
            bot20  = gw_recs[-20:]
            gw_summary[gw] = {
                "top20_avg":  round(sum(r["next_pts"] for r in top20)  / len(top20),  2),
                "bot20_avg":  round(sum(r["next_pts"] for r in bot20)  / len(bot20),  2),
                "all_avg":    round(sum(r["next_pts"] for r in gw_recs)/ len(gw_recs),2),
            }

        # 2. Signal correlations — Pearson r between each signal and next_pts
        def pearson(xs, ys):
            n = len(xs)
            if n < 2: return 0
            mx, my = sum(xs)/n, sum(ys)/n
            num = sum((x-mx)*(y-my) for x,y in zip(xs,ys))
            den = (sum((x-mx)**2 for x in xs) * sum((y-my)**2 for y in ys)) ** 0.5
            return round(num/den, 3) if den > 0 else 0

        next_pts_all   = [r["next_pts"]      for r in records]
        correlations = {
            "composite":    pearson([r["composite_est"] for r in records], next_pts_all),
            "form":         pearson([r["form_roll"]      for r in records], next_pts_all),
            "xgi90":        pearson([r["xgi_roll"]       for r in records], next_pts_all),
            "pts_per_start":pearson([r["pts_per_start"]  for r in records], next_pts_all),
        }

        # 3. Scatter sample — 300 random records for plotting
        import random
        random.seed(42)
        scatter = random.sample(records, min(300, len(records)))
        scatter = [{"x": r["composite_est"], "y": r["next_pts"],
                    "name": r["name"], "pos": r["pos"], "gw": r["gw"]} for r in scatter]

        return jsonify({
            "gws":          sorted(gw_summary.keys()),
            "gw_summary":   gw_summary,
            "correlations": correlations,
            "scatter":      scatter,
            "n_records":    len(records),
            "n_gws":        len(gw_summary),
        })

    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "detail": traceback.format_exc()}), 500


@app.route("/api/season_review/<int:team_id>")
def season_review(team_id):
    """
    Simulates what the model would have recommended across the season for a given team.
    Starts from GW1 squad, applies model transfer/captain/formation logic each GW,
    and compares to what the manager actually did.
    """
    try:
        boot        = fpl_get("/bootstrap-static/")
        players_raw = {p["id"]: p for p in boot["elements"]}
        teams       = {t["id"]: t for t in boot["teams"]}
        events      = boot["events"]
        finished    = sorted([e["id"] for e in events if e.get("finished")])

        if len(finished) < 2:
            return jsonify({"error": "Not enough completed gameweeks yet"}), 400

        # ── Fetch user history ──────────────────────────────────────────
        hist_data       = fpl_get(f"/entry/{team_id}/history/")
        user_gw_history = {r["event"]: r for r in hist_data.get("current", [])}
        chip_history    = {c["event"]: c["name"] for c in hist_data.get("chips", [])}
        freehit_gws     = {c["event"] for c in hist_data.get("chips", [])
                           if c["name"] == "freehit"}

        # ── Fetch all GW picks ──────────────────────────────────────────
        gw_picks = {}
        for gw in finished:
            try:
                p = fpl_get(f"/entry/{team_id}/event/{gw}/picks/")
                if p.get("active_chip") != "freehit":
                    gw_picks[gw] = p
            except Exception:
                pass

        if not gw_picks:
            return jsonify({"error": "Could not load picks"}), 500

        # ── Collect player IDs to fetch histories for ───────────────────
        # User's own squad players across the season
        all_pids = set()
        for gw, pk in gw_picks.items():
            for pick in pk.get("picks", []):
                all_pids.add(pick["element"])

        # Top players by position — needed so model can suggest transfers
        # to players the user never owned. Take top 50 per position by
        # season total_points (these are the realistic transfer targets).
        for pos_type in [1, 2, 3, 4]:   # GKP, DEF, MID, FWD
            top_by_pos = sorted(
                [p for p in boot["elements"] if p.get("element_type") == pos_type
                 and p.get("total_points", 0) > 0],
                key=lambda x: -x.get("total_points", 0)
            )[:50]
            for p in top_by_pos:
                all_pids.add(p["id"])

        # ── Fetch element-summary for every player in the pool ──────────
        player_histories = {}
        for pid in all_pids:
            try:
                s = fpl_get(f"/element-summary/{pid}/")
                player_histories[pid] = s.get("history", [])
            except Exception:
                player_histories[pid] = []

        # ── Helper: rolling stats for a player up to (but not including) target_gw
        def rolling_stats(pid, before_gw):
            hist = [r for r in player_histories.get(pid, [])
                    if r.get("round", 0) < before_gw]
            if not hist:
                return None
            mins_total  = sum(r.get("minutes", 0) for r in hist)
            starts      = sum(1 for r in hist if r.get("minutes", 0) >= 45)
            pts_total   = sum(r.get("total_points", 0) for r in hist)
            xgi_total   = sum(float(r.get("expected_goal_involvements") or 0) for r in hist)
            xgc_total   = sum(float(r.get("expected_goals_conceded") or 0) for r in hist)
            goals       = sum(r.get("goals_scored", 0) for r in hist)
            xg_total    = sum(float(r.get("expected_goals") or 0) for r in hist)
            bps_total   = sum(r.get("bps", 0) for r in hist)
            last5       = hist[-5:]
            form        = round(sum(r.get("total_points", 0) for r in last5) / len(last5), 2)
            xgi90       = round(xgi_total / mins_total * 90, 3) if mins_total >= 90 else 0
            pts_start   = round(pts_total / max(starts, 1), 2)
            starts_rel  = min(starts / max(len(hist), 1), 1.0) if starts >= 5 else 0.70
            mps_norm    = min((mins_total / max(starts, 1)) / 90, 1.0)
            pt_norm     = starts_rel * 0.65 + mps_norm * 0.35
            bps_pg      = round(bps_total / max(starts, 1), 2)
            xgc90       = round(xgc_total / mins_total * 90, 3) if mins_total >= 90 else 1.5
            xg_overperf = round(goals - xg_total, 2)
            return {
                "form": form, "xgi90": xgi90, "pts_per_start": pts_start,
                "playing_time_norm": round(pt_norm, 3), "starts": starts,
                "bps_per_game": bps_pg, "xgc90": xgc90,
                "xg_overperf": xg_overperf, "mins": mins_total,
                "has_xg": mins_total >= 90 and xgi90 > 0,
            }

        # ── Helper: compute composite from rolling stats ─────────────────
        def composite_from_stats(pid, before_gw, pos, wfdr_val=3.0,
                                  availability=1.0, has_dgw=False, xgc_opp=None):
            s = rolling_stats(pid, before_gw)
            if not s:
                return 30   # prior for unknown players

            W = {
                "GKP": (0.15, 0.00, 0.05, 0.20, 0.15, 0.05, 0.40),
                "DEF": (0.15, 0.10, 0.05, 0.30, 0.10, 0.10, 0.20),
                "MID": (0.25, 0.40, 0.05, 0.15, 0.10, 0.05, 0.00),
                "FWD": (0.20, 0.50, 0.05, 0.15, 0.10, 0.00, 0.00),
            }
            w          = W.get(pos, W["MID"])
            form_norm  = min(s["form"] / 12, 1)
            xgi_norm   = min(s["xgi90"] / 1.5, 1) if s["has_xg"] and s["starts"] >= 5 else form_norm * 0.75
            pts_norm   = min(s["pts_per_start"] / 10, 1)
            # FDR threshold model
            fdr_score = 0.20 if wfdr_val>=4.5 else 0.45 if wfdr_val>=3.5 else 0.55 if wfdr_val>=2.5 else 0.65 if wfdr_val>=1.5 else 0.80
            pt_norm    = s["playing_time_norm"]
            def_norm   = min(s["bps_per_game"] / (10 if pos == "DEF" else 12), 1.0) \
                         if pos in ("DEF", "MID") and s["bps_per_game"] > 0 else 0.0
            cs_pts     = 6 if pos in ("GKP", "DEF") else 1 if pos == "MID" else 0
            cs_prob    = round(max(0, min(0.8, 0.5 / max(s["xgc90"], 0.1))), 3)
            xcs_norm   = min(cs_prob * cs_pts / 4.0, 1.0) if cs_pts >= 6 else \
                         min(cs_prob * cs_pts / 0.5, 1.0) if cs_pts == 1 else 0.0
            xg_adj     = max(-0.08, min(0.08, -(s["xg_overperf"] / 10))) if s["has_xg"] else 0
            dgw_bonus  = 0.15 if has_dgw else 0.0

            raw = (form_norm*w[0] + xgi_norm*w[1] + pts_norm*w[2] + fdr_score*w[3] +
                   pt_norm*w[4] + def_norm*w[5] + xcs_norm*w[6] + xg_adj + dgw_bonus)
            return max(0, min(100, round(raw * 100 * availability)))

        # ── Helper: optimal XI from 15 players ──────────────────────────
        def optimal_xi(squad_scores):
            # squad_scores: list of {pid, pos, composite}
            # Returns: (starters set, captain_pid, bench list ordered)
            VALID_FORMATIONS = [
                (3,4,3),(3,5,2),(4,3,3),(4,4,2),(4,5,1),(5,2,3),(5,3,2),(5,4,1)
            ]
            by_pos = {"GKP":[], "DEF":[], "MID":[], "FWD":[]}
            for p in squad_scores:
                by_pos[p["pos"]].append(p)
            for pos in by_pos:
                by_pos[pos].sort(key=lambda x: -x["composite"])

            gkp_pick = by_pos["GKP"][0] if by_pos["GKP"] else None
            outfield = [p for p in squad_scores if p["pos"] != "GKP"]
            outfield.sort(key=lambda x: -x["composite"])

            best_score, best_xi, best_form = -1, [], (4,4,2)
            for nd, nm, nf in VALID_FORMATIONS:
                defs = [p for p in outfield if p["pos"]=="DEF"][:nd]
                mids = [p for p in outfield if p["pos"]=="MID"][:nm]
                fwds = [p for p in outfield if p["pos"]=="FWD"][:nf]
                if len(defs)<nd or len(mids)<nm or len(fwds)<nf:
                    continue
                xi    = defs + mids + fwds
                score = sum(p["composite"] for p in xi)
                if score > best_score:
                    best_score = score
                    best_xi    = xi
                    best_form  = (nd, nm, nf)

            if not best_xi or not gkp_pick:
                return set(), None, []

            xi_ids    = {p["pid"] for p in best_xi} | {gkp_pick["pid"]}
            bench     = sorted([p for p in squad_scores if p["pid"] not in xi_ids],
                                key=lambda x: x["composite"])
            # Captain: highest composite outfield starter × fixture ease
            cap = max(best_xi, key=captain_score)
            return xi_ids, cap["pid"], bench, best_form

        # ── Helper: price of player at a given GW from element-summary ───
        def player_price_at_gw(pid, gw):
            hist = player_histories.get(pid, [])
            row  = next((r for r in reversed(hist) if r.get("round", 0) < gw), None)
            if row:
                return row.get("value", players_raw.get(pid, {}).get("now_cost", 0)) / 10
            return players_raw.get(pid, {}).get("now_cost", 0) / 10

        # ── Helper: suggest transfers for a GW ──────────────────────────
        def suggest_transfers(squad_ids, before_gw, bank, free_transfers, pos_map_local):
            # Score all current squad members
            current_scores = {}
            for pid in squad_ids:
                pos = pos_map_local.get(pid, "MID")
                current_scores[pid] = composite_from_stats(pid, before_gw, pos)

            # Only consider players with enough history to score reliably (≥3 GWs)
            # and sort by composite ascending — worst players are transfer targets
            candidates = []
            for pid, comp in sorted(current_scores.items(), key=lambda x: x[1]):
                pos = pos_map_local.get(pid, "MID")
                if pos == "GKP":
                    continue
                out_history = [r for r in player_histories.get(pid, [])
                               if r.get("round", 0) < before_gw]
                # Don't suggest selling players with fewer than 3 GWs — too early to judge
                if len(out_history) < 3:
                    continue

                out_price = player_price_at_gw(pid, before_gw)

                # Find best available replacement with sufficient history
                best_in    = None
                best_gain  = 0
                # Only scan players who have appeared in histories (known active players)
                for in_pid, in_hist in player_histories.items():
                    if in_pid in squad_ids:
                        continue
                    in_raw = players_raw.get(in_pid)
                    if not in_raw:
                        continue
                    in_pos = POS_MAP.get(in_raw.get("element_type"))
                    if in_pos != pos:
                        continue
                    if in_raw.get("status") not in ("a", None):
                        continue
                    # Must have at least 3 GWs of history before this GW
                    in_hist_before = [r for r in in_hist if r.get("round", 0) < before_gw]
                    if len(in_hist_before) < 3:
                        continue
                    in_price    = player_price_at_gw(in_pid, before_gw)
                    price_delta = round(in_price - out_price, 1)
                    if price_delta > bank + 0.05:
                        continue
                    in_comp = composite_from_stats(in_pid, before_gw, in_pos)
                    gain    = in_comp - comp
                    if gain > best_gain:
                        best_gain = gain
                        best_in   = {"pid": in_pid, "name": in_raw["web_name"],
                                     "pos": in_pos, "gain": gain,
                                     "price_delta": price_delta}
                if best_in and best_gain >= 5:
                    candidates.append({
                        "out_pid":  pid,
                        "out_name": players_raw.get(pid, {}).get("web_name", str(pid)),
                        "in":       best_in,
                        "gain":     best_gain,
                    })

            candidates.sort(key=lambda x: -x["gain"])
            transfers = []
            ft_remaining = free_transfers
            hits         = 0
            bank_rem     = bank

            # Get current starters for this sim squad from optimal XI
            # Only suggest selling starters, not bench players
            sim_xi_ids, _, _, _ = optimal_xi(
                [{"pid": pid, "pos": pos_map_local.get(pid,"MID"),
                  "composite": composite_from_stats(pid, before_gw, pos_map_local.get(pid,"MID")),
                  "name": players_raw.get(pid,{}).get("web_name","")}
                 for pid in squad_ids]
            )
            candidates = [c for c in candidates if c["out_pid"] in sim_xi_ids]
            candidates.sort(key=lambda x: -x["gain"])

            for c in candidates[:3]:   # max 3 candidates evaluated
                is_free = ft_remaining > 0
                # In simulation: only use free transfers — hits are too speculative
                # for retrospective testing without knowing injury/fixture context
                if not is_free:
                    break
                hit_pts  = 0
                net_gain = c["gain"]

                # Free transfer threshold: must be meaningful gain (≥20 composite pts)
                if net_gain < 20:
                    continue
                if c["in"]["price_delta"] > bank_rem + 0.05:
                    continue

                transfers.append({
                    "out_pid":          c["out_pid"],
                    "out_name":         c["out_name"],
                    "in_pid":           c["in"]["pid"],
                    "in_name":          c["in"]["name"],
                    "gain":             c["gain"],
                    "is_free":          is_free,
                    "hit_pts":          hit_pts,
                    "net_gain":         net_gain,
                    "price_delta_actual": max(0, c["in"].get("price_delta", 0)),
                })
                if is_free:
                    ft_remaining -= 1
                else:
                    hits += 1
                bank_rem -= max(0, c["in"]["price_delta"])
                if len(transfers) >= 3:
                    break

            return transfers

        # ── Main simulation loop ─────────────────────────────────────────
        # Get GW1 squad as starting point
        first_gw = min(gw_picks.keys())
        first_picks = gw_picks[first_gw]
        sim_squad = {pk["element"] for pk in first_picks.get("picks", [])}
        pos_map_local = {
            pk["element"]: POS_MAP.get(
                players_raw.get(pk["element"], {}).get("element_type"), "MID"
            )
            for pk in first_picks.get("picks", [])
        }
        sim_bank = first_picks.get("entry_history", {}).get("bank", 0) / 10
        sim_ft   = 1

        gw_results = []

        for gw in finished:
            actual_picks = gw_picks.get(gw)
            if not actual_picks:
                continue

            # Actual user squad this GW
            actual_squad = {pk["element"] for pk in actual_picks.get("picks", [])}
            actual_cap   = next((pk["element"] for pk in actual_picks.get("picks", [])
                                 if pk.get("multiplier", 1) >= 2), None)

            # ── Step 1: apply transfers BEFORE computing the XI ──────────
            # Transfers are decided using stats before this GW and hits are
            # deducted from this GW's score, so they must happen first.
            hits_taken      = 0
            model_transfers = []
            if gw > first_gw:
                model_transfers = suggest_transfers(sim_squad, gw, sim_bank, sim_ft, pos_map_local)
                for t in model_transfers:
                    out_pid = t["out_pid"]
                    in_pid  = t["in_pid"]
                    in_pos  = POS_MAP.get(
                        players_raw.get(in_pid, {}).get("element_type"),
                        pos_map_local.get(out_pid, "MID")
                    )
                    sim_squad.discard(out_pid)
                    sim_squad.add(in_pid)
                    pos_map_local[in_pid] = in_pos
                    sim_bank -= max(0, t.get("price_delta_actual", 0))
                    if t["is_free"]:
                        sim_ft = max(0, sim_ft - 1)
                    else:
                        hits_taken += 1

            # ── Step 2: score squad and pick optimal XI ──────────────────
            squad_scores = []
            for pid in sim_squad:
                pos  = pos_map_local.get(pid, "MID")
                comp = composite_from_stats(pid, gw, pos)
                squad_scores.append({"pid": pid, "pos": pos, "composite": comp,
                                     "name": players_raw.get(pid, {}).get("web_name", str(pid))})

            xi_ids, model_cap, bench, formation = optimal_xi(squad_scores)

            # ── Step 3: calculate GW points ──────────────────────────────
            def gw_pts(pid):
                row = next((r for r in player_histories.get(pid, [])
                            if r.get("round") == gw), None)
                return row.get("total_points", 0) if row else 0

            model_xi_pts   = sum(gw_pts(pid) for pid in xi_ids)
            if model_cap:
                model_xi_pts += gw_pts(model_cap)   # captain doubles (already in sum)
            model_xi_pts   = max(0, model_xi_pts - hits_taken * 4)

            # Actual user points (from GW history — already includes hit deductions)
            actual_pts = user_gw_history.get(gw, {}).get("points", 0)

            # Actual transfers (difference between this GW and the immediately preceding one)
            prev_gws  = [g for g in gw_picks if g < gw]
            prev_gw   = max(prev_gws) if prev_gws else None
            prev_pids = {pk["element"] for pk in gw_picks[prev_gw].get("picks", [])} if prev_gw else set()
            actual_transfers_in  = actual_squad - prev_pids
            actual_transfers_out = prev_pids - actual_squad

            # Did the model agree with what the user did?
            model_in_pids  = {t["in_pid"]  for t in model_transfers}
            model_out_pids = {t["out_pid"] for t in model_transfers}
            agreed = bool(actual_transfers_in & model_in_pids or
                          actual_transfers_out & model_out_pids)

            # FT accrual for next GW (max 2, +1 per GW if not used)
            ft_used = len([t for t in model_transfers if t["is_free"]])
            sim_ft  = min(2, (sim_ft - ft_used) + 1)

            # Captain agreement
            cap_agreed = (actual_cap == model_cap) if actual_cap and model_cap else None
            actual_cap_name = players_raw.get(actual_cap, {}).get("web_name", "?") if actual_cap else "?"
            model_cap_name  = players_raw.get(model_cap,  {}).get("web_name", "?") if model_cap  else "?"
            actual_cap_pts  = gw_pts(actual_cap) * 2 if actual_cap else 0
            model_cap_pts   = gw_pts(model_cap)  * 2 if model_cap  else 0

            gw_results.append({
                "gw":                gw,
                "actual_pts":        actual_pts,
                "model_pts":         model_xi_pts,
                "diff":              model_xi_pts - actual_pts,
                "formation":         f"{formation[0]}-{formation[1]}-{formation[2]}",
                "chip":              chip_history.get(gw),
                "model_xi":          [{"name": players_raw.get(pid,{}).get("web_name","?"),
                                        "pos":  pos_map_local.get(pid,"?"),
                                        "pts":  gw_pts(pid),
                                        "is_cap": pid == model_cap}
                                       for pid in xi_ids],
                "model_bench":       [{"name": p["name"], "pos": p["pos"],
                                        "pts":  gw_pts(p["pid"])}
                                       for p in (bench or [])],
                "model_transfers":   [{"out": t["out_name"], "in": t["in_name"],
                                       "gain": t["gain"], "free": t["is_free"],
                                       "hit_pts": t["hit_pts"]} for t in model_transfers],
                "actual_in":         [players_raw.get(pid, {}).get("web_name", str(pid))
                                      for pid in actual_transfers_in],
                "actual_out":        [players_raw.get(pid, {}).get("web_name", str(pid))
                                      for pid in actual_transfers_out],
                "transfers_agreed":  agreed,
                "hits_taken":        hits_taken,
                "captain": {
                    "actual_name":  actual_cap_name,
                    "model_name":   model_cap_name,
                    "actual_pts":   actual_cap_pts,
                    "model_pts":    model_cap_pts,
                    "agreed":       cap_agreed,
                },
            })

        # ── Season summary ───────────────────────────────────────────────
        total_actual = sum(r["actual_pts"]  for r in gw_results)
        total_model  = sum(r["model_pts"]   for r in gw_results)
        cap_agreed_n = sum(1 for r in gw_results if r["captain"]["agreed"])
        cap_total    = sum(1 for r in gw_results if r["captain"]["agreed"] is not None)
        cap_gain     = sum(r["captain"]["model_pts"] - r["captain"]["actual_pts"]
                          for r in gw_results)
        transfers_agreed = sum(1 for r in gw_results if r["transfers_agreed"])
        transfers_total  = sum(1 for r in gw_results if r["actual_in"])

        return jsonify({
            "summary": {
                "actual_total":      total_actual,
                "model_total":       total_model,
                "diff":              total_model - total_actual,
                "gws_analysed":      len(gw_results),
                "cap_agreed":        cap_agreed_n,
                "cap_total":         cap_total,
                "cap_pts_gain":      cap_gain,
                "transfers_agreed":  transfers_agreed,
                "transfers_total":   transfers_total,
            },
            "gw_results": gw_results,
        })

    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "detail": traceback.format_exc()}), 500


@app.route("/api/squad_builder", methods=["POST"])
def squad_builder():
    """
    Builds an optimal 15-player squad within a given budget.
    Used for Wildcard and Free Hit planning.
    """
    try:
        data        = request.get_json()
        budget      = float(data.get("budget", 100.0))
        mode        = data.get("mode", "wildcard")   # "wildcard" or "freehit"
        locked_ids  = set(data.get("locked_ids", []))  # player IDs to keep
        banned_ids  = set(data.get("banned_ids", []))  # player IDs to exclude

        boot        = fpl_get("/bootstrap-static/")
        players_raw = {p["id"]: p for p in boot["elements"]}
        teams       = {t["id"]: t for t in boot["teams"]}
        events      = boot["events"]
        current_gw  = next((e["id"] for e in events if e.get("is_next")),
                      next((e["id"] for e in events if e.get("is_current")),
                      max((e["id"] for e in events if e.get("finished")), default=1)))
        fixtures_raw = fpl_get("/fixtures/")
        fix_map      = build_fix_map(fixtures_raw, teams, current_gw)
        dgw_map      = get_dgw_map(fix_map, current_gw)
        bgw_set      = get_bgw_set(fix_map, current_gw)
        team_stats   = build_team_stats(players_raw)

        # Build enriched pool — same availability filter as transfers
        pool = []
        for p_raw in players_raw.values():
            if p_raw["id"] in banned_ids:
                continue
            if p_raw.get("status") not in ("a", None):
                if p_raw["id"] not in locked_ids:
                    continue
            chance = p_raw.get("chance_of_playing_next_round") or p_raw.get("chance_of_playing_this_round")
            if chance is not None and chance < 75 and p_raw["id"] not in locked_ids:
                continue
            starts = int(p_raw.get("starts") or 0)
            if starts < 2 and p_raw["id"] not in locked_ids:
                continue
            enriched = enrich(p_raw, teams, fix_map, dgw_map, team_stats)
            pool.append(enriched)

        # Find the planning GW — first GW from now where most teams have fixtures
        # If current GW is a BGW, look ahead so the selection still makes sense
        all_pool_fixes = [f for p in pool for f in p.get("fixes", [])]
        gw_fixture_counts = {}
        for f in all_pool_fixes:
            gw_fixture_counts[f["gw"]] = gw_fixture_counts.get(f["gw"], 0) + 1

        # Planning GW = first GW from current with 15+ teams playing (not a BGW)
        planning_gw = current_gw
        for gw_candidate in sorted(gw_fixture_counts):
            if gw_candidate >= current_gw and gw_fixture_counts[gw_candidate] >= 30:
                planning_gw = gw_candidate
                break

        # Pre-filter: top 40 per position by adjusted composite
        # Penalise BGW players, boost DGW players for this specific selection
        def selection_score(p):
            base = p["composite"]
            fixes = p.get("fixes", [])
            planning_fix = [f for f in fixes if f["gw"] == planning_gw]

            if mode == "freehit":
                if not planning_fix:
                    base -= 80
                elif len(planning_fix) >= 2:
                    base += 25  # DGW on free hit = massive
            else:
                if not planning_fix:
                    base -= 60  # BGW — won't play in planning GW
                elif len(planning_fix) >= 2:
                    base += 18  # DGW this planning GW
                else:
                    # Check next GW for DGW
                    next_fix = [f for f in fixes if f["gw"] == planning_gw + 1]
                    if len(next_fix) >= 2:
                        base += 8

            return base

        by_pos = {}
        for pos in ["GKP","DEF","MID","FWD"]:
            candidates = sorted([p for p in pool if p["pos"] == pos],
                                 key=lambda x: -selection_score(x))
            locked_in_pos = [p for p in candidates if p["id"] in locked_ids]
            unlocked = [p for p in candidates if p["id"] not in locked_ids]
            by_pos[pos] = locked_in_pos + unlocked[:40]

        SLOTS = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}

        def squad_cost(squad):
            return round(sum(p["price"] for p in squad), 1)

        def club_counts(squad):
            from collections import Counter
            return Counter(p["team"] for p in squad)

        def build_greedy(by_pos, budget, locked_ids):
            """Greedy fill: place locked players first, then best available."""
            squad = []
            # Place locked players
            for pos, candidates in by_pos.items():
                for p in candidates:
                    if p["id"] in locked_ids:
                        squad.append({**p, "is_locked": True})

            remaining_budget = round(budget - squad_cost(squad), 1)

            # Fill remaining slots greedily
            for pos, n_slots in SLOTS.items():
                already = [p for p in squad if p["pos"] == pos]
                needed  = n_slots - len(already)
                if needed <= 0:
                    continue
                clubs = club_counts(squad)
                for candidate in by_pos[pos]:
                    if needed <= 0:
                        break
                    if any(p["id"] == candidate["id"] for p in squad):
                        continue
                    if clubs.get(candidate["team"], 0) >= 3:
                        continue
                    if candidate["price"] > remaining_budget - (needed - 1) * 4.0:
                        continue
                    squad.append(candidate)
                    remaining_budget = round(remaining_budget - candidate["price"], 1)
                    clubs[candidate["team"]] = clubs.get(candidate["team"], 0) + 1
                    needed -= 1

            return squad if len(squad) == 15 else None

        def improve_squad(squad, by_pos, budget):
            """Local improvement using selection_score — avoids BGW, favours DGW."""
            improved = True
            passes   = 0
            while improved and passes < 4:
                improved = False
                passes  += 1
                for i, p in enumerate(squad):
                    if p.get("is_locked") or p["id"] in locked_ids:
                        continue
                    pos            = p["pos"]
                    others         = [s for s in squad if s["id"] != p["id"]]
                    clubs_without  = club_counts(others)
                    budget_without = round(budget - squad_cost(others), 1)
                    current_score  = selection_score(p)
                    for candidate in sorted(by_pos[pos], key=lambda x: -selection_score(x)):
                        if any(s["id"] == candidate["id"] for s in others):
                            continue
                        if clubs_without.get(candidate["team"], 0) >= 3:
                            continue
                        if candidate["price"] > budget_without:
                            continue
                        if selection_score(candidate) > current_score:
                            squad[i] = candidate
                            improved = True
                            break
            return squad

        squad = build_greedy(by_pos, budget, locked_ids)
        if not squad or len(squad) < 15:
            return jsonify({"error": "Could not build a valid squad within budget. Try increasing the budget or reducing locked players."}), 400

        squad = improve_squad(squad, by_pos, budget)

        # Pick optimal XI using same logic as season review
        VALID_FORMATIONS = [(3,4,3),(3,5,2),(4,3,3),(4,4,2),(4,5,1),(5,2,3),(5,3,2),(5,4,1)]
        gkps     = sorted([p for p in squad if p["pos"]=="GKP"],  key=lambda x: -x["composite"])
        outfield = sorted([p for p in squad if p["pos"]!="GKP"],  key=lambda x: -x["composite"])
        defs_pool = [p for p in outfield if p["pos"]=="DEF"]
        mids_pool = [p for p in outfield if p["pos"]=="MID"]
        fwds_pool = [p for p in outfield if p["pos"]=="FWD"]

        best_xi, best_form, best_score = [], (4,4,2), -1
        for nd, nm, nf in VALID_FORMATIONS:
            if len(defs_pool)<nd or len(mids_pool)<nm or len(fwds_pool)<nf: continue
            xi    = defs_pool[:nd] + mids_pool[:nm] + fwds_pool[:nf]
            score = sum(p["composite"] for p in xi)
            if score > best_score:
                best_score, best_xi, best_form = score, xi, (nd,nm,nf)

        xi_ids  = {p["id"] for p in best_xi} | {gkps[0]["id"]}
        xi_gkp  = gkps[0]
        bench   = sorted([p for p in squad if p["id"] not in xi_ids],
                         key=lambda x: (x["pos"]!="GKP", -x["composite"]))

        # Captain: highest composite xi outfield player
        cap     = max(best_xi, key=captain_score)
        vc      = sorted(best_xi, key=lambda x: -x["composite"])[1] if len(best_xi)>1 else None

        # 4-GW projections for each XI player
        for p in squad:
            p["projections"] = [project_gw_points(p, current_gw+i)
                                for i in range(4) if current_gw+i <= 38]
            p["is_sub"]      = p["id"] not in xi_ids

        total_comp = sum(p["composite"] for p in squad if not p["is_sub"])
        total_cost = squad_cost(squad)
        remaining  = round(budget - total_cost, 1)

        # Check wildcard availability — FPL resets wildcards mid-season (~GW19)
        try:
            team_id_sb = data.get("team_id")
            wc_available = None
            if team_id_sb:
                hist_sb   = fpl_get(f"/entry/{team_id_sb}/history/")
                chips_sb  = [c["name"] for c in hist_sb.get("chips", [])]
                wc_count  = chips_sb.count("wildcard")
                mid_gw    = 19
                wc_available = wc_count == 0 if current_gw <= mid_gw else wc_count <= 1
        except Exception:
            wc_available = None

        # Validate club limits
        from collections import Counter as _Ctr
        club_final      = _Ctr(p["team_name"] for p in squad)
        club_violations = {t: n for t, n in club_final.items() if n > 3}

        return jsonify({
            "mode":               mode,
            "budget":             budget,
            "total_cost":         total_cost,
            "remaining":          remaining,
            "formation":          f"{best_form[0]}-{best_form[1]}-{best_form[2]}",
            "total_comp":         total_comp,
            "captain":            {"id": cap["id"], "name": cap["name"]},
            "vc":                 {"id": vc["id"],  "name": vc["name"]} if vc else None,
            "wildcard_available": wc_available,
            "club_violations":    club_violations,
            "squad":              [serialize_player(p) | {
                "is_sub":      p["is_sub"],
                "projections": p["projections"],
                "is_locked":   p.get("is_locked", False),
            } for p in squad],
        })

    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "detail": traceback.format_exc()}), 500


def _open_browser():
    time.sleep(1.2)
    webbrowser.open("http://localhost:5000")

if __name__ == "__main__":
    print("\n" + "="*50)
    print("  FPL Analysis Dashboard")
    print("  Opening http://localhost:5000 ...")
    print("  Press Ctrl+C to stop")
    print("="*50 + "\n")
    threading.Thread(target=_open_browser, daemon=True).start()
    app.run(debug=False, port=5000, use_reloader=False)
