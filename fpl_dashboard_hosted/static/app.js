// ================================================================
// FPL Dashboard — app.js
// ================================================================

const FDR_C = {1:"#1a8a26",2:"#78c97e",3:"#a88a00",4:"#c1501f",5:"#9c1a1a"};
const FONT  = "Tahoma,Verdana,Geneva,sans-serif";
const VERDICT_CLS = {
  "Strong":"badge-green","Good":"badge-blue","Marginal":"badge-amber",
  "Consider hit":"badge-amber","Risky hit":"badge-red",
};

let _state = null;
let _charts = {};
let _phCache = {};       // player history cache
let _playerMode = "pts";
let _rankSort   = {key:"composite", dir:-1};
let _rankPos    = "ALL";

// ── Tooltip system ────────────────────────────────────────────
// Uses a single floating div driven by mouseenter/mouseleave.
// Works reliably in dynamically generated innerHTML.

function ttip(label, tip) {
  return `<span class="tooltip-host" data-tip="${tip.replace(/"/g,'&quot;')}">${label}<span class="tip-icon">ⓘ</span></span>`;
}

document.addEventListener("mouseover", e => {
  const host = e.target.closest("[data-tip]");
  if (!host) return;
  const box = el("globalTip");
  const raw = host.dataset.tip || "";
  // Score breakdowns use ~~ as entry separator, | within each signal entry
  if (raw.includes("~~")) {
    const parts = raw.split("~~");
    let html = `<div style="font-weight:700;margin-bottom:8px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.15);padding-bottom:6px">${parts[0]}</div>`;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part === "MOD") {
        i++;
        html += `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.15);font-size:10px;color:rgba(255,255,255,.6)">${parts[i]||""}</div>`;
      } else {
        // Format: "Label|barPct|contrib|colour"
        const seg = part.split("|");
        if (seg.length === 4) {
          const [lbl, pct, contrib, barC] = seg;
          html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <div style="font-size:10px;color:rgba(255,255,255,.75);min-width:58px">${lbl}</div>
            <div style="flex:1;height:6px;background:rgba(255,255,255,.12);border-radius:0;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${barC};border-radius:0"></div>
            </div>
            <div style="font-size:10px;font-weight:700;color:${barC};min-width:20px;text-align:right">${contrib}</div>
          </div>`;
        } else {
          html += `<div style="font-size:11px;color:rgba(255,255,255,.8);margin-bottom:2px">${part}</div>`;
        }
      }
    }
    box.innerHTML = html;
  } else if (raw.includes("|")) {
    // Legacy plain | format for simple tooltips
    box.innerHTML = raw.split("|").map((l,i) =>
      i===0
        ? `<div style="font-weight:700;margin-bottom:4px;font-size:12px">${l}</div>`
        : `<div style="font-size:11px">${l}</div>`
    ).join("");
  } else {
    box.innerHTML = raw;
  }
  box.style.display = "block";
  positionTip(box, host);
});

document.addEventListener("mouseout", e => {
  if (!e.target.closest("[data-tip]")) return;
  const box = el("globalTip");
  if (!e.relatedTarget?.closest("[data-tip]")) box.style.display = "none";
});

document.addEventListener("scroll", () => {
  el("globalTip").style.display = "none";
}, true);

function positionTip(box, host) {
  const r   = host.getBoundingClientRect();
  const bw  = 230;
  let left  = r.left;
  let top   = r.top - 8;   // will subtract box height below
  // Clamp to viewport
  if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;
  if (left < 8) left = 8;
  box.style.left = left + "px";
  // Position above — measure after display:block
  box.style.top = "0px";
  const bh = box.offsetHeight;
  top = r.top - bh - 8;
  if (top < 8) top = r.bottom + 8;   // flip below if no room above
  box.style.top = top + "px";
}



const el   = id => document.getElementById(id);
const show = id => el(id).style.display = "block";
const hide = id => el(id).style.display = "none";

function fdrSq(fixes, n=5) {
  return (fixes||[]).slice(0,n).map(f => {
    const c = FDR_C[f.fdr]||"#888";
    const ha = f.home ? "H" : "A";
    return `<span class="fdr-sq" title="${f.opp} (${ha})" style="background:${c}22;color:${c};border:1px solid ${c}44">${f.fdr}</span>`;
  }).join("");
}

function projMiniBar(opt) {
  // Shows 3-GW projected points for the incoming player vs outgoing
  const gws = opt.in_proj_gws || [];
  const gainC = opt.proj_gain3 >= 0 ? "var(--green-fg)" : "var(--red-fg)";
  const cells = gws.map(g => {
    const c = g.blank ? "var(--text3)" : g.dgw ? "var(--purple-fg)" : "var(--text2)";
    const bg = g.blank ? "var(--surface2)" : g.dgw ? "var(--purple-bg)" : "var(--surface)";
    const lbl = g.blank ? "BGW" : g.dgw ? `${g.proj}×2` : g.proj;
    return `<div style="text-align:center;background:${bg};border:1px solid var(--border);
      border-radius:0;padding:3px 6px;min-width:38px">
      <div style="font-size:11px;font-weight:700;color:${c}">${lbl}</div>
      <div style="font-size:9px;color:var(--text3)">GW${g.gw}</div>
    </div>`;
  }).join("");
  return `<div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:10px;color:var(--text3)">3GW proj:</span>
    ${cells}
    <span style="font-size:11px;font-weight:700;color:${gainC};margin-left:2px">
      ${opt.proj_gain3 >= 0 ? "+" : ""}${opt.proj_gain3} vs out
    </span>
  </div>`;
}

function badge(cls, txt) { return `<span class="badge badge-${cls}">${txt}</span>`; }

function scoreBar(v, w=70, p=null) {
  const pct = Math.min(v,100);
  const c   = pct>70?"#1a8a26":pct>45?"#9c7a00":"#a3182a";

  let tipAttr = "";
  if (p) {
    // Mirror the backend weight matrix (recalibrated from backtest correlations)
    const W = {
      GKP:[0.15,0.00,0.05,0.20,0.15,0.05,0.40],
      DEF:[0.15,0.10,0.05,0.30,0.10,0.10,0.20],
      MID:[0.25,0.40,0.05,0.15,0.10,0.05,0.00],
      FWD:[0.20,0.50,0.05,0.15,0.10,0.00,0.00],
    };
    // ATK_MID: blend MID (35%) and FWD (65%) weights
    const wMID = W.MID, wFWD = W.FWD;
    W.ATK_MID = wMID.map((v,i) => Math.round((v*0.35 + wFWD[i]*0.65)*1000)/1000);
    const effPos = p.effective_pos || p.pos;
    const w    = W[effPos] || W[p.pos] || W.MID;
    const form_norm  = Math.min((p.form||0)/12, 1);
    const xgi_norm   = p.has_xg && p.starts>=5 ? Math.min((p.xgi90||0)/1.5,1) : form_norm*0.75;
    const pts_norm   = Math.min((p.pts_per_start||0)/10, 1);
    // FDR threshold model — data shows non-linear signal, FDR5 is a hard penalty
    const nf = p.fixes?.[0]?.fdr || 3;
    const fdr_score = nf===5 ? 0.20 : nf===4 ? 0.45 : nf===3 ? 0.55 : nf===2 ? 0.65 : 0.80;
    const pt_norm    = p.playing_time_norm||0;
    const def_norm   = p.def_contrib_norm||0;
    const xcs_norm   = p.xcs_pts_per_game
      ? (["GKP","DEF"].includes(p.pos)
          ? Math.min((p.xcs_pts_per_game)/4,1)
          : Math.min((p.xcs_pts_per_game)/0.5,1))
      : 0;

    const signals = [
      ["Form",      form_norm, w[0]],
      ["xGI/90",    xgi_norm,  w[1]],
      ["Pts/start", pts_norm,  w[2]],
      ["Fixture",   fdr_score, w[3]],
      ["Play time", pt_norm,   w[4]],
      ["Def/BPS",   def_norm,  w[5]],
      ["xCS",       xcs_norm,  w[6]],
    ];

    // Availability and DGW modifiers
    const avail = p.availability||1;
    const dgwB  = p.n_dgw>0 ? ` +DGW boost` : "";
    const injNote = avail<1 ? ` ×${Math.round(avail*100)}% avail` : "";

    const lines = signals
      .filter(([,, wt]) => wt > 0)
      .map(([lbl, val, wt]) => {
        const contrib = Math.round(val * wt * 100);
        const pct     = Math.min(contrib * 2, 100);   // scale: 50pts = full bar
        const barC    = contrib >= 12 ? "#1a8a26"
                      : contrib >= 6  ? "#123a70"
                      : contrib >= 2  ? "#9c7a00" : "#aaa";
        return `${lbl}|${pct}|${contrib}|${barC}`;
      });

    const trendNote = (p.form_trend_label && p.form_trend_label !== "→" && p.starts >= 5)
      ? ` ${p.form_trend_label} form trend` : "";
    const tip = `Score breakdown (${p.pos})~~` +
      lines.join("~~") +
      (dgwB||injNote||trendNote ? `~~MOD~~Modifiers:${dgwB}${injNote}${trendNote}` : "");

    tipAttr = `data-tip="${tip}"`;
  }

  return `<div class="score-bar-wrap" ${tipAttr} style="cursor:${p?"help":"default"}">
    <div class="score-bar" style="width:${w}px">
      <div class="score-fill" style="width:${pct}%;background:${c}"></div>
    </div>
    <span style="font-size:12px">${v}</span>
  </div>`;
}

function injBadge(p) {
  if (!p.news) return "";
  const c = p.chance === 75 ? "#9c7a00" : p.chance <= 50 ? "#a3182a" : "#9c7a00";
  const pct = p.chance != null ? ` (${p.chance}%)` : "";
  return `<span title="${p.news}" style="font-size:10px;color:${c};font-weight:700;display:block;margin-top:2px">⚠${pct}</span>`;
}

function dgwBadge(p) {
  if (!p.has_dgw_next) return "";
  if (p.is_dgw_imminent) return `<span class="dgw-badge">DGW 🔥</span>`;
  return `<span class="dgw-badge" style="opacity:0.75">DGW GW${p.dgw_next_gw}</span>`;
}

function priceArrow(p) {
  if (p.price_rising)  return `<span class="price-badge" title="Price rise likely — high net transfers in">↑</span>`;
  if (p.price_falling) return `<span class="price-badge" style="color:var(--red-fg)" title="Price fall likely — high net transfers out">↓</span>`;
  return "";
}

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

function mkChart(id, cfg) {
  destroyChart(id);
  const canvas = el(id);
  if (!canvas) return null;
  _charts[id] = new Chart(canvas, cfg);
  return _charts[id];
}

function baseOpts(yLabel, extra={}) {
  return {
    responsive:true, maintainAspectRatio:false, spanGaps:false,
    plugins:{ legend:{display:false},
      tooltip:{mode:"index",intersect:false,
        callbacks:{title:c=>"GW "+c[0].label}} },
    scales:{
      x:{ticks:{color:"#aaa",font:{size:11,family:FONT}},grid:{color:"rgba(0,0,0,0.04)"}},
      y:{ticks:{color:"#aaa",font:{size:11,family:FONT}},grid:{color:"rgba(0,0,0,0.04)"},
         title:{display:!!yLabel,text:yLabel||"",color:"#aaa",font:{size:11}}}
    },
    ...extra,
  };
}

function lineDs(color, fill, label, data, dashed, t=0.35) {
  return {
    label, data, borderColor:color,
    backgroundColor: fill||"transparent",
    borderWidth:2, pointRadius:3, pointHoverRadius:5,
    fill:!!fill, tension:t,
    borderDash: dashed?[5,4]:[],
    spanGaps:false,
  };
}

// ── Load ───────────────────────────────────────────────────────

async function loadDashboard() {
  const teamId = el("teamId").value.trim();
  if (!teamId) { alert("Please enter a Team ID"); return; }
  const ft = parseInt(el("freeTransfers").value);
  const gw = el("gwSelect").value || null;

  hide("emptyState"); hide("errorState"); hide("dashboard");
  show("loadingState");
  el("loadBtn").disabled = true;
  _phCache = {};

  try {
    el("loadMsg").textContent = "Fetching FPL data...";
    const res = await fetch("/api/load", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({team_id:teamId, free_transfers:ft, gameweek:gw}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unknown error");
    _state = data;

    // Populate GW selector
    const gwSel = el("gwSelect");
    gwSel.innerHTML = '<option value="">Auto-detect</option>';
    (data.meta.available_gws||[]).forEach(g => {
      const o = document.createElement("option");
      o.value = g; o.text = `GW${g}`;
      if (g === data.meta.current_gw) o.selected = true;
      gwSel.appendChild(o);
    });

    hide("loadingState");
    saveRecentTeam(teamId, data.meta.team_name, data.meta.manager);
    renderDashboard(data);
    el("lastLoaded").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch(e) {
    hide("loadingState");
    const box = el("errorState");
    box.innerHTML = `<div class="err-box"><strong>Error:</strong> ${e.message}</div>`;
    show("errorState");
  } finally {
    el("loadBtn").disabled = false;
  }
}

// ── Render dashboard ───────────────────────────────────────────

function renderDashboard(data) {
  const m = data.meta;


  // Update club hub sidebar
  updateClubHub(data, m);


  // DGW / BGW banners — show which of your players are affected
  const banners = el("gwBanners");
  banners.innerHTML = "";
  const dgw   = data.dgw_summary || {};
  const squad = data.squad || [];
  const MAX_GW = 38;

  Object.entries(dgw).forEach(([gw, teams]) => {
    if (!teams.length) return;
    const gwNum   = parseInt(gw);
    if (gwNum > MAX_GW) return;                          // cap at GW38
    const gwsAway = gwNum - m.current_gw;
    if (gwsAway < 0 || gwsAway > 5) return;             // only show next 5 GWs
    const myDgwPlayers = squad.filter(p => !p.is_sub && teams.includes(p.team_name));
    const myStr = myDgwPlayers.length
      ? ` &nbsp;·&nbsp; Yours: <strong>${myDgwPlayers.map(p=>p.name).join(", ")}</strong>`
      : ` &nbsp;·&nbsp; <em style="opacity:0.7">None of your starters</em>`;
    const icon  = gwsAway === 0 ? "🔥" : gwsAway === 1 ? "⚡" : "📅";
    const lbl   = gwsAway === 0 ? "This GW" : gwsAway === 1 ? "Next GW" : `GW${gw} (in ${gwsAway})`;
    banners.innerHTML += `<div class="gw-banner dgw">
      ${icon} <strong>${lbl} Double:</strong> ${teams.join(", ")}${myStr}
    </div>`;
  });

  (data.bgw_gws||[]).forEach(gw => {
    if (gw > MAX_GW) return;                             // cap at GW38
    const gwsAway  = gw - m.current_gw;
    if (gwsAway < 0 || gwsAway > 5) return;             // only show next 5 GWs
    const myBlank  = squad.filter(p => !p.is_sub && !(p.fixes||[]).some(f => f.gw === gw));
    const blankStr = myBlank.length
      ? ` &nbsp;·&nbsp; Blanking: <strong>${myBlank.map(p=>p.name).join(", ")}</strong>`
      : "";
    const lbl = gwsAway === 0 ? "This GW" : gwsAway === 1 ? "Next GW" : `GW${gw}`;
    banners.innerHTML += `<div class="gw-banner bgw">⚠ <strong>${lbl} Blank</strong>${blankStr}</div>`;
  });

  // Metrics
  const top = [...data.squad].sort((a,b)=>b.composite-a.composite)[0];
  const ftC = m.free_transfers > 0 ? "var(--green)" : "var(--red)";

  // Deadline countdown
  let deadlineHtml = "";
  if (m.deadline_time) {
    const dlMs    = new Date(m.deadline_time) - new Date();
    const dlHrs   = Math.floor(dlMs / 3600000);
    const dlMins  = Math.floor((dlMs % 3600000) / 60000);
    if (dlMs > 0) {
      const urgC  = dlHrs < 2 ? "var(--red-fg)" : dlHrs < 12 ? "var(--amber-fg)" : "var(--green-fg)";
      const dlStr = dlHrs > 24 ? `${Math.floor(dlHrs/24)}d ${dlHrs%24}h`
                  : dlHrs > 0  ? `${dlHrs}h ${dlMins}m`
                  : `${dlMins}m`;
      deadlineHtml = `<div class="metric">
        <div class="metric-label">Deadline</div>
        <div class="metric-val" style="color:${urgC}">${dlStr}</div>
        <div class="metric-sub">GW${m.current_gw} closes</div>
      </div>`;
    }
  }

  el("metricsRow").innerHTML = `
    ${deadlineHtml}
    <div class="metric">
      <div class="metric-label">Gameweek</div>
      <div class="metric-val">GW${m.current_gw}</div>
      <div class="metric-sub">${m.active_chip || "No chip active"}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Team value</div>
      <div class="metric-val">£${m.squad_value.toFixed(1)}m</div>
      <div class="metric-sub">Bank: £${m.bank.toFixed(1)}m</div>
    </div>
    <div class="metric">
      <div class="metric-label">Free transfers</div>
      <div class="metric-val" style="color:${ftC}">${m.free_transfers}</div>
      <div class="metric-sub">Available this GW</div>
    </div>
    <div class="metric">
      <div class="metric-label">Top pick</div>
      <div class="metric-val" style="font-size:15px">${top?.name||"—"}</div>
      <div class="metric-sub">Score ${top?.composite||"—"}</div>
    </div>`;

  // Grouped tab navigation
  const TAB_GROUPS = [
    { label: "Team",        key: "team",       tabs: [["myteam","My Team"],["squadbuilder","Squad Builder"]] },
    { label: "Transfers",   key: "transfers",  tabs: [["transfers","Transfers"],["planner","GW Planner"],["chips","Chip Advisor"]] },
    { label: "Intelligence",key: "intel",      tabs: [["rankings","Rankings"],["scout","Scout"],["runin","Run-in"],["fixtures","Fixtures"]] },
    { label: "Analysis",    key: "analysis",   tabs: [["history","GW History"],["backtest","Backtest"],["seasonreview","Season Review"],["panel","Panel"],["transfers_impact","Transfer Impact"]] },
  ];
  window._TAB_GROUPS = TAB_GROUPS;
  renderGroupedTabs(TAB_GROUPS, "team");


  renderMyTeam(data.squad, data.dgw_summary||{}, data.all_players||[], m);
  renderTransfers(data.transfers, data.combos, data.all_players||[], data.dgw_summary||{}, m);
  renderRankings(data.all_players, data.dgw_summary||{});
  renderFixtures(data.fixtures, data.dgw_summary, m.current_gw);
  renderChips(data.chip_analysis, m);
  renderHistory(data.gw_history, data.squad, data.all_players, m);
  renderPlanner(data.squad, data.all_players, data.transfers, data.dgw_summary||{}, data.bgw_gws||[], m);
  renderBacktestShell();
  renderSeasonReviewShell(m.team_id);
  renderSquadBuilderShell(m);
  updateWatchlistFromLoad(data.all_players);
  renderScoutTab();
  renderPanelShell();
  renderRunIn(data, m);
  renderTransferImpactShell(m.team_id);
  show("dashboard");
  // First tab-content is now shown by renderGroupedTabs
}

function switchTab(id) {
  document.querySelectorAll(".tab-content").forEach(t=>t.classList.remove("visible"));
  const target = el("tab-"+id);
  if (target) target.classList.add("visible");
  Object.values(_charts).forEach(c => { try { c.resize(); } catch(e){} });
  // Update sub-tab active state
  document.querySelectorAll(".sub-tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === id);
  });
  window._activeTab = id;
}

function renderGroupedTabs(groups, activeGroupKey) {
  const groupBar = el("tabGroupBar");
  const subBar   = el("subTabBar");
  if (!groupBar || !subBar) return;

  groupBar.innerHTML = groups.map(g =>
    `<button class="tab-group-btn${g.key===activeGroupKey?" active":""}"
      data-gkey="${g.key}"
      onclick="switchTabGroup('${g.key}',this)">${g.label}</button>`
  ).join("");

  const activeGroup = groups.find(g=>g.key===activeGroupKey) || groups[0];
  renderSubTabs(activeGroup.tabs, activeGroup.tabs[0][0]);
  switchTab(activeGroup.tabs[0][0]);
}

function renderSubTabs(tabs, activeId) {
  const subBar = el("subTabBar");
  if (!subBar) return;
  subBar.innerHTML = tabs.map(([id,lbl]) =>
    `<button class="sub-tab-btn${id===activeId?" active":""}"
      data-tab="${id}"
      onclick="switchTab('${id}')">${lbl}</button>`
  ).join("");
}

function switchTabGroup(gkey, btn) {
  document.querySelectorAll(".tab-group-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  const group = (window._TAB_GROUPS||[]).find(g=>g.key===gkey);
  if (!group) return;
  renderSubTabs(group.tabs, group.tabs[0][0]);
  switchTab(group.tabs[0][0]);
}

// ── Sidebar collapse ──────────────────────────────────────────────

function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const btn     = document.getElementById("sidebarCollapseBtn");
  const main    = document.querySelector(".main");
  if (!sidebar) { console.warn("FPL: sidebar element not found"); return; }
  const collapsed = sidebar.classList.toggle("collapsed");
  if (btn) {
    btn.textContent = collapsed ? "\u00BB" : "\u00AB";
    btn.title       = collapsed ? "Expand sidebar" : "Collapse sidebar";
  }
  if (main) {
    main.style.maxWidth = collapsed ? "calc(100vw - 56px)" : "calc(100vw - 250px)";
  }
  try { localStorage.setItem("fpl_sidebar_collapsed", collapsed ? "1" : "0"); } catch(e) {}
}

// Restore sidebar collapsed state on page load
window.addEventListener("load", function() {
  try {
    if (localStorage.getItem("fpl_sidebar_collapsed") === "1") {
      const sidebar = document.querySelector(".sidebar");
      const btn = document.getElementById("sidebarCollapseBtn");
      const main = document.querySelector(".main");
      if (sidebar) sidebar.classList.add("collapsed");
      if (btn) btn.textContent = "\u00BB";
      if (main) main.style.maxWidth = "calc(100vw - 56px)";
    }
  } catch(e) {}
});

// ── Keyboard shortcuts ────────────────────────────────────────────

function showShortcuts() {
  const ov = el("shortcutOverlay");
  if (ov) ov.classList.add("visible");
}
function hideShortcuts() {
  const ov = el("shortcutOverlay");
  if (ov) ov.classList.remove("visible");
}

document.addEventListener("keydown", e => {
  // Don't trigger when typing in an input/select/textarea
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    if (e.key === "Enter" && document.activeElement === el("teamId")) loadDashboard();
    return;
  }

  const ov = el("shortcutOverlay");
  const ovVisible = ov && ov.classList.contains("visible");

  if (e.key === "Escape") {
    if (ovVisible) { hideShortcuts(); return; }
    const pm = el("profileModal"); if (pm) pm.style.display="none";
    const cm = el("compareModal"); if (cm) cm.style.display="none";
    const tm = el("teamCompModal"); if (tm) tm.style.display="none";
    return;
  }

  if (ovVisible) return; // swallow all keys when shortcut modal is open

  // ? key (Shift+/ on US keyboards — e.key will be "?")
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); showShortcuts(); return; }
  if (e.key === "[") { e.preventDefault(); toggleSidebar(); return; }
  if (e.key === "d" || e.key === "D") { toggleTheme(); return; }
  if (e.key === "l" || e.key === "L") { loadDashboard(); return; }

  if (!_state) return;

  const tabMap = { m:"myteam", t:"transfers", r:"rankings", f:"fixtures",
                   h:"history", s:"scout", b:"squadbuilder" };
  const tabId = tabMap[e.key.toLowerCase()];
  if (tabId) {
    e.preventDefault();
    const groups = window._TAB_GROUPS || [];
    for (const g of groups) {
      const found = g.tabs.find(([id]) => id === tabId);
      if (found) {
        const gBtn = document.querySelector(`.tab-group-btn[data-gkey="${g.key}"]`);
        if (gBtn) switchTabGroup(g.key, gBtn);
        else { renderSubTabs(g.tabs, tabId); switchTab(tabId); }
        break;
      }
    }
  }
});

// ── Player hover panel ────────────────────────────────────────────

function showPlayerHover(p, targetEl) {
  const panel = el("playerHoverPanel");
  if (!panel) return;
  el("phpName").textContent = p.name;
  el("phpMeta").textContent = `${p.team_name} · ${p.pos} · £${p.price}m`;
  el("phpStats").innerHTML = [
    { lbl:"Form",      val: p.form },
    { lbl:"xGI/90",   val: p.xgi90 != null ? p.xgi90.toFixed(2) : "—" },
    { lbl:"Score",     val: p.composite },
    { lbl:"Pts/start", val: p.pts_per_start != null ? p.pts_per_start.toFixed(1) : "—" },
    { lbl:"Ownership", val: p.selected_pct != null ? p.selected_pct.toFixed(1)+"%" : "—" },
    { lbl:"Play time", val: p.playing_time_norm != null ? Math.round(p.playing_time_norm*100)+"%" : "—" },
  ].map(s=>`<div class="php-stat">
    <div class="php-stat-lbl">${s.lbl}</div>
    <div class="php-stat-val">${s.val}</div>
  </div>`).join("");
  el("phpFixes").innerHTML = fdrSq(p.fixes, 5);

  panel.style.display = "block";
  positionHoverPanel(panel, targetEl);
}

function positionHoverPanel(panel, target) {
  const r = target.getBoundingClientRect();
  const pw = 260, ph = panel.offsetHeight || 200;
  let left = r.right + 8;
  let top  = r.top;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
  if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
  if (top < 8) top = 8;
  panel.style.left = left + "px";
  panel.style.top  = top + "px";
}

function hidePlayerHover() {
  const panel = el("playerHoverPanel");
  if (panel) panel.style.display = "none";
}

// Delegated hover events for player cards — use mouseenter/mouseleave on document
// mouseenter/mouseleave don't bubble, so we use mouseover/mouseout but check properly
document.addEventListener("mouseover", e => {
  const card = e.target.closest(".pcard");
  if (!card) return;
  if (!_state) return;
  const pid = card.dataset && parseInt(card.dataset.pid);
  if (!pid) return;
  const allP = (_state.squad || []).concat(_state.all_players || []);
  const p = allP.find(x => x.id === pid || String(x.id) === String(pid));
  if (p) showPlayerHover(p, card);
}, false);

document.addEventListener("mouseout", e => {
  const card = e.target.closest(".pcard");
  if (!card) return;
  // Only hide if we're leaving the card entirely (not moving to a child)
  if (!e.relatedTarget || !e.relatedTarget.closest(".pcard")) {
    hidePlayerHover();
  }
}, false);

// ── GW Decision Banner ────────────────────────────────────────────

function buildGwDecisionBanner(data, meta) {
  if (!data || !meta) return "";
  const squad = data.squad || [];
  const starters = squad.filter(p=>!p.is_sub);
  const transfers = data.transfers || [];

  // ── Key action ──
  // Find the best transfer suggestion
  let actionHtml = "";
  const allGroups = transfers;
  const strongOpts = allGroups.flatMap(g => g.options.filter(o=>o.verdict==="Strong"));
  const bestOpt = allGroups.flatMap(g=>g.options.map(o=>({...o,out:g.out}))).sort((a,b)=>b.gain-a.gain)[0];
  if (bestOpt) {
    const gainC = bestOpt.gain > 5 ? "var(--green-fg)" : bestOpt.gain > 2 ? "var(--blue-fg)" : "var(--text2)";
    const ft = meta.free_transfers > 0;
    actionHtml = `<div class="gw-db-section">
      <div class="gw-db-label">Top transfer</div>
      <div class="gw-db-main">${bestOpt.out.name} → ${bestOpt.in.name}</div>
      <div class="gw-db-sub" style="color:${gainC}">+${bestOpt.gain} score · ${ft?"Free transfer":"4pt hit"} · ${bestOpt.verdict}</div>
    </div>`;
  }

  // ── Captain pick ──
  const capCandidates = starters.filter(p=>p.pos!=="GKP")
    .map(p => {
      const xgiScore  = p.has_xg && p.starts>=5 ? Math.min((p.xgi90||0)/1.5,1) : 0;
      const formScore = Math.min((p.form||0)/12, 1);
      const atkScore  = xgiScore*0.6 + formScore*0.4;
      const fix1      = p.fixes?.[0];
      const fdrMod    = fix1 ? 1.0 + ((6-fix1.fdr)/5)*0.15 : 1.0;
      const dgwMod    = p.is_dgw_imminent ? 1.20 : p.has_dgw_next ? 1.08 : 1.0;
      const posMod    = p.pos==="FWD" ? 1.05 : p.pos==="MID" ? 1.0 : 0.75;
      const teamAtkMod = Math.max(0.85, Math.min(1.15,(p.team_xg_pg||1.3)/1.3));
      return { ...p, capScore: Math.round(atkScore*fdrMod*dgwMod*(p.availability||1)*posMod*teamAtkMod*100) };
    }).sort((a,b)=>b.capScore-a.capScore);
  const cap = capCandidates[0];
  let capHtml = "";
  if (cap) {
    const fix = cap.fixes?.[0];
    capHtml = `<div class="gw-db-section">
      <div class="gw-db-label">Suggested captain</div>
      <div class="gw-db-main">${cap.name} ${cap.is_dgw_imminent?"🔥":""}</div>
      <div class="gw-db-sub">${fix?`vs ${fix.opp} (${fix.home?"H":"A"}) FDR${fix.fdr} · `:""}xGI/90: ${cap.xgi90?cap.xgi90.toFixed(2):"—"}</div>
    </div>`;
  }

  // ── Injury alert ──
  const injured = starters.filter(p => p.chance != null && p.chance < 75);
  let injHtml = "";
  if (injured.length) {
    injHtml = `<div class="gw-db-section">
      <div class="gw-db-label">⚠ Injury alerts</div>
      <div class="gw-db-main" style="color:var(--amber-fg)">${injured.map(p=>`${p.name} (${p.chance}%)`).join(", ")}</div>
      <div class="gw-db-sub">Check fitness before deadline</div>
    </div>`;
  }

  // ── Deadline ──
  let dlHtml = "";
  if (meta.deadline_time) {
    const dlMs  = new Date(meta.deadline_time) - new Date();
    if (dlMs > 0) {
      const dlHrs  = Math.floor(dlMs/3600000);
      const dlMins = Math.floor((dlMs%3600000)/60000);
      const dlStr  = dlHrs>24?`${Math.floor(dlHrs/24)}d ${dlHrs%24}h`:dlHrs>0?`${dlHrs}h ${dlMins}m`:`${dlMins}m`;
      const urgC   = dlHrs<2?"var(--red-fg)":dlHrs<12?"var(--amber-fg)":"var(--green-fg)";
      dlHtml = `<div class="gw-db-section" style="flex:0;min-width:120px;text-align:right">
        <div class="gw-db-label">Deadline</div>
        <div class="gw-db-main" style="color:${urgC};font-size:18px">${dlStr}</div>
        <div class="gw-db-sub">GW${meta.current_gw} closes</div>
      </div>`;
    }
  }

  const sections = [capHtml, actionHtml ? '<div class="gw-db-divider"></div>'+actionHtml : '', injHtml ? '<div class="gw-db-divider"></div>'+injHtml : '', dlHtml ? '<div class="gw-db-divider"></div>'+dlHtml : ''].filter(Boolean).join("");
  if (!sections) return "";

  return `<div class="gw-decision-banner">${sections}</div>`;
}



// ── My Team / Pitch ────────────────────────────────────────────

function playerCard(p, dim=false) {
  const fix1  = p.fixes?.[0];
  const fdrC  = fix1 ? FDR_C[fix1.fdr]||"#888" : "#888";
  const nFix  = fix1 ? `${fix1.opp} (${fix1.home?"H":"A"})` : "TBC";
  const cap   = p.multiplier===2 ? `<div class="cap-dot">C</div>` : p.multiplier===3 ? `<div class="cap-dot tc">TC</div>` : "";
  const inj   = p.news ? `<div class="inj-dot" title="${p.news}">⚠️</div>` : "";
  const pArr  = p.price_rising ? `<div class="price-badge">↑</div>` : p.price_falling ? `<div class="price-badge" style="color:var(--red-fg)">↓</div>` : "";

  // Form trend arrow on card
  const tLbl = p.form_trend_label || "→";
  const tC   = tLbl.startsWith("↑") ? "#1a8a26" : tLbl.startsWith("↓") ? "#a3182a" : "var(--text3)";
  const trendEl = (p.starts >= 5 && tLbl !== "→")
    ? `<span style="font-size:10px;color:${tC};margin-left:3px">${tLbl}</span>` : "";
  const rotEl = p.rotation_risk
    ? `<div style="font-size:9px;color:var(--amber);margin-top:1px"
        title="${p.rotation_risk_label||''}">🔄 rotation risk</div>` : "";

  return `<div class="pcard${dim?" dim":""}" data-pid="${p.id}" style="cursor:pointer">
    ${cap}${inj}${pArr}
    <img src="${p.shirt}" onerror="this.style.display='none'" alt="">
    <div class="pname">${p.name}</div>
    <div class="pteam">${p.team_name} · £${p.price}m</div>
    <div class="pform">${p.form}${trendEl}</div>
    <div class="pform-lbl">form</div>
    <div class="fdr-row">${fdrSq(p.fixes,3)}</div>
    <div style="font-size:9px;color:${fdrC};margin-top:2px">${nFix}</div>
    ${dgwBadge(p)}
    ${p.availability < 1 && p.availability > 0 ? `<div style="font-size:9px;color:var(--amber);margin-top:1px">${Math.round(p.availability*100)}% avail.</div>` : ""}
    ${rotEl}
  </div>`;
}

function pitchRow(players, label) {
  return `<div class="pitch-row">
    <div class="pitch-row-label">${label}</div>
    <div class="pitch-players">${players.map(p=>playerCard(p)).join("")}</div>
  </div>`;
}

function renderMyTeam(squad, dgwSummary, allPlayers, meta) {
  const starters = squad.filter(p=>!p.is_sub).sort((a,b)=>a.pick_pos-b.pick_pos);
  const subs     = squad.filter(p=> p.is_sub).sort((a,b)=>a.pick_pos-b.pick_pos);
  const gkp  = starters.filter(p=>p.pos==="GKP");
  const defs = starters.filter(p=>p.pos==="DEF");
  const mids = starters.filter(p=>p.pos==="MID");
  const fwds = starters.filter(p=>p.pos==="FWD");

  // ── Suggested captain ──────────────────────────────────────────
  // Score each outfield starter: composite × fixture ease × DGW bonus
  const capCandidates = starters
    .filter(p => p.pos !== "GKP")
    .map(p => {
      const xgiScore  = p.has_xg && p.starts >= 5 ? Math.min((p.xgi90||0)/1.5,1) : 0;
      const formScore = Math.min((p.form||0)/12, 1);
      const atkScore  = xgiScore * 0.6 + formScore * 0.4;
      const fix1      = p.fixes?.[0];
      const fdrMod    = fix1 ? 1.0 + ((6 - fix1.fdr) / 5) * 0.15 : 1.0;
      const dgwMod    = p.is_dgw_imminent ? 1.20 : p.has_dgw_next ? 1.08 : 1.0;
      const injMod    = p.availability || 1.0;
      const posMod    = p.pos === "FWD" ? 1.05 : p.pos === "MID" ? 1.0 : 0.75;
      // Team attacking quality — penalises players on weak attacking teams
      const teamXgPg  = p.team_xg_pg || 1.3;
      const teamAtkMod = Math.max(0.85, Math.min(1.15, teamXgPg / 1.3));
      const score     = atkScore * fdrMod * dgwMod * injMod * posMod * teamAtkMod;
      return { ...p, capScore: Math.round(score * 100) };
    })
    .sort((a,b) => b.capScore - a.capScore);

  const capPick  = capCandidates[0];
  const vcPick   = capCandidates[1];
  const capFix   = capPick?.fixes?.[0];
  const capReason = capPick ? [
    `Score ${capPick.composite}`,
    capFix ? `vs ${capFix.opp} (${capFix.home?"H":"A"}) FDR${capFix.fdr}` : "",
    capPick.is_dgw_imminent ? "DGW 🔥" : capPick.has_dgw_next ? `DGW GW${capPick.dgw_next_gw} ⚡` : "",
    capPick.xgi90 ? `xGI/90: ${capPick.xgi90.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ") : "";

  const capBanner = capPick ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="flex:1;min-width:200px;background:var(--surface);border:1px solid var(--border);
        border-radius:0;padding:10px 14px;border-left:4px solid #0c6e6e">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:3px">Suggested captain</div>
        <div style="font-size:15px;font-weight:800">${capPick.name}
          ${dgwBadge(capPick)}
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">${capReason}</div>
      </div>
      ${vcPick ? `<div style="flex:1;min-width:200px;background:var(--surface);
        border:1px solid var(--border);border-radius:0;padding:10px 14px;
        border-left:4px solid var(--border2)">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:3px">Vice captain</div>
        <div style="font-size:15px;font-weight:800">${vcPick.name}
          ${dgwBadge(vcPick)}
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">Score ${vcPick.composite}
          ${vcPick.fixes?.[0]?` · vs ${vcPick.fixes[0].opp} FDR${vcPick.fixes[0].fdr}`:""}
        </div>
      </div>` : ""}
    </div>` : "";

  // ── Suggested formation ────────────────────────────────────────
  // Try all valid FPL formations and pick the one with highest total composite
  const FORMATIONS = [
    [3,4,3],[3,5,2],[4,3,3],[4,4,2],[4,5,1],[5,2,3],[5,3,2],[5,4,1]
  ];
  const allOutfield = starters.filter(p=>p.pos!=="GKP")
    .sort((a,b)=>b.composite-a.composite);
  const defPool = allOutfield.filter(p=>p.pos==="DEF");
  const midPool = allOutfield.filter(p=>p.pos==="MID");
  const fwdPool = allOutfield.filter(p=>p.pos==="FWD");

  let bestFormation = null, bestScore = -1;
  for (const [nd,nm,nf] of FORMATIONS) {
    if (defPool.length<nd || midPool.length<nm || fwdPool.length<nf) continue;
    const score = [...defPool.slice(0,nd),...midPool.slice(0,nm),...fwdPool.slice(0,nf)]
      .reduce((s,p)=>s+p.composite,0);
    if (score > bestScore) { bestScore=score; bestFormation=[nd,nm,nf]; }
  }
  const [snd,snm,snf] = bestFormation || [defs.length,mids.length,fwds.length];
  const currentForm = `${defs.length}-${mids.length}-${fwds.length}`;
  const suggestedForm = `${snd}-${snm}-${snf}`;
  const formChanged = currentForm !== suggestedForm;

  const formBanner = formChanged ? `
    <div style="background:var(--amber-bg);border:1px solid #e8c840;border-radius:0;
      padding:8px 14px;margin-bottom:12px;font-size:12px;color:var(--amber-fg)">
      💡 Suggested formation: <strong>${suggestedForm}</strong>
      (current: ${currentForm}) — based on highest composite scorers in each position
    </div>` : "";

  // ── Bench auto-select suggestion ──────────────────────────────────────
  // Score each outfield bench player on likelihood of coming on:
  // availability × playing_time_norm × fixture_ease (inverted FDR)
  const benchGkp      = subs.find(p => p.pos === "GKP");
  const benchOutfield = subs.filter(p => p.pos !== "GKP")
    .sort((a,b) => a.pick_pos - b.pick_pos);

  const scoredBench = benchOutfield.map(p => {
    const avail   = p.availability || 1;
    const ptNorm  = p.playing_time_norm || 0;
    const fix1    = p.fixes?.[0];
    const fdrEase = fix1 ? (6 - fix1.fdr) / 5 : 0.5;
    const dgwBonus = p.has_dgw_next ? 0.1 : 0;
    const score   = avail * (ptNorm * 0.55 + fdrEase * 0.35 + dgwBonus);
    return { ...p, benchScore: Math.round(score * 100) };
  }).sort((a,b) => b.benchScore - a.benchScore);

  // Compare optimal order vs current pick_pos order
  const currentOrder  = benchOutfield.map(p => p.id);
  const optimalOrder  = scoredBench.map(p => p.id);
  const benchMismatch = currentOrder.some((id,i) => id !== optimalOrder[i]);

  const benchBanner = benchMismatch ? (() => {
    const rows = scoredBench.map((p, i) => {
      const currentSlot = benchOutfield.findIndex(b => b.id === p.id) + 1;
      const changed = currentSlot !== i + 1;
      const injNote = p.chance != null && p.chance < 100
        ? `<span style="color:var(--amber);font-size:10px"> ⚠${p.chance}%</span>` : "";
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;
        border-bottom:1px solid var(--border);font-size:12px">
        <span style="font-size:13px;font-weight:800;color:var(--blue-fg);min-width:16px">${i+1}</span>
        <span style="flex:1;font-weight:${changed?"700":"400"}">${p.name}${injNote}</span>
        <span style="font-size:10px;color:var(--text3)">${p.team_name} · ${p.pos}</span>
        <span style="font-size:10px;color:var(--text2);min-width:30px;text-align:right">${p.benchScore}</span>
        ${changed ? `<span style="font-size:9px;color:var(--amber)">(was ${currentSlot})</span>` : `<span style="font-size:9px;color:var(--text3)">✓</span>`}
      </div>`;
    }).join("");
    return `<div style="background:var(--blue-bg);border:1px solid var(--border);
      border-radius:0;padding:10px 14px;margin-bottom:12px">
      <div style="font-size:10px;font-weight:700;color:var(--blue-fg);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:8px">💺 Suggested bench order</div>
      ${rows}
      <div style="font-size:10px;color:var(--text3);margin-top:6px">
        Scored on: playing time reliability (55%) · fixture ease (35%) · DGW bonus (10%) · availability</div>
    </div>`;
  })() : "";


  // ── DGW planning card ─────────────────────────────────────────
  const dgwEntries = Object.entries(dgwSummary||{})
    .filter(([,teams]) => teams.length > 0)
    .sort(([a],[b]) => parseInt(a)-parseInt(b));

  const dgwCard = dgwEntries.length ? (() => {
    const curGw = meta?.current_gw || 0;
    return dgwEntries.map(([gw, teams]) => {
      const gwNum   = parseInt(gw);
      const gwsAway = gwNum - curGw;
      const urgency = gwsAway === 0 ? "🔥" : gwsAway === 1 ? "⚡" : "📅";
      const gwLbl   = gwsAway === 0 ? "This GW" : gwsAway === 1 ? "Next GW" : `GW${gw} (${gwsAway} away)`;
      const myDgw   = starters.filter(p => teams.includes(p.team_name));
      const myIds   = new Set(squad.map(p=>p.id));
      const targets = (allPlayers||[])
        .filter(p => teams.includes(p.team_name) && !myIds.has(p.id)
                  && p.status==="a" && (p.chance==null||p.chance>=75) && p.starts>=5)
        .sort((a,b)=>b.composite-a.composite).slice(0,5);

      return `<div style="background:var(--purple-bg);border:1px solid var(--border);border-left:3px solid var(--purple-fg);
        border-radius:0;padding:7px 12px;margin-bottom:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px">${urgency}</span>
        <div style="flex:1;min-width:0">
          <span style="font-size:11px;font-weight:800;color:var(--purple-fg)">${gwLbl} DGW · </span>
          <span style="font-size:11px;color:var(--text2)">${teams.join(", ")}</span>
          ${myDgw.length ? `<span style="font-size:10px;color:var(--text3);margin-left:6px">· Yours: <strong>${myDgw.map(p=>p.name).join(", ")}</strong></span>` : ""}
        </div>
        ${targets.length ? `<div style="font-size:10px;color:var(--text3)">Targets: ${targets.slice(0,3).map(p=>`<strong style="color:var(--text2)">${p.name}</strong> £${p.price}m`).join(" · ")}</div>` : ""}
      </div>`;
    }).join("");
  })() : "";

  // ── Build side info panel ─────────────────────────────────────
  // Captain card
  const sideCapFix = capPick?.fixes?.[0];
  const sideCapCard = capPick ? `
    <div class="tsp-card" style="border-left:3px solid #0c6e6e">
      <div class="tsp-title">Suggested captain</div>
      <div class="tsp-cap-name">${capPick.name} ${dgwBadge(capPick)}</div>
      <div class="tsp-cap-meta">${sideCapFix ? `vs ${sideCapFix.opp} (${sideCapFix.home?"H":"A"}) · FDR ${sideCapFix.fdr}` : "TBC"}</div>
      <div class="tsp-cap-score">xGI/90: ${capPick.xgi90 ? capPick.xgi90.toFixed(2) : "—"} · Score: ${capPick.composite}</div>
      ${vcPick ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;color:var(--text3)">VC: <strong style="color:var(--text2)">${vcPick.name}</strong>${vcPick.fixes?.[0]?' · vs '+vcPick.fixes[0].opp:''}</div>` : ""}
    </div>` : "";

  // Top transfer card
  const allOpts = (_state.transfers||[]).flatMap(g=>g.options.map(o=>({...o,outName:g.out.name})));
  allOpts.sort((a,b)=>b.gain-a.gain);
  const topTransfers = allOpts.slice(0,3);
  const sideTransferCard = topTransfers.length ? `
    <div class="tsp-card">
      <div class="tsp-title">Top transfers</div>
      ${topTransfers.map(o=>`
        <div class="tsp-transfer-row">
          <div>
            <span style="color:var(--text3);text-decoration:line-through;font-size:11px">${o.outName}</span>
            <span style="margin:0 4px;color:var(--text3)">→</span>
            <strong>${o.in.name}</strong>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge ${VERDICT_CLS[o.verdict]||'badge-gray'}">${o.verdict}</span>
            <span style="font-size:11px;color:var(--green-fg);font-weight:700">+${o.gain}</span>
          </div>
        </div>`).join("")}
    </div>` : "";

  // Injury / availability card
  const injuredPlayers = starters.filter(p => p.news || (p.chance != null && p.chance < 100));
  const sideInjCard = injuredPlayers.length ? `
    <div class="tsp-card" style="border-left:3px solid var(--amber)">
      <div class="tsp-title">⚠ Fitness alerts</div>
      ${injuredPlayers.map(p=>`
        <div class="tsp-injury-row">
          <span style="font-weight:700;flex:1">${p.name}</span>
          <span style="font-size:10px;color:var(--amber-fg)">${p.chance!=null?p.chance+'%':''}</span>
          ${p.news ? `<span style="font-size:10px;color:var(--text3);max-width:120px;text-align:right">${p.news.slice(0,40)}${p.news.length>40?'…':''}</span>` : ''}
        </div>`).join("")}
    </div>` : "";

  // Squad stats card
  const totalComp = starters.reduce((s,p)=>s+p.composite,0);
  const avgForm   = (starters.reduce((s,p)=>s+(p.form||0),0)/starters.length).toFixed(1);
  const sideStatsCard = `
    <div class="tsp-card">
      <div class="tsp-title">Squad stats</div>
      <div class="tsp-stat-row"><span style="color:var(--text3)">Formation</span><strong>${currentForm}</strong></div>
      <div class="tsp-stat-row"><span style="color:var(--text3)">Total score</span><strong>${totalComp}</strong></div>
      <div class="tsp-stat-row"><span style="color:var(--text3)">Avg form</span><strong>${avgForm}</strong></div>
      <div class="tsp-stat-row"><span style="color:var(--text3)">Squad value</span><strong>£${(meta.squad_value||0).toFixed(1)}m</strong></div>
      <div class="tsp-stat-row"><span style="color:var(--text3)">Bank</span><strong>£${(meta.bank||0).toFixed(1)}m</strong></div>
    </div>`;

  el("tab-myteam").innerHTML = `
    ${buildGwDecisionBanner(_state, meta)}
    ${dgwCard}
    ${formBanner}
    <div class="myteam-layout">
      <div class="myteam-left">
        <div style="text-align:center;margin-bottom:6px">
          <span style="background:rgba(0,0,0,.6);color:#fff;font-size:10px;font-weight:700;
            padding:2px 10px;border-radius:0;letter-spacing:.5px">${currentForm}</span>
        </div>
        <div class="pitch">
          ${pitchRow(fwds,"FORWARDS")}
          ${pitchRow(mids,"MIDFIELDERS")}
          ${pitchRow(defs,"DEFENDERS")}
          ${pitchRow(gkp,"GOALKEEPER")}
        </div>
        <div class="bench-strip">
          <div class="bench-strip-label">Bench</div>
          ${subs.map(p=>playerCard(p,true)).join("")}
        </div>
        ${benchBanner}
      </div>
      <div class="myteam-right">
        <div class="team-side-panel">
          ${sideCapCard}
          ${sideTransferCard}
          ${sideInjCard}
          ${sideStatsCard}
        </div>
      </div>
    </div>`;
}

function jumpToPlayer(pid, name) {
  // Switch to Analysis group > History tab
  const groups = window._TAB_GROUPS || [];
  for (const g of groups) {
    const found = g.tabs.find(([id]) => id === "history");
    if (found) {
      const gBtn = document.querySelector(`.tab-group-btn[data-gkey="${g.key}"]`);
      if (gBtn) switchTabGroup(g.key, gBtn);
      renderSubTabs(g.tabs, "history");
      switchTab("history");
      break;
    }
  }
  setTimeout(async () => {
    const sel = el("playerHistSel");
    if (sel) { sel.value = pid; await updatePlayerChart(); }
    const momSel = el("momSel");
    if (momSel) { momSel.value = pid; await updateMomChart(); }
  }, 80);
}

// ── Transfers ──────────────────────────────────────────────────

function renderTransfers(groups, combos, allPlayers, dgwSummary, meta) {

  // ── Price alerts panel ────────────────────────────────────────
  const rising  = (allPlayers||[]).filter(p => p.price_rising  && !p.price_change)
    .sort((a,b) => b.net_transfers - a.net_transfers).slice(0,8);
  const falling = (allPlayers||[]).filter(p => p.price_falling && !p.price_change)
    .sort((a,b) => a.net_transfers - b.net_transfers).slice(0,8);

  const priceAlerts = (rising.length || falling.length) ? `
    <div class="card" style="margin-bottom:1rem">
      <div class="chart-title" style="margin-bottom:.75rem">📈 Price Change Alerts</div>
      <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
        Players near a price change based on net transfer activity. Act before deadline.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div style="font-size:10px;font-weight:700;color:var(--green-fg);text-transform:uppercase;
            letter-spacing:.5px;margin-bottom:6px">📈 Rising soon</div>
          ${rising.map(p => `
            <div style="display:flex;align-items:center;gap:6px;padding:5px 0;
              border-bottom:1px solid var(--border);font-size:12px">
              <span style="flex:1;font-weight:600">${p.name}</span>
              <span style="color:var(--text3);font-size:11px">${p.pos} · ${p.team_name}</span>
              <span style="color:var(--green-fg);font-weight:700">£${p.price}m</span>
              ${wlStarBtn(p)}
            </div>`).join("") || `<div style="font-size:12px;color:var(--text3)">None detected</div>`}
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:var(--red-fg);text-transform:uppercase;
            letter-spacing:.5px;margin-bottom:6px">📉 Falling soon</div>
          ${falling.map(p => `
            <div style="display:flex;align-items:center;gap:6px;padding:5px 0;
              border-bottom:1px solid var(--border);font-size:12px">
              <span style="flex:1;font-weight:600">${p.name}</span>
              <span style="color:var(--text3);font-size:11px">${p.pos} · ${p.team_name}</span>
              <span style="color:var(--red-fg);font-weight:700">£${p.price}m</span>
              ${wlStarBtn(p)}
            </div>`).join("") || `<div style="font-size:12px;color:var(--text3)">None detected</div>`}
        </div>
      </div>
    </div>` : "";

  // ── Hit calculator ────────────────────────────────────────────
  const hitCalc = `
    <div class="card" style="margin-bottom:1rem">
      <div class="chart-title" style="margin-bottom:.5rem">🧮 Should I Take a Hit?</div>
      <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
        Estimate how many GWs until your transfer pays off.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
            letter-spacing:.5px;margin-bottom:4px">Hits taken</div>
          <select id="hitCount" onchange="calcHit()"
            style="padding:7px 10px;border:1px solid var(--border);border-radius:0;
            background:var(--surface);color:var(--text);font-size:13px;font-family:var(--font)">
            <option value="1">1 hit (-4pts)</option>
            <option value="2">2 hits (-8pts)</option>
            <option value="3">3 hits (-12pts)</option>
          </select>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
            letter-spacing:.5px;margin-bottom:4px">Expected pts gain/GW</div>
          <input id="hitGainPerGw" type="number" step="0.5" min="0" max="20" value="2.5"
            onchange="calcHit()" oninput="calcHit()"
            style="width:100px;padding:7px 10px;border:1px solid var(--border);border-radius:0;
            background:var(--surface);color:var(--text);font-size:13px;font-family:var(--font)">
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
            letter-spacing:.5px;margin-bottom:4px">GWs of benefit</div>
          <input id="hitGwsBenefit" type="number" step="1" min="1" max="20" value="5"
            onchange="calcHit()" oninput="calcHit()"
            style="width:80px;padding:7px 10px;border:1px solid var(--border);border-radius:0;
            background:var(--surface);color:var(--text);font-size:13px;font-family:var(--font)">
        </div>
      </div>
      <div id="hitResult" style="margin-top:.75rem"></div>
    </div>`;

  const bar = `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;
    padding:11px 14px;background:var(--surface2);border-radius:0;
    border:1px solid var(--border);font-size:13px;margin-bottom:1.25rem">
    <span>Bank: <strong>£${meta.bank.toFixed(1)}m</strong></span>
    <span style="color:${meta.free_transfers>0?"var(--green)":"var(--red)"}">
      Free transfers: <strong>${meta.free_transfers}</strong></span>
    <span style="color:var(--text3);font-size:12px">
      wFDR weights: GW+1 35% · GW+2 25% · GW+3 20% · GW+4 12% · GW+5 8%</span>
  </div>`;

  const byPos = {DEF:[],MID:[],FWD:[]};
  groups.forEach(g => { if(byPos[g.pos]) byPos[g.pos].push(g); });
  const posIds = {DEF:"tdef",MID:"tmid",FWD:"tfwd"};

  let ptabs = `<div class="pos-tabs" id="transPT">`;
  let panels = "";
  let first = true;

  // DGW filter tab — only if a DGW is coming
  const allDgwTeams = Object.values(dgwSummary||{}).flat();
  const dgwGroups = groups.filter(g =>
    g.options.some(o => o.in?.has_dgw_next || allDgwTeams.includes(o.in?.team_name))
  );
  if (dgwGroups.length > 0) {
    const dgwDgwGw = Object.entries(dgwSummary||{})
      .filter(([,t])=>t.length>0).sort(([a],[b])=>parseInt(a)-parseInt(b))[0];
    const dgwLabel = dgwDgwGw ? `GW${dgwDgwGw[0]} DGW` : "DGW";
    ptabs += `<button class="pos-tab active" style="background:var(--purple-bg);color:var(--purple-fg)"
      onclick="switchTransPos('trans-dgw',this)">
      🔥 ${dgwLabel} targets <span style="opacity:.65;font-size:11px">(${dgwGroups.length})</span></button>`;
    const dgwInner = dgwGroups.map(g => {
      // Filter options to DGW players, fallback to all if none
      const dgwOpts = g.options.filter(o => o.in?.has_dgw_next || allDgwTeams.includes(o.in?.team_name));
      return renderGroup({...g, options: dgwOpts.length ? dgwOpts : g.options});
    }).join("");
    panels += `<div id="trans-dgw">${dgwInner}</div>`;
    first = false;
  }

  for (const pos of ["DEF","MID","FWD"]) {
    const np = byPos[pos].length;
    const no = byPos[pos].reduce((s,g)=>s+g.options.length,0);
    ptabs += `<button class="pos-tab${first?" active":""}"
      onclick="switchTransPos('${posIds[pos]}',this)">
      ${pos} <span style="opacity:.65;font-size:11px">(${np} players, ${no} options)</span></button>`;
    const inner = byPos[pos].map(renderGroup).join("") ||
      `<p style="color:var(--text3);font-size:13px;padding:1rem 0">No upgrades within budget.</p>`;
    panels += `<div id="trans-${posIds[pos]}" style="display:${first?"block":"none"}">${inner}</div>`;
    first = false;
  }
  ptabs += "</div>";

  const combosHtml = renderCombos(combos, meta);

  el("tab-transfers").innerHTML = `
    ${priceAlerts}
    ${hitCalc}
    <p style="font-size:12px;color:var(--text2);margin-bottom:.75rem;line-height:1.6">Model-driven transfer suggestions for your squad. <strong>Individual transfers</strong> ranks upgrade options for each of your players by composite gain and projected 3-GW points. <strong>Smart combinations</strong> shows multi-transfer packages. The 🔥 DGW tab (when active) filters to doubling players only.</p>
    <div class="pos-tabs">
      <button class="pos-tab active" onclick="switchTransSec('individual',this)">Individual transfers</button>
      <button class="pos-tab" onclick="switchTransSec('combos',this)">Smart combinations</button>
    </div>
    <div id="trans-sec-individual">${bar}${ptabs}${panels}</div>
    <div id="trans-sec-combos" style="display:none">${bar}${combosHtml}</div>`;
  calcHit();
}

function renderGroup(g) {
  const out    = g.out;
  const bColor = {Strong:"#1a8a26",Good:"#123a70","Consider hit":"#9c7a00",
                  "Risky hit":"#a3182a",Marginal:"#ccc"}[g.best_verdict]||"#ccc";
  const outDGW = out.has_dgw_next ? `<span class="badge badge-purple" style="font-size:9px">${out.is_dgw_imminent?"DGW 🔥":"DGW GW"+out.dgw_next_gw}</span> ` : "";
  const outInj = out.chance != null && out.chance < 100
    ? ` <span style="font-size:10px;color:var(--amber)">⚠ ${out.chance}%</span>` : "";

  const optRows = g.options.map((opt,i) => {
    const inp    = opt.in;
    const fdrC   = FDR_C[opt.next_fdr]||"#888";
    const vCls   = VERDICT_CLS[opt.verdict]||"badge-gray";
    const inDGW  = inp.has_dgw_next ? ` <span class="badge badge-purple" style="font-size:9px">${inp.is_dgw_imminent?"DGW 🔥":"DGW GW"+inp.dgw_next_gw}</span>` : "";
    const inInj  = inp.chance != null && inp.chance < 100
      ? ` <span style="font-size:10px;color:var(--amber)">⚠${inp.chance}%</span>` : "";
    const avail  = inp.availability < 1
      ? `<div style="font-size:10px;color:var(--amber);margin-top:2px">${Math.round(inp.availability*100)}% chance of playing</div>` : "";

    let costHtml;
    if (opt.uses_free) {
      costHtml = badge("green","Free transfer");
    } else {
      const beC = opt.hit_worth?"var(--green-fg)":"var(--red-fg)";
      const beLbl = opt.breakeven ? `BE ~${opt.breakeven} GWs` : "large hit";
      costHtml = `${badge("red","−4pt hit")} <span style="font-size:11px;color:${beC};margin-left:4px">${beLbl}</span>`;
    }
    const bankNote = opt.bank_used > 0
      ? `<span style="font-size:11px;color:var(--amber)">£${opt.bank_used.toFixed(1)}m bank · £${opt.remaining_bank.toFixed(1)}m left</span>` : "";

    return `<div class="t-opt">
      <div style="flex:1;min-width:130px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px">
          <span class="t-in-name">${inp.name}</span>${inDGW}${inInj}
          ${wlStarBtn(inp)}
          ${badge(vCls, opt.verdict)}
          <span style="font-size:12px;font-weight:700;color:var(--text2)">+${opt.gain}</span>
        </div>
        <div class="t-in-meta">${inp.team_name} · £${inp.price}m · Form ${inp.form} · wFDR ${inp.wfdr}${inp.near_fdr != null ? ` · <span title="Near-term fixture difficulty (GW+1 60%, GW+2 40%) — lower is easier" style="color:${inp.near_fdr<=2?"var(--green-fg)":inp.near_fdr>=4?"var(--red-fg)":"var(--text2)"}">NF ${inp.near_fdr}</span>` : ""}</div>
        <div class="fdr-row" style="justify-content:flex-start;margin-bottom:4px">${fdrSq(opt.in_fixes,5)}</div>
        <div class="t-snippet">${opt.snippet}</div>
        ${avail}
        ${opt.in_proj_gws ? projMiniBar(opt) : ""}
        ${opt.timing_verdict ? (() => {
          const tv = opt.timing_verdict;
          const isAct  = tv.startsWith("Act now");
          const isHold = tv.startsWith("Consider holding");
          const bg  = isAct  ? "var(--green-bg)"  : isHold ? "var(--amber-bg)"  : "var(--surface2)";
          const c   = isAct  ? "var(--green-fg)"  : isHold ? "var(--amber-fg)"  : "var(--text2)";
          const ico = isAct  ? "⚡" : isHold ? "⏸" : "→";
          return `<div style="margin-top:6px;padding:6px 10px;background:${bg};
            border-radius:0;font-size:11px;color:${c};font-weight:600">
            ${ico} ${tv}</div>`;
        })() : ""}
      </div>
      <div style="flex-shrink:0;text-align:right;padding-top:2px">
        <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          ${costHtml}${bankNote}
        </div>
        <div style="font-size:11px;color:${fdrC};margin-top:4px">Next: ${opt.next_fix}</div>
      </div>
    </div>`;
  }).join("");

  return `<div class="t-group" style="border-left:4px solid ${bColor}">
    <div class="t-header">
      <div style="flex:1">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">
          Transfer out · ${out.pos}</div>
        <div class="t-out-name" data-pid="${out.id}" style="cursor:pointer">${out.name} ${outDGW}${outInj}</div>
        <div class="t-out-meta">${out.team_name} · £${out.price}m · Form ${out.form} · wFDR ${out.wfdr}</div>
        <div class="fdr-row" style="justify-content:flex-start;margin-top:6px">${fdrSq(g.out_fixes,5)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;color:var(--text3)">${g.options.length} alternative${g.options.length>1?"s":""}</div>
        <div style="font-size:11px;color:var(--text2);margin-top:3px">Best: <strong>${g.options[0].in.name}</strong></div>
      </div>
    </div>
    ${g.out_regression_alert ? `
    <div style="margin:0 16px 0;padding:8px 12px;background:var(--amber-bg);
      border-bottom:1px solid #e8c840;font-size:12px;color:var(--amber-fg);
      display:flex;align-items:center;gap:6px">
      <span>📉</span> <span>${g.out_regression_alert}</span>
    </div>` : ""}
    <div class="t-options">${optRows}</div>
  </div>`;
}

function renderCombos(combos, meta) {
  const {singles, doubles, triples, quads} = combos;
  if (!singles.length && !doubles.length && !(triples||[]).length && !(quads||[]).length)
    return `<p style="color:var(--text3);padding:1rem 0">No combinations found within budget.</p>`;

  function mvCard(m) {
    const inp = m.in;
    return `<div style="flex:1;min-width:150px;background:var(--surface2);border-radius:0;
        border:1px solid var(--border);padding:10px 12px">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:3px">Out → In</div>
      <div style="font-size:12px;color:var(--text2);text-decoration:line-through" data-pid="${m.out.id}" style="cursor:pointer">${m.out.name} £${m.out.price}m</div>
      <div data-pid="${inp.id}" style="font-size:14px;font-weight:700;cursor:pointer">${inp.name} £${inp.price}m</div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">${inp.team_name} · Form ${inp.form} · wFDR ${inp.wfdr}</div>
      <div class="fdr-row" style="justify-content:flex-start;margin-top:4px">${fdrSq(inp.fixes||[],3)}</div>
    </div>`;
  }

  function comboCard(c) {
    const netProj = c.net_proj ?? c.net_gain;
    const bC  = netProj>=6?"#1a8a26":netProj>=3?"#123a70":"#9c7a00";
    const bCls= netProj>=6?"badge-green":netProj>=3?"badge-blue":"badge-amber";
    const costStr = c.hit_pts===0
      ? `Uses ${c.type==="double"?2:1} free transfer${c.type==="double"?"s":""}`
      : `−${c.hit_pts}pt hit`;
    const costC = c.hit_pts===0 ? "var(--green)" : "var(--red)";
    const syn = c.synergy
      ? `<div style="margin-top:8px;padding:8px 10px;background:var(--blue-bg);
          border-left:3px solid var(--blue);border-radius:0 6px 6px 0;font-size:11px;color:var(--blue-fg)">
          ⚡ Selling ${c.moves[0].out.name} frees £${c.freed_by_m1?.toFixed(1)}m, unlocking ${c.moves[1].in.name}</div>` : "";
    const dgwNote = c.both_dgw
      ? `<div style="margin-top:6px;padding:6px 10px;background:var(--purple-bg);
          border-radius:0;font-size:11px;color:var(--purple-fg)">🔥 Both incoming players have a DGW</div>` : "";
    const bankStr = c.type==="double"
      ? `£${meta.bank.toFixed(1)}m → £${c.bank_mid?.toFixed(1)}m → £${c.bank_after?.toFixed(1)}m bank`
      : `£${meta.bank.toFixed(1)}m → £${c.bank_after?.toFixed(1)}m bank`;
    const projStr = c.proj_gain != null
      ? `<span style="font-size:12px;color:var(--text2)">+${netProj} pts next 3 GWs</span>` : "";

    const typeLabel = {double:"2 transfers",triple:"3 transfers",quad:"4 transfers"}[c.type] || `${c.n} transfers`;
    const riskBadge = c.hits > 0
      ? `<span class="badge badge-red" style="font-size:9px">${c.risk} ⚠ Higher risk</span>`
      : "";

    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:0;
        margin-bottom:14px;overflow:hidden;border-left:4px solid ${bC}">
      <div style="background:var(--surface2);border-bottom:1px solid var(--border);
          padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        ${badge(bCls, typeLabel)}
        ${riskBadge}
        <span style="font-size:13px;font-weight:700">+${c.gain} composite</span>
        ${projStr}
        <span style="margin-left:auto;font-size:12px;color:${costC}">${costStr}</span>
      </div>
      <div style="padding:14px 16px">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${c.moves.map((m,i)=>mvCard(m)+(i<c.moves.length-1?`<div style="display:flex;align-items:center;font-size:18px;color:var(--border2)">+</div>`:"")).join("")}
        </div>
        ${syn}${dgwNote}
        <div style="margin-top:8px;font-size:11px;color:var(--text3)">${bankStr}</div>
      </div>
    </div>`;
  }

  let html = `<p style="font-size:12px;color:var(--text2);margin-bottom:1.25rem;line-height:1.7">
    Sorted by projected 3-GW points gain. Best move shown first within each combo.
    Triples and quads are higher risk — each hit beyond free transfers costs 4pts.</p>`;
  if ((quads||[]).length) {
    html += `<div style="font-size:13px;font-weight:700;margin-bottom:6px">Quad transfers
      <span class="badge badge-red" style="font-size:10px;margin-left:6px">High risk</span></div>`;
    html += quads.map(comboCard).join("");
  }
  if ((triples||[]).length) {
    html += `<div style="font-size:13px;font-weight:700;margin:${(quads||[]).length?"16px":"0"} 0 6px">Triple transfers
      <span class="badge badge-amber" style="font-size:10px;margin-left:6px">Elevated risk</span></div>`;
    html += triples.map(comboCard).join("");
  }
  if (doubles.length) {
    html += `<div style="font-size:13px;font-weight:700;margin:${(triples||[]).length||(quads||[]).length?"16px":"0"} 0 6px">Double transfers</div>`;
    html += doubles.map(comboCard).join("");
  }
  if (singles.length) {
    html += `<div style="font-size:13px;font-weight:700;margin:${doubles.length?"16px":"0"} 0 6px">Single transfers</div>`;
    html += singles.map(comboCard).join("");
  }
  return html;
}

// ── Rankings ───────────────────────────────────────────────────

let _rankDgwGw    = null;
let _rankDgwTeams = [];

function renderRankings(players, dgwSummary) {
  dgwSummary = dgwSummary || {};
  // Find nearest upcoming DGW — stored in module scope for drawRankTable
  const dgwEntries = Object.entries(dgwSummary)
    .filter(([,t])=>t.length>0).sort(([a],[b])=>parseInt(a)-parseInt(b));
  _rankDgwGw    = dgwEntries.length ? parseInt(dgwEntries[0][0]) : null;
  _rankDgwTeams = dgwEntries.length ? dgwEntries[0][1] : [];
  const dgwSortBtn = _rankDgwGw ? `
    <button class="pos-tab" onclick="sortRankings('dgw_proj')"
      style="margin-left:auto;background:var(--purple-bg);color:var(--purple-fg);border-color:var(--purple-fg)">
      🔥 Sort by GW${_rankDgwGw} DGW proj</button>` : "";
  el("tab-rankings").innerHTML = `
    <p style="font-size:12px;color:var(--text2);margin-bottom:.5rem;line-height:1.6">Ranks all players by composite score — a weighted blend of xGI/90 (primary), form, fixture ease and playing time. Sort any column by clicking the header. Filter by position. Click <strong>vs</strong> to compare two players. ☆ adds to Watchlist.</p>
    <div class="pos-tabs" id="rankPT" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
      ${[["ALL","All"],["GKP","GK"],["DEF","DEF"],["MID","MID"],["FWD","FWD"]]
        .map(([pos,lbl],i)=>`<button class="pos-tab${i===0?" active":""}"
          onclick="setRankPos('${pos}',this)">${lbl}</button>`).join("")}
      ${dgwSortBtn}
    </div>
    <div id="rankTable" style="overflow-x:auto;overflow-y:auto;max-height:72vh;border-radius:0"></div>`;
  drawRankTable(players);
}

function setRankPos(pos, btn) {
  _rankPos = pos;
  document.querySelectorAll("#rankPT .pos-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  drawRankTable(_state.all_players);
}

function sortRankings(key) {
  // near_fdr sorts ascending by default (lower = easier = better)
  const ascendingKeys = ["wfdr","near_fdr","price"];
  if (_rankSort.key === key) {
    _rankSort.dir *= -1;
  } else {
    _rankSort.dir = ascendingKeys.includes(key) ? 1 : -1;
  }
  _rankSort.key = key;
  drawRankTable(_state.all_players);
}

function drawRankTable(players) {
  let rows = players.filter(p => _rankPos==="ALL" || p.pos===_rankPos);

  // Special sort: dgw_proj — sort by projected pts in the DGW GW
  if (_rankSort.key === "dgw_proj" && _rankDgwGw) {
    rows.sort((a,b) => {
      const aProj = (a.projections||[]).find(x=>x.gw===_rankDgwGw)?.proj || 0;
      const bProj = (b.projections||[]).find(x=>x.gw===_rankDgwGw)?.proj || 0;
      return bProj - aProj;
    });
  } else {
    rows.sort((a,b) => _rankSort.dir * ((b[_rankSort.key]||0) - (a[_rankSort.key]||0)));
  }
  rows = rows.slice(0, 30);

  const showDef = ["ALL","GKP","DEF","MID"].includes(_rankPos);
  const showCS  = ["ALL","GKP","DEF","MID"].includes(_rankPos);

  function th(key, label, tip) {
    const on = _rankSort.key===key;
    const arr = on ? (_rankSort.dir>0?"↑":"↓") : "↕";
    const lbl = tip ? ttip(label, tip) : label;
    return `<th onclick="sortRankings('${key}')">${lbl}<span class="sort-arrow${on?" on":""}">${arr}</span></th>`;
  }

  let html = `<table class="data-table"><thead><tr>
    <th>#</th>
    <th>Player</th>
    ${th("form","Form","FPL's rolling 5-game form average")}
    ${th("xgi90","xGI/90","Expected goal involvements per 90 minutes (FPL native data). Measures underlying attacking contribution regardless of actual returns.")}
    ${showDef ? th("bps_per_game","BPS/g","FPL Bonus Points System per game started. Aggregates tackles, clearances, blocks, interceptions and recoveries. DEF threshold: 10/g, MID: 12/g.") : ""}
    ${showCS  ? th("cs_prob","xCS","Expected clean sheet probability based on the team's xGC/90 (expected goals conceded per 90). GKP/DEF = 6pts for a clean sheet, MID = 1pt.") : ""}
    ${th("value","Value","Total season points divided by current price (pts/£m)")}
    <th>Price</th>
    ${th("playing_time_norm","Mins","Minutes reliability — combines starts reliability (65%) and minutes per start (35%). Penalises sub-heavy players. January signings use a neutral prior until 5 starts.")}
    <th>Next 5 GWs</th>
    ${th("wfdr","wFDR","Weighted Fixture Difficulty — next 5 GWs weighted GW+1 35%, GW+2 25%, GW+3 20%, GW+4 12%, GW+5 8%. Lower = easier run.")}
    ${th("near_fdr","NF","Near-term Fixture Difficulty — GW+1 (60%) and GW+2 (40%) only. More actionable for immediate transfer decisions. Lower = easier.")}
    ${th("composite","Score","Composite score 0–100. Position-aware weighting across form, xGI/90, value, fixture ease, minutes reliability, BPS, and expected clean sheets. Discounted for injury risk and DGW-boosted.")}
    ${_rankDgwGw ? `<th title="Projected points in GW${_rankDgwGw} double gameweek — double fixture scored at 85% for second game">DGW${_rankDgwGw} proj</th>` : ""}
    ${th("differential_score","Diff","Composite score adjusted for ownership. High score + low ownership = strong differential pick. Formula: composite × (1 − ownership%)^0.4")}
    ${_rankDgwGw ? `<th title="Has a fixture in GW${_rankDgwGw} double gameweek (${_rankDgwTeams.join(', ')})">DGW${_rankDgwGw}</th>` : ""}
    <th>Rec.</th>
    <th></th>
  </tr></thead><tbody>`;

  rows.forEach((p,i) => {
    const xgBadge = p.has_xg ? badge("blue","xG") + " " : "";
    const dgwB    = dgwBadge(p) ? dgwBadge(p) + " " : "";
    const injB    = p.chance!=null && p.chance<100
      ? `<span style="font-size:10px;color:var(--amber)">⚠${p.chance}%</span> ` : "";
    const priceArrow = p.price_rising ? `<span style="color:var(--green);font-size:11px" title="Price rise imminent">↑</span>`
                     : p.price_falling ? `<span style="color:var(--red);font-size:11px" title="Price fall likely">↓</span>` : "";

    // Form trend arrow
    const trendLbl = p.form_trend_label || "→";
    const trendC   = trendLbl.startsWith("↑") ? "var(--green-fg)"
                   : trendLbl.startsWith("↓") ? "var(--red-fg)" : "var(--text3)";
    const trendTip = trendLbl==="↑↑" ? "Strongly accelerating — form well above season avg"
                   : trendLbl==="↑"  ? "Rising — form above season avg"
                   : trendLbl==="↓↓" ? "Declining badly — form well below season avg"
                   : trendLbl==="↓"  ? "Cooling — form below season avg"
                   : "Stable — form in line with season avg";
    const trendArrow = p.starts >= 5
      ? `<span style="font-size:11px;color:${trendC}" title="${trendTip}">${trendLbl}</span>`
      : "";
    const rotBadge = p.rotation_risk
      ? `<span style="font-size:9px;color:var(--amber);margin-left:2px"
          title="${p.rotation_risk_label||'Rotation risk'}">🔄</span>` : "";

    // xGI bar
    const xgCell = (() => {
      if (!p.xgi90) return `<td><span style="color:var(--text3);font-size:11px">—</span></td>`;
      const pct = Math.min(p.xgi90/1.5*100,100);
      const c   = p.xgi90>=0.6?"#1a8a26":p.xgi90>=0.3?"#9c7a00":"#a3182a";
      const flag = p.xg_overperf>=3?` ${badge("amber","↓ regress?")}`:
                   p.xg_overperf<=-3?` ${badge("green","↑ due goals")}`:"";
      return `<td>
        <div style="display:flex;align-items:center;gap:5px">
          <div style="height:5px;border-radius:0;background:var(--border2);width:46px;overflow:hidden">
            <div style="height:100%;width:${pct.toFixed(0)}%;background:${c};border-radius:0"></div></div>
          <span style="font-size:11px">${p.xgi90.toFixed(2)}</span>
        </div>${flag}
      </td>`;
    })();

    const defCell = showDef ? (() => {
      const bps = p.bps_per_game, thr = p.def_threshold;
      if (!thr || !bps) return `<td><span style="color:var(--text3);font-size:11px">—</span></td>`;
      const r   = bps/thr;
      const cls = r>=1?"badge-green":r>=0.75?"badge-amber":"badge-red";
      return `<td>${badge(cls, bps.toFixed(1))}</td>`;
    })() : "";

    const csCell = showCS ? (() => {
      const prob = p.cs_prob, pts = p.xcs_pts_per_game;
      if (!prob || p.pos==="FWD") return `<td><span style="color:var(--text3);font-size:11px">—</span></td>`;
      const cls = prob>=0.4?"badge-green":prob>=0.25?"badge-amber":"badge-red";
      return `<td>${badge(cls,(prob*100).toFixed(0)+"% CS")}<div style="font-size:10px;color:var(--text3)">+${pts.toFixed(1)}pts/g</div></td>`;
    })() : "";

    const minsCell = (() => {
      if (!p.minutes) return `<td><span style="color:var(--text3)">—</span></td>`;
      const norm = p.playing_time_norm || 0;
      const cls  = norm>=0.7?"badge-green":norm>=0.4?"badge-amber":"badge-red";
      const tip  = `${p.starts} starts · ${Math.round(p.mins_per_start||0)}m/start`;
      return `<td><span class="badge ${cls}" title="${tip}">${p.minutes}m</span></td>`;
    })();

    const rec = (() => {
      if (p.composite>=70 && p.wfdr<=2.5) return badge("green","Strong buy");
      if (p.composite>=55) return badge("blue","Consider");
      if (p.wfdr>=4) return badge("red","Avoid");
      return badge("gray","Watch");
    })();

    html += `<tr>
      <td style="color:var(--text3);font-size:12px">${i+1}</td>
      <td>
        <div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap">
          <span data-pid="${p.id}" style="font-weight:700;cursor:pointer">${p.name}</span>${xgBadge}${dgwB}${injB}${priceArrow}${trendArrow}${rotBadge}
        </div>
        <div style="font-size:11px;color:var(--text3)">${p.team_name} · ${p.pos}${p.effective_pos==="ATK_MID"?` <span style="font-size:9px;background:var(--purple-bg);color:var(--purple-fg);padding:1px 4px;border-radius:0;font-weight:700">ATK</span>`:""}</div>
      </td>
      <td><strong>${p.form}</strong></td>
      ${xgCell}${defCell}${csCell}
      <td>${p.value}</td>
      <td>£${p.price}m</td>
      ${minsCell}
      <td><div class="fdr-row" style="justify-content:flex-start">${fdrSq(p.fixes,5)}</div></td>
      <td style="font-size:12px;color:var(--text2)">${p.wfdr}</td>
      <td style="font-size:12px;font-weight:700;color:${(p.near_fdr||3)<=2?"var(--green-fg)":(p.near_fdr||3)>=4?"var(--red-fg)":"var(--text2)"}">${p.near_fdr ?? "—"}</td>
      <td>${scoreBar(p.composite, 70, p)}</td>
      ${_rankDgwGw ? (() => {
        const dgwProj = (p.projections||[]).find(x=>x.gw===_rankDgwGw);
        if (!dgwProj) return `<td style="text-align:center;color:var(--text3)">—</td>`;
        if (dgwProj.blank) return `<td style="text-align:center;color:var(--text3);font-size:11px">BGW</td>`;
        const pc = dgwProj.proj >= 12 ? "var(--green-fg)" : dgwProj.proj >= 8 ? "var(--text)" : "var(--text2)";
        const bg = dgwProj.dgw ? "var(--purple-bg)" : "";
        return `<td style="text-align:center;background:${bg}">
          <span style="font-weight:800;font-size:13px;color:${pc}">${dgwProj.proj}</span>
          ${dgwProj.dgw ? `<span style="font-size:9px;color:var(--purple-fg)"> ×2</span>` : ""}
        </td>`;
      })() : ""}
      <td>
        ${p.differential_score != null ? (() => {
          const ds  = p.differential_score;
          const own = p.ownership || 0;
          const c   = own <= 5  ? "var(--green-fg)"
                    : own <= 15 ? "var(--text)"
                    : "var(--text3)";
          const tip = `Diff score: ${ds} · Ownership: ${own}%`;
          return `<div style="font-size:12px;font-weight:700;color:${c}" title="${tip}">${ds}</div>
            <div style="font-size:9px;color:var(--text3)">${own}% owned</div>`;
        })() : "—"}
      </td>
      <td>${rec}</td>
      ${_rankDgwGw ? `<td style="text-align:center">
        ${_rankDgwTeams.includes(p.team_name)
          ? `<span style="color:var(--purple-fg);font-weight:800;font-size:13px">✓</span>`
          : `<span style="color:var(--text3);font-size:11px">–</span>`}
      </td>` : ""}
      <td><button onclick="openComparison(${p.id})"
        style="font-size:11px;padding:3px 8px;border:1px solid var(--border2);
        border-radius:0;background:var(--surface);cursor:pointer;
        color:var(--text2);font-family:var(--font);white-space:nowrap">
        vs</button>
      ${wlStarBtn(p)}</td>
    </tr>`;
  });

  el("rankTable").innerHTML = html + "</tbody></table>";
}

// ── Fixtures ───────────────────────────────────────────────────

function renderFixtures(fixtures, dgwSummary, currentGw) {
  const gws = [0,1,2,3,4].map(i=>currentGw+i);
  let html = `
    <p style="font-size:12px;color:var(--text2);margin-bottom:.75rem">Shows all team fixtures for the next 5 GWs colour-coded by difficulty. Sorted by weighted FDR — easiest run first. Click any team name to compare attack/defence stats. — easiest 5-game run first.
      <span class="badge badge-purple" style="font-size:10px">DGW</span> = double gameweek.</p>
    <div style="overflow-x:auto">
    <table class="fdr-table">
      <thead><tr>
        <th>Team</th>
        ${gws.map(g => {
          const dgwTeams = (dgwSummary||{})[String(g)]||[];
          const dgwNote  = dgwTeams.length ? ` <span class="badge badge-purple" style="font-size:9px">DGW</span>` : "";
          return `<th>GW${g}${dgwNote}</th>`;
        }).join("")}
        <th>${ttip("wFDR","Weighted Fixture Difficulty Rating across 5 GWs. GW+1 35% · GW+2 25% · GW+3 20% · GW+4 12% · GW+5 8%")}</th>
      </tr></thead>
      <tbody>`;

  fixtures.forEach(t => {
    const byGw = {};
    (t.fixes||[]).forEach(f => byGw[f.gw]=f);
    const wC = FDR_C[Math.round(t.wfdr)]||"#888";
    html += `<tr><td><button onclick="openTeamComparison('${t.team}')"
      style="background:none;border:none;cursor:pointer;font-weight:700;
      font-size:12px;color:var(--text);font-family:var(--font);padding:0;
      text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--border2)"
      title="Compare ${t.full}">${t.team}</button></td>`;
    gws.forEach(gw => {
      const f = byGw[gw];
      if (!f) { html += `<td style="color:var(--text3)">—</td>`; return; }
      const c = FDR_C[f.fdr]||"#888";
      const dgwTeams = (dgwSummary||{})[String(gw)]||[];
      const isDGW = dgwTeams.includes(t.team);
      html += `<td><span class="fdr-cell" style="background:${c}22;color:${c}">${f.opp} <span style="font-weight:400;opacity:.7">${f.home?"H":"A"}</span></span>${isDGW?` <span class="badge badge-purple" style="font-size:9px">×2</span>`:""}`;
      html += `</td>`;
    });
    html += `<td style="font-weight:800;color:${wC}">${t.wfdr}</td></tr>`;
  });

  html += `</tbody></table></div>`;
  el("tab-fixtures").innerHTML = html;
}

// ── Chip advisor ───────────────────────────────────────────────

function renderChips(chips, meta) {
  const CHIPS = [
    ["3xc","Triple Captain","3️⃣"],
    ["bboost","Bench Boost","📈"],
    ["wildcard","Wildcard","🃏"],
    ["freehit","Free Hit","⚡"],
  ];
  const TIMING = {
    good:{cls:"badge-green",lbl:"Good timing"},
    ideal:{cls:"badge-green",lbl:"Ideal now"},
    consider:{cls:"badge-amber",lbl:"Consider"},
    urgent:{cls:"badge-red",lbl:"Urgent"},
    ok:{cls:"badge-gray",lbl:"Okay"},
    "not yet":{cls:"badge-gray",lbl:"Hold for now"},
    "not needed":{cls:"badge-gray",lbl:"Not needed"},
    poor:{cls:"badge-red",lbl:"Poor timing"},
  };

  let html = `<p style="font-size:12px;color:var(--text2);margin-bottom:.5rem;line-height:1.6">Recommends when and which chip to use based on your squad's current strength, upcoming fixtures and DGW/BGW data. Each chip is scored 0–100.</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1.25rem;line-height:1.7">
    Scored 0–100 using your squad's composite scores, upcoming fixtures and DGW/BGW data.
    Used chips are greyed out.</p>`;

  CHIPS.forEach(([key, label, emoji]) => {
    const d      = chips[key]||{};
    const used   = (meta.chips_used||[]).includes(key);
    const active = meta.active_chip === key;
    const score  = d.score||0;
    const scC    = score>=65?"#1a8a26":score>=40?"#9c7a00":"#a3182a";

    let timing="ok", advice="";

    if (key==="3xc") {
      timing = d.fdr<=2&&d.has_dgw?"ideal":d.fdr<=2?"good":d.fdr<=3?"ok":"poor";
      const dgwNote = d.has_dgw ? " <strong>They have a DGW — double points from two games.</strong>" : "";
      const xgiStr  = d.xgi90 ? `${d.xgi90.toFixed(2)} xGI/90` : "no xGI data";
      advice = d.pick
        ? `Best candidate: <strong>${d.pick}</strong> (${d.pick_team}) — ${d.next_opp} FDR ${d.fdr} · ${xgiStr}.${dgwNote} ${d.fdr<=2?"Fixture looks ideal.":d.fdr===3?"Average fixture — consider waiting for a DGW or FDR 1–2.":"Tough fixture. Hold the chip."}`
        : "No strong candidate found.";
    }
    else if (key==="bboost") {
      const dgwNote = d.bench_dgws>0 ? ` <strong>${d.bench_dgws} bench player${d.bench_dgws>1?"s have":"has"} a DGW — excellent timing.</strong>` : "";
      timing = (d.avg_comp>=45&&d.avg_fdr<=2.5)||d.bench_dgws>=2?"ideal":
               d.avg_comp>=45&&d.avg_fdr<=3?"good":d.avg_comp>=35?"ok":"poor";
      const bench = (d.bench||[]).map(p =>
        `<div style="background:var(--surface2);border-radius:0;padding:7px 10px;border:1px solid var(--border);min-width:100px">
          <div data-pid="${p.id}" style="font-size:12px;font-weight:700;cursor:pointer">${p.name}${p.has_dgw?" <span class='dgw-badge'>DGW</span>":""}</div>
          <div style="font-size:11px;color:var(--text2)">${p.pos} · ${p.team} · Score ${p.composite}</div>
        </div>`
      ).join("");
      advice = `Bench avg score: <strong>${d.avg_comp}</strong> · avg FDR: <strong>${d.avg_fdr}</strong>.${dgwNote}
        ${d.avg_comp>=45?"Strong bench.":d.avg_comp>=35?"Decent bench.":"Weak bench — hold."}<br>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${bench}</div>`;
    }
    else if (key==="wildcard") {
      timing = d.weak_count>=4?"urgent":d.weak_count>=2?"consider":"not yet";
      const upgHtml = (d.upgrades||[]).map(u =>
        `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
          <span style="color:var(--text3);min-width:30px">${u.pos}</span>
          <span style="text-decoration:line-through;color:var(--text3)">${u.out}</span>
          <span style="color:var(--border2)">→</span>
          <span style="font-weight:700">${u.in}${u.in_dgw?" <span class='dgw-badge'>DGW</span>":""}</span>
          <span style="color:var(--green);margin-left:auto">+${u.gain}</span>
        </div>`
      ).join("");
      advice = `${d.weak_count} starters below threshold.
        ${d.upgrades?.length ? `<div style="margin-top:8px">${upgHtml}</div>` : ""}
        ${d.weak_count>=4?"High urgency — significant upgrades available.":
          d.weak_count>=2?"Worth considering — free transfers may manage this gradually.":
          "Squad looks solid."}`;
    }
    else if (key==="freehit") {
      timing = d.blanking_now>=8?"ideal":d.blanking_now>=4||d.my_blankers?.length>=3?"consider":"not needed";
      const blankerList = d.my_blankers?.join(", ") || "none";
      advice = `<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text2);margin-bottom:8px">
        <span>Blanking now: <strong style="color:${d.blanking_now>=6?"var(--red)":d.blanking_now>=3?"var(--amber)":"var(--green)"}">${d.blanking_now} teams</strong></span>
        <span>Blanking next: <strong>${d.blanking_next} teams</strong></span>
        <span>DGW teams next: <strong style="color:var(--purple)">${d.dgw_next}</strong></span>
        <span>Your blankers: <strong style="color:${d.my_blankers?.length>=3?"var(--red)":"var(--text)"}">${d.my_blankers?.length||0}</strong></span>
      </div>
      ${d.my_blankers?.length ? `<div style="font-size:12px;color:var(--text2);margin-bottom:6px">Blanking: ${blankerList}</div>` : ""}
      ${d.blanking_now>=8?"Ideal blank GW — strongly consider activating to field a full team.":
        d.blanking_now>=4?"Significant blank — Free Hit worthwhile, especially with "+d.dgw_next+" doubles next GW.":
        d.my_blankers?.length>=3?"Several blankers in your squad — Free Hit could rescue the GW.":
        "No major blank — save this chip for a heavily blank gameweek."}`;
    }

    const tInfo = TIMING[timing]||TIMING["ok"];
    const bColor = active?"#123a70":used?"#c6c6c6":score>=65?"#1a8a26":score>=40?"#9c7a00":"#ccc";
    const hBg    = active?"var(--blue-bg)":used?"var(--surface2)":score>=65?"var(--green-bg)":score>=40?"var(--amber-bg)":"var(--surface2)";
    const dimSt  = used&&!active ? "opacity:.5;" : "";

    html += `<div class="chip-card" style="border-left:4px solid ${bColor};${dimSt}">
      <div class="chip-header" style="background:${hBg}">
        <span style="font-size:20px">${emoji}</span>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:800">${label}
            ${used&&!active?`<span style="font-size:11px;font-weight:400;text-decoration:line-through;color:var(--text3)"> Used</span>`:""}
          </div>
        </div>
        ${active ? badge("blue","● Active this GW") : used ? "" : badge(tInfo.cls, tInfo.lbl)}
        <div class="score-bar-wrap">
          <div class="score-bar"><div class="score-fill" style="width:${score}%;background:${scC}"></div></div>
          <span style="font-size:13px;font-weight:700">${score}</span>
        </div>
      </div>
      <div class="chip-body"><div class="chip-advice">${advice}</div></div>
    </div>`;
  });

  el("tab-chips").innerHTML = html;
}

// ── GW History ─────────────────────────────────────────────────

function renderHistory(gwHistory, squad, allPlayers, meta) {
  if (!gwHistory?.length) {
    el("tab-history").innerHTML = `<p style="color:var(--text2);padding:1rem 0">No GW history yet.</p>`;
    return;
  }

  const gws     = gwHistory.map(r=>r.event);
  const myPts   = gwHistory.map(r=>r.points);
  const myTotal = gwHistory.map(r=>r.total_points);
  const avgPts  = gwHistory.map(r=>r.avg);
  const highPts = gwHistory.map(r=>r.highest);
  const bench   = gwHistory.map(r=>r.points_on_bench||0);
  const myRank  = gwHistory.map(r=>r.overall_rank);

  // Cumulative average
  let rA=0;
  const cumAvg = gwHistory.map(r=>{ rA+=r.avg; return Math.round(rA); });
  const ptsVsAvg = myTotal.map((t,i)=>t-cumAvg[i]);
  const lastDiff = ptsVsAvg[ptsVsAvg.length-1]||0;
  const diffC    = lastDiff>=0?"var(--green)":"var(--red)";

  const avgGw  = (myPts.reduce((a,b)=>a+b,0)/myPts.length).toFixed(1);
  const lgAvg  = (avgPts.reduce((a,b)=>a+b,0)/avgPts.length).toFixed(1);
  const bestPt = Math.max(...myPts);
  const bestGw = gws[myPts.indexOf(bestPt)];
  const totB   = bench.reduce((a,b)=>a+b,0);

  const sqOpts = squad.sort((a,b)=>a.pos.localeCompare(b.pos)||a.name.localeCompare(b.name))
    .map(p=>`<option value="${p.id}">${p.name} (${p.pos} · ${p.team_name})</option>`).join("");

  el("tab-history").innerHTML = `
    <p style="font-size:12px;color:var(--text2);margin-bottom:.75rem;line-height:1.6">Your GW-by-GW points history. Shows captain decisions, total progression and how you compare to the average manager score each week.</p>
    <div class="summary-strip">
      <div class="sum-stat">
        <div class="sum-stat-lbl">Total pts</div>
        <div class="sum-stat-val">${myTotal[myTotal.length-1]||0}</div>
        <div class="sum-stat-sub">After GW${gws[gws.length-1]}</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">vs avg cumulative</div>
        <div class="sum-stat-val" style="color:${diffC}">${lastDiff>=0?"+":""}${lastDiff}</div>
        <div class="sum-stat-sub">${lastDiff>=0?"ahead of":"behind"} avg</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">GW avg</div>
        <div class="sum-stat-val">${avgGw}</div>
        <div class="sum-stat-sub">League avg ${lgAvg}</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Best GW</div>
        <div class="sum-stat-val">${bestPt}</div>
        <div class="sum-stat-sub">GW${bestGw}</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Bench pts</div>
        <div class="sum-stat-val">${totB}</div>
        <div class="sum-stat-sub">Points missed</div>
      </div>
    </div>

    <div class="chart-sec">
      <div class="chart-title">Gameweek scores</div>
      <div class="chart-sub">Your score each GW vs the league average and highest manager</div>
      <div class="chart-leg">
        <span><b style="background:#123a70"></b>Your score</span>
        <span><b style="background:#565b57;border-top:2px dashed #565b57;height:0;width:14px"></b>Avg</span>
        <span><b style="background:#8a6a00"></b>Highest</span>
      </div>
      <div class="chart-wrap" style="height:240px"><canvas id="hGwC"></canvas></div>
    </div>

    <div class="chart-sec">
      <div class="chart-title">You vs average — cumulative</div>
      <div class="chart-sub">Your running total vs the cumulative league average. The gap shows whether you are pulling ahead or falling behind the average manager over time.</div>
      <div class="chart-leg">
        <span><b style="background:#123a70"></b>Your total</span>
        <span><b style="background:#565b57"></b>Avg manager</span>
      </div>
      <div class="chart-wrap" style="height:220px"><canvas id="hCumulC"></canvas></div>
    </div>

    <div class="chart-sec">
      <div class="chart-title">Overall rank trajectory</div>
      <div class="chart-sub">Your overall rank after each GW. A falling line means you are climbing — lower is better.</div>
      <div class="chart-wrap" style="height:200px"><canvas id="hRankC"></canvas></div>
    </div>

    <div class="chart-sec" id="capSec">
      <div class="chart-title">Captain tracker</div>
      <div class="chart-sub" id="capSub">Loading captain data...</div>
      <div class="chart-leg">
        <span><b style="background:#123a70"></b>Your captain (2×)</span>
        <span><b style="background:#8a6a00"></b>Optimal captain (2×)</span>
      </div>
      <div class="chart-wrap" style="height:220px"><canvas id="hCapC"></canvas></div>
    </div>

    <div class="chart-sec">
      <div class="chart-title">Player history</div>
      <div class="chart-sub">GW-by-GW returns — hover for match detail. Click a player on the pitch to jump here.</div>
      <div class="chart-ctl">
        <select class="chart-sel" id="playerHistSel" onchange="updatePlayerChart()">
          ${sqOpts}
        </select>
        <div style="display:flex;gap:4px">
          <button class="ctog on" onclick="setPMode('pts',this)">Points</button>
          <button class="ctog" onclick="setPMode('cumul',this)">Cumulative</button>
          <button class="ctog" onclick="setPMode('xgi',this)">xGI</button>
        </div>
      </div>
      <div class="chart-wrap" style="height:220px"><canvas id="hPlayerC"></canvas></div>
      <div class="stat-strip" id="pStatStrip"></div>
    </div>

    <div class="chart-sec">
      <div class="chart-title">Form momentum</div>
      <div class="chart-sub">Rolling 3, 5 and 8 GW averages. When the blue 3GW line rises above the amber 8GW line the player is accelerating — a strong buy signal.</div>
      <div class="chart-ctl">
        <select class="chart-sel" id="momSel" onchange="updateMomChart()">${sqOpts}</select>
      </div>
      <div class="chart-leg">
        <span><b style="background:#123a70"></b>3 GW avg</span>
        <span><b style="background:#0c6e6e"></b>5 GW avg</span>
        <span><b style="background:#8a6a00"></b>8 GW avg</span>
      </div>
      <div class="chart-wrap" style="height:200px"><canvas id="hMomC"></canvas></div>
    </div>`;

  window._hd = {gws,myPts,myTotal,avgPts,highPts,myRank,cumAvg,ptsVsAvg,allPlayers};

  requestAnimationFrame(() => {
    mkChart("hGwC",{type:"line",data:{labels:gws,datasets:[
      lineDs("#123a70","rgba(55,138,221,0.12)","Your score",myPts),
      lineDs("#565b57",null,"Avg",avgPts,true),
      lineDs("#8a6a00","rgba(186,117,23,0.09)","Highest",highPts,true),
    ]},options:baseOpts("Points")});

    mkChart("hCumulC",{type:"line",data:{labels:gws,datasets:[
      lineDs("#123a70","rgba(55,138,221,0.12)","Your total",myTotal),
      lineDs("#565b57","rgba(147,150,142,0.08)","Avg",cumAvg,true),
    ]},options:{...baseOpts("Cumulative pts"),plugins:{legend:{display:false},
      tooltip:{mode:"index",intersect:false,callbacks:{title:c=>"GW "+c[0].label,
        afterBody:c=>{const i=c[0].dataIndex;const d=ptsVsAvg[i];return[(d>=0?"+":"")+d+" vs avg"];}
      }}}}});

    mkChart("hRankC",{type:"line",data:{labels:gws,datasets:[{
      label:"Rank",data:myRank,borderColor:"#0c6e6e",
      backgroundColor:"rgba(127,119,221,0.1)",borderWidth:2,
      pointRadius:3,pointHoverRadius:5,fill:true,tension:0.35,spanGaps:false,
    }]},options:{...baseOpts(),scales:{
      x:{ticks:{color:"#aaa",font:{size:11,family:FONT}},grid:{color:"rgba(0,0,0,0.04)"}},
      y:{reverse:true,ticks:{color:"#aaa",font:{size:11,family:FONT},
           callback:v=>v>=1e6?(v/1e6).toFixed(1)+"M":v>=1e3?(v/1e3).toFixed(0)+"K":v},
         grid:{color:"rgba(0,0,0,0.04)"},
         title:{display:true,text:"Rank (lower = better)",color:"#aaa",font:{size:11}}},
    },plugins:{legend:{display:false},tooltip:{callbacks:{
      title:c=>"GW "+c[0].label,
      label:c=>"Rank: "+(c.raw||0).toLocaleString(),
    }}}}});

    loadCaptainHistory(meta.team_id, gwHistory);
    updatePlayerChart();
    updateMomChart();
  });
}

async function loadCaptainHistory(teamId, gwHistory) {
  try {
    const res  = await fetch(`/api/captain_history/${teamId}`);
    const data = await res.json();
    if (!data.records?.length) return;
    const recs = data.records;
    // Fetch histories for all captains
    const pids = [...new Set(recs.map(r=>r.captain_id))];
    await Promise.all(pids.map(fetchPlayerHistory));

    const capGws=[], capPts=[], bestPts=[], capNames=[], bestNames=[], lostArr=[];
    let totalLost=0;
    recs.forEach(r => {
      const hist  = _phCache[r.captain_id]||[];
      const gwRow = hist.find(h=>h.gw===r.gw);
      if (!gwRow) return;
      const myPts  = gwRow.pts * r.multiplier;
      const optPts = r.top_pts_raw * 2;
      const lost   = Math.max(0, optPts - myPts);
      totalLost += lost;
      capGws.push(r.gw); capPts.push(myPts); bestPts.push(optPts);
      capNames.push(r.captain); bestNames.push(r.top_name); lostArr.push(lost);
    });
    if (!capGws.length) return;

    const lostC = totalLost>30?"var(--red)":totalLost>15?"var(--amber)":"var(--green)";
    const subEl = el("capSub");
    if (subEl) subEl.innerHTML = `Your captain's doubled return vs the optimal pick.
      Total pts lost to captain decisions: <strong style="color:${lostC}">${totalLost}</strong>`;

    mkChart("hCapC",{type:"bar",data:{labels:capGws,datasets:[
      {label:"Your captain",data:capPts,backgroundColor:"rgba(55,138,221,0.22)",
       borderColor:"#123a70",borderWidth:1.5,borderRadius:4,order:2},
      {label:"Optimal",data:bestPts,type:"line",fill:false,
       borderColor:"#8a6a00",backgroundColor:"transparent",
       borderWidth:2,pointRadius:3,tension:0.3,order:1,spanGaps:false},
    ]},options:{...baseOpts("Captain pts"),plugins:{legend:{display:false},
      tooltip:{mode:"index",intersect:false,callbacks:{title:c=>"GW "+c[0].label,
        afterBody:c=>{
          const i=capGws.indexOf(parseInt(c[0].label));
          if(i<0) return [];
          return ["Captain: "+capNames[i],"Optimal: "+bestNames[i],
                  lostArr[i]>0?"Lost: "+lostArr[i]+" pts":"✓ Optimal pick!"];
        }
      }}}}});
  } catch(e) { console.warn("Captain history failed:", e); }
}

async function fetchPlayerHistory(pid) {
  if (_phCache[pid]) return _phCache[pid];
  try {
    const r = await fetch(`/api/player_history/${pid}`);
    const d = await r.json();
    _phCache[pid] = d.history||[];
  } catch(e) { _phCache[pid]=[]; }
  return _phCache[pid];
}

async function updatePlayerChart() {
  const pid  = parseInt(el("playerHistSel")?.value);
  if (!pid) return;
  const hist = await fetchPlayerHistory(pid);
  const sq   = _state?.squad||[];
  const p    = sq.find(x=>x.id===pid)||{};
  const gws  = hist.map(r=>r.gw);

  let data, label, color, fill;
  if (_playerMode==="cumul") {
    data=hist.map(r=>r.cumulative);label="Cumulative pts";color="#0c6e6e";fill="rgba(29,158,117,0.12)";
  } else if (_playerMode==="xgi") {
    data=hist.map(r=>parseFloat(r.xgi.toFixed(3)));label="xGI";color="#0c6e6e";fill="rgba(127,119,221,0.12)";
  } else {
    data=hist.map(r=>r.pts);label="GW pts";color="#123a70";fill="rgba(55,138,221,0.12)";
  }

  const datasets=[lineDs(color,fill,label,data)];
  if (_playerMode==="cumul" && p.pos) {
    const allP=_state?.all_players||[];
    const top=allP.filter(x=>x.pos===p.pos).sort((a,b)=>b.total_pts-a.total_pts)[0];
    if (top && hist.length)
      datasets.push(lineDs("#8a6a00","rgba(186,117,23,0.08)",`Top ${p.pos} pace`,
        hist.map((_,i)=>Math.round(top.total_pts*(i+1)/hist.length)),true));
  }

  mkChart("hPlayerC",{type:"line",data:{labels:gws,datasets},
    options:{...baseOpts(label),spanGaps:false,plugins:{legend:{display:false},
      tooltip:{mode:"index",intersect:false,callbacks:{title:c=>"GW "+c[0].label,
        afterBody:c=>{
          const r=hist[c[0].dataIndex];
          if(!r) return [];
          return [r.mins+"m",
            r.goals?r.goals+" goal"+(r.goals>1?"s":""):null,
            r.assists?r.assists+" assist"+(r.assists>1?"s":""):null,
            r.cs?"Clean sheet":null, r.bonus?r.bonus+" bonus":null,
          ].filter(Boolean);
        }
      }}}}});

  if (hist.length) {
    const tot=hist.reduce((s,r)=>s+r.pts,0);
    const g=hist.filter(r=>r.mins>0).length;
    const gl=hist.reduce((s,r)=>s+r.goals,0);
    const as=hist.reduce((s,r)=>s+r.assists,0);
    const cs=hist.reduce((s,r)=>s+r.cs,0);
    const best=hist.reduce((a,r)=>r.pts>a.pts?r:a,hist[0]);
    el("pStatStrip").innerHTML=[
      ["Season pts",tot],["Games",g],["Goals",gl],["Assists",as],
      ["Clean sheets",cs],["Best GW",best.pts+" (GW"+best.gw+")"],
    ].map(([l,v])=>`<div class="stat-chip"><div class="stat-chip-lbl">${l}</div>
      <div class="stat-chip-val">${v}</div></div>`).join("");
  }
}

function setPMode(m, btn) {
  _playerMode = m;
  el("tab-history").querySelectorAll(".ctog").forEach(b=>b.classList.remove("on"));
  btn.classList.add("on");
  updatePlayerChart();
}

function roll(arr, n) {
  return arr.map((_,i) => {
    if (i<n-1) return null;
    const sl=arr.slice(i-n+1,i+1);
    return +(sl.reduce((a,b)=>a+b,0)/n).toFixed(2);
  });
}

async function updateMomChart() {
  const pid  = parseInt(el("momSel")?.value);
  if (!pid) return;
  const hist = await fetchPlayerHistory(pid);
  const pts  = hist.map(r=>r.pts);
  const gws  = hist.map(r=>r.gw);
  mkChart("hMomC",{type:"line",data:{labels:gws,datasets:[
    {label:"GW",data:pts,borderColor:"rgba(0,0,0,0.07)",backgroundColor:"transparent",
     borderWidth:1,pointRadius:2,tension:0.2,spanGaps:false},
    lineDs("#123a70",null,"3GW",roll(pts,3),false,0.4),
    lineDs("#0c6e6e",null,"5GW",roll(pts,5),false,0.4),
    lineDs("#8a6a00",null,"8GW",roll(pts,8),true,0.4),
  ]},options:{...baseOpts("Avg pts"),spanGaps:true,
    plugins:{legend:{display:false}}}});
}

// ── Transfer switching helpers ──────────────────────────────────

function switchTransPos(pid, btn) {
  document.querySelectorAll("#transPT .pos-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  ["tdef","tmid","tfwd","dgw"].forEach(id=>{
    const d=el("trans-"+id); if(d) d.style.display="none";
  });
  const target = el("trans-"+pid) || el(pid);
  if (target) target.style.display = "block";
}

// ── Hit calculator ─────────────────────────────────────────────
function calcHit() {
  const hits       = parseInt(el("hitCount")?.value || 1);
  const gainPerGw  = parseFloat(el("hitGainPerGw")?.value || 2.5);
  const gwsBenefit = parseInt(el("hitGwsBenefit")?.value || 5);
  const resultDiv  = el("hitResult");
  if (!resultDiv) return;

  const hitCost    = hits * 4;
  const totalGain  = gainPerGw * gwsBenefit;
  const netGain    = totalGain - hitCost;
  const breakeven  = gainPerGw > 0 ? Math.ceil(hitCost / gainPerGw) : 999;

  const verdict    = netGain > 3  ? { label: "Worth it",   c: "var(--green-fg)", icon: "✅" }
                   : netGain > 0  ? { label: "Marginal",    c: "var(--amber-fg)", icon: "⚠" }
                   : netGain > -3 ? { label: "Borderline",  c: "var(--amber-fg)", icon: "⚠" }
                                  : { label: "Don\'t do it", c: "var(--red-fg)",  icon: "❌" };

  resultDiv.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:.25rem">
      <div class="sum-stat">
        <div class="sum-stat-lbl">Hit cost</div>
        <div class="sum-stat-val" style="color:var(--red-fg)">-${hitCost}pts</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Total gain (${gwsBenefit} GWs)</div>
        <div class="sum-stat-val" style="color:var(--green-fg)">+${totalGain.toFixed(1)}pts</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Net gain</div>
        <div class="sum-stat-val" style="color:${netGain>=0?"var(--green-fg)":"var(--red-fg)"}">
          ${netGain>=0?"+":""}${netGain.toFixed(1)}pts</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Breakeven</div>
        <div class="sum-stat-val">${breakeven > 20 ? "Never" : "GW+"+breakeven}</div>
        <div class="sum-stat-sub">GWs to recover hit</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Verdict</div>
        <div class="sum-stat-val" style="color:${verdict.c};font-size:14px">
          ${verdict.icon} ${verdict.label}</div>
      </div>
    </div>`;
}

