import React, { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase ────────────────────────────────────────────────────────
const db = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// ─── Google Sheets ───────────────────────────────────────────────────
async function pushSheet(webAppUrl, spreadsheetId, tabName, rows) {
  if (!webAppUrl || !spreadsheetId) return { ok: false, err: "Google Sheets not configured — tap ⚙️ Sheets" };
  const CHUNK = 5;
  let totalWritten = 0;
  let lastSheets = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const isFirst = i === 0;
    const ts = Date.now();
    const payload = encodeURIComponent(JSON.stringify({
      spreadsheetId, tab: tabName,
      rows: chunk, startRow: i + 1,
      clear: isFirst, ts
    }));
    const url = `${webAppUrl}?payload=${payload}`;
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!data) return { ok: false, err: `No response from script on chunk ${i/CHUNK+1}` };
      if (data.ok === false) return { ok: false, err: `Script error: ${data.error} (tab="${data.tab}", id="${data.spreadsheetId}")` };
      totalWritten += (data.written || 0);
      if (data.sheets) lastSheets = data.sheets;
    } catch (e) {
      return { ok: false, err: `Network error chunk ${i/CHUNK+1}: ${e.message}` };
    }
  }
  return { ok: true, written: totalWritten, sheets: lastSheets };
}

async function pushSheetAppend(webAppUrl, spreadsheetId, tabName, headerRow, dataRows) {
  if (!webAppUrl || !spreadsheetId) return { ok: false, err: "Google Sheets not configured — tap ⚙️ Sheets" };
  const infoPayload = encodeURIComponent(JSON.stringify({
    spreadsheetId, tab: tabName, getInfo: true, ts: Date.now()
  }));
  let existingRows = 0;
  try {
    const res = await fetch(`${webAppUrl}?payload=${infoPayload}`, { method: "GET", cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (data && data.ok) existingRows = data.rowCount || 0;
  } catch (_) {}

  const rowsToWrite = existingRows === 0 ? [headerRow, ...dataRows] : dataRows;
  const startRow = existingRows === 0 ? 1 : existingRows + 1;
  if (rowsToWrite.length === 0) return { ok: true, written: 0, sheets: [] };
  const CHUNK = 5;
  let totalWritten = 0;
  let lastSheets = [];
  for (let i = 0; i < rowsToWrite.length; i += CHUNK) {
    const chunk = rowsToWrite.slice(i, i + CHUNK);
    const payload = encodeURIComponent(JSON.stringify({
      spreadsheetId, tab: tabName,
      rows: chunk, startRow: startRow + i,
      clear: false, ts: Date.now()
    }));
    try {
      const res = await fetch(`${webAppUrl}?payload=${payload}`, { method: "GET", cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!data) return { ok: false, err: `No response on chunk ${i/CHUNK+1}` };
      if (data.ok === false) return { ok: false, err: `Script error: ${data.error}` };
      totalWritten += (data.written || 0);
      if (data.sheets) lastSheets = data.sheets;
    } catch (e) {
      return { ok: false, err: `Network error chunk ${i/CHUNK+1}: ${e.message}` };
    }
  }
  return { ok: true, written: totalWritten, sheets: lastSheets };
}

// ─── Helpers & Constants ─────────────────────────────────────────────
const DAYS_SUN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const todayISO = () => new Date().toISOString().split("T")[0];
const nowTime = () => new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
const fmtDate = iso => { if(!iso)return""; const[y,m,d]=iso.split("-"); return`${d}/${m}/${y}`; };
const addDays = (iso,n) => { const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; };

function snapToSunday(isoDate){
  const d=new Date(isoDate+"T12:00:00");
  const dow=d.getDay();
  if(dow===0)return isoDate;
  d.setDate(d.getDate()-dow);
  return d.toISOString().split("T")[0];
}

function rotaWeekOf(iso) {
  return { start: snapToSunday(iso), end: addDays(snapToSunday(iso), 6) };
}

// ─── CSS Injection ──────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#FFF5EF;-webkit-tap-highlight-color:transparent;}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;position:relative;overflow-x:hidden;}
.role-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;background:linear-gradient(160deg,#1A1A2E,#3D2010);}
.role-logo{font-size:52px;margin-bottom:12px;}.role-title{font-size:28px;font-weight:900;color:#fff;text-align:center;margin-bottom:6px;}
.role-sub{font-size:14px;color:rgba(255,255,255,.55);margin-bottom:36px;text-align:center;}
.role-btn{width:100%;padding:20px;border-radius:18px;border:none;cursor:pointer;margin-bottom:12px;display:flex;align-items:center;gap:14px;}
.role-btn.staff{background:#E8620A;color:#fff;}.role-btn.manager{background:#fff;color:#1A1A2E;}
.auth{min-height:100vh;padding:48px 24px 32px;display:flex;flex-direction:column;}
.back{background:none;border:none;font-size:26px;cursor:pointer;align-self:flex-start;margin-bottom:20px;color:#1A1A2E;}
.atitle{font-size:25px;font-weight:900;color:#1A1A2E;margin-bottom:6px;}
.asub{font-size:14px;color:#888;margin-bottom:24px;line-height:1.6;}
.lbl{font-size:13px;font-weight:700;color:#888;margin-bottom:5px;display:block;text-transform:uppercase;}
.inp{width:100%;padding:14px;border:2px solid #E5E5E5;border-radius:12px;font-size:16px;margin-bottom:14px;outline:none;}
.inp:focus{border-color:#E8620A;}.inp.code{font-size:26px;letter-spacing:8px;font-weight:800;text-align:center;}
.btn{width:100%;padding:16px;background:#E8620A;border:none;border-radius:14px;font-size:16px;font-weight:800;color:#1A1A2E;cursor:pointer;margin-top:8px;}
.btn.sec{background:#F0F0F0;color:#1A1A2E;}
.slist{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;}
.sitem{padding:14px 16px;background:#FFF5EF;border-radius:12px;display:flex;align-items:center;gap:12px;cursor:pointer;}
.avatar{width:42px;height:42px;border-radius:21px;background:#E8620A;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;}
.hdr{padding:18px 18px 8px;display:flex;align-items:center;justify-content:space-between;}
.hdr-name{font-size:20px;font-weight:900;color:#1A1A2E;}
.body{padding:0 16px 110px;}
.clkcard{background:linear-gradient(135deg,#1A1A2E,#2D1F0E);border-radius:20px;padding:20px;margin-bottom:14px;color:#fff;}
.clktime{font-size:40px;font-weight:900;}
.clkbtns{display:flex;gap:8px;margin-top:12px;}
.clkbtn{flex:1;padding:13px;border-radius:11px;border:none;font-size:13px;font-weight:800;cursor:pointer;}
.clkbtn.in{background:#50DC78;color:#1A1A2E;}.clkbtn.out{background:#E05252;color:#fff;}
.rday{background:#FFF5EF;border-radius:13px;padding:11px 13px;margin-bottom:7px;display:flex;align-items:center;gap:8px;}
.rday.today{border:2px solid #E8620A;}
.rdaylbl{min-width:60px;}.rdayname{font-size:12px;font-weight:800;}.rdaydate{font-size:10px;color:#aaa;}
.rdayshift{flex:1;font-size:13px;font-weight:700;}
.rdaybtns{display:flex;gap:5px;}
.okbtn{border:none;background:#D1FAE5;color:#065F46;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;}
.nobtn{border:none;background:#FEE2E2;color:#E05252;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;}
.chip{display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;}
.chip.g{background:#D1FAE5;color:#065F46;}.chip.r{background:#FEE2E2;color:#7F1D1D;}
.toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#E8620A;color:#fff;padding:10px 18px;border-radius:40px;font-size:13px;font-weight:700;z-index:999;}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:200;}
.sheet{background:#fff;border-radius:24px 24px 0 0;padding:24px 20px 44px;width:100%;max-width:430px;}
`;

function Toast({ msg }) {
  return msg ? <div className="toast">{msg}</div> : null;
}

// ─── MAIN APP COMPONENT ──────────────────────────────────────────────
export default function App() {
  const [role, setRole] = useState(null);
  const [user, setUser] = useState(null);
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  };

  useEffect(() => {
    async function loadStaff() {
      const { data } = await db.from("staff").select("*");
      if (data) setStaffList(data);
      setLoading(false);
    }
    loadStaff();
  }, []);

  if (loading) return <div style={{ textAlign: "center", padding: 40 }}>Loading app…</div>;

  return (
    <div className="app">
      <style>{CSS}</style>
      <Toast msg={toastMsg} />

      {!role && (
        <RolePicker onPick={(r) => setRole(r)} />
      )}

      {role === "staff" && !user && (
        <StaffLogin
          staff={staffList}
          onLogin={(u) => setUser(u)}
          onBack={() => setRole(null)}
        />
      )}

      {role === "staff" && user && (
        <StaffDashboard
          user={user}
          onLogout={() => setUser(null)}
          toast={showToast}
        />
      )}
    </div>
  );
}

// ─── ROLE PICKER ─────────────────────────────────────────────────────
function RolePicker({ onPick }) {
  return (
    <div className="role-screen">
      <div className="role-logo">🍽️</div>
      <div className="role-title">Staff Portal</div>
      <div className="role-sub">Who is using this device?</div>
      <button className="role-btn staff" onClick={() => onPick("staff")}>
        <span>👤</span><span>I'm a Staff Member</span>
      </button>
      <button className="role-btn manager" onClick={() => onPick("manager")}>
        <span>🔑</span><span>I'm the Manager</span>
      </button>
    </div>
  );
}

// ─── STAFF LOGIN ─────────────────────────────────────────────────────
function StaffLogin({ staff, onLogin, onBack }) {
  const [sel, setSel] = useState(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  if (sel) {
    return (
      <div className="auth">
        <button className="back" onClick={() => setSel(null)}>←</button>
        <div className="atitle">Hi {sel.name.split(" ")[0]}! 👋</div>
        <div className="asub">Enter your 8-digit code</div>
        <input
          className="inp code"
          type="password"
          maxLength={8}
          placeholder="••••••••"
          value={code}
          onChange={(e) => { setCode(e.target.value); setErr(""); }}
        />
        {err && <div style={{ color: "#E05252", fontWeight: 700, marginBottom: 10 }}>{err}</div>}
        <button
          className="btn"
          disabled={code.length !== 8}
          onClick={() => {
            if (code === sel.code) onLogin(sel);
            else { setErr("Wrong code — try again"); setCode(""); }
          }}
        >
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="auth">
      <button className="back" onClick={onBack}>←</button>
      <div className="atitle">Who are you? 👋</div>
      <div className="asub">Select your name to continue</div>
      <div className="slist">
        {staff.map((s) => (
          <div key={s.id} className="sitem" onClick={() => setSel(s)}>
            <div className="avatar">{s.name[0]}</div>
            <div><div style={{ fontWeight: 700 }}>{s.name}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── STAFF DASHBOARD (WITH INSTANT FIXED ROTA RESPONSES) ──────────────
function StaffDashboard({ user, onLogout, toast }) {
  const [clockedIn, setClockedIn] = useState(false);
  const [responses, setResponses] = useState({});
  const [rejectingDate, setRejectingDate] = useState(null);
  const [rejectReason, setRejectReason] = useState("");

  const week = rotaWeekOf(todayISO());
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(week.start, i);
    return { date: d, dayName: DAYS_SUN[i], isToday: d === todayISO() };
  });

  // Load existing rota responses on mount
  useEffect(() => {
    async function fetchResponses() {
      const { data } = await db
        .from("rota_responses")
        .select("*")
        .eq("staff_id", user.id);

      if (data) {
        const respMap = {};
        data.forEach((r) => { respMap[r.date] = r.status; });
        setResponses(respMap);
      }
    }
    fetchResponses();
  }, [user.id]);

  // ── FIX: Instant Optimistic "Okay" Handler ──
  const handleAccept = async (date) => {
    // 1. Instant local state update (solves the 11-click delay)
    setResponses((prev) => ({ ...prev, [date]: "accepted" }));
    toast("👍 Confirmed shift!");

    // 2. Persist to DB asynchronously
    const { error } = await db
      .from("rota_responses")
      .upsert({ staff_id: user.id, date, status: "accepted" });

    if (error) {
      // Revert state on failure
      setResponses((prev) => ({ ...prev, [date]: undefined }));
      toast("❌ Network error — failed to save response");
    }
  };

  // ── FIX: Instant Optimistic "Can't Do" Handler ──
  const handleRejectSubmit = async () => {
    const date = rejectingDate;
    if (!date) return;

    // 1. Instant local state update & close modal
    setResponses((prev) => ({ ...prev, [date]: "rejected" }));
    setRejectingDate(null);
    toast("Marked as Can't Do");

    // 2. Persist to DB asynchronously
    const { error } = await db
      .from("rota_responses")
      .upsert({
        staff_id: user.id,
        date,
        status: "rejected",
        reason: rejectReason
      });

    setRejectReason("");

    if (error) {
      setResponses((prev) => ({ ...prev, [date]: undefined }));
      toast("❌ Failed to submit request");
    }
  };

  return (
    <div>
      <div className="hdr">
        <div>
          <div className="hdr-name">{user.name}</div>
          <div style={{ fontSize: 12, color: "#888" }}>Staff Dashboard</div>
        </div>
        <button
          onClick={onLogout}
          style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#F0F0F0", fontWeight: 700 }}
        >
          Exit
        </button>
      </div>

      <div className="body">
        {/* Clock In / Out Card */}
        <div className="clkcard">
          <div className="clktime">{nowTime()}</div>
          <div className="clkbtns">
            <button
              className="clkbtn in"
              disabled={clockedIn}
              onClick={() => { setClockedIn(true); toast("Clocked in!"); }}
            >
              Clock In
            </button>
            <button
              className="clkbtn out"
              disabled={!clockedIn}
              onClick={() => { setClockedIn(false); toast("Clocked out!"); }}
            >
              Clock Out
            </button>
          </div>
        </div>

        {/* Weekly Rota List */}
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 10 }}>This Week's Rota</div>
        {days.map((day) => {
          const status = responses[day.date];

          return (
            <div key={day.date} className={`rday ${day.isToday ? "today" : ""}`}>
              <div className="rdaylbl">
                <div className="rdayname">{day.dayName}</div>
                <div className="rdaydate">{fmtDate(day.date)}</div>
              </div>
              <div className="rdayshift">Shift Scheduled</div>

              <div className="rdaybtns">
                {status === "accepted" ? (
                  <span className="chip g">Accepted ✓</span>
                ) : status === "rejected" ? (
                  <span className="chip r">Can't Do ✗</span>
                ) : (
                  <>
                    <button className="okbtn" onClick={() => handleAccept(day.date)}>
                      Okay
                    </button>
                    <button className="nobtn" onClick={() => setRejectingDate(day.date)}>
                      Can't Do
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Rejection Modal for "Can't Do" */}
      {rejectingDate && (
        <div className="overlay">
          <div className="sheet">
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 8 }}>
              Mark as Can't Do
            </div>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 14 }}>
              Let your manager know why you can't work on {fmtDate(rejectingDate)}:
            </div>
            <input
              className="inp"
              placeholder="Reason (optional)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <button className="btn" onClick={handleRejectSubmit}>
              Submit
            </button>
            <button
              className="btn sec"
              onClick={() => { setRejectingDate(null); setRejectReason(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
