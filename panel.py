"""
FPL Model Performance Panel
============================
Automatically tracks model suggestion quality across a fixed panel of
100 managers, sampled once from the current top-100 standings.

Triggered automatically on each dashboard load from app.py:
  - If no snapshot exists for the current GW, captures one in the background
  - If previous GW snapshots are unevaluated, evaluates them in the background

Data stored in panel_data.json — never modifies app.py logic.

The panel answers: "Do the model's suggestions outperform what 100 real
managers actually did?" Accumulates week by week into a calibration log.
"""

import os, json, time, threading
from datetime import datetime
from collections import defaultdict

PANEL_FILE = os.path.join(os.path.dirname(__file__), "panel_data.json")
PANEL_SIZE = 100
_lock      = threading.Lock()


# ── Persistence ────────────────────────────────────────────────
def _load():
    if not os.path.exists(PANEL_FILE):
        return {"panel_ids": [], "snapshots": {}, "evaluations": {}, "meta": {}}
    try:
        with open(PANEL_FILE) as f:
            return json.load(f)
    except Exception:
        return {"panel_ids": [], "snapshots": {}, "evaluations": {}, "meta": {}}

def _save(data):
    try:
        with open(PANEL_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[panel] save failed: {e}")


# ── Panel initialisation ───────────────────────────────────────
def ensure_panel(fpl_get_fn):
    """
    If panel_ids is empty, fetch top 100 managers from overall standings.
    Called once; IDs are fixed for the rest of the season.
    """
    data = _load()
    if len(data.get("panel_ids", [])) >= PANEL_SIZE:
        return data["panel_ids"]

    print("[panel] Initialising panel — fetching top 100 managers...")
    managers = []
    page = 1
    while len(managers) < PANEL_SIZE:
        try:
            resp    = fpl_get_fn(f"/leagues-classic/314/standings/?page_standings={page}")
            results = resp.get("standings", {}).get("results", [])
            if not results:
                break
            managers.extend(results)
            if not resp.get("standings", {}).get("has_next", False):
                break
            page += 1
            time.sleep(0.1)
        except Exception as e:
            print(f"[panel] standings page {page} failed: {e}")
            break

    ids = [m["entry"] for m in managers[:PANEL_SIZE] if m.get("entry")]
    data["panel_ids"]  = ids
    data["meta"]["initialised"] = datetime.now().isoformat()[:19]
    data["meta"]["panel_size"]  = len(ids)
    _save(data)
    print(f"[panel] Panel initialised with {len(ids)} managers")
    return ids


# ── Snapshot ───────────────────────────────────────────────────
def snapshot_gw(gw, fpl_get_fn, enrich_fn, build_fix_map_fn, get_dgw_map_fn,
                build_team_stats_fn, captain_score_fn, build_transfer_fn,
                POS_MAP, players_raw, teams, fix_map, dgw_map, team_stats,
                all_players):
    """
    For each panel manager, capture:
      - Model's captain recommendation for their squad
      - Model's top transfer suggestion for their squad
    Runs in background thread. Does not block dashboard.
    """
    data = _load()
    gw_key = str(gw)

    if gw_key in data.get("snapshots", {}):
        print(f"[panel] GW{gw} snapshot already exists, skipping")
        return

    print(f"[panel] Starting GW{gw} snapshot for {len(data['panel_ids'])} managers...")
    snaps = {}

    for i, entry_id in enumerate(data["panel_ids"]):
        try:
            hist = fpl_get_fn(f"/entry/{entry_id}/history/")
            fh   = {c["event"] for c in hist.get("chips",[]) if c["name"]=="freehit"}
            picks = None
            for gw_try in [gw, gw-1]:
                if gw_try < 1 or gw_try in fh: continue
                try:
                    picks = fpl_get_fn(f"/entry/{entry_id}/event/{gw_try}/picks/")
                    break
                except Exception:
                    continue
            if not picks:
                continue

            bank  = picks.get("entry_history",{}).get("bank", 0) / 10
            squad = []
            for pk in picks["picks"]:
                if pk["element"] in players_raw:
                    squad.append(enrich_fn(
                        players_raw[pk["element"]], teams, fix_map,
                        dgw_map, team_stats, pk
                    ))

            if not squad:
                continue

            starters = [p for p in squad if not p.get("is_sub") and p["pos"] != "GKP"]
            if not starters:
                continue

            # Model captain
            cap = max(starters, key=captain_score_fn)

            # Model transfer (best suggestion)
            transfer_snap = None
            try:
                # Attach projections so DGW sort works inside build_transfer_groups
                from app import project_gw_points as _pgp
                for _ap in all_players:
                    if not _ap.get("projections"):
                        _ap["projections"] = [_pgp(_ap, gw+i) for i in range(4)]
                groups = build_transfer_fn(squad, all_players, bank, 1, gw)
                if groups and groups[0]["options"]:
                    best = groups[0]["options"][0]
                    transfer_snap = {
                        "out_id":    groups[0]["out"]["id"],
                        "out_name":  groups[0]["out"]["name"],
                        "out_comp":  groups[0]["out"]["composite"],
                        "in_id":     best["in"]["id"],
                        "in_name":   best["in"]["name"],
                        "in_comp":   best["in"]["composite"],
                        "comp_gain": best["gain"],
                        "verdict":   best["verdict"],
                    }
            except Exception:
                pass

            snaps[str(entry_id)] = {
                "entry_id":     entry_id,
                "cap_id":       cap["id"],
                "cap_name":     cap["name"],
                "cap_comp":     cap["composite"],
                "transfer":     transfer_snap,
                # Filled in by evaluate:
                "actual_cap_id":   None,
                "actual_cap_pts":  None,
                "model_cap_pts":   None,
                "cap_delta":       None,
                "actual_pts":      None,
            }

            time.sleep(0.07)

        except Exception as e:
            pass  # Skip failed managers silently

        if (i+1) % 10 == 0:
            print(f"[panel] Snapped {i+1}/{len(data['panel_ids'])}...")

    data["snapshots"][gw_key] = {
        "gw":       gw,
        "date":     datetime.now().isoformat()[:19],
        "managers": snaps,
        "evaluated": False,
    }
    _save(data)
    print(f"[panel] GW{gw} snapshot complete — {len(snaps)} managers captured")


# ── Evaluate ───────────────────────────────────────────────────
def evaluate_gw(gw, fpl_get_fn):
    """
    For a completed GW, fetch actual points and score the snapshots.
    """
    data   = _load()
    gw_key = str(gw)
    snap   = data.get("snapshots",{}).get(gw_key)

    if not snap:
        print(f"[panel] No snapshot for GW{gw}, cannot evaluate")
        return
    if snap.get("evaluated"):
        print(f"[panel] GW{gw} already evaluated")
        return

    print(f"[panel] Evaluating GW{gw}...")

    # Fetch player histories for all relevant IDs
    all_ids = set()
    for m in snap["managers"].values():
        all_ids.add(m["cap_id"])
        if m.get("transfer"):
            all_ids.update([m["transfer"]["out_id"], m["transfer"]["in_id"]])

    histories = {}
    for pid in all_ids:
        try:
            s = fpl_get_fn(f"/element-summary/{pid}/")
            histories[pid] = s.get("history", [])
        except Exception:
            histories[pid] = []
        time.sleep(0.05)

    def pts_in_gw(pid, target_gw):
        hist = histories.get(pid, [])
        row  = next((r for r in hist if r.get("round") == target_gw), None)
        return row.get("total_points", 0) if row else 0

    cap_deltas = []
    transfer_results = defaultdict(list)

    for entry_id, m in snap["managers"].items():
        # Actual captain
        try:
            picks = fpl_get_fn(f"/entry/{entry_id}/event/{gw}/picks/")
            actual_cap = next(
                (pk for pk in picks["picks"] if pk.get("multiplier",1) >= 2), None
            )
            if actual_cap:
                m["actual_cap_id"]  = actual_cap["element"]
                m["actual_cap_pts"] = pts_in_gw(actual_cap["element"], gw) * 2
                m["model_cap_pts"]  = pts_in_gw(m["cap_id"], gw) * 2
                m["cap_delta"]      = m["model_cap_pts"] - m["actual_cap_pts"]
                cap_deltas.append(m["cap_delta"])
            m["actual_pts"] = picks.get("entry_history",{}).get("points", 0)
        except Exception:
            pass

        # Transfer evaluation (3 GWs out — will be filled next time we have data)
        if m.get("transfer"):
            t = m["transfer"]
            t["out_pts3"]    = sum(pts_in_gw(t["out_id"], gw+i) for i in range(3))
            t["in_pts3"]     = sum(pts_in_gw(t["in_id"],  gw+i) for i in range(3))
            t["actual_gain"] = t["in_pts3"] - t["out_pts3"]
            t["correct"]     = t["actual_gain"] > 0
            transfer_results[t["verdict"]].append(t["actual_gain"])

        time.sleep(0.05)

    # Aggregate results
    agg = {}
    if cap_deltas:
        agg["cap_avg_delta"]  = round(sum(cap_deltas) / len(cap_deltas), 2)
        agg["cap_n"]          = len(cap_deltas)
        agg["cap_model_wins"] = sum(1 for d in cap_deltas if d > 0)
        agg["cap_win_pct"]    = round(agg["cap_model_wins"] / agg["cap_n"] * 100, 1)

    for verdict, gains in transfer_results.items():
        n = len(gains)
        agg[f"transfer_{verdict.lower()}_n"]       = n
        agg[f"transfer_{verdict.lower()}_avg"]     = round(sum(gains)/n, 2) if n else 0
        agg[f"transfer_{verdict.lower()}_correct"] = sum(1 for g in gains if g>0)

    snap["aggregates"] = agg
    snap["evaluated"]  = True
    data["snapshots"][gw_key] = snap
    _save(data)

    print(f"[panel] GW{gw} evaluation complete")
    if cap_deltas:
        print(f"  Captain: avg delta {agg['cap_avg_delta']:+.1f}pts  "
              f"model wins {agg['cap_win_pct']:.0f}% of captains")


# ── Report ─────────────────────────────────────────────────────
def get_report():
    """Returns a dict summary suitable for the dashboard API."""
    data = _load()
    done = {k: v for k,v in data.get("snapshots",{}).items() if v.get("evaluated")}
    all_snaps = data.get("snapshots", {})
    panel_ids = data.get("panel_ids", [])

    if not panel_ids:
        return {
            "status":      "not_initialised",
            "panel_size":  0,
            "message":     "Panel not yet initialised. Click 'Initialise panel' to fetch the top-100 managers.",
            "gws_tracked": 0,
        }

    if not done:
        pending = [k for k,v in all_snaps.items() if not v.get("evaluated")]
        return {
            "status":      "no_data",
            "panel_size":  len(panel_ids),
            "gws_tracked": 0,
            "pending_gws": pending,
            "message":     f"Panel has {len(panel_ids)} managers. "
                           + (f"GW snapshot(s) {', '.join('GW'+p for p in pending)} captured — will evaluate after GW completes."
                              if pending else "No snapshots yet — load the dashboard before the GW deadline."),
        }

    cap_deltas   = [v["aggregates"]["cap_avg_delta"]
                    for v in done.values() if "cap_avg_delta" in v.get("aggregates",{})]
    strong_avgs  = [v["aggregates"].get("transfer_strong_avg")
                    for v in done.values() if v.get("aggregates",{}).get("transfer_strong_n",0)>0]

    return {
        "status":        "ok",
        "panel_size":    data["meta"].get("panel_size", 0),
        "gws_tracked":   len(done),
        "cap_avg_delta": round(sum(cap_deltas)/len(cap_deltas),2) if cap_deltas else None,
        "strong_transfer_avg": round(sum(strong_avgs)/len(strong_avgs),2) if strong_avgs else None,
        "by_gw": {
            gw_key: {
                "cap_avg_delta":  v["aggregates"].get("cap_avg_delta"),
                "cap_win_pct":    v["aggregates"].get("cap_win_pct"),
                "transfer_strong_avg": v["aggregates"].get("transfer_strong_avg"),
                "transfer_strong_n":   v["aggregates"].get("transfer_strong_n"),
            }
            for gw_key, v in sorted(done.items())
            if v.get("aggregates")
        }
    }


# ── Background trigger (called from app.py) ────────────────────
def trigger(current_gw, fpl_get_fn, enrich_fn, build_fix_map_fn,
            get_dgw_map_fn, build_team_stats_fn, captain_score_fn,
            build_transfer_fn, POS_MAP,
            players_raw, teams, fix_map, dgw_map, team_stats, all_players):
    """
    Called from api_load on each dashboard load.
    Runs panel operations in a background thread — never blocks the response.
    """
    def _run():
        with _lock:
            try:
                # Ensure panel is initialised
                ids = ensure_panel(fpl_get_fn)
                if not ids:
                    return

                data = _load()

                # Evaluate previous GW if unevaluated
                prev_gw = current_gw - 1
                if prev_gw >= 1:
                    prev_key = str(prev_gw)
                    prev_snap = data.get("snapshots",{}).get(prev_key)
                    if prev_snap and not prev_snap.get("evaluated"):
                        evaluate_gw(prev_gw, fpl_get_fn)

                # Snapshot current GW if not done yet
                gw_key = str(current_gw)
                if gw_key not in data.get("snapshots",{}):
                    snapshot_gw(
                        current_gw, fpl_get_fn, enrich_fn, build_fix_map_fn,
                        get_dgw_map_fn, build_team_stats_fn, captain_score_fn,
                        build_transfer_fn, POS_MAP,
                        players_raw, teams, fix_map, dgw_map, team_stats, all_players
                    )
            except Exception as e:
                print(f"[panel] background error: {e}")

    t = threading.Thread(target=_run, daemon=True)
    t.start()