function switchTransSec(sec, btn) {
  btn.closest(".pos-tabs").querySelectorAll(".pos-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  ["individual","combos"].forEach(s=>{
    const d=el("trans-sec-"+s); if(d) d.style.display=s===sec?"block":"none";
  });
}

// ── GW Planner ─────────────────────────────────────────────────

function renderPlanner(squad, allPlayers, transfers, dgwSummary, bgwGws, meta) {
  // ── Build "suggested" squad by applying top transfer recommendation ──
  // Take the first Strong/Good transfer from each position group
  let suggestedSquad = squad.map(p => ({...p}));   // deep-ish copy
  const appliedTransfers = [];

  if (transfers && transfers.length) {
    const strongGroups = transfers.filter(g =>
      ["Strong","Good"].includes(g.best_verdict) && g.options.length
    );
    // Apply up to free_transfers number of suggestions
    let ft = meta.free_transfers;
    for (const g of strongGroups) {
      if (ft <= 0) break;
      const opt = g.options[0];
      const outId = g.out.id;
      const inPlayer = allPlayers.find(p => p.id === opt.in.id);
      if (!inPlayer) continue;
      const outIdx = suggestedSquad.findIndex(p => p.id === outId);
      if (outIdx === -1) continue;
      const outP = suggestedSquad[outIdx];
      // Build suggested player with projections
      const projections = [0,1,2,3].map(i => {
        const gw = meta.current_gw + i;
        const fixes = inPlayer.fixes || [];
        const gwFixes = fixes.filter(f => f.gw === gw);
        if (!gwFixes.length) return {gw, proj:0, blank:true, dgw:false, fixes:[]};
        const isDgw = gwFixes.length >= 2;
        const FDR_MOD = {1:1.25,2:1.10,3:1.00,4:0.80,5:0.65};
        const base = inPlayer.pts_per_start || 4;
        const avail = inPlayer.availability || 1;
        let proj = isDgw
          ? base * (FDR_MOD[gwFixes[0].fdr]||1) + base * (FDR_MOD[gwFixes[1].fdr]||1) * 0.85
          : base * (FDR_MOD[gwFixes[0].fdr]||1);
        return {gw, proj:Math.round(proj*avail*10)/10, blank:false, dgw:isDgw, fixes:gwFixes};
      });
      suggestedSquad[outIdx] = {
        ...inPlayer,
        is_sub: outP.is_sub,
        pick_pos: outP.pick_pos,
        multiplier: outP.multiplier,
        projections,
        _isNew: true,
        _replaces: outP.name,
      };
      appliedTransfers.push({out: outP.name, in: inPlayer.name, verdict: g.best_verdict});
      ft--;
    }
  }

  const makeView = (viewSquad) => {
    const starters = viewSquad.filter(p=>!p.is_sub).sort((a,b)=>a.pick_pos-b.pick_pos);
    const subs     = viewSquad.filter(p=> p.is_sub).sort((a,b)=>a.pick_pos-b.pick_pos);
    const gws      = [0,1,2,3].map(i => meta.current_gw + i);

    function gwHeader(gw) {
      const proj  = viewSquad.flatMap(p=>(p.projections||[]).filter(x=>x.gw===gw));
      const isDgw = proj.some(x=>x.dgw);
      const isBgw = proj.length > 0 && proj.filter(p=>!p.blank).length <= 8;
      const tag   = isDgw ? `<span class="dgw-badge" style="font-size:9px">DGW</span>`
                  : isBgw ? `<span class="badge badge-red" style="font-size:9px">BGW</span>` : "";
      return `<div style="font-size:13px;font-weight:800">GW${gw} ${tag}</div>`;
    }

    function projCell(p, gw) {
      const proj = (p.projections||[]).find(x=>x.gw===gw);
      if (!proj) return `<td style="background:var(--surface2);border:1px solid var(--border);padding:8px;text-align:center;color:var(--text3)">—</td>`;
      if (proj.blank) return `<td style="background:#d8dad8;border:1px solid var(--border);padding:8px;text-align:center"><div style="font-size:11px;color:var(--text3)">BLANK</div></td>`;
      const fix  = proj.fixes[0];
      const fix2 = proj.dgw ? proj.fixes[1] : null;
      const fdrC = FDR_C[fix?.fdr]||"#888";
      const ptC  = proj.proj>=8?"var(--green-fg)":proj.proj>=5?"var(--text)":"var(--text2)";
      const bg   = proj.dgw ? "var(--purple-bg)" : (p._isNew ? "rgba(39,160,71,0.06)" : "var(--surface)");
      return `<td style="background:${bg};border:1px solid var(--border);padding:8px;text-align:center;min-width:90px">
        <div style="font-size:14px;font-weight:800;color:${ptC}">${proj.proj}</div>
        <div style="font-size:9px;color:var(--text3);margin-top:1px">proj pts</div>
        <div style="margin-top:4px"><span style="font-size:10px;background:${fdrC}22;color:${fdrC};padding:1px 5px;border-radius:0;font-weight:700">${fix?.opp} ${fix?.home?"H":"A"}</span></div>
        ${fix2?`<div style="margin-top:2px"><span style="font-size:10px;background:${(FDR_C[fix2?.fdr]||"#888")}22;color:${FDR_C[fix2?.fdr]||"#888"};padding:1px 5px;border-radius:0;font-weight:700">${fix2.opp} ${fix2.home?"H":"A"}</span></div>`:""}
        ${proj.dgw?`<div class="dgw-badge" style="margin-top:3px">DGW</div>`:""}
      </td>`;
    }

    function playerRows(players) {
      return players.map(p => {
        const gwProjs = gws.map(gw => (p.projections||[]).find(x=>x.gw===gw));
        const total4  = gwProjs.reduce((s,x)=>s+(x?.proj||0), 0);
        const injNote = p.news ? `<span style="font-size:9px;color:var(--amber)">⚠</span> ` : "";
        const newBadge = p._isNew ? `<span class="badge badge-green" style="font-size:9px">IN</span> ` : "";
        return `<tr>
          <td style="border:1px solid var(--border);padding:8px;white-space:nowrap;background:${p._isNew?"rgba(39,160,71,0.05)":"var(--surface)"}">
            <div style="font-size:12px;font-weight:700">${injNote}${newBadge}${p.name}</div>
            <div style="font-size:10px;color:var(--text3)">${p.team_name} · ${p.pos}</div>
            <div style="font-size:10px;color:var(--text3)">£${p.price}m${p._replaces?` <span style="text-decoration:line-through;color:var(--text3)">${p._replaces}</span>`:""}</div>
          </td>
          ${gws.map(gw=>projCell(p,gw)).join("")}
          <td style="border:1px solid var(--border);padding:8px;text-align:center;background:var(--surface2)">
            <div style="font-size:13px;font-weight:800">${total4.toFixed(1)}</div>
            <div style="font-size:9px;color:var(--text3)">4GW</div>
          </td>
        </tr>`;
      }).join("");
    }

    // ── Captain recommendation per GW ─────────────────────────────────────
    function capRow() {
      return gws.map(gw => {
        // Score each outfield starter for captain this GW
        // Captain value = projected pts × 2 (doubled), with DGW extra game bonus
        const scored = starters
          .filter(p => p.pos !== "GKP")
          .map(p => {
            const proj = (p.projections||[]).find(x=>x.gw===gw);
            if (!proj || proj.blank) return null;
            const capPts = proj.proj * 2;   // doubled
            // Reasoning signals
            const reasons = [];
            if (proj.dgw)                         reasons.push("DGW");
            if (proj.fixes?.[0]?.fdr <= 2)        reasons.push("FDR " + proj.fixes[0].fdr);
            if ((p.xgi90||0) >= 0.5)              reasons.push("xGI " + p.xgi90.toFixed(2));
            if (p.is_dgw_imminent) reasons.push("DGW next"); else if (p.has_dgw_next) reasons.push(`DGW GW${p.dgw_next_gw}`);
            return { name: p.name, capPts, proj: proj.proj, reasons,
                     dgw: proj.dgw, pos: p.pos };
          })
          .filter(Boolean)
          .sort((a,b) => b.capPts - a.capPts);

        if (!scored.length) return `<td style="border:1px solid var(--border);padding:8px;background:var(--surface2);text-align:center;color:var(--text3);font-size:11px">—</td>`;

        const cap = scored[0];
        const vc  = scored[1];
        const capC = cap.dgw ? "var(--purple-fg)" : "var(--blue-fg)";
        const capBg = cap.dgw ? "var(--purple-bg)" : "var(--blue-bg)";

        return `<td style="border:1px solid var(--border);padding:8px;background:${capBg};text-align:center;vertical-align:top">
          <div style="font-size:10px;font-weight:700;color:${capC};margin-bottom:3px">
            <span style="background:${capC};color:#fff;border-radius:50%;width:14px;height:14px;
              display:inline-flex;align-items:center;justify-content:center;font-size:9px;margin-right:3px">C</span>
            ${cap.name}
          </div>
          <div style="font-size:11px;font-weight:800;color:${capC}">${cap.capPts.toFixed(1)} proj</div>
          ${cap.reasons.length ? `<div style="font-size:9px;color:${capC};opacity:.8;margin-top:1px">${cap.reasons.join(" · ")}</div>` : ""}
          ${vc ? `<div style="font-size:9px;color:var(--text3);margin-top:4px;padding-top:4px;border-top:1px solid var(--border)">
            VC: ${vc.name} (${vc.capPts.toFixed(1)})</div>` : ""}
        </td>`;
      }).join("");
    }

    function gwTotals() {
      return gws.map(gw => {
        const total = starters.reduce((s,p)=>{
          const pr=(p.projections||[]).find(x=>x.gw===gw);
          return s+(pr?.proj||0);
        }, 0);
        return `<td style="border:1px solid var(--border);padding:8px;text-align:center;background:var(--surface2)">
          <div style="font-size:13px;font-weight:800">${total.toFixed(1)}</div>
          <div style="font-size:9px;color:var(--text3)">est.</div>
        </td>`;
      }).join("");
    }

    return `<div style="overflow-x:auto">
    <table style="border-collapse:collapse;width:100%">
      <thead><tr>
        <th style="border:1px solid var(--border);padding:8px;background:var(--surface2);text-align:left;font-size:12px;min-width:130px">Player</th>
        ${gws.map(gw=>`<th style="border:1px solid var(--border);padding:8px;background:var(--surface2);text-align:center;min-width:90px">${gwHeader(gw)}</th>`).join("")}
        <th style="border:1px solid var(--border);padding:8px;background:var(--surface2);text-align:center;font-size:12px">4GW</th>
      </tr></thead>
      <tbody>
        <tr><td colspan="${gws.length+2}" style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;background:var(--surface2);border:1px solid var(--border)">Starting XI</td></tr>
        ${playerRows(starters)}
        <tr>
          <td style="border:1px solid var(--border);padding:8px;background:var(--surface2);font-size:11px;font-weight:700;color:var(--text2)">XI Total</td>
          ${gwTotals()}
          <td style="border:1px solid var(--border);background:var(--surface2)"></td>
        </tr>
        <tr>
          <td style="border:1px solid var(--border);padding:8px;background:var(--blue-bg);font-size:11px;font-weight:700;color:var(--blue-fg)">
            <span style="background:var(--blue-fg);color:#fff;border-radius:50%;width:14px;height:14px;
              display:inline-flex;align-items:center;justify-content:center;font-size:9px;margin-right:4px">C</span>
            Captain pick
          </td>
          ${capRow()}
          <td style="border:1px solid var(--border);background:var(--blue-bg)"></td>
        </tr>
        <tr><td colspan="${gws.length+2}" style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;background:var(--surface2);border:1px solid var(--border)">Bench</td></tr>
        ${playerRows(subs)}
      </tbody>
    </table></div>`;
  };

  const transferNote = appliedTransfers.length
    ? `<div style="background:var(--green-bg);border:1px solid #cfe0b0;border-radius:0;
        padding:8px 14px;margin-bottom:1rem;font-size:12px;color:var(--green-fg);display:flex;gap:8px;flex-wrap:wrap">
        <strong>Applied ${appliedTransfers.length} suggested transfer${appliedTransfers.length>1?"s":""}:</strong>
        ${appliedTransfers.map(t=>`${t.out} → <strong>${t.in}</strong> <span class="badge badge-${t.verdict==="Strong"?"green":"blue"}" style="font-size:9px">${t.verdict}</span>`).join("  ·  ")}
      </div>`
    : `<div style="font-size:12px;color:var(--text3);margin-bottom:1rem">No Strong/Good transfers available — showing current squad only.</div>`;

  // ── FT rolling tracker ────────────────────────────────────────────────
  const ftNow    = meta.free_transfers || 1;
  const cgw      = meta.current_gw;
  const planGws  = [0,1,2,3].map(i => cgw + i);

  // Project FT bank: spend path (use 1 FT this GW) vs hold path (save this GW)
  function projectFTs(startFT, spendThisGW) {
    let ft = startFT;
    return planGws.map((gw, i) => {
      const hasDgw = ((dgwSummary||{})[String(gw)]||[]).length > 0;
      const ftThisGw = ft;
      if (i === 0 && spendThisGW) {
        ft = Math.min(2, Math.max(0, ft - 1) + 1);  // spent 1, accrued 1 next
      } else {
        ft = Math.min(2, ft + 1);  // accrued 1, capped at 2
      }
      return { gw, ft: ftThisGw, hasDgw };
    });
  }

  const spendPath = projectFTs(ftNow, true);
  const holdPath  = projectFTs(ftNow, false);

  // Find first upcoming DGW in next 4 GWs
  const firstDgwIdx = planGws.findIndex(gw => ((dgwSummary||{})[String(gw)]||[]).length > 0);
  const dgwAdvice = firstDgwIdx > 0 && holdPath[firstDgwIdx].ft >= 2
    ? `💡 Holding now gives you <strong>2 FTs</strong> for GW${planGws[firstDgwIdx]} DGW`
    : firstDgwIdx === 0
    ? `🔥 DGW this GW — use your transfers now`
    : firstDgwIdx === -1
    ? `No confirmed DGW in next 4 GWs`
    : `Spending this GW still leaves 1 FT for GW${planGws[firstDgwIdx]} DGW`;

  function ftCell(ft, hasDgw) {
    const c  = ft >= 2 ? "var(--green-fg)" : ft === 1 ? "var(--text)" : "var(--red-fg)";
    const bg = hasDgw ? "var(--purple-bg)" : "var(--surface)";
    return `<div style="text-align:center;padding:6px 10px;background:${bg};
      border-radius:0;border:1px solid var(--border);min-width:52px">
      <div style="font-size:15px;font-weight:800;color:${c}">${ft}</div>
      <div style="font-size:9px;color:var(--text3)">${hasDgw?"DGW":"FTs"}</div>
    </div>`;
  }

  const ftTrackerHtml = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:0;
      padding:12px 16px;margin-bottom:1rem">
      <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:10px;
        text-transform:uppercase;letter-spacing:.5px">Free transfer bank</div>
      <div style="display:grid;grid-template-columns:auto repeat(4,1fr);gap:8px;align-items:center">
        <div style="font-size:11px;color:var(--text3)">Spend 1 FT</div>
        ${spendPath.map(r => ftCell(r.ft, r.hasDgw)).join("")}
        <div style="font-size:11px;color:var(--text3)">Hold FT</div>
        ${holdPath.map(r => ftCell(r.ft, r.hasDgw)).join("")}
        <div></div>
        ${planGws.map(gw => `<div style="text-align:center;font-size:10px;color:var(--text3)">GW${gw}</div>`).join("")}
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--text2)">${dgwAdvice}</div>
    </div>`;

  // ── DGW/BGW planning mode ─────────────────────────────────────────────
  const planGwNums = [0,1,2,3,4].map(i => meta.current_gw + i);
  const upcomingDgwGws = planGwNums.filter(gw => ((dgwSummary||{})[String(gw)]||[]).length > 0);
  const upcomingBgwGws = planGwNums.filter(gw => (bgwGws||[]).includes(gw));
  const hasDgwOrBgw = upcomingDgwGws.length > 0 || upcomingBgwGws.length > 0;

  const dgwBgwPanel = (() => {
    if (!hasDgwOrBgw) return `<div style="color:var(--text2);font-size:12px;padding:.75rem 0">
      No confirmed DGWs or BGWs in the next 5 gameweeks.</div>`;

    const sections = [];

    // DGW sections
    for (const gw of upcomingDgwGws) {
      const dgwTeams = (dgwSummary[String(gw)]||[]);
      const myDgwPlayers  = squad.filter(p => !p.is_sub &&
        dgwTeams.includes(p.team_name));
      const missingDgw    = squad.filter(p => !p.is_sub &&
        p.fixes && p.fixes.filter(f=>f.gw===gw).length === 0);

      // Suggested transfers in — players in all_players with DGW this GW
      const dgwTargets = (allPlayers||[])
        .filter(p => !squad.find(s=>s.id===p.id) &&
          p.fixes && p.fixes.filter(f=>f.gw===gw).length >= 2 &&
          p.status === "a" && (p.chance==null||p.chance>=75) && p.starts>=2)
        .sort((a,b) => b.composite - a.composite)
        .slice(0, 6);

      sections.push(`
        <div style="margin-bottom:1.5rem">
          <div style="font-size:13px;font-weight:800;color:var(--purple-fg);margin-bottom:8px">
            🔥 GW${gw} Double Gameweek — ${dgwTeams.join(", ")}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;flex-wrap:wrap">
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:6px">Your players with DGW</div>
              ${myDgwPlayers.length ? myDgwPlayers.map(p => `
                <div style="display:flex;align-items:center;gap:8px;padding:5px 0;
                  border-bottom:1px solid var(--border);font-size:12px">
                  <span class="dgw-badge" style="font-size:9px">×2</span>
                  <span style="font-weight:700;flex:1">${p.name}</span>
                  <span style="color:var(--text3)">${p.pos} · ${p.team_name}</span>
                  <span style="font-weight:700;color:var(--purple-fg)">${p.composite}</span>
                </div>`).join("") :
                `<div style="color:var(--text3);font-size:12px;padding:6px 0">None of your starters have this DGW</div>`}
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:6px">Top DGW transfer targets</div>
              ${dgwTargets.map(p => `
                <div style="display:flex;align-items:center;gap:8px;padding:5px 0;
                  border-bottom:1px solid var(--border);font-size:12px">
                  <span class="dgw-badge" style="font-size:9px">×2</span>
                  <span style="font-weight:700;flex:1">${p.name}</span>
                  <span style="color:var(--text3)">${p.pos} · £${p.price}m</span>
                  <span style="font-weight:700;color:var(--purple-fg)">${p.composite}</span>
                  ${wlStarBtn(p)}
                </div>`).join("") ||
                `<div style="color:var(--text3);font-size:12px;padding:6px 0">No additional DGW players found</div>`}
            </div>
          </div>
          ${meta.free_transfers > 0 ? `
            <div style="margin-top:8px;padding:7px 12px;background:var(--green-bg);
              border-radius:0;font-size:11px;color:var(--green-fg)">
              ✅ You have ${meta.free_transfers} free transfer${meta.free_transfers>1?"s":""} —
              good time to bring in DGW coverage
            </div>` : `
            <div style="margin-top:8px;padding:7px 12px;background:var(--amber-bg);
              border-radius:0;font-size:11px;color:var(--amber-fg)">
              ⏸ No free transfers — weigh up whether a hit is justified for DGW coverage
            </div>`}
        </div>`);
    }

    // BGW sections
    for (const gw of upcomingBgwGws) {
      const myBlankPlayers = squad.filter(p => !p.is_sub &&
        p.fixes && p.fixes.filter(f=>f.gw===gw).length === 0);

      sections.push(`
        <div style="margin-bottom:1.5rem">
          <div style="font-size:13px;font-weight:800;color:var(--red-fg);margin-bottom:8px">
            ⚠ GW${gw} Blank Gameweek
          </div>
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
            letter-spacing:.5px;margin-bottom:6px">Your starters who blank</div>
          ${myBlankPlayers.length ? `
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
              ${myBlankPlayers.map(p => `
                <span style="padding:4px 10px;background:var(--red-bg);border-radius:0;
                  font-size:11px;color:var(--red-fg);font-weight:600">
                  ${p.name} (${p.pos})
                </span>`).join("")}
            </div>
            <div style="font-size:12px;color:var(--text2)">
              ${myBlankPlayers.length} starter${myBlankPlayers.length>1?"s":""}
              blank${myBlankPlayers.length===1?"s":""} — consider bench cover or transferring out
            </div>` :
            `<div style="color:var(--green-fg);font-size:12px;padding:6px 0">
              ✅ All your starters have fixtures this GW</div>`}
        </div>`);
    }

    return sections.join("");
  })();

  el("tab-planner").innerHTML = `<div class="card">
    <p style="font-size:12px;color:var(--text2);margin-bottom:.5rem;line-height:1.6">Projects your squad's points over the next 5 GWs. Compare your <strong>current squad</strong> vs the <strong>suggested transfers</strong> applied. The <strong>DGW/BGW planner</strong> tab appears when a double or blank GW is confirmed.</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.6">
      Projected pts = pts/start × FDR modifier × availability. DGW second game at 85%.
    </p>
    ${ftTrackerHtml}
    <div class="pos-tabs" style="margin-bottom:1rem" id="plannerTabs">
      <button class="pos-tab active" onclick="switchPlannerView('current',this)">Current squad</button>
      <button class="pos-tab" onclick="switchPlannerView('suggested',this)">With suggested transfers</button>
      ${hasDgwOrBgw ? `<button class="pos-tab" onclick="switchPlannerView('dgwbgw',this)">🔥 DGW/BGW planner</button>` : ""}
    </div>
    <div id="planner-current">${makeView(squad)}</div>
    <div id="planner-suggested" style="display:none">
      ${transferNote}
      ${makeView(suggestedSquad)}
    </div>
    ${hasDgwOrBgw ? `<div id="planner-dgwbgw" style="display:none">${dgwBgwPanel}</div>` : ""}
    <p style="font-size:11px;color:var(--text3);margin-top:.75rem">
      FDR: ×1.25 FDR1 · ×1.10 FDR2 · ×1.00 FDR3 · ×0.80 FDR4 · ×0.65 FDR5</p>
  </div>`;
}

function switchPlannerView(view, btn) {
  document.querySelectorAll("#plannerTabs .pos-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  el("planner-current").style.display   = view==="current"   ? "block" : "none";
  el("planner-suggested").style.display = view==="suggested" ? "block" : "none";
  const dgwEl = el("planner-dgwbgw");
  if (dgwEl) dgwEl.style.display = view==="dgwbgw" ? "block" : "none";
}

// ── Squad Builder ──────────────────────────────────────────────

let _sbLocked = new Set();
let _sbBanned = new Set();

function renderSquadBuilderShell(meta) {
  const budget = ((meta.squad_value||0) + (meta.bank||0)).toFixed(1);
  const chipsUsed = meta.chips_used || [];
  const wcUsed    = chipsUsed.filter(c=>c==="wildcard").length;
  const fhUsed    = chipsUsed.includes("freehit");
  const curGw     = meta.current_gw || 1;
  const midGw     = 19;

  // Wildcard availability
  let wcStatus = "";
  if (curGw <= midGw) {
    wcStatus = wcUsed === 0
      ? `<span style="color:var(--green-fg)">✅ WC1 available</span>`
      : `<span style="color:var(--text3)">WC1 used</span>`;
  } else {
    wcStatus = wcUsed <= 1
      ? `<span style="color:var(--green-fg)">✅ WC2 available</span>`
      : `<span style="color:var(--text3)">Both wildcards used</span>`;
  }
  const fhStatus = fhUsed
    ? `<span style="color:var(--text3)">FH used</span>`
    : `<span style="color:var(--green-fg)">✅ Free Hit available</span>`;

  el("tab-squadbuilder").innerHTML = `<div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:.3rem">
      <div class="chart-title">Squad Builder</div>
      <div style="font-size:12px;display:flex;gap:12px">${wcStatus} &nbsp; ${fhStatus}</div>
    </div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.6">
      Builds the highest-composite 15-player squad within your budget using a greedy optimisation algorithm. Use for Wildcard or Free Hit planning. Respects the 3-player-per-club limit. <strong>Lock</strong> players you want to keep from your current squad. Automatically detects DGW/BGW fixtures to favour players with a double and avoid blanks.
    </p>

    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem">
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:4px">Budget (£m)</div>
        <input id="sbBudget" type="number" step="0.1" min="80" max="120" value="${budget}"
          style="width:90px;padding:7px 10px;border:1px solid var(--border);border-radius:0;
          background:var(--surface);color:var(--text);font-size:13px;font-family:var(--font)">
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:4px">Mode</div>
        <div class="pos-tabs" id="sbModeTabs" style="margin-bottom:0">
          <button class="pos-tab active" onclick="setSbMode('wildcard',this)">🃏 Wildcard — best 15 for season run-in</button>
          <button class="pos-tab" onclick="setSbMode('freehit',this)">⚡ Free Hit — best 15 for this GW only</button>
        </div>
      </div>
      <button onclick="runSquadBuilder()"
        style="background:var(--text);color:#fff;border:none;border-radius:0;
        padding:9px 20px;font-size:13px;font-weight:700;cursor:pointer;
        font-family:var(--font)">Build squad →</button>
    </div>

    <div style="font-size:11px;color:var(--text2);margin-bottom:1rem">
      💡 <strong>Wildcard:</strong> Penalises BGW players (−60 pts) and boosts DGW players (+18 pts) so your squad plays this GW.
      <strong>Free Hit:</strong> Optimises purely for this GW — great if there's a DGW or your squad has lots of blanks. Resets next week automatically.
      Lock players you want to keep from your current squad.
    </div>
    </div>

    <div id="sbLockPanel" style="margin-bottom:1rem">
      ${buildLockPanel()}
    </div>

    <div id="sbResult"></div>
  </div>`;
}

function buildLockPanel() {
  const squad = _state?.squad || [];
  if (!squad.length) return `<div style="color:var(--text3);font-size:12px">Load a team first.</div>`;
  return `<div style="display:flex;gap:6px;flex-wrap:wrap">
    ${squad.map(p => {
    return `<button onclick="toggleSbLock(${p.id},this)" data-pname="${p.name}"
      style="padding:5px 10px;border-radius:0;font-size:11px;cursor:pointer;
      font-family:var(--font);border:1px solid var(--border);
      background:var(--surface);color:var(--text2)">
      ○ ${p.name}
    </button>`;
    }).join("")}
  </div>`;
}

function toggleSbLock(id, btn) {
  const name = btn.dataset.pname || "";
  if (_sbLocked.has(id)) {
    _sbLocked.delete(id);
    btn.style.background = "var(--surface)";
    btn.style.color      = "var(--text2)";
    btn.style.border     = "1px solid var(--border)";
    btn.textContent      = `○ ${name}`;
  } else {
    _sbLocked.add(id);
    btn.style.background = "var(--blue-bg)";
    btn.style.color      = "var(--blue-fg)";
    btn.style.border     = "1px solid var(--blue-fg)";
    btn.textContent      = `🔒 ${name}`;
  }
}

function setSbMode(mode, btn) {
  document.querySelectorAll("#sbModeTabs .pos-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
}

async function runSquadBuilder() {
  const budget    = parseFloat(el("sbBudget").value) || 100;
  const modeBtn   = document.querySelector("#sbModeTabs .pos-tab.active");
  const mode      = modeBtn?.textContent.includes("Free") ? "freehit" : "wildcard";
  const resultDiv = el("sbResult");

  resultDiv.innerHTML = `<div style="display:flex;align-items:center;gap:10px;
    color:var(--text2);font-size:13px;padding:1rem 0">
    <div class="spinner"></div> Building optimal squad...
  </div>`;

  try {
    const res  = await fetch("/api/squad_builder", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        budget,
        mode,
        locked_ids: [..._sbLocked],
        banned_ids: [..._sbBanned],
        team_id:    _state?.meta?.team_id,
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSquadBuilderResult(data);
  } catch(e) {
    resultDiv.innerHTML = `<div class="err-box">Squad builder failed: ${e.message}</div>`;
  }
}

function renderSquadBuilderResult(data) {
  const squad    = data.squad || [];
  const starters = squad.filter(p=>!p.is_sub);
  const subs     = squad.filter(p=> p.is_sub);
  const gws      = [0,1,2,3].map(i => (_state?.meta?.current_gw||1) + i);

  // Wildcard status banner
  const wcHtml = data.wildcard_available === true
    ? `<div style="padding:8px 12px;background:var(--green-bg);border-radius:0;
        font-size:12px;color:var(--green-fg);margin-bottom:.75rem">
        ✅ Wildcard available — this squad can be set for free</div>`
    : data.wildcard_available === false
    ? `<div style="padding:8px 12px;background:var(--amber-bg);border-radius:0;
        font-size:12px;color:var(--amber-fg);margin-bottom:.75rem">
        ⚠ Wildcard already used this half-season</div>`
    : "";

  // Club violations
  const violations = data.club_violations || {};
  const violHtml = Object.keys(violations).length
    ? `<div style="padding:8px 12px;background:var(--red-bg);border-radius:0;
        font-size:12px;color:var(--red-fg);margin-bottom:.75rem">
        ❌ Club limit breached: ${Object.entries(violations).map(([t,n])=>`${n}× ${t}`).join(", ")} — max 3 per club</div>`
    : "";

  // Summary strip
  const modeLabel = data.mode === "freehit" ? "⚡ Free Hit" : "🃏 Wildcard";
  const modeC     = data.mode === "freehit" ? "var(--purple-fg)" : "var(--blue-fg)";
  const fhNote    = data.mode === "freehit"
    ? `<div style="padding:8px 12px;background:var(--purple-bg);border-radius:0;
        font-size:12px;color:var(--purple-fg);margin-bottom:.75rem;border-left:3px solid var(--purple-fg)">
        ⚡ <strong>Free Hit squad</strong> — optimised for this GW only.
        Your original squad automatically returns next GW.
        BGW badges in future columns are expected — this squad was chosen to maximise <em>this</em> GW.
      </div>`
    : "";

  const summaryHtml = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:1.25rem">
      <div class="sum-stat">
        <div class="sum-stat-lbl">${modeLabel}</div>
        <div class="sum-stat-val" style="color:${modeC}">${data.formation}</div>
        <div class="sum-stat-sub">Suggested formation</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Budget used</div>
        <div class="sum-stat-val">£${data.total_cost}m</div>
        <div class="sum-stat-sub">£${data.remaining}m remaining</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Total composite</div>
        <div class="sum-stat-val">${data.total_comp}</div>
        <div class="sum-stat-sub">Starting XI</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Captain</div>
        <div class="sum-stat-val" style="font-size:16px">${data.captain?.name}</div>
        <div class="sum-stat-sub">VC: ${data.vc?.name||"—"}</div>
      </div>
    </div>`;

  // Club distribution check — max 3 per club
  const clubs = {};
  squad.forEach(p => { clubs[p.team_name] = (clubs[p.team_name]||0)+1; });
  const clubWarning = Object.entries(clubs).filter(([,n])=>n>=3).map(([t,n])=>
    n > 3 ? `❌ ${n}× ${t} (OVER LIMIT)` : `⚠ ${n}× ${t} (at max)`).join(", ");

  // Player table
  function playerRow(p, isStarter, benchNum) {
    const gwCells = gws.map(gw => {
      const proj = (p.projections||[]).find(x=>x.gw===gw);
      if (!proj || proj.blank) return `<td style="text-align:center;color:var(--text3);font-size:11px">${proj?.blank?"BGW":"—"}</td>`;
      const c = proj.proj>=8?"var(--green-fg)":proj.proj>=5?"var(--text)":"var(--text2)";
      const bg = proj.dgw?"var(--purple-bg)":"";
      return `<td style="text-align:center;background:${bg};font-size:12px;font-weight:${isStarter?"700":"400"};color:${c}">${proj.proj}${proj.dgw?"×2":""}</td>`;
    });
    const total    = (p.projections||[]).slice(0,4).reduce((s,x)=>s+(x?.proj||0),0);
    const lockBadge = p.is_locked ? `<span style="font-size:9px;color:var(--blue-fg)">🔒</span> ` : "";
    const capBadge  = p.id===data.captain?.id
      ? `<span style="background:var(--blue-fg);color:#fff;border-radius:50%;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;margin-left:3px">C</span>`
      : p.id===data.vc?.id
      ? `<span style="background:var(--text3);color:#fff;border-radius:50%;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;margin-left:3px">V</span>`
      : "";
    const benchBadge = !isStarter && benchNum
      ? `<span style="font-size:10px;color:var(--text3);margin-right:4px">${benchNum}</span>`
      : "";
    // Flag BGW players in name
    const hasBgw = (p.projections||[]).some(x=>x.gw===gws[0]&&x.blank);
    const bgwBadge = hasBgw ? `<span style="font-size:9px;background:var(--amber-bg);color:var(--amber-fg);padding:1px 4px;border-radius:0;margin-left:3px">BGW</span>` : "";
    const rowBg = !isStarter ? "var(--surface2)" : p.is_locked ? "rgba(55,138,221,0.04)" : hasBgw ? "rgba(251,191,36,0.04)" : "";
    return `<tr style="background:${rowBg};opacity:${isStarter?1:0.75}">
      <td style="font-weight:600"><span data-pid="${p.id}" style="cursor:pointer">${benchBadge}${lockBadge}${p.name}</span>${capBadge}${bgwBadge}</td>
      <td style="font-size:11px;color:var(--text3)">${p.pos}</td>
      <td style="font-size:11px;color:var(--text2)">${p.team_name}</td>
      <td style="font-size:12px;font-weight:700">£${p.price}m</td>
      <td style="font-size:12px">${p.composite}</td>
      ${gwCells.join("")}
      <td style="font-weight:700;color:var(--text2)">${total.toFixed(1)}</td>
    </tr>`;
  }

  const tableHtml = `
    <div style="overflow-x:auto">
    <table class="data-table">
      <thead><tr>
        <th>Player</th><th>Pos</th><th>Team</th><th>Price</th><th>Score</th>
        ${gws.map((gw,i)=>{
          const isCur = i===0;
          const isDgw = (data.squad||[]).some(p=>(p.projections||[]).find(x=>x.gw===gw&&x.dgw));
          const style = isCur ? "color:var(--green-fg);font-weight:800" : "";
          const badge = isDgw ? " 🔥" : "";
          return `<th style="${style}">GW${gw}${badge}${isCur?" ←":""}</th>`;
        }).join("")}
        <th>4GW</th>
      </tr></thead>
      <tbody>
        <tr><td colspan="${gws.length+6}" style="padding:5px 8px;font-size:10px;
          font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;
          background:var(--surface2)">Starting XI · ${data.formation}</td></tr>
        ${starters.map(p=>playerRow(p,true)).join("")}
        <tr><td colspan="${gws.length+6}" style="padding:5px 8px;font-size:10px;
          font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;
          background:var(--surface2)">Bench order (1=first sub)</td></tr>
        ${subs.map((p,i)=>playerRow(p,false,i+1)).join("")}
      </tbody>
    </table></div>
    <p style="font-size:11px;color:var(--text3);margin-top:.5rem">
      Bench order: GKP always first, then outfield players ranked by composite score.
      Lock players in the Squad Builder to force them into the XI.
    </p>`;

  const warningHtml = clubWarning ? `
    <div style="padding:8px 12px;background:var(--amber-bg);border-radius:0;
      font-size:12px;color:var(--amber-fg);margin-bottom:1rem">
      ⚠ Max club check: ${clubWarning}
    </div>` : "";

  el("sbResult").innerHTML = wcHtml + violHtml + fhNote + summaryHtml + warningHtml + tableHtml;
}

// ── Transfer Impact Tracker ────────────────────────────────────

function renderTransferImpactShell(teamId) {
  el("tab-transfers_impact").innerHTML = `<div class="card">
    <div class="chart-title" style="margin-bottom:.3rem">📈 Transfer Impact</div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.6">
      Scores every transfer you've made this season — OUT player points vs IN player
      points over the following 3 GWs. Shows whether each decision helped or hurt
      your rank. Partially scored for recent GWs where less than 3 GWs have passed.
    </p>
    <button onclick="loadTransferImpact(${teamId})"
      style="background:var(--text);color:#fff;border:none;border-radius:0;
      padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;
      font-family:var(--font)">Load transfer history →</button>
    <div id="transferImpactContent" style="margin-top:1.5rem"></div>
  </div>`;
}

async function loadTransferImpact(teamId) {
  const content = el("transferImpactContent");
  content.innerHTML = `<div style="display:flex;align-items:center;gap:10px;
    color:var(--text2);font-size:13px"><div class="spinner"></div>
    Fetching transfer history and scoring each move... (~20 seconds)</div>`;
  try {
    const res  = await fetch(`/api/transfer_impact/${teamId}`);
    const data = await res.json();
    if (data.error) {
      content.innerHTML = `<div class="err-box">Error: ${data.error}</div>`;
      return;
    }
    renderTransferImpact(data);
  } catch(e) {
    content.innerHTML = `<div class="err-box">${e.message}</div>`;
  }
}

function renderTransferImpact(data) {
  const content   = el("transferImpactContent");
  const transfers = data.transfers || [];
  const s         = data.summary   || {};

  if (!transfers.length) {
    content.innerHTML = `<div style="color:var(--text2);font-size:13px">No transfers found.</div>`;
    return;
  }

  // ── Summary strip ────────────────────────────────────────────
  const totalC = (s.total_gain||0) >= 0 ? "var(--green-fg)" : "var(--red-fg)";
  const avgC   = (s.avg_gain||0)   >= 0 ? "var(--green-fg)" : "var(--red-fg)";

  const summaryHtml = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:1.25rem">
      <div class="sum-stat">
        <div class="sum-stat-lbl">Transfers scored</div>
        <div class="sum-stat-val">${s.n_scored||0} <span style="font-size:12px;color:var(--text3)">/ ${s.n_total||0}</span></div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Total pts gain</div>
        <div class="sum-stat-val" style="color:${totalC}">${(s.total_gain||0)>=0?"+":""}${s.total_gain||0}</div>
        <div class="sum-stat-sub">vs holding</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Avg / transfer</div>
        <div class="sum-stat-val" style="color:${avgC}">${(s.avg_gain||0)>=0?"+":""}${s.avg_gain||0}</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Breakdown</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
          <span style="background:var(--green-bg);color:var(--green-fg);padding:2px 7px;border-radius:0;font-size:11px;font-weight:700">${s.very_good||0} very good</span>
          <span style="background:var(--green-bg);color:var(--green-fg);padding:2px 7px;border-radius:0;font-size:11px">${s.good||0} good</span>
          <span style="background:var(--surface2);color:var(--text3);padding:2px 7px;border-radius:0;font-size:11px">${s.average||0} average</span>
          <span style="background:var(--red-bg);color:var(--red-fg);padding:2px 7px;border-radius:0;font-size:11px">${s.bad||0} bad</span>
          <span style="background:var(--red-bg);color:var(--red-fg);padding:2px 7px;border-radius:0;font-size:11px;font-weight:700">${s.very_bad||0} very bad</span>
        </div>
      </div>
    </div>`;

  // ── Best/worst ────────────────────────────────────────────────
  let callouts = "";
  if (s.best && s.best.net_gain != null) {
    callouts = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:1.25rem">
        <div style="padding:10px 14px;background:var(--green-bg);border-radius:0;border-left:3px solid var(--green-fg);border-radius:0">
          <div style="font-size:10px;font-weight:700;color:var(--green-fg);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Best</div>
          <div style="font-weight:700;font-size:12px">${s.best.out_name} → ${s.best.in_name}</div>
          <div style="font-size:11px;color:var(--text2)">GW${s.best.gw} · <span style="color:var(--green-fg);font-weight:700">+${s.best.net_gain} pts</span></div>
        </div>
        <div style="padding:10px 14px;background:var(--red-bg);border-left:3px solid var(--red-fg);border-radius:0">
          <div style="font-size:10px;font-weight:700;color:var(--red-fg);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Worst</div>
          <div style="font-weight:700;font-size:12px">${s.worst.out_name} → ${s.worst.in_name}</div>
          <div style="font-size:11px;color:var(--text2)">GW${s.worst.gw} · <span style="color:var(--red-fg);font-weight:700">${s.worst.net_gain} pts</span></div>
        </div>
      </div>`;
  }

  // ── Charts ────────────────────────────────────────────────────
  // Build cumulative line data (reverse transfers array which is newest-first)
  const chronological = [...transfers].reverse().filter(t => t.net_gain != null);
  let cumul = 0;
  const cumulData = chronological.map(t => {
    cumul += t.net_gain;
    return { x: t.gw, y: cumul, label: `GW${t.gw}: ${t.out_name} → ${t.in_name}` };
  });

  // Scatter: X = GW (with jitter for same-GW transfers), Y = actual 3GW gain
  // Using GW avoids same-composite stacking; jitter separates multiple transfers per GW
  const gwCounts = {};
  chronological.forEach(t => { gwCounts[t.gw] = (gwCounts[t.gw]||0) + 1; });
  const gwOffsets = {};
  chronological.forEach(t => {
    gwOffsets[t.gw] = gwOffsets[t.gw] == null ? 0 : gwOffsets[t.gw] + 1;
  });
  const gwSeenCount = {};
  const scatterData = chronological.map(t => {
    gwSeenCount[t.gw] = (gwSeenCount[t.gw]||0) + 1;
    const total   = gwCounts[t.gw];
    const idx     = gwSeenCount[t.gw] - 1;
    const spread  = total > 1 ? 0.35 : 0;
    const jitter  = total > 1 ? (idx / (total - 1) - 0.5) * spread * 2 : 0;
    return {
      x: t.gw + jitter,
      y: t.net_gain,
      label: `GW${t.gw}: ${t.out_name} → ${t.in_name}`,
      verdict: t.verdict,
    };
  });

  const SCATTER_COLOURS = {
    very_good: "#3B6D11",
    good:      "#146622",
    average:   "#4a4e49",
    bad:       "#9c1a1a",
    very_bad:  "#7a1019",
  };
  const scatterColors = scatterData.map(d => SCATTER_COLOURS[d.verdict] || "#4a4e49");

  // ── Group transfers by GW for cumulative line ─────────────────
  const byGw = {};
  chronological.forEach(t => {
    byGw[t.gw] = (byGw[t.gw] || 0) + t.net_gain;
  });
  const gwKeys   = Object.keys(byGw).sort((a,b) => a-b).map(Number);
  const gwLabels = gwKeys.map(g => `GW${g}`);
  const gwGains  = gwKeys.map(g => byGw[g]);
  let gwRun = 0;
  const gwCumul  = gwKeys.map(g => { gwRun += byGw[g]; return gwRun; });

  const chartsHtml = `
    <div style="margin-bottom:1.25rem">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:3px">Cumulative pts gain by gameweek</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px">
        Net pts gained or lost per GW (sums multiple transfers). Line = running total.
      </div>
      <div style="position:relative;width:100%;height:180px">
        <canvas id="tiLineChart" role="img"
          aria-label="Cumulative transfer impact by gameweek, ${gwKeys.length} GWs with transfers">
          ${gwRun >= 0 ? '+' : ''}${gwRun} pts total.
        </canvas>
      </div>
    </div>

    <div style="margin-bottom:1.5rem">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
        letter-spacing:.5px;margin-bottom:3px">Individual transfer gain/loss</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px">
        Each bar = one transfer (IN minus OUT over 3 GWs). Green = better than holding.
      </div>
      <div style="display:flex;gap:12px;font-size:11px;color:var(--text2);margin-bottom:6px">
        <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#146622;display:inline-block;border-radius:0"></span>Gain</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#a3182a;display:inline-block;border-radius:0"></span>Loss</span>
      </div>
      <div style="position:relative;width:100%;height:${Math.max(160, chronological.length * 18)}px">
        <canvas id="tiScatterChart" role="img"
          aria-label="Individual transfer gains and losses, ${chronological.length} transfers">
          ${chronological.length} transfers scored.
        </canvas>
      </div>
    </div>`;

  // ── Per-transfer table ─────────────────────────────────────────
  const verdictStyle = {
    very_good: "background:var(--green-bg);color:var(--green-fg);font-weight:800",
    good:      "background:var(--green-bg);color:var(--green-fg)",
    average:   "background:var(--surface2);color:var(--text3)",
    bad:       "background:var(--red-bg);color:var(--red-fg)",
    very_bad:  "background:var(--red-bg);color:var(--red-fg);font-weight:800",
  };
  const verdictIcon = { very_good:"★", good:"↑", average:"→", bad:"↓", very_bad:"✗" };

  const rows = transfers.map(t => {
    const scored  = t.net_gain != null;
    const partial = t.partially_scored && !t.scoreable;
    const netC    = !scored ? "var(--text3)" : t.net_gain > 0 ? "var(--green-fg)" : t.net_gain < 0 ? "var(--red-fg)" : "var(--text2)";
    const nGws    = Math.max(t.in_pts_gws?.length||0, t.out_pts_gws?.length||0);

    let gwCells = "";
    for (let i = 0; i < 3; i++) {
      if (i < nGws) {
        const ip = t.in_pts_gws[i] ?? "—", op = t.out_pts_gws[i] ?? "—";
        const diff = typeof ip==="number" && typeof op==="number" ? ip-op : null;
        const dc = diff===null?"var(--text3)":diff>0?"var(--green-fg)":diff<0?"var(--red-fg)":"var(--text2)";
        gwCells += `<td style="text-align:center;font-size:11px">
          <span style="color:var(--green-fg)">${ip}</span><span style="color:var(--text3)"> / </span><span style="color:var(--red-fg)">${op}</span>
          ${diff!==null?`<div style="font-size:10px;color:${dc};font-weight:700">${diff>0?"+":""}${diff}</div>`:""}
        </td>`;
      } else {
        gwCells += `<td style="text-align:center;color:var(--text3);font-size:11px">—</td>`;
      }
    }

    const verdict = t.verdict
      ? `<span style="${verdictStyle[t.verdict]};padding:2px 7px;border-radius:0;font-size:11px;font-weight:700">${verdictIcon[t.verdict]} ${t.verdict}</span>`
      : partial ? `<span style="background:var(--amber-bg);color:var(--amber-fg);padding:2px 7px;border-radius:0;font-size:11px">partial</span>`
      : `<span style="color:var(--text3);font-size:11px">pending</span>`;

    const costCell = t.cost_diff !== 0
      ? `<span style="color:${t.cost_diff>0?"var(--red-fg)":"var(--green-fg)"};font-size:11px">${t.cost_diff>0?"−":"+"}£${Math.abs(t.cost_diff)}m</span>`
      : `<span style="color:var(--text3);font-size:11px">even</span>`;

    return `<tr>
      <td style="font-size:11px;color:var(--text3);font-weight:700">GW${t.gw}</td>
      <td><div style="font-size:12px;color:var(--red-fg)">${t.out_name} <span style="font-size:10px;color:var(--text3)">${t.out_team_name}</span></div>
          <div style="font-size:10px;color:var(--text3)">£${t.out_cost}m</div></td>
      <td style="color:var(--text3);font-size:12px">→</td>
      <td><div style="font-size:12px;color:var(--green-fg)">${t.in_name} <span style="font-size:10px;color:var(--text3)">${t.in_team_name}</span></div>
          <div style="font-size:10px;color:var(--text3)">£${t.in_cost}m</div></td>
      <td style="text-align:center">${costCell}</td>
      ${gwCells}
      <td style="text-align:center;font-weight:800;color:${netC}">
        ${scored ? (t.net_gain>0?"+":"")+t.net_gain : "—"}
        ${partial?`<div style="font-size:9px;color:var(--amber-fg)">${t.n_gws_scored}/3</div>`:""}
      </td>
      <td>${verdict}</td>
    </tr>`;
  }).join("");

  const tableHtml = `
    <div style="overflow-x:auto">
    <table class="data-table">
      <thead><tr>
        <th>GW</th><th>Out</th><th></th><th>In</th><th>Cost</th>
        <th title="IN/OUT pts GW+1">GW+1</th>
        <th title="IN/OUT pts GW+2">GW+2</th>
        <th title="IN/OUT pts GW+3">GW+3</th>
        <th>3GW net</th><th>Verdict</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p style="font-size:11px;color:var(--text3);margin-top:.5rem">
      Each cell: IN pts / OUT pts. Green net = good transfer.
      Partial = fewer than 3 GWs scored yet.
    </p>`;

  content.innerHTML = summaryHtml + callouts + chartsHtml + tableHtml;

  // ── Render charts after DOM update ────────────────────────────
  requestAnimationFrame(() => {
    const textCol = "#4a4e49";
    const gridCol = "rgba(0,0,0,0.06)";

    // Chart 1: cumulative by GW (bar per GW + cumulative line)
    const lineCanvas = document.getElementById("tiLineChart");
    if (lineCanvas && gwKeys.length > 0) {
      new Chart(lineCanvas, {
        data: {
          labels: gwLabels,
          datasets: [
            {
              type: "bar",
              label: "GW net",
              data: gwGains,
              backgroundColor: gwGains.map(g => g >= 0 ? "#cfe0b0" : "#e0b0b0"),
              borderColor:     gwGains.map(g => g >= 0 ? "#146622" : "#a3182a"),
              borderWidth: 1,
              borderRadius: 3,
              yAxisID: "y",
            },
            {
              type: "line",
              label: "Running total",
              data: gwCumul,
              borderColor: "#0c6e6e",
              backgroundColor: "transparent",
              pointBackgroundColor: gwCumul.map(v => v >= 0 ? "#0c6e6e" : "#a3182a"),
              pointRadius: 4,
              tension: 0,
              borderWidth: 2,
              yAxisID: "y",
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: "index",
              callbacks: {
                label: ctx => ctx.datasetIndex === 0
                  ? `GW net: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y} pts`
                  : `Running total: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y} pts`
              }
            }
          },
          scales: {
            x: { ticks: { color: textCol, font: { size: 11 } }, grid: { color: gridCol } },
            y: {
              ticks: { color: textCol, font: { size: 11 }, callback: v => (v>=0?"+":"")+v },
              grid: { color: gridCol }
            }
          }
        }
      });
    }

    // Chart 2: horizontal bar — one bar per individual transfer
    const barCanvas = document.getElementById("tiScatterChart");
    if (barCanvas && chronological.length > 0) {
      const barLabels = chronological.map(t =>
        `GW${t.gw}: ${t.out_name} → ${t.in_name}`
      );
      const barGains  = chronological.map(t => t.net_gain);
      const barColours = barGains.map(g => g >= 0 ? "#146622" : "#a3182a");

      new Chart(barCanvas, {
        type: "bar",
        data: {
          labels: barLabels,
          datasets: [{
            label: "3GW net",
            data: barGains,
            backgroundColor: barColours,
            borderRadius: 3,
            barThickness: 14,
          }]
        },
        options: {
          indexAxis: "y",
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => `${ctx.parsed.x >= 0 ? "+" : ""}${ctx.parsed.x} pts vs holding`
              }
            }
          },
          scales: {
            x: {
              ticks: { color: textCol, font: { size: 11 }, callback: v => (v>=0?"+":"")+v },
              grid: { color: gridCol }
            },
            y: {
              ticks: { color: textCol, font: { size: 10 } },
              grid: { display: false }
            }
          }
        }
      });
    }

    // Scatter
    const scatterCanvas = document.getElementById("tiScatterChart");
    if (scatterCanvas && scatterData.length > 0) {
      const allY = scatterData.map(d => d.y);
      const yPad = Math.max(4, (Math.max(...allY) - Math.min(...allY)) * 0.15);

      new Chart(scatterCanvas, {
        type: "scatter",
        data: {
          datasets: [{
            label: "Transfer",
            data: scatterData,
            backgroundColor: scatterColors,
            pointRadius: 7,
            pointHoverRadius: 9,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const d = scatterData[ctx.dataIndex];
                  return [d.label, `3GW gain: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y} pts`, `Verdict: ${d.verdict?.replace("_"," ")}`];
                }
              }
            }
          },
          scales: {
            x: {
              type: "linear", min: 0, max: 39,
              title: { display: true, text: "Gameweek", color: textCol, font: { size: 11 } },
              ticks: { color: textCol, font: { size: 11 }, stepSize: 5,
                callback: v => v > 0 && v < 39 ? `GW${v}` : "" },
              grid: { color: gridCol }
            },
            y: {
              min: Math.min(...allY) - yPad,
              max: Math.max(...allY) + yPad,
              title: { display: true, text: "3GW pts gain vs holding", color: textCol, font: { size: 11 } },
              ticks: { color: textCol, font: { size: 11 }, callback: v => (v >= 0 ? "+" : "") + v },
              grid: { color: gridCol }
            }
          }
        }
      });
    }
  });
}



// ── Run-in Tracker ─────────────────────────────────────────────

function renderRunIn(data, meta) {
  const squad     = data.squad || [];
  const allP      = data.all_players || [];
  const starters  = squad.filter(p => !p.is_sub && p.pos !== "GKP");
  const curGw     = meta.current_gw || 1;
  const bank      = meta.bank || 0;
  const ft        = meta.free_transfers || 1;
  const chipsUsed = meta.chips_used || [];
  const dgwSummary = data.dgw_summary || {};
  const bgwGws     = data.bgw_gws || [];
  const N = Math.min(5, 38 - curGw + 1);

  // ── FT plan ──────────────────────────────────────────────────
  // Simulate rolling FT count for next 5 GWs (max 2)
  const ftPlan = [];
  let ft_rolling = ft;
  for (let i = 0; i < N; i++) {
    const gw = curGw + i;
    const maxFt  = Math.min(ft_rolling + (i > 0 ? 1 : 0), 2);
    ftPlan.push({ gw, ft: maxFt });
    if (i === 0) ft_rolling = Math.min(ft + 1, 2);
  }

  // ── Chip availability ─────────────────────────────────────────
  const wcCount  = chipsUsed.filter(c=>c==="wildcard").length;
  const tcUsed   = chipsUsed.includes("3xc");
  const fhUsed   = chipsUsed.includes("freehit");
  const bbUsed   = chipsUsed.includes("bboost");
  const midGw    = 19;
  const wc2Avail = curGw > midGw && wcCount <= 1;
  const wc1Avail = curGw <= midGw && wcCount === 0;

  // ── 5-GW projections per starter ─────────────────────────────
  const projGrid = starters.map(p => {
    const projs = Array.from({length:N}, (_,i) => {
      const gw = curGw + i;
      const proj = (p.projections||[]).find(x=>x.gw===gw)
                || { gw, proj: 0, blank: true, dgw: false };
      return proj;
    });
    return { p, projs, total: projs.reduce((s,x)=>s+(x.proj||0),0) };
  }).sort((a,b) => b.total - a.total);

  // ── Captain by GW ─────────────────────────────────────────────
  const capByGw = Array.from({length:N}, (_,i) => {
    const gw = curGw + i;
    const best = starters.reduce((best, p) => {
      const proj = (p.projections||[]).find(x=>x.gw===gw)?.proj || 0;
      return proj > (best.proj||0) ? {p, proj} : best;
    }, {proj:0});
    return { gw, player: best.p, proj: best.proj };
  });

  // TC recommendation — best single GW projection among all starters
  const tcBest = capByGw.reduce((best, c) =>
    c.proj > best.proj ? c : best, {proj:0});

  // ── Squad GW scores (blanks/doubles) ─────────────────────────
  const gwTotals = Array.from({length:N}, (_,i) => {
    const gw = curGw + i;
    return starters.reduce((s,p) => {
      const proj = (p.projections||[]).find(x=>x.gw===gw)?.proj || 0;
      return s + proj;
    }, 0);
  });

  // ── DGW/BGW flags per GW ─────────────────────────────────────
  const gwFlags = Array.from({length:N}, (_,i) => {
    const gw = curGw + i;
    const isDgw = (dgwSummary[String(gw)]||[]).length > 0;
    const isBgw = bgwGws.includes(gw);
    return { gw, isDgw, isBgw,
      dgwTeams: dgwSummary[String(gw)]||[],
      label: isDgw ? "🔥 DGW" : isBgw ? "⚠ BGW" : "" };
  });

  // ── Chip timing recommendation ────────────────────────────────
  let chipRec = "";
  if (!tcUsed) {
    const tcGw = tcBest;
    if (tcGw.proj > 0) {
      const isDgw = gwFlags.find(g=>g.gw===tcGw.gw)?.isDgw;
      chipRec = `<div style="padding:10px 14px;background:var(--purple-bg);border-radius:0;
        border-left:3px solid var(--purple-fg);margin-bottom:1rem;font-size:13px">
        <strong style="color:var(--purple-fg)">🎯 Triple Captain timing:</strong>
        GW${tcGw.gw} — ${tcGw.player?.name||"?"} projecting ${tcGw.proj.toFixed(1)}pts
        ${isDgw ? `<span class="dgw-badge" style="font-size:9px">DGW ×2</span>` : ""}
        → TC would yield ~${(tcGw.proj*3).toFixed(0)}pts
        ${isDgw ? "(×3 + DGW = massive haul potential)" : ""}
      </div>`;
    }
  }

  // ── Build HTML ────────────────────────────────────────────────
  // GW header row
  const gwHeaders = gwFlags.map(g =>
    `<th style="text-align:center;${g.isDgw?"color:var(--purple-fg)":g.isBgw?"color:var(--red-fg)":""}">
      GW${g.gw}${g.label?`<br><span style="font-size:9px">${g.label}</span>`:""}
    </th>`
  ).join("");

  // FT row
  const ftRow = ftPlan.map(f =>
    `<td style="text-align:center;font-weight:700;color:${f.ft===2?"var(--green-fg)":"var(--text2)"}">
      ${f.ft} FT</td>`
  ).join("");

  // Projection rows
  const projRows = projGrid.map(({p, projs, total}) => {
    const isCap = p.id === capByGw[0]?.player?.id;
    const cells = projs.map(proj => {
      if (proj.blank) return `<td style="text-align:center;color:var(--text3);font-size:11px">BGW</td>`;
      const c = proj.proj>=10?"var(--green-fg)":proj.proj>=6?"var(--text)":"var(--text2)";
      const bg = proj.dgw?"background:var(--purple-bg);":"";
      return `<td style="text-align:center;${bg}font-weight:700;color:${c}">${proj.proj.toFixed(1)}${proj.dgw?"×":""}
      </td>`;
    }).join("");
    return `<tr>
      <td style="font-weight:${isCap?"800":"600"};white-space:nowrap">
        ${isCap?`<span style="color:var(--blue-fg)">(C) </span>`:""}${p.name}
        ${dgwBadge(p)}
      </td>
      <td style="font-size:11px;color:var(--text3)">${p.pos}</td>
      <td style="font-size:11px;color:var(--text2)">${p.team_name}</td>
      ${cells}
      <td style="font-weight:700;color:var(--text2)">${total.toFixed(1)}</td>
    </tr>`;
  }).join("");

  // Totals row
  const totalRow = gwTotals.map(t =>
    `<td style="text-align:center;font-weight:800;font-size:13px">${t.toFixed(1)}</td>`
  ).join("");

  // Captain recommendation row
  const capRow = capByGw.map(c => {
    const isDgw = gwFlags.find(g=>g.gw===c.gw)?.isDgw;
    return `<td style="text-align:center;font-size:11px;font-weight:700;
      color:var(--blue-fg)">
      ${c.player?.name?.split(" ").pop()||"?"}<br>
      <span style="font-size:10px;color:var(--text2)">${c.proj.toFixed(1)}${isDgw?"×2":""}</span>
    </td>`;
  }).join("");

  // Transfer suggestions per GW
  const transferRows = Array.from({length:N}, (_,i) => {
    const gw = curGw + i;
    const gwFt = ftPlan[i].ft;
    // Find best transfer targets for this GW (DGW teams prioritised)
    const dgwTeams = gwFlags[i].dgwTeams;
    const targets = allP
      .filter(p => !squad.find(s=>s.id===p.id)
               && p.status==="a" && (p.chance==null||p.chance>=75)
               && p.starts>=3)
      .sort((a,b) => {
        const aBonus = dgwTeams.includes(a.team_name) ? 20 : 0;
        const bBonus = dgwTeams.includes(b.team_name) ? 20 : 0;
        return (b.composite+bBonus) - (a.composite+aBonus);
      }).slice(0,3);

    const suggest = targets.length
      ? targets.map(t=>`${t.name}${dgwTeams.includes(t.team_name)?" 🔥":""}`).join(", ")
      : "Hold";
    return `<td style="font-size:10px;color:var(--text2);padding:4px 6px">
      ${gwFt}FT: ${suggest}</td>`;
  }).join("");

  el("tab-runin").innerHTML = `<div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:.75rem">
      <div class="chart-title">🏁 Run-in Tracker</div>
      <div style="font-size:12px;display:flex;gap:10px;flex-wrap:wrap">
        ${!tcUsed?`<span style="color:var(--green-fg)">✅ TC available</span>`:`<span style="color:var(--text3)">TC used</span>`}
        ${!fhUsed?`<span style="color:var(--green-fg)">✅ FH available</span>`:`<span style="color:var(--text3)">FH used</span>`}
        ${!bbUsed?`<span style="color:var(--green-fg)">✅ BB available</span>`:`<span style="color:var(--text3)">BB used</span>`}
        ${wc1Avail||wc2Avail?`<span style="color:var(--green-fg)">✅ WC available</span>`:`<span style="color:var(--text3)">WC used</span>`}
      </div>
    </div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:.75rem;line-height:1.6">
      5-GW forward view of your squad. Shows projected points per player per GW,
      recommended captain each week, FT availability, and transfer targets.
      DGW weeks highlighted in purple, BGWs in red.
    </p>

    ${chipRec}

    <div style="overflow-x:auto">
    <table class="data-table">
      <thead>
        <tr>
          <th>Player</th><th>Pos</th><th>Team</th>
          ${gwHeaders}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${projRows}
        <tr style="background:var(--surface2);font-weight:800">
          <td colspan="3" style="font-size:11px;font-weight:700;color:var(--text3)">
            Squad total (XI)</td>
          ${totalRow}
          <td></td>
        </tr>
        <tr style="background:rgba(55,138,221,0.06)">
          <td colspan="3" style="font-size:11px;font-weight:700;color:var(--blue-fg)">
            Captain pick</td>
          ${capRow}
          <td></td>
        </tr>
        <tr style="background:var(--surface2)">
          <td colspan="3" style="font-size:11px;font-weight:700;color:var(--text3)">
            Free transfers</td>
          ${ftRow}
          <td></td>
        </tr>
        <tr>
          <td colspan="3" style="font-size:11px;font-weight:700;color:var(--text3)">
            Transfer targets</td>
          ${transferRows}
          <td></td>
        </tr>
      </tbody>
    </table></div>

    <div style="margin-top:1rem;font-size:11px;color:var(--text3);line-height:1.8">
      <strong>FT strategy:</strong> Banking a FT this GW gives 2 FTs next week — worth it if no urgent transfer needed.<br>
      <strong>TC timing:</strong> Best used on a DGW week with your highest-projected captain. Avoid using on a BGW.<br>
      <strong>FH timing:</strong> Best used on a BGW to avoid blanks, or to maximise a DGW without permanent squad changes.
    </div>
  </div>`;
}

// ── Panel Report ───────────────────────────────────────────────

function renderPanelShell() {
  el("tab-panel").innerHTML = `<div class="card">
    <div class="chart-title" style="margin-bottom:.4rem">📊 100-Manager Panel</div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:.5rem;line-height:1.6">Measures whether the model's captain and transfer suggestions would have outperformed 100 real managers. Captures snapshots automatically each GW and scores them after results come in. After 5+ GWs this becomes the primary calibration signal for weight adjustments.</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.6">
      Tracks model suggestion quality across a fixed panel of 100 managers sampled
      from the current top-100 standings. Snapshots are captured automatically each GW.
      After each GW completes, actual points are fetched and suggestions scored.
    </p>
    <button onclick="loadPanelReport()"
      style="background:var(--text);color:#fff;border:none;border-radius:0;
      padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;
      font-family:var(--font)">Load report →</button>
    <div id="panelContent" style="margin-top:1.5rem"></div>
  </div>`;
}

async function initPanel() {
  const statusDiv = el("panelInitStatus");
  if (statusDiv) statusDiv.textContent = "Fetching top-100 managers from FPL standings...";
  try {
    const res  = await fetch("/api/panel_init");
    const data = await res.json();
    if (data.status === "ok") {
      if (statusDiv) statusDiv.innerHTML =
        `<span style="color:var(--green-fg)">✓ ${data.message}</span>`;
      setTimeout(loadPanelReport, 1000);
    } else {
      if (statusDiv) statusDiv.innerHTML =
        `<span style="color:var(--red-fg)">✗ ${data.message}</span>`;
    }
  } catch(e) {
    if (statusDiv) statusDiv.innerHTML =
      `<span style="color:var(--red-fg)">✗ ${e.message}</span>`;
  }
}

async function loadPanelReport() {
  el("panelContent").innerHTML = `<div style="display:flex;align-items:center;gap:10px;
    color:var(--text2);font-size:13px"><div class="spinner"></div> Loading...</div>`;
  try {
    const res  = await fetch("/api/panel_report");
    const data = await res.json();
    renderPanelReport(data);
  } catch(e) {
    el("panelContent").innerHTML = `<div class="err-box">Panel report failed: ${e.message}</div>`;
  }
}

function renderPanelReport(data) {
  if (data.status === "error") {
    el("panelContent").innerHTML = `<div class="err-box">
      Panel error: ${data.message}</div>`;
    return;
  }

  if (data.status === "not_initialised") {
    el("panelContent").innerHTML = `<div style="font-size:13px;color:var(--text2);line-height:1.7">
      <p>Panel not yet initialised.</p>
      <p style="margin-top:.5rem">This fetches the current top-100 manager IDs and saves them
      permanently. Takes about 10 seconds. Only needs to run once.</p>
      <button onclick="initPanel()"
        style="margin-top:.75rem;background:var(--purple-fg);color:#fff;border:none;
        border-radius:0;padding:9px 20px;font-size:13px;font-weight:700;cursor:pointer;
        font-family:var(--font)">Initialise panel →</button>
      <div id="panelInitStatus" style="margin-top:.75rem;font-size:12px;color:var(--text3)"></div>
    </div>`;
    return;
  }

  if (data.status === "no_data") {
    el("panelContent").innerHTML = `<div style="color:var(--text2);font-size:13px;line-height:1.7">
      <p>${data.message}</p>
      <p style="margin-top:.5rem;color:var(--text3)">Panel size: <strong>${data.panel_size}</strong> managers tracked</p>
      ${data.pending_gws?.length ? `<p style="margin-top:.5rem;color:var(--green-fg);font-size:12px">
        ✓ Snapshot captured — evaluation will run automatically after GW completes.</p>` : ""}
    </div>`;
    return;
  }

  const byGw   = data.by_gw || {};
  const gwKeys = Object.keys(byGw).sort((a,b)=>parseInt(a)-parseInt(b));

  // Summary strip
  const capC = data.cap_avg_delta > 0 ? "var(--green-fg)" : "var(--red-fg)";
  const trC  = data.strong_transfer_avg > 0 ? "var(--green-fg)" : "var(--red-fg)";
  const summary = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:1.5rem">
      <div class="sum-stat">
        <div class="sum-stat-lbl">Panel size</div>
        <div class="sum-stat-val">${data.panel_size}</div>
        <div class="sum-stat-sub">managers tracked</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">GWs tracked</div>
        <div class="sum-stat-val">${data.gws_tracked}</div>
      </div>
      ${data.cap_avg_delta != null ? `<div class="sum-stat">
        <div class="sum-stat-lbl">Captain Δ (avg)</div>
        <div class="sum-stat-val" style="color:${capC}">${data.cap_avg_delta > 0 ? "+" : ""}${data.cap_avg_delta}pts</div>
        <div class="sum-stat-sub">${data.cap_avg_delta > 0 ? "Model beats managers" : "Managers beat model"}</div>
      </div>` : ""}
      ${data.strong_transfer_avg != null ? `<div class="sum-stat">
        <div class="sum-stat-lbl">Strong transfer Δ</div>
        <div class="sum-stat-val" style="color:${trC}">${data.strong_transfer_avg > 0 ? "+" : ""}${data.strong_transfer_avg}pts</div>
        <div class="sum-stat-sub">avg 3GW gain</div>
      </div>` : ""}
    </div>`;

  // Per-GW table
  const tableRows = gwKeys.map(gw => {
    const d  = byGw[gw];
    const cc = d.cap_avg_delta > 0 ? "var(--green-fg)" : d.cap_avg_delta < 0 ? "var(--red-fg)" : "var(--text3)";
    const tc = d.transfer_strong_avg > 0 ? "var(--green-fg)" : d.transfer_strong_avg < 0 ? "var(--red-fg)" : "var(--text3)";
    return `<tr>
      <td>GW${gw}</td>
      <td style="color:${cc};font-weight:700">${d.cap_avg_delta != null ? (d.cap_avg_delta > 0 ? "+" : "") + d.cap_avg_delta + "pts" : "—"}</td>
      <td>${d.cap_win_pct != null ? d.cap_win_pct + "%" : "—"}</td>
      <td style="color:${tc};font-weight:700">${d.transfer_strong_avg != null ? (d.transfer_strong_avg > 0 ? "+" : "") + d.transfer_strong_avg + "pts" : "—"}</td>
      <td>${d.transfer_strong_n != null ? d.transfer_strong_n : "—"}</td>
    </tr>`;
  }).join("");

  const table = gwKeys.length ? `
    <div style="overflow-x:auto">
    <table class="data-table">
      <thead><tr>
        <th>GW</th>
        <th title="Model captain avg pts minus actual captain avg pts">Cap Δ</th>
        <th title="% of GWs model captain outscored actual captain">Cap win%</th>
        <th title="Avg 3GW pts gain for Strong transfers">Strong Δ</th>
        <th title="Number of Strong transfer suggestions evaluated">n</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
    <p style="font-size:11px;color:var(--text3);margin-top:.75rem">
      Cap Δ: positive = model captain outperformed. Evaluated across all 100 panel managers.<br>
      Strong Δ: avg points gained vs held over 3 GWs. Target: consistently positive after 5+ GWs.
    </p>` : `<p style="color:var(--text3);font-size:12px">No GW data yet — check back after first GW completes.</p>`;

  el("panelContent").innerHTML = summary + table;
}

// ── Season Review ──────────────────────────────────────────────

function renderSeasonReviewShell(teamId) {
  el("tab-seasonreview").innerHTML = `<div class="card">
    <div class="chart-title" style="margin-bottom:.4rem">Season Review</div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.6">
      Simulates what the model would have recommended from GW1 — transfers, captain picks,
      and optimal formation each week. Compares to your actual decisions.
      Takes ~60 seconds on first run (fetches every player's GW history).
    </p>
    <button id="srRunBtn" onclick="runSeasonReview(${teamId})"
      style="background:var(--text);color:#fff;border:none;border-radius:0;
      padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;
      font-family:var(--font)">Run season review →</button>
    <div id="srContent" style="margin-top:1.5rem"></div>
  </div>`;
}

async function runSeasonReview(teamId) {
  const btn = el("srRunBtn");
  btn.disabled = true;
  btn.textContent = "Running simulation...";
  el("srContent").innerHTML = `<div style="display:flex;align-items:center;gap:10px;
    color:var(--text2);font-size:13px">
    <div class="spinner"></div>
    Fetching GW picks and player histories — this takes about 60 seconds...
  </div>`;

  try {
    const res  = await fetch(`/api/season_review/${teamId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSeasonReviewResults(data);
  } catch(e) {
    el("srContent").innerHTML = `<div class="err-box">Season review failed: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-run season review →";
  }
}

function renderSeasonReviewResults(data) {
  const s   = data.summary;
  const gws = data.gw_results;

  const diffC    = s.diff >= 0 ? "var(--green-fg)" : "var(--red-fg)";
  const capAgrPct = s.cap_total ? Math.round(s.cap_agreed / s.cap_total * 100) : 0;
  const trnAgrPct = s.transfers_total ? Math.round(s.transfers_agreed / s.transfers_total * 100) : 0;
  const capGainC  = s.cap_pts_gain >= 0 ? "var(--green-fg)" : "var(--red-fg)";

  // ── Summary strip ─────────────────────────────────────────────
  const summaryHtml = `
    <div class="summary-strip" style="margin-bottom:1.5rem">
      <div class="sum-stat">
        <div class="sum-stat-lbl">Your total</div>
        <div class="sum-stat-val">${s.actual_total}</div>
        <div class="sum-stat-sub">Actual points</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Model total</div>
        <div class="sum-stat-val" style="color:${diffC}">${s.model_total}</div>
        <div class="sum-stat-sub">${s.diff >= 0 ? "+" : ""}${s.diff} vs yours</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Captain agreement</div>
        <div class="sum-stat-val">${capAgrPct}%</div>
        <div class="sum-stat-sub">${s.cap_agreed} / ${s.cap_total} GWs</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Captain pts gain</div>
        <div class="sum-stat-val" style="color:${capGainC}">${s.cap_pts_gain >= 0 ? "+" : ""}${s.cap_pts_gain}</div>
        <div class="sum-stat-sub">Model vs yours</div>
      </div>
      <div class="sum-stat">
        <div class="sum-stat-lbl">Transfer agreement</div>
        <div class="sum-stat-val">${trnAgrPct}%</div>
        <div class="sum-stat-sub">${s.transfers_agreed} / ${s.transfers_total} weeks</div>
      </div>
    </div>`;

  // ── Charts ────────────────────────────────────────────────────
  const gwNums   = gws.map(r => r.gw);
  const actPts   = gws.map(r => r.actual_pts);
  const modPts   = gws.map(r => r.model_pts);
  let cumA = 0, cumM = 0;
  const cumAct = gws.map(r => { cumA += r.actual_pts; return cumA; });
  const cumMod = gws.map(r => { cumM += r.model_pts;  return cumM; });
  const capDiff = gws.map(r => r.captain.model_pts - r.captain.actual_pts);

  const chartsHtml = `
    <div class="chart-sec">
      <div class="chart-title">GW points — you vs model</div>
      <div class="chart-sub">Your actual GW score vs what the model's XI + captain would have scored</div>
      <div class="chart-leg">
        <span><b style="background:#123a70"></b>Your actual</span>
        <span><b style="background:#1a8a26"></b>Model suggestion</span>
      </div>
      <div class="chart-wrap" style="height:220px"><canvas id="srGwChart"></canvas></div>
    </div>
    <div class="chart-sec">
      <div class="chart-title">Cumulative points — you vs model</div>
      <div class="chart-sub">Running total — gap shows where decisions diverged over the season</div>
      <div class="chart-wrap" style="height:200px"><canvas id="srCumChart"></canvas></div>
    </div>
    <div class="chart-sec">
      <div class="chart-title">Captain decision delta per GW</div>
      <div class="chart-sub">Difference in captain points each week (green = model was better, red = you were better)</div>
      <div class="chart-wrap" style="height:160px"><canvas id="srCapChart"></canvas></div>
    </div>`;

  // ── GW by GW table ────────────────────────────────────────────
  // ── GW by GW expandable cards ─────────────────────────────────
  const gwCards = gws.map(r => {
    const diffC2   = r.diff > 5 ? "var(--green-fg)" : r.diff < -5 ? "var(--red-fg)" : "var(--text2)";
    const chipBadge = r.chip
      ? `<span class="badge badge-purple" style="font-size:9px">${r.chip}</span>` : "";

    const capAgreed = r.captain.agreed === true
      ? `<span class="badge badge-green" style="font-size:10px">✓ ${r.captain.actual_name}</span>`
      : r.captain.agreed === false
      ? `<span class="badge badge-red" style="font-size:10px">✗ You: ${r.captain.actual_name} · Model: ${r.captain.model_name}</span>`
      : `<span style="font-size:11px;color:var(--text3)">${r.captain.actual_name}</span>`;

    const modelTrn = r.model_transfers.length
      ? r.model_transfers.map(t =>
          `<div style="font-size:11px;margin-bottom:2px">
            <span style="color:var(--text3);text-decoration:line-through">${t.out}</span>
            → <strong>${t.in}</strong>
            ${t.free ? badge("green","FT") : badge("red",`−${t.hit_pts}pt`)}
          </div>`).join("")
      : `<span style="color:var(--text3);font-size:11px">Hold</span>`;

    const actualTrn = r.actual_in.length
      ? r.actual_in.map((name,i) =>
          `<div style="font-size:11px;margin-bottom:2px">
            <span style="color:var(--text3);text-decoration:line-through">${r.actual_out[i]||"?"}</span>
            → <strong>${name}</strong>
          </div>`).join("")
      : `<span style="color:var(--text3);font-size:11px">No transfers</span>`;

    // Model XI grouped by position
    const pos_order = ["GKP","DEF","MID","FWD"];
    const by_pos = {};
    (r.model_xi||[]).forEach(p => {
      if (!by_pos[p.pos]) by_pos[p.pos] = [];
      by_pos[p.pos].push(p);
    });
    const modelXIHtml = pos_order.map(pos => {
      const players = by_pos[pos] || [];
      if (!players.length) return "";
      return `<div style="margin-bottom:4px">
        <span style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;
          letter-spacing:.5px;margin-right:4px">${pos}</span>
        ${players.map(p =>
          `<span style="font-size:11px;margin-right:6px;${p.is_cap?"font-weight:800;color:var(--blue-fg)":""}">
            ${p.name}${p.is_cap?" (C)":""} <span style="color:var(--text3)">${p.pts}pts</span>
          </span>`
        ).join("")}
      </div>`;
    }).join("");

    const benchHtml = (r.model_bench||[]).map(p =>
      `<span style="font-size:11px;color:var(--text3);margin-right:6px">
        ${p.name} ${p.pts}pts
      </span>`
    ).join("");

    const rowId = `sr-gw-${r.gw}`;
    const headerBg = r.diff > 5 ? "var(--green-bg)" : r.diff < -5 ? "var(--red-bg)" : "var(--surface2)";

    return `
      <div style="border:1px solid var(--border);border-radius:0;margin-bottom:8px;overflow:hidden">
        <!-- Clickable summary row -->
        <div onclick="toggleSRGw('${rowId}')"
          style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
          padding:10px 14px;background:${headerBg};cursor:pointer;user-select:none">
          <span style="font-weight:800;min-width:50px">GW${r.gw} ${chipBadge}</span>
          <span style="font-size:13px">You: <strong>${r.actual_pts}</strong></span>
          <span style="font-size:13px">Model: <strong style="color:${r.model_pts>r.actual_pts?"var(--green-fg)":"var(--text)"}">${r.model_pts}</strong></span>
          <span style="font-weight:800;color:${diffC2}">${r.diff>=0?"+":""}${r.diff}</span>
          <span style="font-size:11px;color:var(--text2)">${r.formation}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--text3)">▾ expand</span>
        </div>
        <!-- Expanded detail -->
        <div id="${rowId}" style="display:none;padding:12px 14px;
          display:none;border-top:1px solid var(--border)">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;flex-wrap:wrap">
            <!-- Left: actual -->
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:6px">Your decisions</div>
              <div style="margin-bottom:6px">${actualTrn}</div>
              <div style="font-size:11px;color:var(--text2)">Captain: ${capAgreed}</div>
            </div>
            <!-- Right: model -->
            <div>
              <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;
                letter-spacing:.5px;margin-bottom:6px">Model suggestions</div>
              <div style="margin-bottom:8px">${modelTrn}</div>
              <div style="font-size:10px;font-weight:700;color:var(--text3);
                text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Model XI</div>
              ${modelXIHtml}
              ${benchHtml ? `<div style="font-size:10px;font-weight:700;color:var(--text3);
                text-transform:uppercase;letter-spacing:.5px;margin:6px 0 3px">Bench</div>
                ${benchHtml}` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }).join("");

  const tableHtml = `
    <div class="chart-title" style="margin:1.5rem 0 .5rem">GW-by-GW breakdown</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
      Click any row to expand — shows your decisions vs the model's independently evolving squad.
    </p>
    <div id="srGwCards">${gwCards}</div>`;

  el("srContent").innerHTML = summaryHtml + chartsHtml + tableHtml;

  requestAnimationFrame(() => {
    mkChart("srGwChart", {
      type: "line",
      data: { labels: gwNums, datasets: [
        lineDs("#123a70","rgba(55,138,221,0.1)","Your actual",actPts,false),
        lineDs("#1a8a26","rgba(39,160,71,0.1)","Model",modPts,false),
      ]},
      options: { ...baseOpts("GW pts"), spanGaps:false,
        plugins:{ legend:{display:true,position:"top",
          labels:{color:"var(--text2)",font:{size:11,family:FONT},boxWidth:10}},
          tooltip:{mode:"index",intersect:false,
            callbacks:{title:c=>"GW "+c[0].label}}}}
    });

    mkChart("srCumChart", {
      type: "line",
      data: { labels: gwNums, datasets: [
        lineDs("#123a70","rgba(55,138,221,0.1)","Your total",cumAct,false),
        lineDs("#1a8a26","rgba(39,160,71,0.1)","Model total",cumMod,false),
      ]},
      options: { ...baseOpts("Cumulative pts"), spanGaps:false,
        plugins:{ legend:{display:true,position:"top",
          labels:{color:"var(--text2)",font:{size:11,family:FONT},boxWidth:10}},
          tooltip:{mode:"index",intersect:false,
            callbacks:{title:c=>"GW "+c[0].label,
              afterBody:c=>{
                const i=c[0].dataIndex;
                const d=cumMod[i]-cumAct[i];
                return [`Model ${d>=0?"+":""}${d} vs actual`];
              }}}}}
    });

    mkChart("srCapChart", {
      type: "bar",
      data: { labels: gwNums, datasets: [{
        label:"Captain pts difference",
        data: capDiff,
        backgroundColor: capDiff.map(v => v >= 0
          ? "rgba(39,160,71,0.5)" : "rgba(212,75,42,0.5)"),
        borderColor: capDiff.map(v => v >= 0 ? "#1a8a26" : "#a3182a"),
        borderWidth: 1, borderRadius: 3,
      }]},
      options: { ...baseOpts("Pts diff (+ = model better)"),
        plugins:{ legend:{display:false},
          tooltip:{callbacks:{title:c=>"GW "+c[0].label,
            label:c=>`${c.raw>=0?"+":""}${c.raw} pts`}}}}
    });
  });
}

function toggleSRGw(id) {
  const el2 = el(id);
  if (!el2) return;
  el2.style.display = el2.style.display === "none" ? "block" : "none";
}

// ── Backtest ───────────────────────────────────────────────────

function renderBacktestShell() {
  el("tab-backtest").innerHTML = `<div class="card">
    <div class="chart-title" style="margin-bottom:.4rem">Signal accuracy backtest</div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:.5rem;line-height:1.6">Validates the model's signal quality against actual historical returns. Shows Pearson correlation for each signal (form, xGI/90, pts/start) and whether the top-20 composite players consistently outscored the field.</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem;line-height:1.6">
      Tests how well the model's signals predicted actual next-GW returns across the season.
      Fetches GW history for the top 150 players — takes ~30 seconds on first run, then cached.
    </p>
    <button id="btRunBtn" onclick="runBacktest()"
      style="background:var(--text);color:#fff;border:none;border-radius:0;
      padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;
      font-family:var(--font)">Run backtest →</button>
    <div id="btContent" style="margin-top:1.5rem"></div>
  </div>`;
}

async function runBacktest() {
  const btn = el("btRunBtn");
  btn.disabled = true;
  btn.textContent = "Running... (fetching ~150 player histories)";
  el("btContent").innerHTML = `<div style="display:flex;align-items:center;gap:10px;
    color:var(--text2);font-size:13px">
    <div class="spinner"></div> This takes about 30 seconds on first run...
  </div>`;

  try {
    const res  = await fetch("/api/backtest");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderBacktestResults(data);
  } catch(e) {
    el("btContent").innerHTML = `<div class="err-box">Backtest failed: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-run backtest →";
  }
}

function renderBacktestResults(data) {
  const corr = data.correlations;
  const gws  = data.gws;
  const gs   = data.gw_summary;

  // ── Correlation table ──────────────────────────────────────────
  const corrRows = [
    ["Composite score",  corr.composite,     "Combined weighted signal"],
    ["Rolling form",     corr.form,          "Avg pts last 5 GWs"],
    ["xGI/90 rolling",  corr.xgi90,         "xGI per 90 up to that GW"],
    ["Pts per start",    corr.pts_per_start, "Season pts/start up to that GW"],
  ].sort((a,b) => Math.abs(b[1]) - Math.abs(a[1]));

  function corrBar(r) {
    const pct = Math.abs(r) * 100;
    const c   = Math.abs(r)>=0.15?"#1a8a26":Math.abs(r)>=0.08?"#9c7a00":"#a3182a";
    return `<div style="display:flex;align-items:center;gap:8px">
      <div style="height:8px;border-radius:0;background:var(--border2);width:100px;overflow:hidden">
        <div style="height:100%;width:${pct.toFixed(0)}%;background:${c};border-radius:0"></div>
      </div>
      <span style="font-size:12px;font-weight:700;color:${c}">${r > 0 ? "+" : ""}${r.toFixed(3)}</span>
    </div>`;
  }

  const corrHtml = `
    <div class="cmp-section-title">Signal correlations with next-GW return</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
      Pearson r between each signal and actual points the following GW.
      Analysed across ${data.n_records.toLocaleString()} player-GW observations over ${data.n_gws} gameweeks.
    </p>
    <table class="data-table" style="max-width:500px">
      <thead><tr>
        <th>Signal</th><th>Correlation (r)</th><th>Notes</th>
      </tr></thead>
      <tbody>
        ${corrRows.map(([lbl,r,note]) => `<tr>
          <td style="font-weight:600">${lbl}</td>
          <td>${corrBar(r)}</td>
          <td style="font-size:11px;color:var(--text2)">${note}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <p style="font-size:11px;color:var(--text3);margin-top:.5rem">
      r > 0.15 = meaningful signal · r > 0.08 = weak but present · r < 0.08 = unreliable</p>`;

  // ── GW top-20 vs field chart ───────────────────────────────────
  const top20  = gws.map(gw => gs[gw]?.top20_avg || null);
  const allAvg = gws.map(gw => gs[gw]?.all_avg   || null);
  const bot20  = gws.map(gw => gs[gw]?.bot20_avg || null);

  // Cumulative advantage — sum of (top20 - all_avg) over the season
  let cumAdv = 0;
  const cumAdvArr = gws.map((gw,i) => {
    if (top20[i] != null && allAvg[i] != null) cumAdv += top20[i] - allAvg[i];
    return parseFloat(cumAdv.toFixed(1));
  });
  const totalAdv = cumAdv.toFixed(1);
  const advC     = cumAdv > 0 ? "var(--green-fg)" : "var(--red-fg)";

  const chartHtml = `
    <div class="cmp-section-title" style="margin-top:1.5rem">Top-20 composite vs field — next GW avg points</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
      Each GW: average next-GW points for the top 20 players by composite score vs the full sample.
      Cumulative advantage over the season: <strong style="color:${advC}">${totalAdv > 0 ? "+" : ""}${totalAdv} pts per player per GW</strong>
    </p>
    <div class="chart-leg">
      <span><b style="background:#1a8a26"></b>Top 20 by composite</span>
      <span><b style="background:#4a4e49"></b>Full sample avg</span>
      <span><b style="background:#a3182a"></b>Bottom 20</span>
    </div>
    <div style="position:relative;height:220px;margin-bottom:1.5rem">
      <canvas id="btGwChart"></canvas>
    </div>
    <div class="cmp-section-title">Cumulative pts advantage — top 20 vs field avg</div>
    <div style="position:relative;height:160px;margin-bottom:1.5rem">
      <canvas id="btCumChart"></canvas>
    </div>`;

  // ── Scatter ────────────────────────────────────────────────────
  const posColors = {GKP:"#0c6e6e",DEF:"#1a8a26",MID:"#123a70",FWD:"#a3182a"};
  const scatterHtml = `
    <div class="cmp-section-title">Composite score vs actual next-GW points (sample of 300)</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
      Each dot = one player in one GW. A cluster of high scores on the right with higher y values confirms the signal is predictive.
    </p>
    <div class="chart-leg">
      ${Object.entries(posColors).map(([pos,c])=>
        `<span><b style="background:${c};width:8px;height:8px;border-radius:50%;display:inline-block"></b>${pos}</span>`
      ).join("")}
    </div>
    <div style="position:relative;height:260px">
      <canvas id="btScatterChart"></canvas>
    </div>`;

  el("btContent").innerHTML = corrHtml + chartHtml + scatterHtml;

  requestAnimationFrame(() => {
    mkChart("btGwChart", {
      type: "line",
      data: { labels: gws, datasets: [
        lineDs("#1a8a26","rgba(39,160,71,0.10)","Top 20",top20,false,0.35),
        lineDs("#4a4e49",null,"Field avg",allAvg,true,0.35),
        lineDs("#a3182a","rgba(212,75,42,0.08)","Bottom 20",bot20,true,0.35),
      ]},
      options: { ...baseOpts("Avg next-GW pts"), spanGaps:true,
        plugins:{legend:{display:false},
          tooltip:{mode:"index",intersect:false,
            callbacks:{title:c=>"GW "+c[0].label}}}}
    });

    mkChart("btCumChart", {
      type: "line",
      data: { labels: gws, datasets: [{
        label:"Cumulative advantage",
        data: cumAdvArr,
        borderColor:"#1a8a26",
        backgroundColor:"rgba(39,160,71,0.10)",
        borderWidth:2, pointRadius:2, tension:0.35, fill:true, spanGaps:true,
      }]},
      options: { ...baseOpts("Cumulative pts edge"), spanGaps:true,
        plugins:{legend:{display:false},tooltip:{mode:"index",intersect:false,
          callbacks:{title:c=>"GW "+c[0].label,
            label:c=>`+${c.raw} pts advantage vs field avg`}}}}
    });

    // Scatter by position
    const POS = ["GKP","DEF","MID","FWD"];
    const scatterDatasets = POS.map(pos => ({
      label: pos,
      data: data.scatter.filter(r=>r.pos===pos).map(r=>({x:r.x,y:r.y,name:r.name,gw:r.gw})),
      backgroundColor: posColors[pos] + "88",
      borderColor:     posColors[pos],
      borderWidth: 0.5,
      pointRadius: 4,
      pointHoverRadius: 6,
    }));

    mkChart("btScatterChart", {
      type: "scatter",
      data: { datasets: scatterDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display:true, position:"top",
            labels:{color:"var(--text2)",font:{size:11,family:FONT},boxWidth:10}},
          tooltip: { callbacks: {
            label: c => `${c.raw.name} GW${c.raw.gw}: score ${c.raw.x} → ${c.raw.y}pts`,
          }}
        },
        scales: {
          x: { title:{display:true,text:"Composite score estimate",color:"#aaa",font:{size:11}},
               ticks:{color:"#aaa",font:{size:11,family:FONT}},grid:{color:"rgba(0,0,0,0.04)"}},
          y: { title:{display:true,text:"Actual next-GW points",color:"#aaa",font:{size:11}},
               ticks:{color:"#aaa",font:{size:11,family:FONT}},grid:{color:"rgba(0,0,0,0.04)"}},
        }
      }
    });
  });
}

// ── Player comparison modal ────────────────────────────────────

function cmpSetPos(pos, btn) {
  document.querySelectorAll("#cmpPosFilter .pos-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  populateCompareSelects(pos, parseInt(el("cmpSelA").value)||null, null);
  refreshComparison();
}

function openComparison(idA, idB) {
  const modal = el("compareModal");
  const allP  = _state?.all_players || [];

  // Determine position filter based on first player
  const pRef = allP.find(p=>p.id===idA);
  const posFilter = pRef?.pos || "ALL";

  populateCompareSelects(posFilter, idA, idB);
  modal.style.display = "block";
  document.body.style.overflow = "hidden";
  refreshComparison();
}

function populateCompareSelects(posFilter, selIdA, selIdB) {
  const allP = _state?.all_players || [];
  const filt = posFilter === "ALL" ? allP : allP.filter(p=>p.pos===posFilter || p.effective_pos===posFilter);
  const sorted = [...filt].sort((a,b)=>a.name.localeCompare(b.name));

  // Group by team
  const byTeam = {};
  sorted.forEach(p => { (byTeam[p.team_name] = byTeam[p.team_name]||[]).push(p); });
  const teamsSorted = Object.keys(byTeam).sort();

  function buildOpts(skipId) {
    return teamsSorted.map(t =>
      `<optgroup label="${t}">${byTeam[t].map(p=>
        `<option value="${p.id}">${p.name} (${p.pos})</option>`
      ).join("")}</optgroup>`
    ).join("");
  }

  const html = buildOpts();
  el("cmpSelA").innerHTML = html;
  el("cmpSelB").innerHTML = html;

  if (selIdA) el("cmpSelA").value = String(selIdA);
  if (selIdB) el("cmpSelB").value = String(selIdB);
  else if (selIdA) {
    const other = sorted.find(p=>p.id!==selIdA);
    if (other) el("cmpSelB").value = String(other.id);
  }

  // Update pos filter UI
  const posTabEl = el("cmpPosFilter");
  if (posTabEl) {
    [...posTabEl.querySelectorAll("button")].forEach(b => {
      b.classList.toggle("active", b.dataset.pos === posFilter);
    });
  }
}

function closeComparison() {
  el("compareModal").style.display = "none";
  document.body.style.overflow = "";
}

function refreshComparison() {
  const pidA = parseInt(el("cmpSelA").value);
  const pidB = parseInt(el("cmpSelB").value);
  if (!pidA || !pidB || pidA===pidB) {
    el("cmpContent").innerHTML = `<div style="text-align:center;padding:1.5rem;color:var(--text3);font-size:13px">Select two different players</div>`;
    return;
  }
  const allP = _state?.all_players || [];
  const pA = allP.find(p=>p.id===pidA);
  const pB = allP.find(p=>p.id===pidB);
  if (!pA || !pB) {
    el("cmpContent").innerHTML = `<div style="padding:1rem;color:var(--red-fg);font-size:12px">Could not find player data</div>`;
    return;
  }
  try {
    el("cmpContent").innerHTML = buildCompareView(pA, pB);
  } catch(e) {
    el("cmpContent").innerHTML = `<div style="padding:1rem;color:var(--red-fg);font-size:12px">Error: ${e.message}</div>`;
    console.error("buildCompareView error:", e);
  }
}


function buildCompareView(pA, pB) {
  const isDef = pos => pos==="DEF" || pos==="GKP";
  function col2(a, b) {
    return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>${a}</div><div>${b}</div></div>`;
  }
  function winStyle(vA, vB, higherWins=true) {
    const aW = higherWins ? vA > vB : vA < vB;
    const bW = higherWins ? vB > vA : vB < vA;
    return [
      aW ? "color:var(--green-fg);font-weight:800" : bW ? "color:var(--red-fg)" : "color:var(--text)",
      bW ? "color:var(--green-fg);font-weight:800" : aW ? "color:var(--red-fg)" : "color:var(--text)",
    ];
  }
  function statRow(label, vA, vB, higherWins=true, fmt=v=>v) {
    const [sA, sB] = winStyle(vA, vB, higherWins);
    return `<div style="display:grid;grid-template-columns:1fr 1.5fr 1fr;
      align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
      <div style="${sA};text-align:left">${fmt(vA)}</div>
      <div style="text-align:center;font-size:10px;color:var(--text3);text-transform:uppercase;
        letter-spacing:.5px">${label}</div>
      <div style="${sB};text-align:right">${fmt(vB)}</div>
    </div>`;
  }

  // Header cards
  function headerCard(p) {
    const posC = {MID:"#0c6e6e",FWD:"#9c1a1a",DEF:"#0c6e6e",GKP:"#8a6a00"}[p.pos]||"#888";
    const compC = p.composite>=80?"var(--green-fg)":p.composite>=60?"var(--amber-fg)":"var(--red-fg)";
    const teamCode = _state?.teams?.[String(p.team)]?.code||"";
    const shirt = teamCode ? `<img src="https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${teamCode}-110.png"
      style="height:44px;object-fit:contain" onerror="this.style.display='none'">` : "";
    const atkBadge = p.effective_pos==="ATK_MID"
      ? `<span style="background:rgba(124,99,255,0.12);color:var(--purple-fg);padding:1px 6px;
          border-radius:0;font-size:10px;font-weight:700">ATK</span>` : "";
    return `<div style="background:var(--surface2);border-radius:0;padding:12px;
      display:flex;align-items:center;gap:10px">
      <div style="width:44px;height:44px;background:var(--surface);border-radius:0;
        display:flex;align-items:center;justify-content:center;flex-shrink:0">${shirt}</div>
      <div style="flex:1;min-width:0">
        <div data-pid="${p.id}" style="font-weight:800;font-size:13px;cursor:pointer;
          color:var(--text)">${p.name}</div>
        <div style="font-size:11px;color:var(--text2)">
          <span style="background:${posC}22;color:${posC};padding:1px 5px;border-radius:0;
            font-size:10px;font-weight:700">${p.pos}</span>
          ${atkBadge} ${p.team_name} · £${p.price}m
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:22px;font-weight:800;color:${compC}">${p.composite}</div>
        <div style="font-size:10px;color:var(--text3)">score</div>
      </div>
    </div>`;
  }

  // Fixture pills
  const fdrC = {1:"#146622",2:"#33cc33",3:"#a88a00",4:"#d8342f",5:"#7a1019"};
  function fixRow(p) {
    return (p.fixes||[]).slice(0,5).map(f=>{
      const c = fdrC[f.fdr]||"#888";
      return `<span style="display:inline-flex;padding:2px 7px;border-radius:0;
        font-size:11px;font-weight:600;background:${c}22;color:${c};border:1px solid ${c}44;
        margin:2px">${f.opp} ${f.home?"H":"A"}</span>`;
    }).join("");
  }

  // xGI bar
  function xbar(val, max, colour) {
    const pct = Math.min(100, Math.round((val||0)/max*100));
    return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:4px">
      <span style="width:24px;color:var(--text3)">${colour==="#0c6e6e"?"xGI":colour==="#9c1a1a"?"xG":"xA"}</span>
      <div style="height:4px;background:var(--surface2);border-radius:0;flex:1">
        <div style="height:4px;border-radius:0;background:${colour};width:${pct}%"></div>
      </div>
      <span style="min-width:28px;text-align:right;font-weight:700;color:var(--text)">${(val||0).toFixed(2)}</span>
    </div>`;
  }

  // Projections
  function projRow(p) {
    return (p.projections||[]).slice(0,4).map(proj=>{
      const c = proj.proj>=10?"var(--green-fg)":proj.proj>=6?"var(--text)":"var(--text2)";
      const bg = proj.dgw?"background:rgba(124,99,255,0.08)":"";
      return `<div style="text-align:center;padding:4px;border-radius:0;${bg}">
        <div style="font-size:10px;color:var(--text3)">GW${proj.gw}</div>
        <div style="font-weight:700;color:${c}">${proj.blank?"BGW":proj.proj}</div>
      </div>`;
    }).join("");
  }

  return `<div style="padding:14px 16px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div>${headerCard(pA)}</div><div>${headerCard(pB)}</div>
    </div>
    <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Key stats</div>
    ${statRow("Composite", pA.composite, pB.composite, true)}
    ${statRow("Form", pA.form||0, pB.form||0, true, v=>v.toFixed(1))}
    ${statRow("Pts / start", pA.pts_per_start||0, pB.pts_per_start||0, true, v=>v.toFixed(1))}
    ${statRow("xGI / 90", pA.xgi90||0, pB.xgi90||0, true, v=>v.toFixed(2))}
    ${statRow("Price", pA.price, pB.price, false, v=>"£"+v+"m")}
    ${statRow("Ownership", pA.ownership||0, pB.ownership||0, false, v=>v+"%")}
    ${statRow("Starts", pA.starts||0, pB.starts||0, true)}
    ${(pA.has_xg || pB.has_xg) ? `
      <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px">Attacking (per 90)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>${xbar(pA.xgi90,1.2,"#0c6e6e","xGI")}${xbar(pA.xg90,1.0,"#9c1a1a","xG")}${xbar(pA.xa90,0.6,"#0c6e6e","xA")}</div>
        <div>${xbar(pB.xgi90,1.2,"#0c6e6e","xGI")}${xbar(pB.xg90,1.0,"#9c1a1a","xG")}${xbar(pB.xa90,0.6,"#0c6e6e","xA")}</div>
      </div>` : ""}
    ${(isDef(pA.pos) && isDef(pB.pos)) ? `
      <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px">Defensive</div>
      ${statRow("CS prob", pA.cs_prob, pB.cs_prob, true, v=>(v*100).toFixed(0)+"%")}
      ${statRow("xCS pts/g", pA.xcs_pts_per_game, pB.xcs_pts_per_game, true, v=>v.toFixed(1))}
      ${statRow("BPS / game", pA.bps_per_game, pB.bps_per_game, true, v=>v.toFixed(1))}
      ${statRow("xGC / 90", pA.xgc90, pB.xgc90, false, v=>v.toFixed(2))}
    ` : ""}
    <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px">Projections</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px">${projRow(pA)}</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px">${projRow(pB)}</div>
    </div>
    <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Fixtures</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div>${fixRow(pA)}</div><div>${fixRow(pB)}</div>
    </div>
  </div>`;
}

// ── Team comparison modal ──────────────────────────────────────

function _buildTeamOptions() {
  // Build sorted list of teams from _state.teams
  const teams = _state?.teams || {};
  return Object.entries(teams)
    .map(([id, t]) => ({ id: parseInt(id), ...t }))
    .sort((a,b) => a.name.localeCompare(b.name));
}

function openTeamComparison(preselectedShortName) {
  const modal = el("teamCompModal");
  const selA  = el("tcmpSelA");
  const selB  = el("tcmpSelB");

  if (!selA.options.length) {
    _buildTeamOptions().forEach(t => {
      selA.appendChild(new Option(t.name, t.id));
      selB.appendChild(new Option(t.name, t.id));
    });
  }

  // Pre-select clicked team in slot A
  if (preselectedShortName) {
    const match = _buildTeamOptions().find(t => t.short_name === preselectedShortName);
    if (match) selA.value = match.id;
  }
  // Default B to a different team
  if (selB.value === selA.value && selB.options.length > 1) {
    selB.selectedIndex = selA.selectedIndex === 0 ? 1 : 0;
  }

  modal.style.display = "block";
  document.body.style.overflow = "hidden";
  refreshTeamComparison();
}

function closeTeamComparison() {
  el("teamCompModal").style.display = "none";
  document.body.style.overflow = "";
}

async function refreshTeamComparison() {
  const tidA = el("tcmpSelA").value;
  const tidB = el("tcmpSelB").value;
  if (!tidA || !tidB || tidA === tidB) return;

  const teams = _state?.teams || {};
  el("tcmpTitle").textContent =
    `${teams[tidA]?.name || tidA}  vs  ${teams[tidB]?.name || tidB}`;
  el("tcmpContent").innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text3)">
    <div class="spinner" style="margin:0 auto 1rem"></div>Loading team data...</div>`;

  try {
    const res  = await fetch(`/api/team_comparison/${tidA}/${tidB}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderTeamComparison(data, tidA, tidB);
  } catch(e) {
    el("tcmpContent").innerHTML =
      `<div class="err-box">Failed to load team data: ${e.message}</div>`;
  }
}

function renderTeamComparison(data, tidA, tidB) {
  const tA = data[String(tidA)];
  const tB = data[String(tidB)];
  if (!tA || !tB) return;

  const sA = tA.season, sB = tB.season;

  // ── Season stat blocks ────────────────────────────────────────
  function statRow(label, vA, vB, higherWins=true, fmt=v=>v) {
    const aW = higherWins ? vA > vB : vA < vB;
    const bW = higherWins ? vB > vA : vB < vA;
    return `
      <div class="cmp-stat${aW?" cmp-winner":""}">
        <div class="cmp-stat-lbl">${label}</div>
        <div class="cmp-stat-val">${fmt(vA)}</div>
      </div>
      <div class="cmp-stat${bW?" cmp-winner":""}">
        <div class="cmp-stat-lbl">${label}</div>
        <div class="cmp-stat-val">${fmt(vB)}</div>
      </div>`;
  }

  // xG over/underperformance flag
  function xgFlag(goals, xg) {
    const diff = goals - xg;
    if (diff > 0.3) return ` <span class="badge badge-amber" style="font-size:9px">↓ regress?</span>`;
    if (diff < -0.3) return ` <span class="badge badge-green" style="font-size:9px">↑ due goals</span>`;
    return "";
  }

  const attackHtml = `
    <div class="cmp-section-title">Attack</div>
    <div class="cmp-stat-grid">
      ${statRow("Goals/game", sA.goals_pg, sB.goals_pg, true, v=>v.toFixed(2))}
      ${statRow("xG/game",    sA.xg_pg,    sB.xg_pg,    true, v=>v.toFixed(2))}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:1rem">
      <div style="font-size:11px;color:var(--text2)">
        vs xG: <strong>${(sA.goals_pg - sA.xg_pg).toFixed(2)}</strong>
        ${xgFlag(sA.goals_pg, sA.xg_pg)}
      </div>
      <div style="font-size:11px;color:var(--text2)">
        vs xG: <strong>${(sB.goals_pg - sB.xg_pg).toFixed(2)}</strong>
        ${xgFlag(sB.goals_pg, sB.xg_pg)}
      </div>
    </div>`;

  const defenceHtml = `
    <div class="cmp-section-title">Defence</div>
    <div class="cmp-stat-grid">
      ${statRow("Conceded/game", sA.conceded_pg, sB.conceded_pg, false, v=>v.toFixed(2))}
      ${statRow("xGC/game",      sA.xgc_pg,      sB.xgc_pg,      false, v=>v.toFixed(2))}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:1rem">
      <div style="font-size:11px;color:var(--text2)">
        Conceded vs xGC: <strong>${(sA.conceded_pg - sA.xgc_pg).toFixed(2)}</strong>
        ${xgFlag(sA.conceded_pg, sA.xgc_pg)}
      </div>
      <div style="font-size:11px;color:var(--text2)">
        Conceded vs xGC: <strong>${(sB.conceded_pg - sB.xgc_pg).toFixed(2)}</strong>
        ${xgFlag(sB.conceded_pg, sB.xgc_pg)}
      </div>
    </div>`;

  // ── Fixtures ──────────────────────────────────────────────────
  const allFixes  = _state?.fixtures || [];
  const getFixRow = (tid) => allFixes.find(f => {
    const teams = _state?.teams || {};
    return parseInt(Object.keys(teams).find(k=>teams[k].name===
      (data[String(tid)]?.name))) === parseInt(f.team?.replace ? null : tid);
  });
  // Use fixture data from the main load for each team's next 5
  const fixtureData = _state?.fixtures || [];
  function teamFixtures(tid) {
    const tName = data[String(tid)]?.short_name;
    const row   = fixtureData.find(f => f.team === tName);
    return row ? row.fixes || [] : [];
  }

  const fixHtml = `
    <div class="cmp-section-title">Next 5 fixtures</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:1rem">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:5px">${tA.name}</div>
        <div class="fdr-row" style="justify-content:flex-start">${fdrSq(teamFixtures(tidA),5)}</div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:5px">${tB.name}</div>
        <div class="fdr-row" style="justify-content:flex-start">${fdrSq(teamFixtures(tidB),5)}</div>
      </div>
    </div>`;

  // ── Charts ────────────────────────────────────────────────────
  const chartsHtml = `
    <div class="cmp-section-title">Defensive record — goals conceded vs xGC per GW</div>
    <div style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
      When conceded (solid) rises above xGC (dashed) the team is unlucky — CS chances may improve.
      When below, they have been fortunate and clean sheets may be harder to come by.
    </div>
    <div style="position:relative;height:230px;margin-bottom:1.5rem">
      <canvas id="tcmpDefChart"></canvas>
    </div>
    <div class="cmp-section-title">Clean sheet record per GW</div>
    <div style="position:relative;height:180px">
      <canvas id="tcmpCsChart"></canvas>
    </div>`;

  el("tcmpContent").innerHTML = attackHtml + defenceHtml + fixHtml + chartsHtml;

  // Draw charts
  requestAnimationFrame(() => {
    const histA = tA.gw_history || [];
    const histB = tB.gw_history || [];

    // Align on common GW axis
    const allGws = [...new Set([...histA.map(r=>r.gw), ...histB.map(r=>r.gw)])].sort((a,b)=>a-b);
    const getV   = (hist, gw, key) => { const r=hist.find(h=>h.gw===gw); return r!=null?r[key]:null; };

    const concA = allGws.map(gw => getV(histA,gw,"conceded"));
    const xgcA  = allGws.map(gw => getV(histA,gw,"xgc"));
    const concB = allGws.map(gw => getV(histB,gw,"conceded"));
    const xgcB  = allGws.map(gw => getV(histB,gw,"xgc"));
    const csA   = allGws.map(gw => getV(histA,gw,"cs"));
    const csB   = allGws.map(gw => getV(histB,gw,"cs"));

    // Rolling 5-GW averages for smoother trend
    const rollArr = (arr, n=5) => arr.map((_,i) => {
      const sl = arr.slice(Math.max(0,i-n+1),i+1).filter(v=>v!=null);
      return sl.length ? +(sl.reduce((a,b)=>a+b,0)/sl.length).toFixed(2) : null;
    });

    mkChart("tcmpDefChart", {
      type: "line",
      data: { labels: allGws, datasets: [
        { ...lineDs("#123a70",null,`${tA.short_name} conceded`,rollArr(concA),false,0.4),
          borderWidth:2 },
        { ...lineDs("#123a70",null,`${tA.short_name} xGC`,rollArr(xgcA),true,0.4),
          borderWidth:1.5, borderDash:[4,3] },
        { ...lineDs("#a3182a",null,`${tB.short_name} conceded`,rollArr(concB),false,0.4),
          borderWidth:2 },
        { ...lineDs("#a3182a",null,`${tB.short_name} xGC`,rollArr(xgcB),true,0.4),
          borderWidth:1.5, borderDash:[4,3] },
      ]},
      options: { ...baseOpts("Goals (5GW avg)"), spanGaps:true,
        plugins:{ legend:{display:true,position:"top",
          labels:{color:"var(--text2)",font:{size:11,family:FONT},boxWidth:10}},
          tooltip:{mode:"index",intersect:false,
            callbacks:{title:c=>"GW "+c[0].label}}}}
    });

    mkChart("tcmpCsChart", {
      type: "bar",
      data: { labels: allGws, datasets: [
        { label:`${tA.short_name} CS`, data:csA,
          backgroundColor:"rgba(55,138,221,0.4)", borderColor:"#123a70",
          borderWidth:1, borderRadius:2 },
        { label:`${tB.short_name} CS`, data:csB,
          backgroundColor:"rgba(212,75,42,0.4)", borderColor:"#a3182a",
          borderWidth:1, borderRadius:2 },
      ]},
      options: { ...baseOpts("Clean sheets"),
        plugins:{ legend:{display:true,position:"top",
          labels:{color:"var(--text2)",font:{size:11,family:FONT},boxWidth:10}},
          tooltip:{mode:"index",intersect:false,
            callbacks:{title:c=>"GW "+c[0].label}}}}
    });
  });
}

// ── Player Profile Modal ───────────────────────────────────────

let _profilePlayerId = null;

function openPlayerProfile(id) {
  _profilePlayerId = id;
  const p = (_state?.all_players || []).find(p => p.id === id)
         || (_state?.squad || []).find(p => p.id === id);
  if (!p) return;

  const modal = el("profileModal");
  el("profileModalTitle").textContent = p.name;

  // Scout button state
  const watching = wlHas(id);
  const btn = el("profileScoutBtn");
  btn.textContent = watching ? "★ Scouted" : "☆ Scout";
  btn.style.color = watching ? "#f5c400" : "var(--text2)";
  btn.style.borderColor = watching ? "#f5c400" : "var(--border)";

  el("profileModalContent").innerHTML = buildProfileCard(p);
  modal.style.display = "block";
  document.body.style.overflow = "hidden";
}

function closeProfileModal() {
  el("profileModal").style.display = "none";
  document.body.style.overflow = "";
}

function profileToggleScout() {
  if (!_profilePlayerId) return;
  wlToggle(_profilePlayerId);
  const watching = wlHas(_profilePlayerId);
  const btn = el("profileScoutBtn");
  btn.textContent = watching ? "★ Scouted" : "☆ Scout";
  btn.style.color = watching ? "#f5c400" : "var(--text2)";
  btn.style.borderColor = watching ? "#f5c400" : "var(--border)";
}

function openProfileCompare() {
  if (!_profilePlayerId) return;
  closeProfileModal();
  openComparison(_profilePlayerId);
}

function buildProfileCard(p) {
  if (!p) return "";
  const pos     = p.pos||"MID";
  const isDef   = pos==="DEF"||pos==="GKP";
  const posC    = {MID:"#0c6e6e",FWD:"#9c1a1a",DEF:"#0c6e6e",GKP:"#8a6a00"}[pos]||"#888";
  const compC   = p.composite>=80?"var(--green-fg)":p.composite>=60?"var(--amber-fg)":"var(--red-fg)";
  const tc      = _state?.teams?.[String(p.team)]?.code||"";
  const shirtUrl = tc ? `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${tc}-110.png` : "";

  function xbar(val, max, colour) {
    const pct = Math.min(100, Math.round((val||0)/max*100));
    return `<div style="height:4px;background:var(--surface2);border-radius:0;flex:1;margin:0 8px">
      <div style="height:4px;border-radius:0;background:${colour};width:${pct}%"></div></div>`;
  }

  // Fixture pills
  const fdrC={1:"#146622",2:"#33cc33",3:"#a88a00",4:"#d8342f",5:"#7a1019"};
  const fixPills = (p.fixes||[]).slice(0,5).map(f=>{
    const c=fdrC[f.fdr]||"#888";
    const isDgw=(p.dgw_gws||[]).includes(f.gw);
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;
      border-radius:0;font-size:11px;font-weight:600;background:${c}22;color:${c};
      border:1px solid ${c}44;margin:2px">${f.opp} ${f.home?"H":"A"}${isDgw?
      `<span style="font-size:9px;background:${c};color:#fff;border-radius:0;padding:0 3px">×2</span>`:""}</span>`;
  }).join("");

  // Projections
  const projCells = (p.projections||[]).slice(0,4).map(pr=>{
    const c=pr.proj>=10?"var(--green-fg)":pr.proj>=6?"var(--text)":"var(--text2)";
    const bg=pr.dgw?"background:rgba(124,99,255,0.08)":"";
    return `<div style="text-align:center;padding:5px 2px;border-radius:0;${bg}">
      <div style="font-size:10px;color:var(--text3);margin-bottom:1px">GW${pr.gw}</div>
      ${pr.blank?`<span style="color:var(--text3);font-size:10px">BGW</span>`
        :`<span style="font-weight:800;font-size:13px;color:${c}">${pr.proj}</span>`}
    </div>`;
  }).join("");

  // Badges
  const badges = [
    p.effective_pos==="ATK_MID"?`<span style="background:rgba(124,99,255,0.12);color:var(--purple-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">ATK</span>`:"",
    p.is_dgw_imminent?`<span style="background:rgba(124,99,255,0.12);color:var(--purple-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">DGW 🔥</span>`
      :p.has_dgw_next?`<span style="background:rgba(124,99,255,0.12);color:var(--purple-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">DGW GW${p.dgw_next_gw}</span>`:"",
    p.price_rising?`<span style="background:var(--green-bg);color:var(--green-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">↑ Rising</span>`:"",
    p.price_falling?`<span style="background:var(--red-bg);color:var(--red-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">↓ Falling</span>`:"",
    (p.xg_overperf||0)>=3?`<span style="background:var(--amber-bg);color:var(--amber-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">⚠ Regress?</span>`:"",
    p.rotation_risk?`<span style="background:var(--amber-bg);color:var(--amber-fg);padding:2px 6px;border-radius:0;font-size:10px;font-weight:700">ROT</span>`:"",
  ].filter(Boolean).join(" ");

  const trendC=(p.form_trend_label||"→").startsWith("↑")?"var(--green-fg)"
    :(p.form_trend_label||"→").startsWith("↓")?"var(--red-fg)":"var(--text3)";

  // Position-aware stat section
  const statSection = isDef ? `
    <div style="padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Defensive stats</div>
      ${[
        {l:"CS prob",   v:((p.cs_prob||0)*100).toFixed(0)+"%", bar:(p.cs_prob||0), max:0.45, c:"#0c6e6e"},
        {l:"xCS pts/g", v:(p.xcs_pts_per_game||0).toFixed(1), bar:p.xcs_pts_per_game||0, max:3, c:"#33cc33"},
        {l:"BPS/game",  v:(p.bps_per_game||0).toFixed(1),     bar:p.bps_per_game||0, max:30, c:"#0c6e6e"},
        {l:"xGC/90",    v:(p.xgc90||0).toFixed(2),            bar:1-(p.xgc90||0), max:1, c:"#0c6e6e"},
      ].map(m=>`
        <div style="display:flex;align-items:center;font-size:12px;margin-bottom:4px">
          <span style="width:64px;color:var(--text2);font-size:11px">${m.l}</span>
          ${xbar(m.bar, m.max, m.c)}
          <span style="min-width:36px;text-align:right;font-weight:700;color:var(--text)">${m.v}</span>
        </div>`).join("")}
    </div>` : (p.has_xg && p.xgi90) ? `
    <div style="padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Attacking (per 90)</div>
      ${[
        {l:"xGI",v:(p.xgi90||0).toFixed(2),max:1.2,c:"#0c6e6e"},
        {l:"xG", v:(p.xg90||0).toFixed(2), max:1.0,c:"#9c1a1a"},
        {l:"xA", v:(p.xa90||0).toFixed(2), max:0.6,c:"#0c6e6e"},
      ].map(m=>`
        <div style="display:flex;align-items:center;font-size:12px;margin-bottom:4px">
          <span style="width:28px;color:var(--text2)">${m.l}</span>
          ${xbar(parseFloat(m.v), m.max, m.c)}
          <span style="min-width:32px;text-align:right;font-weight:700;color:var(--text)">${m.v}</span>
        </div>`).join("")}
    </div>` : "";

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="width:52px;height:52px;background:var(--surface2);border-radius:0;
        display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
        ${shirtUrl?`<img src="${shirtUrl}" style="height:46px;object-fit:contain"
          onerror="this.style.display='none'">`:""}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:3px">
          <span style="background:${posC}22;color:${posC};padding:2px 6px;border-radius:0;font-size:11px;font-weight:700">${pos}</span>
          ${badges}
        </div>
        <div style="font-size:12px;color:var(--text2)">${p.team_name} · £${p.price}m · ${p.ownership||0}% owned</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:26px;font-weight:800;color:${compC};line-height:1">${p.composite}</div>
        <div style="font-size:10px;color:var(--text3)">composite</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid var(--border)">
      ${[
        {l:"Form",v:(p.form||0).toFixed(1),s:`<span style="color:${trendC};font-size:11px"> ${p.form_trend_label||"→"}</span>`},
        {l:"Pts/start",v:(p.pts_per_start||0).toFixed(1)},
        {l:"Starts",v:p.starts||0},
      ].map((s,i)=>`
        <div style="padding:8px 12px;${i<2?"border-right:1px solid var(--border);":""}">
          <div style="font-size:10px;color:var(--text3)">${s.l}</div>
          <div style="font-size:14px;font-weight:700;color:var(--text)">${s.v}${s.s||""}</div>
        </div>`).join("")}
    </div>

    ${statSection}

    ${(p.projections||[]).length ? `
    <div style="padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Next 4 GW projections</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px">${projCells}</div>
    </div>` : ""}

    ${(p.fixes||[]).length ? `
    <div style="padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Next 5 fixtures</div>
      <div>${fixPills}</div>
    </div>` : ""}

    <div style="padding:8px 16px;display:flex;gap:16px;font-size:12px;color:var(--text2)">
      <span>£${p.price}m</span>
      ${p.price_change?`<span style="color:${p.price_change>0?"var(--green-fg)":"var(--red-fg)"}">${p.price_change>0?"+":""}£${p.price_change}m</span>`:""}
      <span>Value ${(p.value||0).toFixed(1)}</span>
      <span>${p.pts_per_start?`${(p.pts_per_start).toFixed(1)} pts/start`:"—"}</span>
    </div>`;
}


// Make player names clickable across the app
// Delegated listener — fires on any element with data-pid attribute
document.addEventListener("click", function(e) {
  const el_pid = e.target.closest("[data-pid]");
  if (el_pid && !e.target.closest(".wl-star-btn")) {
    const id = parseInt(el_pid.dataset.pid);
    if (id) openPlayerProfile(id);
  }
}, true);

// ── Watchlist ──────────────────────────────────────────────────

function wlGet() {
  try { return JSON.parse(localStorage.getItem("fpl_watchlist") || "{}"); }
  catch(e) { return {}; }
}

function wlSave(wl) {
  try { localStorage.setItem("fpl_watchlist", JSON.stringify(wl)); }
  catch(e) {}
}

function wlAdd(p) {
  const wl   = wlGet();
  const id   = String(p.id);
  const today = new Date().toISOString().slice(0,10);
  if (wl[id]) return;   // already watching
  wl[id] = {
    id: p.id, name: p.name, pos: p.pos, team_name: p.team_name,
    added: today,
    history: [{
      date: today, composite: p.composite, price: p.price,
      form: p.form, ownership: p.ownership||0,
    }],
  };
  wlSave(wl);
  refreshWlButtons();
  renderScoutTab();
}

function wlRemove(id) {
  const wl = wlGet();
  delete wl[String(id)];
  wlSave(wl);
  refreshWlButtons();
  renderScoutTab();
}

function wlHas(id) {
  return !!wlGet()[String(id)];
}

// Called on each dashboard load — appends today's stats to each watched player
function updateWatchlistFromLoad(allPlayers) {
  if (!allPlayers?.length) return;
  const wl    = wlGet();
  const today = new Date().toISOString().slice(0,10);
  let changed = false;
  for (const entry of Object.values(wl)) {
    const live = allPlayers.find(p => p.id === entry.id);
    if (!live) continue;
    const last = entry.history[entry.history.length - 1];
    // Only append once per day
    if (last?.date === today) {
      // Update today's entry in place
      last.composite = live.composite;
      last.price     = live.price;
      last.form      = live.form;
      last.ownership = live.ownership || 0;
    } else {
      entry.history.push({
        date: today, composite: live.composite, price: live.price,
        form: live.form, ownership: live.ownership || 0,
      });
    }
    // Keep last 20 data points
    if (entry.history.length > 20) entry.history = entry.history.slice(-20);
    // Update display name/team in case of transfer
    entry.name      = live.name;
    entry.team_name = live.team_name;
    changed = true;
  }
  if (changed) wlSave(wl);
}

// Re-render all ★ buttons across the UI to reflect current watchlist state
function refreshWlButtons() {
  document.querySelectorAll(".wl-star-btn[data-wl-id]").forEach(btn => {
    const id       = parseInt(btn.dataset.wlId);
    const watching = wlHas(id);
    btn.textContent      = watching ? "★" : "☆";
    btn.title            = watching ? "Remove from watchlist" : "Add to watchlist";
    btn.style.color      = watching ? "#f5c400" : "var(--text3)";
    btn.style.fontWeight = watching ? "700" : "400";
  });
}

// Star button HTML — used in rankings rows, transfer cards, pitch cards
// Player registry for watchlist — avoids JSON/quote issues in onclick attributes
const _wlRegistry = {};

function wlRegister(p) {
  _wlRegistry[p.id] = {
    id: p.id, name: p.name, pos: p.pos, team_name: p.team_name,
    composite: p.composite, price: p.price, form: p.form, ownership: p.ownership||0,
  };
}

function wlAddById(id) {
  const p = _wlRegistry[id];
  if (p) wlAdd(p);
}

function wlToggle(id) {
  if (wlHas(id)) {
    wlRemove(id);
  } else {
    wlAddById(id);
  }
}

function wlStarBtn(p) {
  if (!p || !p.id) return "";
  wlRegister(p);
  const watching = wlHas(p.id);
  return `<button class="wl-star-btn" data-wl-id="${p.id}"
    title="${watching ? "Remove from watchlist" : "Add to watchlist"}"
    style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 4px;
    color:${watching ? "#f5c400" : "var(--text3)"};font-weight:${watching ? "700" : "400"}">
    ${watching ? "★" : "☆"}</button>`;
}

// Single delegated click handler — attached once, handles all star buttons
document.addEventListener("click", function(e) {
  const btn = e.target.closest(".wl-star-btn");
  if (!btn) return;
  e.stopPropagation();
  const id = parseInt(btn.dataset.wlId);
  if (!id) return;
  wlToggle(id);
}, true);

function renderScoutTab() {
  const wl      = wlGet();
  const entries = Object.values(wl);
  const allP    = _state?.all_players || [];

  if (!entries.length) {
    el("tab-scout").innerHTML = `<div class="card">
      <div class="chart-title" style="margin-bottom:.5rem">★ Watchlist</div>
      <p style="font-size:13px;color:var(--text2);line-height:1.7">
        No players on your watchlist yet.<br>
        Click ☆ next to any player in <strong>Rankings</strong> or <strong>Transfers</strong> to start tracking them.
        The watchlist records composite score, price and form on every dashboard load — building a trend you can review here. Alerts fire when a player's score changes by 5+ points between loads.
      </p>
    </div>`;
    return;
  }

  // Sort by most recently added
  entries.sort((a,b) => (b.added||"") > (a.added||"") ? 1 : -1);

  const cards = entries.map(entry => {
    const live    = allP.find(p => p.id === entry.id);
    const hist    = entry.history;
    const first   = hist[0];
    const last    = hist[hist.length - 1];
    const prev    = hist.length >= 2 ? hist[hist.length - 2] : null;

    const composite = live?.composite ?? last?.composite ?? "?";
    const price     = live?.price     ?? last?.price     ?? "?";
    const form      = live?.form      ?? last?.form      ?? "?";
    const fixes     = live?.fixes     || [];
    const fix1      = fixes[0];

    // Price movement since added
    const priceDiff  = first ? round2(price - first.price) : 0;
    const priceC     = priceDiff > 0 ? "var(--green-fg)" : priceDiff < 0 ? "var(--red-fg)" : "var(--text3)";
    const priceArrow = priceDiff > 0 ? "↑" : priceDiff < 0 ? "↓" : "→";

    // Composite change since last load
    const compDiff  = prev ? composite - prev.composite : 0;
    const compC     = compDiff > 3 ? "var(--green-fg)" : compDiff < -3 ? "var(--red-fg)" : "var(--text2)";
    const alertBadge = Math.abs(compDiff) > 5
      ? badge(compDiff > 0 ? "green" : "red", `${compDiff > 0 ? "+" : ""}${compDiff} score`)
      : "";

    // Trend arrow from form_trend_label
    const trendLbl = live?.form_trend_label || "→";
    const trendC   = trendLbl.startsWith("↑") ? "var(--green-fg)"
                   : trendLbl.startsWith("↓") ? "var(--red-fg)" : "var(--text3)";

    // Mini sparkline using SVG (last 8 data points)
    const sparkData = hist.slice(-8).map(h => h.composite);
    const sparkHtml = sparkline(sparkData, 100, 28);

    // Next fixture
    const fdrC   = FDR_C[fix1?.fdr] || "#888";
    const fixStr = fix1 ? `${fix1.opp} ${fix1.home?"H":"A"} FDR${fix1.fdr}` : "TBC";

    return `<div style="background:var(--surface);border:1px solid var(--border);
      border-radius:0;padding:14px 16px;margin-bottom:10px;
      display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start">
      <div style="padding-top:2px">
        <input type="checkbox" class="scout-compare-cb" data-id="${entry.id}"
          title="Select to compare"
          style="width:16px;height:16px;cursor:pointer;accent-color:var(--purple-fg)">
      </div>
      <div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <span data-pid="${entry.id}" style="font-size:14px;font-weight:800;cursor:pointer;
            color:var(--text)">${entry.name}</span>
          ${badge("gray", entry.pos)}
          <span style="font-size:11px;color:var(--text2)">${entry.team_name}</span>
          ${alertBadge}
          ${live ? dgwBadge(live) : ""}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-bottom:8px">
          <span>Score: <strong style="color:${compC}">${composite}</strong></span>
          <span>£<strong>${typeof price==="number"?price.toFixed(1):price}m</strong>
            <span style="color:${priceC};font-size:11px"> ${priceArrow}${Math.abs(priceDiff).toFixed(1)}</span>
          </span>
          <span>Form: <strong>${form}</strong>
            <span style="color:${trendC};font-size:11px"> ${trendLbl}</span>
          </span>
          <span style="color:${fdrC}">Next: ${fixStr}</span>
        </div>
        <div style="font-size:10px;color:var(--text3)">
          Scouted since ${entry.added} · ${hist.length} data point${hist.length!==1?"s":""}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        ${sparkHtml}
        <button onclick="wlRemove(${entry.id})"
          style="background:none;border:1px solid var(--border);border-radius:0;
          padding:3px 10px;font-size:11px;cursor:pointer;color:var(--text3);
          font-family:var(--font)">Remove</button>
      </div>
    </div>`;
  }).join("");

  el("tab-scout").innerHTML = `<div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
      <div class="chart-title">🔍 Scout <span style="font-size:13px;color:var(--text3);font-weight:400">(${entries.length} player${entries.length!==1?"s":""})</span></div>
      <div style="display:flex;gap:8px">
        <button onclick="scoutCompareSelected()"
          style="background:var(--surface2);border:1px solid var(--border);border-radius:0;
          padding:4px 12px;font-size:11px;cursor:pointer;color:var(--text2);font-family:var(--font)">
          ⇄ Compare selected</button>
        <button onclick="if(confirm('Clear all scouted players?')){localStorage.removeItem('fpl_watchlist');renderScoutTab();refreshWlButtons();}"
          style="background:none;border:1px solid var(--border);border-radius:0;
          padding:4px 12px;font-size:11px;cursor:pointer;color:var(--text3);font-family:var(--font)">
          Clear all</button>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:.75rem">
      Click any player name to open their profile. Tick two players and click Compare.
      Composite score, price and form update each dashboard load.
    </p>
    <div id="scoutCards">${cards}</div>
  </div>`;
}

function scoutCompareSelected() {
  const checked = [...document.querySelectorAll(".scout-compare-cb:checked")];
  if (checked.length < 2) { alert("Tick two players to compare"); return; }
  const [a, b] = checked.map(c => parseInt(c.dataset.id));
  openComparison(a, b);
}
// Mini sparkline SVG for composite trend
function sparkline(data, w=100, h=28) {
  if (data.length < 2) return `<div style="width:${w}px;height:${h}px;color:var(--text3);font-size:10px;text-align:center">—</div>`;
  const mn  = Math.min(...data) - 2;
  const mx  = Math.max(...data) + 2;
  const rng = mx - mn || 1;
  const pts = data.map((v,i) => {
    const x = Math.round(i / (data.length-1) * w);
    const y = Math.round(h - (v - mn) / rng * h);
    return `${x},${y}`;
  }).join(" ");
  const last    = data[data.length-1];
  const prev    = data[data.length-2];
  const lineC   = last > prev ? "#1a8a26" : last < prev ? "#a3182a" : "#888";
  const dotX    = Math.round(w);
  const dotY    = Math.round(h - (last - mn) / rng * h);
  return `<svg width="${w}" height="${h}" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${lineC}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${dotX}" cy="${dotY}" r="2.5" fill="${lineC}"/>
  </svg>`;
}

function round2(v) { return Math.round(v * 10) / 10; }

// ── Theme ──────────────────────────────────────────────────────
function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const next   = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  el("themeToggle").textContent = next === "dark" ? "☀️" : "🌙";
  localStorage.setItem("fpl_theme", next);
}
(function initTheme() {
  const saved = localStorage.getItem("fpl_theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  // Button set after DOM ready
  window.addEventListener("DOMContentLoaded", () => {
    const btn = el("themeToggle");
    if (btn) btn.textContent = saved === "dark" ? "☀️" : "🌙";
  });
})();

// ── Club Hub ───────────────────────────────────────────────────
function updateClubHub(data, meta) {
  const hub = el("clubHub");
  if (!hub) return;
  hub.style.display = "block";

  el("clubName").textContent    = meta.team_name || "My Team";
  el("clubManager").textContent = meta.manager   || "";

  const gwRow = data.gw_history?.[data.gw_history.length - 1];
  el("clubGwPts").textContent = gwRow?.pts ?? "—";
  el("clubRank").textContent  = meta.overall_rank
    ? parseInt(meta.overall_rank).toLocaleString() : "—";
  el("clubBank").textContent  = `£${(meta.bank||0).toFixed(1)}m`;
  el("clubVal").textContent   = `£${(meta.squad_value||0).toFixed(1)}m`;

  // Chips
  const allChips = [
    {key:"wildcard",lbl:"WC",c:"var(--blue-fg)"},
    {key:"freehit", lbl:"FH",c:"var(--purple-fg)"},
    {key:"3xc",     lbl:"TC",c:"var(--amber-fg)"},
    {key:"bboost",  lbl:"BB",c:"var(--green-fg)"},
  ];
  const used = new Set(meta.chips_used || []);
  el("clubChips").innerHTML = allChips.map(chip => {
    const spent = used.has(chip.key);
    return `<span style="padding:2px 8px;border-radius:0;font-size:10px;font-weight:700;
      background:${spent?"var(--surface2)":chip.c+"22"};
      color:${spent?"var(--text3)":chip.c};
      border:1px solid ${spent?"var(--border)":chip.c+"66"};
      text-decoration:${spent?"line-through":"none"}">${chip.lbl}</span>`;
  }).join("");

  // Deadline
  if (meta.deadline_time) {
    const diff    = new Date(meta.deadline_time) - new Date();
    const urgent  = diff > 0 && diff < 3600000;
    const past    = diff <= 0;
    const h = Math.floor(diff/3600000);
    const m = Math.floor((diff%3600000)/60000);
    el("clubDeadline").innerHTML = past
      ? `<span style="color:var(--text3)">GW${meta.current_gw} live</span>`
      : `<span style="color:${urgent?"var(--red-fg)":"var(--text3)"}">
          ${urgent?"⚠":"⏱"} Deadline: ${h>0?h+"h ":""}${m}m
         </span>`;
  }
}

// ── Recent teams (localStorage) ───────────────────────────────

function saveRecentTeam(id, teamName, manager) {
  try {
    const recent = getRecentTeams().filter(t => t.id !== String(id));
    recent.unshift({ id: String(id), teamName, manager, ts: Date.now() });
    localStorage.setItem("fpl_recent_teams", JSON.stringify(recent.slice(0, 5)));
    renderRecentTeams();
  } catch(e) {}  // localStorage may be unavailable
}

function getRecentTeams() {
  try {
    return JSON.parse(localStorage.getItem("fpl_recent_teams") || "[]");
  } catch(e) { return []; }
}

function renderRecentTeams() {
  const container = el("recentTeams");
  if (!container) return;
  const recent = getRecentTeams();
  if (!recent.length) { container.innerHTML = ""; return; }
  container.innerHTML = `
    <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Recent teams</div>
    ${recent.map(t => `
      <button onclick="quickLoadTeam('${t.id}')"
        style="display:block;width:100%;text-align:left;padding:5px 8px;margin-bottom:3px;
        border:1px solid var(--border);border-radius:0;background:var(--surface2);
        cursor:pointer;font-family:var(--font);font-size:11px;color:var(--text2)">
        <strong style="color:var(--text)">${t.teamName||"Team "+t.id}</strong>
        <span style="float:right;color:var(--text3)">${t.id}</span>
        ${t.manager ? `<div style="font-size:10px;color:var(--text3)">${t.manager}</div>` : ""}
      </button>`).join("")}`;
}

function quickLoadTeam(id) {
  el("teamId").value = id;
  loadDashboard();
}



