import React, { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase ────────────────────────────────────────────────────────
const db = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// ─── Google Sheets ───────────────────────────────────────────────────
// Google Sheets WRITES require OAuth2 — a plain API key can only read public
// sheets, never write (Google rejects it with "API keys are not supported by
// this API"). The supported no-backend workaround is a small Google Apps
// Script "Web App" that runs under the sheet owner's own permissions and
// accepts a simple POST from the browser. See the ⚙️ Sheets settings screen
// in the app for the exact script to paste in and how to deploy it.
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
// Header-once push: writes header to row 1 only if the sheet is currently empty,
// then appends data rows after whatever is already there.
// Used for Payroll, Daily, and Weekly tabs so headers are never overwritten.
async function pushSheetAppend(webAppUrl, spreadsheetId, tabName, headerRow, dataRows) {
  if (!webAppUrl || !spreadsheetId) return { ok: false, err: "Google Sheets not configured — tap ⚙️ Sheets" };
  // Step 1: ask the script how many rows the sheet currently has
  const infoPayload = encodeURIComponent(JSON.stringify({
    spreadsheetId, tab: tabName, getInfo: true, ts: Date.now()
  }));
  let existingRows = 0;
  try {
    const res = await fetch(`${webAppUrl}?payload=${infoPayload}`, { method: "GET", cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (data && data.ok) existingRows = data.rowCount || 0;
  } catch (_) {}
  // Step 2: if sheet is empty, write header first
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
// Simple connectivity check used by the "Test Connection" button in Settings.
async function testWebApp(webAppUrl) {
  if (!webAppUrl) return { ok: false, err: "Enter a Web App URL first" };
  // Strip any whitespace/newlines that may have crept in during copy-paste
  const url = webAppUrl.trim();
  // Basic format sanity check before even trying to fetch
  if (!url.startsWith("https://")) return { ok: false, err: `URL must start with https:// — yours starts with: "${url.slice(0,20)}"` };
  if (!url.includes("script.google.com")) return { ok: false, err: `URL must contain script.google.com — yours contains: "${url.slice(0,60)}"` };
  if (url.endsWith("/dev")) return { ok: false, err: "URL ends in /dev — this URL requires a Google login and will never work from the app. Go back to Apps Script → Deploy → Manage deployments, and copy the Web app URL (ends in /exec)." };
  if (!url.endsWith("/exec")) return { ok: false, err: `URL must end in /exec — yours ends in: "…${url.slice(-20)}"` };
  try {
    const res = await fetch(url, { method: "GET" });
    const text = await res.text().catch(() => "");
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (data && data.ok) return { ok: true };
    if (text.includes("accounts.google.com") || text.includes("ServiceLogin")) return { ok: false, err: "Google is asking to sign in — go to Apps Script → Deploy → Manage deployments → edit → set \"Who has access\" to \"Anyone\" (not \"Anyone with Google account\") → create New version → Deploy." };
    if (text.includes("Script function not found") || text.includes("doGet")) return { ok: false, err: "Script reached but doGet is missing — paste the latest script code from the setup steps and create a New deployment version." };
    return { ok: false, err: `Reached the URL but got unexpected response (HTTP ${res.status}). Response starts with: "${text.slice(0,80)}"` };
  } catch (e) {
    // A fetch exception here means the browser couldn't connect at all.
    // Most likely causes: URL has invisible characters, wrong domain, or network blocks script.google.com.
    return { ok: false, err: `Network error: ${e.message}. The URL stored is: "${url.slice(0,80)}". Try opening the URL in a new browser tab using the link above — if that works, the issue is a browser security policy blocking the app's fetch.` };
  }
}
function copyTSV(rows, toast) {
  const tsv = rows.map(r => r.map(c => String(c ?? "")).join("\t")).join("\n");
  navigator.clipboard.writeText(tsv)
    .then(() => toast("📋 Copied! Open Google Sheets → click A1 → Ctrl+V"))
    .catch(() => toast("❌ Copy failed"));
}

// ─── Constants ───────────────────────────────────────────────────────
const DAYS_SUN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAYS_MON = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const SHIFTS   = ["Off","Full Day (11am–close)","Night (5:30pm–close)","Custom"];
const ADD_LBLS = ["Bank Holiday","Red Day","Other"];
const DED_LBLS = ["Left Early","Sick Leave","Other"];
const TKFIELDS = [
  { key:"deliveroo",        label:"Deliveroo 🛵",        db:"deliveroo",         sign: 1 },
  { key:"uber",             label:"Uber Eats 🛵",         db:"uber",              sign: 1 },
  { key:"cash",             label:"Cash 💵",              db:"cash",              sign: 1 },
  { key:"card",             label:"Card 💳",              db:"card",              sign: 1 },
  { key:"online",           label:"Online 🌐",            db:"online",            sign: 1 },
  { key:"shopExpense",      label:"Shop Expense 🧾",      db:"shop_expense",      sign:-1, hint:"Store/supplies expenses — enter as positive, deducted automatically", managerOnly:true },
  { key:"depositReceipt",   label:"Deposit Receipt",      db:"deposit_receipt",   sign: 1, cc:true, ccDb:"deposit_pay_type" },
  { key:"voucherPurchase",  label:"Voucher Purchase 🎫",  db:"voucher_purchase",  sign: 1, cc:true, ccDb:"voucher_pay_type" },
  { key:"tipsCash",         label:"Tips Cash 💵",          db:"tips_cash",         sign: 0, infoOnly:true, hint:"Cash tips received — informational only, does not affect totals" },
  { key:"tipsCard",         label:"Tips Card 💳",          db:"tips_card",         sign: 0, infoOnly:true, hint:"Card tips received — informational only, does not affect totals" },
];

// ── Bank holidays & special restaurant days 2026/2027 ──
const BANK_HOLIDAYS=[
  "2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25","2026-08-31","2026-12-25","2026-12-28",
  "2027-01-01","2027-03-26","2027-03-29","2027-05-03","2027-05-31","2027-08-30","2027-12-27","2027-12-28"
];
const SPECIAL_DAYS=[
  {date:"2026-02-14",label:"Valentine's Day 💝",type:"special"},
  {date:"2026-03-15",label:"Mother's Day 💐",type:"special"},
  {date:"2026-06-21",label:"Father's Day 👔",type:"special"},
  {date:"2026-10-31",label:"Halloween 🎃",type:"special"},
  {date:"2026-11-05",label:"Bonfire Night 🎆",type:"special"},
  {date:"2026-12-24",label:"Christmas Eve 🎄",type:"special"},
  {date:"2026-12-25",label:"Christmas Day 🎅",type:"bh"},
  {date:"2026-12-26",label:"Boxing Day 🎁",type:"special"},
  {date:"2026-12-31",label:"New Year's Eve 🥂",type:"special"},
  {date:"2027-01-01",label:"New Year's Day 🎉",type:"bh"},
  {date:"2027-02-14",label:"Valentine's Day 💝",type:"special"},
  {date:"2027-03-14",label:"Mother's Day 💐",type:"special"},
  {date:"2027-06-20",label:"Father's Day 👔",type:"special"},
  {date:"2027-10-31",label:"Halloween 🎃",type:"special"},
  {date:"2027-11-05",label:"Bonfire Night 🎆",type:"special"},
  {date:"2027-12-24",label:"Christmas Eve 🎄",type:"special"},
  {date:"2027-12-26",label:"Boxing Day 🎁",type:"special"},
  {date:"2027-12-31",label:"New Year's Eve 🥂",type:"special"},
];
function getWeekAlerts(startISO){
  const end=addDays(startISO,6);
  const alerts=[];
  BANK_HOLIDAYS.forEach(d=>{if(d>=startISO&&d<=end)alerts.push({date:d,label:`Bank Holiday: ${new Date(d+"T12:00:00").toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"short"})}`,type:"bh"});});
  SPECIAL_DAYS.forEach(s=>{if(s.date>=startISO&&s.date<=end)alerts.push(s);});
  return alerts;
}
// Snap any date to the nearest preceding Sunday
function snapToSunday(isoDate){
  const d=new Date(isoDate+"T12:00:00");
  const dow=d.getDay(); // 0=Sun
  if(dow===0)return isoDate;
  d.setDate(d.getDate()-dow);
  return d.toISOString().split("T")[0];
}
const todayISO  = () => new Date().toISOString().split("T")[0];
const nowTime   = () => new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
const fmtDate   = iso => { if(!iso)return""; const[y,m,d]=iso.split("-"); return`${d}/${m}/${y}`; };
const r2 = v => Math.round((parseFloat(v)||0)*100)/100; // ⚠️ PERMANENT: always use r2() for monetary values — never toFixed(2) on raw floats, never TKFIELDS.reduce with signs for totals
const addDays   = (iso,n) => { const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; };
const dispDate  = (iso,wd=false) => { if(!iso)return""; const d=new Date(iso+"T12:00:00"); return wd?d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}):d.toLocaleDateString("en-GB",{day:"numeric",month:"short"}); };
const fmtRange  = (s,e) => `${fmtDate(s)} – ${fmtDate(e)}`;
const fmtRangeExport = (s,e) => `${fmtDate(s)}-${fmtDate(e)}`; // plain hyphen, no spaces, for spreadsheet exports
const parseHrs  = (i,o) => { if(!i||!o)return 0; const p=t=>{const[h,m]=t.split(":").map(Number);return h+m/60;}; return Math.max(0,p(o)-p(i)); };
// Rounds a clocked duration UP to the nearest 15-minute mark before converting to hours,
// e.g. 3:00pm–5:12pm (2h12m) becomes 2h15m = 2.25h. Only matters for hourly-paid staff.
const roundHrsUp = hrs => hrs<=0?0:Math.ceil(hrs*4-1e-9)/4;
// Nearest 0.25hr rounding (for overtime/early-leave): 37min→0.5h, 43min→0.75h
const roundHrs025 = hrs => hrs<=0?0:Math.round(hrs*4)/4;
const jsToMon   = d => d; // DAYS_MON is Sun-based ["Sun","Mon",...,"Sat"] so jsDay IS the direct index
const weekDates = monISO => Array.from({length:7},(_,i)=>addDays(monISO,i));
const kId       = id => `k_${id}`; // kitchen staff key prefix for payroll_extras

function payWeekOf(iso) {
  const d=new Date(iso+"T12:00:00"),dow=d.getDay();
  const sun=new Date(d); sun.setDate(d.getDate()-dow);
  const sat=new Date(sun); sat.setDate(sun.getDate()+6);
  return{start:sun.toISOString().split("T")[0],end:sat.toISOString().split("T")[0]};
}
function rotaWeekOf(iso) {
  // Business week: Sunday to Saturday
  return{start:snapToSunday(iso),end:addDays(snapToSunday(iso),6)};
}

// ─── CSS ─────────────────────────────────────────────────────────────
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#FFF5EF;-webkit-tap-highlight-color:transparent;overscroll-behavior:none;}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;position:relative;overflow-x:hidden;}
.role-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;background:linear-gradient(160deg,#1A1A2E,#3D2010);}
.role-logo{font-size:52px;margin-bottom:12px;}.role-title{font-size:28px;font-weight:900;color:#fff;text-align:center;margin-bottom:6px;}
.role-sub{font-size:14px;color:rgba(255,255,255,.55);margin-bottom:36px;text-align:center;}
.role-btn{width:100%;padding:20px;border-radius:18px;border:none;cursor:pointer;margin-bottom:12px;display:flex;align-items:center;gap:14px;transition:transform .1s;}
.role-btn:active{transform:scale(.97);}.role-btn.staff{background:#E8620A;color:#fff;}.role-btn.manager{background:#fff;color:#1A1A2E;}
.ri{font-size:30px;}.rl{font-size:17px;font-weight:800;display:block;}.rd{font-size:12px;font-weight:500;opacity:.6;display:block;}
.auth{min-height:100vh;padding:48px 24px 32px;display:flex;flex-direction:column;}
.back{background:none;border:none;font-size:26px;cursor:pointer;align-self:flex-start;margin-bottom:20px;color:#1A1A2E;}
.atitle{font-size:25px;font-weight:900;color:#1A1A2E;margin-bottom:6px;}
.asub{font-size:14px;color:#888;margin-bottom:24px;line-height:1.6;}
.lbl{font-size:13px;font-weight:700;color:#888;margin-bottom:5px;display:block;text-transform:uppercase;letter-spacing:.5px;}
.inp{width:100%;padding:14px;border:2px solid #E5E5E5;border-radius:12px;font-size:16px;font-family:inherit;margin-bottom:14px;outline:none;transition:border-color .2s;background:#fff;}
.inp:focus{border-color:#E8620A;}.inp.code{font-size:26px;letter-spacing:8px;font-weight:800;text-align:center;color:#1A1A2E;}
.inp.sm{padding:9px 11px;font-size:13px;margin-bottom:0;border-radius:9px;}
.inp.time{padding:8px 9px;font-size:12px;margin-bottom:0;flex:1;border-radius:8px;}
.btn{width:100%;padding:16px;background:#E8620A;border:none;border-radius:14px;font-size:16px;font-weight:800;color:#1A1A2E;cursor:pointer;margin-top:8px;transition:transform .1s;display:block;text-align:center;}
.btn:active{transform:scale(.98);}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn.sec{background:#F0F0F0;color:#1A1A2E;margin-top:10px;}.btn.danger{background:#E05252;color:#fff;}
.btn.green{background:#50DC78;color:#1A1A2E;}.btn.navy{background:#1A1A2E;color:#fff;}
.btn.sm{padding:9px 14px;font-size:12px;width:auto;margin-top:0;border-radius:9px;}
.err{color:#E05252;font-weight:700;font-size:13px;margin-bottom:10px;}
.slist{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;}
.sitem{padding:14px 16px;background:#FFF5EF;border-radius:12px;display:flex;align-items:center;gap:12px;cursor:pointer;border:2px solid transparent;}
.sitem:hover{border-color:#ddd;}
.avatar{width:42px;height:42px;border-radius:21px;background:#E8620A;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;flex-shrink:0;}
.hdr{padding:18px 18px 8px;display:flex;align-items:center;justify-content:space-between;}
.hdr-name{font-size:20px;font-weight:900;color:#1A1A2E;}.hdr-greet{font-size:12px;color:#aaa;font-weight:500;}
.body{padding:0 16px 110px;}
.sec{font-size:17px;font-weight:800;color:#1A1A2E;margin:16px 0 10px;}
.ssub{font-size:13px;color:#aaa;margin-top:-6px;margin-bottom:10px;}
.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:#fff;border-top:1px solid #F0F0F0;display:flex;padding:8px 0 env(safe-area-inset-bottom,18px);z-index:100;}
.nbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;border:none;background:none;cursor:pointer;padding:4px;position:relative;}
.ni{font-size:20px;}.nl{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:.3px;}.nbtn.on .nl{color:#E8620A;}
.nbadge{position:absolute;top:0;right:calc(50% - 18px);background:#E05252;color:#fff;border-radius:10px;font-size:10px;font-weight:800;padding:1px 5px;min-width:16px;text-align:center;}
.clkcard{background:linear-gradient(135deg,#1A1A2E,#2D1F0E);border-radius:20px;padding:20px;margin-bottom:14px;color:#fff;}
.clktime{font-size:40px;font-weight:900;letter-spacing:-1px;}.clkdate{font-size:12px;color:rgba(255,255,255,.5);margin-bottom:12px;}
.clkst{display:inline-block;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:700;margin-bottom:14px;}
.clkst.in{background:rgba(80,220,120,.2);color:#50DC78;}.clkst.out{background:rgba(255,255,255,.1);color:rgba(255,255,255,.4);}
.clkbtns{display:flex;gap:8px;}
.clkbtn{flex:1;padding:13px;border-radius:11px;border:none;font-size:13px;font-weight:800;cursor:pointer;}
.clkbtn.in{background:#50DC78;color:#1A1A2E;}.clkbtn.out{background:#E05252;color:#fff;}.clkbtn:disabled{opacity:.3;cursor:not-allowed;}
.clkhist{margin-top:12px;}
.clkrow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:11px;color:rgba(255,255,255,.65);}
.clkrow:last-child{border:none;}
.rday{background:#FFF5EF;border-radius:13px;padding:11px 13px;margin-bottom:7px;display:flex;align-items:center;gap:8px;}
.rday.today{background:#FFF8EC;border:2px solid #E8620A;}.rday.off{opacity:.4;}
.rdaylbl{min-width:60px;}.rdayname{font-size:12px;font-weight:800;color:#1A1A2E;}
.rdaydate{font-size:10px;color:#aaa;}.rdayflag{font-size:9px;font-weight:700;color:#E8620A;}
.rdayshift{flex:1;font-size:13px;font-weight:700;color:#1A1A2E;}
.rdaybtns{display:flex;gap:5px;}
.okbtn{border:none;background:#D1FAE5;color:#065F46;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;}
.nobtn{border:none;background:#FEE2E2;color:#E05252;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;}
.abscard{background:#FFF8EC;border:2px solid #E8620A;border-radius:16px;padding:16px;margin-bottom:14px;}
.peribtns{display:flex;gap:6px;margin-bottom:12px;}
.pbtn{flex:1;padding:10px 4px;border:2px solid #E5E5E5;border-radius:10px;background:#fff;font-size:12px;font-weight:700;color:#1A1A2E;cursor:pointer;text-align:center;}
.pbtn.sel{border-color:#E8620A;background:#FFF8EC;}
.toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#E8620A;color:#fff;padding:10px 18px;border-radius:40px;font-size:13px;font-weight:700;z-index:999;white-space:nowrap;animation:fio 2.8s forwards;pointer-events:none;}
@keyframes fio{0%{opacity:0;top:10px}12%{opacity:1;top:24px}80%{opacity:1}100%{opacity:0}}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:200;}
.sheet{background:#fff;border-radius:24px 24px 0 0;padding:24px 20px 44px;width:100%;max-width:430px;max-height:90vh;overflow-y:auto;}
.stitle{font-size:19px;font-weight:900;color:#1A1A2E;margin-bottom:4px;}
.ssub2{font-size:13px;color:#888;margin-bottom:14px;}
.toggle{display:flex;border:2px solid #E5E5E5;border-radius:10px;overflow:hidden;width:fit-content;}
.tgl{padding:6px 13px;border:none;background:#fff;font-size:12px;font-weight:700;cursor:pointer;color:#888;}
.tgl.on{background:#E8620A;color:#fff;}
.day-tog{padding:5px 8px;border:1.5px solid #E5E5E5;border-radius:7px;background:#fff;font-size:11px;font-weight:700;cursor:pointer;color:#888;}
.day-tog.on{background:#E8620A;border-color:#E8620A;color:#1A1A2E;}
.day-tog:disabled{opacity:.35;cursor:not-allowed;}
.mhdr{background:linear-gradient(135deg,#1A1A2E,#0F0F1A);padding:22px 16px 14px;display:flex;justify-content:space-between;align-items:flex-start;}
.mtitle{font-size:20px;font-weight:900;color:#fff;}.msub{font-size:11px;color:rgba(255,255,255,.4);}
.mlo{background:rgba(255,255,255,.12);border:none;color:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600;}
.mtabs{display:flex;overflow-x:auto;gap:2px;padding:0 12px;border-bottom:2px solid #F0F0F0;scrollbar-width:none;}
.mtabs::-webkit-scrollbar{display:none;}
.mtab{white-space:nowrap;padding:10px 11px;border:none;background:none;font-size:12px;font-weight:700;color:#bbb;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;}
.mtab.on{color:#E8620A;border-bottom-color:#E8620A;}
.mtab.rej{color:#E05252;}
.mbody{padding:12px 16px 110px;}
.card{background:#FFF5EF;border-radius:14px;padding:13px 14px;margin-bottom:10px;}
.card.w{background:#fff;border:1.5px solid #F0F0F0;}
.chead{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.cname{font-size:15px;font-weight:800;color:#1A1A2E;}.csub{font-size:11px;color:#888;margin-top:2px;}
.chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;}
.chip.g{background:#D1FAE5;color:#065F46;}.chip.r{background:#FEE2E2;color:#7F1D1D;}.chip.a{background:#FEF3C7;color:#78350F;}
.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #F0F0F0;font-size:14px;color:#555;}
.row:last-child{border:none;}.rowb{font-weight:800;color:#1A1A2E;}
.paycard{background:#fff;border:2px solid #F0F0F0;border-radius:14px;margin-bottom:10px;overflow:hidden;}
.phead{background:#FFF5EF;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;}
.pname{font-size:14px;font-weight:800;color:#1A1A2E;}.ptotal{font-size:18px;font-weight:900;color:#E8620A;}
.pbody{padding:11px 14px;}
.mini{width:72px;padding:5px 7px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-family:inherit;outline:none;}
.mini:focus{border-color:#E8620A;}
.addrow{display:flex;gap:5px;align-items:center;margin-top:6px;}
.addinp{flex:1;padding:7px 9px;border:1.5px solid #E5E5E5;border-radius:8px;font-size:12px;font-family:inherit;outline:none;}
.addinp:focus{border-color:#E8620A;}
.addbtn{padding:7px 11px;background:#E8620A;border:none;border-radius:7px;font-size:11px;font-weight:800;color:#1A1A2E;cursor:pointer;}
.addbtn.r{background:#FEE2E2;color:#7F1D1D;}
.psum{background:linear-gradient(135deg,#1A1A2E,#2D1F0E);border-radius:16px;padding:16px;margin-top:14px;color:#fff;}
.psumtitle{font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;}
.psumrow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:14px;color:rgba(255,255,255,.8);}
.psumrow:last-child{border:none;}.psumamt{font-weight:900;color:#E8620A;}
.expsec{background:#FFF5EF;border-radius:14px;padding:13px;margin-top:12px;}
.exptitle{font-size:13px;font-weight:800;color:#1A1A2E;margin-bottom:9px;}
.expbtn{width:100%;padding:13px;border:none;border-radius:11px;font-size:13px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:7px;}
.expbtn:last-child{margin-bottom:0;}.expbtn.p{background:#1A1A2E;color:#fff;}.expbtn.s{background:#E8F0E9;color:#1A1A2E;}
.tfield{margin-bottom:9px;}
.tlbl{font-size:12px;font-weight:700;color:#555;margin-bottom:3px;display:flex;justify-content:space-between;align-items:center;}
.thint{font-size:10px;color:#aaa;margin-top:2px;font-style:italic;}
.tmsg{background:#D1FAE5;border:1.5px solid #50DC78;border-radius:13px;padding:12px 14px;margin-bottom:10px;}
.tmsg-h{font-size:13px;font-weight:800;color:#065F46;margin-bottom:3px;}
.tmsg-d{font-size:12px;color:#047857;}
.tmsg.new{background:#FFF8EC;border-color:#E8620A;}
.tmsg.new .tmsg-h{color:#78350F;}.tmsg.new .tmsg-d{color:#92400E;}
.notif{background:linear-gradient(135deg,#E8620A,#E8940A);border-radius:14px;padding:14px;margin-bottom:14px;cursor:pointer;}
.notif-t{font-size:14px;font-weight:900;color:#1A1A2E;margin-bottom:3px;}
.notif-s{font-size:12px;color:rgba(26,39,68,.7);}
.warn{background:#FEE2E2;border:2px solid #E05252;border-radius:13px;padding:12px 14px;margin-bottom:12px;}
.warn-t{font-size:13px;font-weight:800;color:#7F1D1D;margin-bottom:3px;}.warn-s{font-size:12px;color:#991B1B;}
.rejbanner{background:#FEE2E2;border:1.5px solid #E05252;border-radius:11px;padding:9px 13px;margin-bottom:8px;font-size:12px;color:#7F1D1D;font-weight:600;display:flex;justify-content:space-between;align-items:center;}
.logentry{padding:9px 0;border-bottom:1px dashed #E5E5E5;}.logentry:last-child{border:none;}
.logtop{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;}
.lognote{width:100%;padding:7px 9px;border:1.5px solid #E5E5E5;border-radius:8px;font-size:12px;font-family:inherit;outline:none;margin-top:4px;background:#fff;resize:none;}
.lognote:focus{border-color:#E8620A;}
.logedit{display:flex;gap:5px;align-items:center;margin-bottom:5px;}
.logelbl{font-size:10px;font-weight:700;color:#aaa;min-width:24px;}
.wnav{display:flex;align-items:center;gap:8px;background:#FFF8EC;border:1.5px solid #E8620A;border-radius:12px;padding:10px 14px;margin-bottom:12px;}
.wnavbtn{background:#fff;border:1.5px solid #E5E5E5;border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;flex-shrink:0;}
.wnavlbl{flex:1;text-align:center;font-size:12px;font-weight:700;color:#92400E;line-height:1.4;}
.divider{height:1px;background:#F0F0F0;margin:10px 0;}
.empty{text-align:center;padding:36px 20px;color:#ccc;}
.emptyicon{font-size:42px;margin-bottom:8px;}.emptytxt{font-size:14px;font-weight:600;}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#FFF5EF;gap:16px;}
.spinner{width:40px;height:40px;border:4px solid #E5E5E5;border-top-color:#E8620A;border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}.loadtxt{font-size:14px;font-weight:600;color:#888;}
.cashrow{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #F0F0F0;font-size:15px;}
.cashrow:last-child{border:none;}.cashname{font-weight:700;color:#1A1A2E;}.cashamt{font-weight:900;color:#065F46;font-size:16px;}
.gs-banner{background:#FFF8EC;border:1.5px solid #E8620A;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#78350F;}
.override-box{background:#FFF3CD;border:1.5px solid #E8620A;border-radius:10px;padding:10px 12px;margin-top:8px;}
.pending-badge{background:#E05252;color:#fff;border-radius:10px;font-size:10px;font-weight:800;padding:1px 7px;margin-left:6px;}
`;

function Toast({msg}){return msg?<div className="toast">{msg}</div>:null;}
function Loading({text="Loading…"}){return<div className="loading"><div className="spinner"/><div className="loadtxt">{text}</div></div>;}

// ═══════════════════════════════════════════════════════════════════
// ROLE PICKER
// ═══════════════════════════════════════════════════════════════════
function RolePicker({onPick}){
  return(
    <div className="role-screen">
      <div className="role-logo">🍽️</div>
      <div className="role-title">Restaurant Staff App</div>
      <div className="role-sub">Who is using this device?</div>
      <button className="role-btn staff" onClick={()=>onPick("staff")}>
        <span className="ri">👤</span><span><span className="rl">I'm a Staff Member</span><span className="rd">Clock in/out · Rota · Absence</span></span>
      </button>
      <button className="role-btn manager" onClick={()=>onPick("manager")}>
        <span className="ri">🔑</span><span><span className="rl">I'm the Manager</span><span className="rd">Rota · Payroll · Takings · Expenses</span></span>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF AUTH
// ═══════════════════════════════════════════════════════════════════
function StaffLogin({staff,onLogin,onBack,onRegister}){
  const[sel,setSel]=useState(null);const[code,setCode]=useState("");const[step,setStep]=useState("pick");const[err,setErr]=useState("");
  if(step==="code")return(
    <div className="auth">
      <button className="back" onClick={()=>{setStep("pick");setErr("");}}>←</button>
      <div className="atitle">Hi {sel.name.split(" ")[0]}! 👋</div>
      <div className="asub">Enter your 8-digit code</div>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} autoFocus onChange={e=>{setCode(e.target.value);setErr("");}}/>
      {err&&<div className="err">{err}</div>}
      <button className="btn" disabled={code.length!==8} onClick={()=>{if(code===sel.code)onLogin(sel);else{setErr("Wrong code — try again");setCode("");}}}>Sign In</button>
    </div>
  );
  return(
    <div className="auth">
      <button className="back" onClick={onBack}>←</button>
      <div className="atitle">Who are you? 👋</div>
      <div className="asub">Tap your name then enter your code</div>
      <div className="slist">
        {staff.map(s=>(
          <div key={s.id} className="sitem" onClick={()=>{setSel(s);setStep("code");setCode("");setErr("");}}>
            <div className="avatar">{s.name[0]}</div>
            <div><div style={{fontSize:15,fontWeight:700,color:"#1A1A2E"}}>{s.name}</div><div style={{fontSize:11,color:"#aaa"}}>Tap to sign in</div></div>
          </div>
        ))}
      </div>
      <button className="btn sec" onClick={onRegister}>➕ New here? Register</button>
    </div>
  );
}

function StaffRegister({onBack,onRegister}){
  const[name,setName]=useState("");const[code,setCode]=useState("");const[confirm,setConfirm]=useState("");const[err,setErr]=useState("");const[saving,setSaving]=useState(false);
  async function handle(){
    setErr("");
    if(!name.trim())return setErr("Please type your name");
    if(!/^\d{8}$/.test(code))return setErr("Code must be exactly 8 digits");
    if(code!==confirm)return setErr("Codes don't match");
    setSaving(true);
    const{error}=await db.from("staff").insert({id:code,name:name.trim(),code,pay_type:"hourly",rate:"0",shift_rate:"0",night_rate:"0",card_fixed:"0",card_mode:"fixed"});
    if(error){setSaving(false);return setErr(error.code==="23505"?"That code is already taken":"Error: "+error.message);}
    onRegister({id:code,name:name.trim(),code});
  }
  return(
    <div className="auth">
      <button className="back" onClick={onBack}>←</button>
      <div className="atitle">Create Account 🎉</div>
      <div className="asub">Pick 8 numbers you'll remember — like your birthday: 01051990</div>
      <label className="lbl">Your Full Name</label>
      <input className="inp" placeholder="e.g. Amy Chen" value={name} onChange={e=>setName(e.target.value)}/>
      <label className="lbl">Choose 8-Digit Code</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} onChange={e=>setCode(e.target.value)}/>
      <label className="lbl">Confirm Code</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={confirm} onChange={e=>setConfirm(e.target.value)}/>
      {err&&<div className="err">{err}</div>}
      <button className="btn" onClick={handle} disabled={saving}>{saving?"Creating…":"Create Account"}</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF APP
// ═══════════════════════════════════════════════════════════════════
function StaffApp({user,onLogout,effectiveTakingsPerson}){
  const[tab,setTab]=useState("home");const[msg,setMsg]=useState("");
  const[showTour,setShowTour]=useState(false);
  const[tourStep,setTourStep]=useState(0);
  const[tourDone,setTourDone]=useState(false);
  const[clockedIn,setClockedIn]=useState(false);const[clockInTime,setClockInTime]=useState(null);
  const[breakTime,setBreakTime]=useState("0");
  const[lateModal,setLateModal]=useState(false);
  const[earlyModal,setEarlyModal]=useState(null); // null | "confirm" | "blocked"
  const[staffClockWeek,setStaffClockWeek]=useState(()=>snapToSunday(todayISO()));
  const[checklistModal,setChecklistModal]=useState(false);
  const[checklist,setChecklist]=useState({heating:false,asahi:false,stockroom:false,moneybox:false,backdoor:false,frontdoor:false});
  const CHECKLIST_ITEMS=[{key:"heating",label:"Heating/AC/lights off"},  {key:"asahi",label:"Asahi light off"},{key:"stockroom",label:"Stock room locked"},{key:"moneybox",label:"Money box locked"},{key:"backdoor",label:"Back door locked"},{key:"frontdoor",label:"Front door double locked"}];
  const checklistDone=Object.values(checklist).every(Boolean);
  const[logs,setLogs]=useState([]);const[rota,setRota]=useState([]);
  const[absences,setAbsences]=useState([]);const[rejections,setRejections]=useState([]);
  const[confirmations,setConfirmations]=useState([]);
  const[absDate,setAbsDate]=useState("");const[absPeriod,setAbsPeriod]=useState("");
  const[rejectModal,setRejectModal]=useState(null);const[rejectReason,setRejectReason]=useState("");
  const[tVals,setTVals]=useState({});const[tCC,setTCC]=useState({});const[tNote,setTNote]=useState("");
  const[submitted,setSubmitted]=useState(false);
  const[corrected,setCorrected]=useState(false); // true if already corrected once
  const[showCorrect,setShowCorrect]=useState(false);
  const[loading,setLoading]=useState(true);
  const[rotaMon,setRotaMon]=useState(()=>rotaWeekOf(todayISO()).start);
  const assigned=effectiveTakingsPerson===user.id;
  const now=new Date();
  function t(m){setMsg(m);setTimeout(()=>setMsg(""),2800);}
  useEffect(()=>{loadData();},[]);
  useEffect(()=>{loadRota();},[rotaMon]);
  // Refresh rota from DB when staff opens the rota tab — picks up any manager changes (e.g. Off after rejection)
  useEffect(()=>{if(tab==="rota")loadRota();},[tab]);

  async function loadData(){
    setLoading(true);
    const[logR,absR,rejR,confR,subR]=await Promise.all([
      db.from("clock_logs").select("*").eq("staff_id",user.id).order("date",{ascending:false}).limit(20),
      db.from("absences").select("*").eq("staff_id",user.id).order("date",{ascending:false}),
      db.from("rejections").select("*").eq("staff_id",user.id),
      db.from("confirmations").select("*").eq("staff_id",user.id),
      db.from("takings").select("id,is_corrected").eq("staff_id",user.id).eq("date",todayISO()),
    ]);
    setLogs(logR.data||[]);setAbsences(absR.data||[]);setRejections(rejR.data||[]);setConfirmations(confR.data||[]);
    const todaySub=(subR.data||[])[0]||null;
    setSubmitted(!!todaySub);
    setCorrected(!!(todaySub?.is_corrected));
    const active=(logR.data||[]).find(l=>l.date===todayISO()&&l.time_in&&!l.time_out);
    if(active){setClockedIn(true);setClockInTime(active.time_in);}
    await loadRota();setLoading(false);
    // Launch tour if not completed before
    if(!localStorage.getItem("tourDone_"+user.id)){setShowTour(true);setTourStep(0);}
  }
  async function loadRota(){
    const dates=weekDates(rotaMon);
    const{data}=await db.from("rota").select("*").eq("staff_id",user.id).eq("week_start",rotaMon);
    setRota(dates.map(dateISO=>{const jsDay=new Date(dateISO+"T12:00:00").getDay();const row=(data||[]).find(r=>r.day_index===jsDay);return{date:dateISO,jsDay,type:row?.shift_type||"Off",customIn:row?.custom_in||"",customOut:row?.custom_out||""};}));
  }
  async function clockIn(){
    // Once-per-day restriction
    const todayDone=logs.find(l=>l.date===todayISO()&&l.time_in&&l.time_out);
    if(todayDone)return t("⚠️ You've already clocked in and out today. Contact your manager if you need a correction.");
    // Must have confirmed today's rota shift
    const todayRota=rota.find(sh=>sh.date===todayISO());
    if(todayRota&&todayRota.type!=="Off"){
      const todayDayName=DAYS_MON[new Date(todayISO()+"T12:00:00").getDay()];
      const todayWeekKey=todayDayName+"|"+rotaMon;const isConfirmed=confirmations.some(r=>r.day===todayWeekKey);
      if(!isConfirmed)return t("⚠️ Please confirm your rota shift first (Rota tab → ✓ OK).");
    }
    const time=nowTime();
    const{data,error}=await db.from("clock_logs").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),time_in:time,note:""}).select().single();
    if(!error){setLogs(p=>[data,...p]);setClockedIn(true);setClockInTime(time);t("✅ Clocked in at "+time);}
    else t("❌ "+error.message);
  }
  async function doClockOut(noteType){
    const active=logs.find(l=>l.date===todayISO()&&l.time_in&&!l.time_out);
    if(!active)return;
    const time=nowTime();
    const bt=parseFloat(breakTime||0);
    const finalNote=checklistDone&&assigned?("checklist_done"+(noteType?":"+noteType:"")):(noteType||"");
    let result=await db.from("clock_logs").update({time_out:time,note:finalNote,break_time:bt}).eq("id",active.id);
    if(result.error&&(result.error.message?.includes("break_time")||result.error.code==="42703"||result.error.details?.includes("break_time"))){
      result=await db.from("clock_logs").update({time_out:time,note:finalNote}).eq("id",active.id);
    }
    if(!result.error){setLogs(p=>p.map(l=>l.id===active.id?{...l,time_out:time,note:finalNote,break_time:bt}:l));setClockedIn(false);setBreakTime("0");setLateModal(false);setEarlyModal(null);t("👋 Clocked out at "+time+(bt>0?` (${bt}hr break)`:""));}
    else t("❌ "+result.error.message);
  }
  function clockOut(){
    // Takings-assigned staff must complete takings before clocking out
    if(assigned&&!submitted)return t("⚠️ Please complete today's takings before clocking out (Takings tab).");
    // If takings-assigned and done, show checklist
    if(assigned&&submitted){setChecklist({heating:false,asahi:false,stockroom:false,moneybox:false,backdoor:false,frontdoor:false});setChecklistModal(true);return;}
    doActualClockOut();
  }
  function doActualClockOut(){
    const todayRota=rota.find(sh=>sh.date===todayISO());
    const isHourlyOnly=parseFloat(user.shiftRate||0)===0&&parseFloat(user.nightRate||0)===0&&parseFloat(user.rate||0)>0;
    // Only check time restrictions for hourly-only staff
    if(isHourlyOnly&&todayRota){
      let schedEnd=null;
      if(todayRota.type==="Full Day (11am–close)")schedEnd="23:00";
      else if(todayRota.type==="Night (5:30pm–close)")schedEnd="23:00";
      else if(todayRota.type==="Custom"&&todayRota.customOut)schedEnd=todayRota.customOut;
      if(schedEnd){
        const[eH,eM]=schedEnd.split(":").map(Number);
        const now=new Date();
        const nowMins=now.getHours()*60+now.getMinutes();
        const endMins=eH*60+eM;
        const diffMins=nowMins-endMins;
        if(diffMins>15){setLateModal(true);return;}
        if(diffMins<-60){setEarlyModal("blocked");return;}
        if(diffMins<-10){setEarlyModal("confirm");return;}
      }
    }else if(!isHourlyOnly&&todayRota){
      // Shift-paid: only check late (forgot/overtime), no early restriction
      let schedEnd=null;
      if(todayRota.type==="Full Day (11am–close)")schedEnd="23:00";
      else if(todayRota.type==="Night (5:30pm–close)")schedEnd="23:00";
      else if(todayRota.type==="Custom"&&todayRota.customOut)schedEnd=todayRota.customOut;
      if(schedEnd){
        const[eH,eM]=schedEnd.split(":").map(Number);
        const now=new Date();
        const diffMins=now.getHours()*60+now.getMinutes()-eH*60-eM;
        if(diffMins>15){setLateModal(true);return;}
      }
    }
    doClockOut("");
  }
  async function reportAbsence(){
    if(!absDate||!absPeriod)return t("Please pick a date and period");
    const daysNotice=Math.floor((new Date(absDate+"T12:00:00")-new Date(todayISO()+"T12:00:00"))/(1000*60*60*24));
    if(daysNotice<5)return; // blocked — UI shows warning instead
    const{data,error}=await db.from("absences").insert({staff_id:user.id,staff_name:user.name,date:absDate,period:absPeriod}).select().single();
    if(!error){setAbsences(p=>[...p,data]);setAbsDate("");setAbsPeriod("");t("📅 Absence sent!");}else t("❌ "+error.message);
  }
  // Next Wednesday from today — the rota gets assigned on Wednesday
  // so any absence before next Wednesday must be called in directly
  function nextWednesday(){
    const today=new Date(todayISO()+"T12:00:00");
    const dow=today.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const daysUntilWed=((3-dow)+7)%7||7; // days until next Wed (at least 1)
    const wed=new Date(today);wed.setDate(today.getDate()+daysUntilWed);
    return wed.toISOString().split("T")[0];
  }
  const nextWed=nextWednesday();
  const absBeforeNextWed=absDate&&absDate<nextWed;
  async function confirmShift(idx){const weekKey=DAYS_MON[idx]+"|"+rotaMon;const{data,error}=await db.from("confirmations").insert({staff_id:user.id,staff_name:user.name,day:weekKey}).select().single();if(!error){setConfirmations(p=>[...p,data]);t("✅ Confirmed!");}else t("❌ "+error.message);}
  async function rejectShift(){const weekKey=DAYS_MON[rejectModal]+"|"+rotaMon;const{data,error}=await db.from("rejections").insert({staff_id:user.id,staff_name:user.name,day:weekKey,reason:rejectReason}).select().single();if(!error){setRejections(p=>[...p,data]);setRejectModal(null);t("Rejection sent");}else t("❌ "+error.message);}
  async function submitTakings(){const vals={};TKFIELDS.forEach(f=>{vals[f.db]=parseFloat(tVals[f.key]||0);if(f.ccDb)vals[f.ccDb]=tCC[f.key]||"cash";});const{error}=await db.from("takings").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),...vals,note:tNote,is_new:true,is_corrected:false});if(!error){setTVals({});setTCC({});setTNote("");setSubmitted(true);t("📊 Submitted!");setTab("home");}else t("❌ "+error.message);}
  async function correctTakings(){
    const vals={};TKFIELDS.forEach(f=>{vals[f.db]=parseFloat(tVals[f.key]||0);if(f.ccDb)vals[f.ccDb]=tCC[f.key]||"cash";});
    const{data:existing}=await db.from("takings").select("id").eq("staff_id",user.id).eq("date",todayISO()).maybeSingle();
    if(!existing)return t("❌ No submission found for today");
    const{error}=await db.from("takings").update({...vals,note:tNote,is_new:true,is_corrected:true}).eq("id",existing.id);
    if(!error){setTVals({});setTCC({});setTNote("");setCorrected(true);setShowCorrect(false);t("✅ Correction submitted!");setTab("home");}else t("❌ "+error.message);
  }
  function shiftLabel(sh){if(!sh||sh.type==="Off")return"Day off";if(sh.type==="Full Day (11am–close)")return"Full Day 11am–close";if(sh.type==="Night (5:30pm–close)")return"Night 5:30pm–close";if(sh.type==="Custom")return`${sh.customIn||"?"}–${sh.customOut||"?"}`;return sh.type;}

  if(loading)return<Loading text="Loading your data…"/>;

  function RotaList(){return rota.map((sh,idx)=>{const isToday=sh.date===todayISO();const dayName=DAYS_MON[idx];const weekKey=dayName+"|"+rotaMon;const rejected=rejections.some(r=>r.day===weekKey);const confirmed=confirmations.some(r=>r.day===weekKey);const isOff=sh.type==="Off";return(<div key={idx} className={`rday${isToday?" today":""}${isOff?" off":""}`}><div className="rdaylbl"><div className="rdayname">{dayName}</div><div className="rdaydate">{dispDate(sh.date)}</div>{isToday&&<div className="rdayflag">TODAY</div>}</div><div className="rdayshift">{shiftLabel(sh)}</div>{!isOff&&!rejected&&!confirmed&&<div className="rdaybtns"><button className="okbtn" onClick={()=>confirmShift(idx)}>✓ OK</button><button className="nobtn" onClick={()=>{setRejectModal(idx);setRejectReason("");}}>✕ Can't</button></div>}{confirmed&&<span className="chip g">✓ OK</span>}{rejected&&!isOff&&<span className="chip r">Rejected</span>}</div>);});}

  const navItems=[{id:"home",icon:"🏠",label:"Home"},{id:"clock",icon:"⏰",label:"Clock"},{id:"rota",icon:"📋",label:"Rota"},{id:"absence",icon:"📅",label:"Absence"},...(assigned?[{id:"takings",icon:"📊",label:"Takings",badge:!submitted}]:[])];
  return(
    <div className="app">
      <Toast msg={msg}/>
      <div className="hdr"><div><div className="hdr-greet">Good {now.getHours()<12?"morning":now.getHours()<18?"afternoon":"evening"},</div><div className="hdr-name">{user.name.split(" ")[0]} 👋</div></div><div style={{display:"flex",gap:8,alignItems:"center"}}><button style={{background:"#FFF5EF",border:"1.5px solid #E8620A",borderRadius:"50%",width:32,height:32,fontSize:14,cursor:"pointer",fontWeight:800,color:"#E8620A"}} onClick={()=>{setTourStep(0);setShowTour(true);}}>?</button><button style={{background:"none",border:"none",fontSize:22,cursor:"pointer"}} onClick={onLogout}>🚪</button></div></div>
      {tab==="home"&&<div className="body">
        {/* Welcome message banner */}
        {user.welcomeMsg&&<div style={{background:"linear-gradient(135deg,#E8620A,#FF8C42)",borderRadius:14,padding:"14px 16px",marginBottom:14,color:"#fff"}}>
          <div style={{fontSize:13,fontWeight:800,marginBottom:3}}>👋 Message from the Manager</div>
          <div style={{fontSize:14,lineHeight:1.6}}>{user.welcomeMsg}</div>
        </div>}
        {assigned&&!submitted&&<div className="notif" onClick={()=>setTab("takings")}><div className="notif-t">📊 You're today's Takings Person!</div><div className="notif-s">Tap to record today's takings →</div></div>}
        {/* Forgot to clock in banner - hide if any clock entry exists today */}
        {!logs.some(l=>l.date===todayISO()&&l.time_in)&&(()=>{
          const todayRota=rota.find(sh=>sh.date===todayISO());
          if(!todayRota||todayRota.type==="Off")return null;
          const now=new Date();
          const nowMins=now.getHours()*60+now.getMinutes();
          let startMins=null;
          if(todayRota.type==="Full Day (11am–close)")startMins=11*60;
          else if(todayRota.type==="Night (5:30pm–close)")startMins=17*60+30;
          else if(todayRota.type==="Custom"&&todayRota.customIn){const[h,m]=todayRota.customIn.split(":").map(Number);startMins=h*60+m;}
          if(startMins===null||nowMins<startMins+10)return null;
          return(<div style={{background:"#FFF5EF",border:"2px solid #E8620A",borderRadius:13,padding:"13px 15px",marginBottom:12}}>
            <div style={{fontSize:14,fontWeight:800,color:"#E8620A",marginBottom:6}}>⏰ Did you forget to clock in?</div>
            <div style={{fontSize:13,color:"#555",marginBottom:10}}>You're scheduled to work today but haven't clocked in yet.</div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn sm" style={{flex:1,background:"#E8620A",color:"#fff"}} onClick={clockIn}>Clock in now</button>
              <button className="btn sm sec" style={{flex:1}} onClick={async()=>{
                let startTime="";
                if(todayRota.type==="Full Day (11am–close)")startTime="11:00";
                else if(todayRota.type==="Night (5:30pm–close)")startTime="17:30";
                else if(todayRota.customIn)startTime=todayRota.customIn;
                if(!startTime)return clockIn();
                const{data,error}=await db.from("clock_logs").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),time_in:startTime,note:"back-stamped"}).select().single();
                if(!error){setLogs(p=>[data,...p]);setClockedIn(true);setClockInTime(startTime);t("✅ Back-stamped to "+startTime);}
                else t("❌ "+error.message);
              }}>Back-stamp to {todayRota.type==="Full Day (11am–close)"?"11:00":todayRota.type==="Night (5:30pm–close)"?"17:30":todayRota.customIn||"start"}</button>
            </div>
          </div>);
        })()}
        <div className="sec">This Week</div><RotaList/>
      </div>}

      {tab==="clock"&&<div className="body">
        <div className="sec">Clock In / Out</div>
        {/* Info banner for hourly staff */}
        {parseFloat(user.shiftRate||0)===0&&parseFloat(user.rate||0)>0&&(
          <div style={{background:"#FFF5EF",border:"1.5px solid #E8620A",borderRadius:11,padding:"10px 13px",marginBottom:12,fontSize:13,color:"#E8620A",lineHeight:1.7}}>
            <strong>Hourly-paid staff:</strong> Select your break time before clocking out. If finishing early or staying late, you'll be asked why.
          </div>
        )}
        {/* Clock card */}
        <div className="clkcard">
          <div className="clktime">{now.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>
          <div className="clkdate">{now.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</div>
          <div className={`clkst ${clockedIn?"in":"out"}`}>{clockedIn?`● Clocked in at ${clockInTime}`:"● Not clocked in"}</div>
          {clockedIn&&parseFloat(user.rate||0)>0&&(
            <div style={{margin:"10px 0 0"}}>
              <div style={{fontSize:13,color:"rgba(255,255,255,.7)",marginBottom:6}}>Break time</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {[0,0.5,1,1.5,2,2.5,3].map(v=><button key={v} className={`tgl${parseFloat(breakTime)===v?" on":""}`} style={{padding:"6px 10px",fontSize:12,background:parseFloat(breakTime)===v?"#E8620A":"rgba(255,255,255,.15)",color:"#fff",border:"none",borderRadius:7}} onClick={()=>setBreakTime(String(v))}>{v===0?"None":v+"hr"}</button>)}
              </div>
            </div>
          )}
          <div className="clkbtns" style={{marginTop:14}}>
            {(()=>{
              const todayRota=rota.find(sh=>sh.date===todayISO());
              const isOff=!todayRota||todayRota.type==="Off";
              return isOff&&!clockedIn
                ?<div style={{fontSize:13,color:"rgba(255,255,255,.7)",textAlign:"center",padding:"10px 0"}}>📅 Not scheduled today — contact your manager if this is incorrect.</div>
                :<><button className="clkbtn in" onClick={clockIn} disabled={clockedIn}>🟢 Clock In</button><button className="clkbtn out" onClick={clockOut} disabled={!clockedIn}>🔴 Clock Out</button></>;
            })()}
          </div>
        </div>
        {/* 7-day log */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div className="sec" style={{margin:0}}>Weekly Log</div>
          <div style={{display:"flex",gap:6}}>
            <button className="btn sm sec" style={{padding:"5px 10px"}} onClick={()=>setStaffClockWeek(addDays(staffClockWeek,-7))}>‹</button>
            <span style={{fontSize:12,color:"#888",alignSelf:"center"}}>{fmtDate(staffClockWeek)}–{fmtDate(addDays(staffClockWeek,6))}</span>
            <button className="btn sm sec" style={{padding:"5px 10px"}} onClick={()=>setStaffClockWeek(addDays(staffClockWeek,7))}>›</button>
          </div>
        </div>
        {weekDates(staffClockWeek).map(dateISO=>{
          const dayLogs=logs.filter(l=>l.date===dateISO);
          const totalHrs=dayLogs.reduce((a,l)=>a+parseHrs(l.time_in,l.time_out),0);
          const breakHrs=dayLogs.reduce((a,l)=>a+parseFloat(l.break_time||0),0);
          const netHrs=Math.max(0,totalHrs-breakHrs);
          const jsDay=new Date(dateISO+"T12:00:00").getDay();
          const dayName=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][jsDay];
          return(<div key={dateISO} style={{background:dateISO===todayISO()?"#FFF5EF":"#F8F8F8",border:dateISO===todayISO()?"2px solid #E8620A":"1.5px solid #F0F0F0",borderRadius:11,padding:"10px 13px",marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
            <div style={{minWidth:36,fontSize:13,fontWeight:800,color:dateISO===todayISO()?"#E8620A":"#1A1A2E"}}>{dayName}</div>
            <div style={{fontSize:12,color:"#aaa",minWidth:56}}>{fmtDate(dateISO).slice(0,5)}</div>
            {dayLogs.length>0
              ?<div style={{flex:1,fontSize:13}}>{dayLogs[0].time_in}→{dayLogs[0].time_out||"active"}{netHrs>0&&<span style={{fontWeight:800,color:"#E8620A",marginLeft:8}}>{netHrs.toFixed(1)}h</span>}{breakHrs>0&&<span style={{fontSize:11,color:"#aaa",marginLeft:4}}>(-{breakHrs}hr break)</span>}</div>
              :<div style={{flex:1,fontSize:12,color:"#ccc"}}>—</div>
            }
          </div>);
        })}
        {lateModal&&<div className="overlay"><div className="sheet">
          <div className="stitle">⏰ Late Clock-Out</div>
          <div className="ssub2">You're clocking out later than your scheduled end time. Which applies?</div>
          <button className="btn" onClick={()=>doClockOut("forgot")}>🕐 I forgot to clock out earlier</button>
          <button className="btn sec" onClick={()=>doClockOut("overtime")}>⏱ I was working extra time</button>
          <button className="btn sec" onClick={()=>setLateModal(false)}>Cancel</button>
        </div></div>}
        {earlyModal==="confirm"&&<div className="overlay"><div className="sheet">
          <div className="stitle">🌙 Finishing Early?</div>
          <div className="ssub2">You're clocking out before your scheduled end time. Is it quiet and your manager is happy for you to finish now?</div>
          <button className="btn" onClick={()=>{setEarlyModal(null);doClockOut("left_early");}}>Yes, finishing early</button>
          <button className="btn sec" onClick={()=>setEarlyModal(null)}>Cancel — stay clocked in</button>
        </div></div>}
        {earlyModal==="blocked"&&<div className="overlay"><div className="sheet">
          <div className="stitle">⚠️ Cannot Clock Out</div>
          <div className="ssub2">You're trying to clock out more than 1 hour early. If you're unwell and need to leave, please <strong>call the manager</strong> — they will clock you out and record a sick leave note.</div>
          <button className="btn sec" onClick={()=>setEarlyModal(null)}>OK</button>
        </div></div>}
        {checklistModal&&<div className="overlay"><div className="sheet"><div className="stitle">🔒 End-of-Shift Checklist</div><div className="ssub2">Please check all items before clocking out.</div>
          {CHECKLIST_ITEMS.map(item=><div key={item.key} onClick={()=>setChecklist(p=>({...p,[item.key]:!p[item.key]}))} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderBottom:"1px solid #F0F0F0",cursor:"pointer"}}>
            <div style={{width:24,height:24,borderRadius:6,border:`2px solid ${checklist[item.key]?"#E8620A":"#E5E5E5"}`,background:checklist[item.key]?"#E8620A":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {checklist[item.key]&&<span style={{color:"#fff",fontSize:14,fontWeight:900}}>✓</span>}
            </div>
            <span style={{fontSize:14,color:checklist[item.key]?"#1A1A2E":"#888"}}>{item.label}</span>
          </div>)}
          <button className="btn" style={{marginTop:14,opacity:checklistDone?1:.5}} disabled={!checklistDone} onClick={()=>{setChecklistModal(false);doActualClockOut();}}>Confirm & Clock Out</button>
          <button className="btn sec" onClick={()=>setChecklistModal(false)}>Cancel</button>
        </div></div>}
      </div>}
      {tab==="rota"&&<div className="body"><div className="sec">My Rota</div>
        <div style={{background:"#EFF6FF",border:"1.5px solid #BFDBFE",borderRadius:11,padding:"10px 13px",marginBottom:12,fontSize:12,color:"#1E40AF",lineHeight:1.7}}>
          📅 <strong>Check your rota every Wednesday</strong> and accept or reject by <strong>Friday</strong>. For any emergency, contact the manager directly.
        </div>
        <div className="wnav"><button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,-7))}>‹</button><div className="wnavlbl">{fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon,6))}</div><button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,7))}>›</button></div><RotaList/></div>}
      {tab==="absence"&&<div className="body"><div className="sec">Report Absence</div><div className="abscard"><div style={{fontSize:14,fontWeight:800,color:"#1A1A2E",marginBottom:4}}>📅 Can't come in?</div><div style={{fontSize:12,color:"#888",marginBottom:12}}>Pick the date and when you can't work</div><label className="lbl">Which day?</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:12}} value={absDate} min={todayISO()} onChange={e=>setAbsDate(e.target.value)}/>{absBeforeNextWed&&<div style={{background:"#FEE2E2",border:"1.5px solid #E05252",borderRadius:11,padding:"11px 13px",marginBottom:12}}><div style={{fontSize:13,fontWeight:800,color:"#7F1D1D",marginBottom:4}}>⚠️ Too soon to report online</div><div style={{fontSize:12,color:"#991B1B",lineHeight:1.6}}>This date is before the next rota is assigned (Wednesday {fmtDate(nextWed)}). Please <strong>call the manager directly</strong> as soon as possible.</div></div>}<label className="lbl" style={{marginBottom:7}}>Which part?</label><div className="peribtns">{["Morning","Evening","Full Day"].map(p=><button key={p} className={`pbtn${absPeriod===p?" sel":""}`} onClick={()=>setAbsPeriod(p)}>{p==="Morning"?"🌅":p==="Evening"?"🌙":"☀️"}<br/>{p}</button>)}</div><button className="btn" style={{marginTop:10}} onClick={reportAbsence} disabled={!absDate||!absPeriod||absBeforeNextWed}>Send to Manager</button></div>{absences.length>0&&<>{<div className="sec">Reported</div>}{absences.map(a=><div key={a.id} style={{background:"#FFF5EF",borderRadius:12,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}><div><div style={{fontSize:13,fontWeight:700,color:"#1A1A2E"}}>{dispDate(a.date,true)}</div><div style={{fontSize:11,color:"#aaa"}}>{a.period}</div></div><span className="chip a">Sent ✓</span></div>)}</>}</div>}
      {tab==="takings"&&<div className="body"><div className="sec">📊 Daily Takings</div>
        {!assigned?<div className="empty"><div className="emptyicon">🔒</div><div className="emptytxt">Not assigned today</div></div>
        :submitted&&!showCorrect?(
          <div>
            <div className="empty"><div className="emptyicon">✅</div><div className="emptytxt">Submitted for today</div></div>
            {corrected
              ?<div style={{background:"#FEE2E2",border:"1.5px solid #E05252",borderRadius:13,padding:"13px 15px",margin:"0 0 14px"}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#7F1D1D",marginBottom:4}}>⚠️ Already corrected once</div>
                  <div style={{fontSize:12,color:"#991B1B",lineHeight:1.6}}>You've already made one correction today. For any further changes, please report to the manager directly.</div>
                </div>
              :<button className="btn sec" style={{marginTop:0}} onClick={async()=>{
                // Load existing values into the form before showing it
                const{data}=await db.from("takings").select("*").eq("staff_id",user.id).eq("date",todayISO()).maybeSingle();
                if(data){const v={};TKFIELDS.filter(f=>!f.managerOnly).forEach(f=>{v[f.key]=String(data[f.db]||"");});setTVals(v);const c={};TKFIELDS.filter(f=>!f.managerOnly&&f.ccDb).forEach(f=>{c[f.key]=data[f.ccDb]||"cash";});setTCC(c);setTNote(data.note||"");}
                setShowCorrect(true);
              }}>✏️ Made a mistake? Correct it</button>
            }
          </div>
        ):(
          <>{submitted&&showCorrect&&<div style={{background:"#FFF8EC",border:"1.5px solid #E8620A",borderRadius:11,padding:"10px 13px",marginBottom:12}}><div style={{fontSize:12,fontWeight:800,color:"#92400E"}}>✏️ Correcting today's submission — this is your one chance to fix a mistake.</div></div>}
          <div style={{fontSize:12,color:"#888",marginBottom:14}}>For {dispDate(todayISO(),true)}. <strong>Enter all amounts as positive numbers.</strong></div>
          {TKFIELDS.filter(f=>!f.managerOnly).map(f=><div key={f.key} className="tfield"><div className="tlbl"><span>{f.label}</span>{f.cc&&<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl${(tCC[f.key]||"cash")===c?" on":""}`} onClick={()=>setTCC(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>}</div>{f.hint&&<div className="thint">{f.hint}</div>}<input className="inp sm" style={{display:"block",width:"100%",marginTop:4}} type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" onKeyDown={e=>{if(["e","E","+","-"].includes(e.key))e.preventDefault();}} value={tVals[f.key]||""} onChange={e=>setTVals(p=>({...p,[f.key]:e.target.value}))}/></div>)}
          <label className="lbl" style={{marginTop:10}}>Note (optional)</label><textarea className="lognote" rows={3} style={{marginBottom:12}} placeholder="Any notes…" value={tNote} onChange={e=>setTNote(e.target.value)}/>
          {showCorrect
            ?<><button className="btn" onClick={correctTakings}>Submit Correction ✓</button><button className="btn sec" onClick={()=>setShowCorrect(false)}>Cancel</button></>
            :<button className="btn green" onClick={submitTakings}>Submit to Manager ✓</button>}
          </>
        )}
      </div>}
      <div className="bnav">{navItems.map(n=><button key={n.id} className={`nbtn${tab===n.id?" on":""}`} onClick={()=>setTab(n.id)}>{n.badge&&<span className="nbadge">!</span>}<span className="ni">{n.icon}</span><span className="nl">{n.label}</span></button>)}</div>
      {showTour&&(()=>{
        const TOUR_STEPS=[
          {title:"👋 Welcome to Ming's Staff App!",body:"This app lets you clock in/out, view your rota, report absences, and submit takings. Let's take a quick tour so you know how everything works.",icon:"🏠"},
          {title:"⏰ Clock In & Out",body:"Tap the ⏰ Clock tab to clock in when you arrive and clock out when you leave. If you're paid hourly, select your break time before clocking out. You'll get a prompt if you're clocking out late or early.",icon:"⏰"},
          {title:"📋 Rota — Confirm Your Shifts",body:"Check the 📋 Rota tab every Wednesday. Tap ✓ OK to accept a shift or ✕ Can't if you can't work. You must confirm your shift before you can clock in. Accept/reject by Friday.",icon:"📋"},
          {title:"📅 Reporting Absence",body:"Tap the 📅 Absence tab to report an absence. Important: absences before next Wednesday must be reported by calling the manager directly — the app can only be used for future dates.",icon:"📅"},
          {title:"📊 Takings",body:"If you're the designated takings person today, you'll see a notification on your Home tab. Complete the takings form before clocking out — you won't be able to clock out until it's done.",icon:"📊"},
          {title:"📱 Save to Your Home Screen",body:"You can access this app anytime like a regular app — no app store needed!\n\n📱 iPhone (Safari):\n1. Tap the Share button (□↑) at the bottom\n2. Scroll down and tap 'Add to Home Screen'\n3. Tap 'Add' — done!\n\n🤖 Android (Chrome):\n1. Tap the three dots (⋮) menu at top right\n2. Tap 'Add to Home screen'\n3. Tap 'Add' — done!",icon:"📱"},
          {title:"✅ You're all set!",body:"You've completed the tour. Tap the ? button in the header anytime to see this guide again.\n\nTap 'I understand — let's go!' to confirm you've read this guide.",icon:"🎉",final:true},
        ];
        const step=TOUR_STEPS[tourStep];
        const isLast=tourStep===TOUR_STEPS.length-1;
        return(
          <div className="overlay" style={{zIndex:9999}}>
            <div className="sheet" style={{maxHeight:"85vh",overflowY:"auto"}}>
              <div style={{textAlign:"center",fontSize:40,marginBottom:8}}>{step.icon}</div>
              <div className="stitle" style={{textAlign:"center"}}>{step.title}</div>
              <div style={{fontSize:14,color:"#555",lineHeight:1.8,marginBottom:20,whiteSpace:"pre-line"}}>{step.body}</div>
              <div style={{display:"flex",gap:4,justifyContent:"center",marginBottom:16}}>
                {TOUR_STEPS.map((_,i)=><div key={i} style={{width:i===tourStep?20:6,height:6,borderRadius:3,background:i===tourStep?"#E8620A":i<tourStep?"#FBB49A":"#E5E5E5",transition:"width .2s"}}/>)}
              </div>
              {isLast
                ?<button className="btn" style={{background:"#E8620A"}} onClick={()=>{localStorage.setItem("tourDone_"+user.id,"1");setTourDone(true);setShowTour(false);t("✅ Tour completed!");db.from("confirmations").insert({staff_id:user.id,staff_name:user.name,day:"__tour_done__"}).then(()=>{});}}>🎉 I understand — let's go!</button>
                :<button className="btn" style={{background:"#E8620A"}} onClick={()=>setTourStep(s=>s+1)}>Next →</button>
              }
              <button className="btn sec" style={{marginTop:8}} onClick={()=>setShowTour(false)}>Skip tour</button>
              {tourStep>0&&<button className="btn sec" style={{marginTop:4}} onClick={()=>setTourStep(s=>s-1)}>← Back</button>}
            </div>
          </div>
        );
      })()}
      {rejectModal!==null&&<div className="overlay" onClick={()=>setRejectModal(null)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">Can't work {DAYS_MON[rejectModal]}?</div><div className="ssub2">Tell the manager why (optional)</div><textarea className="lognote" rows={3} placeholder="e.g. Doctor appointment…" value={rejectReason} onChange={e=>setRejectReason(e.target.value)}/><button className="btn danger" style={{marginTop:12}} onClick={rejectShift}>Send Rejection</button><button className="btn sec" onClick={()=>setRejectModal(null)}>Cancel</button></div></div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER AUTH
// ═══════════════════════════════════════════════════════════════════
function ManagerLogin({onLogin,onBack}){
  const[pin,setPin]=useState("");const[err,setErr]=useState("");const[loading,setLoading]=useState(false);
  async function tryLogin(){setLoading(true);const{data}=await db.from("app_settings").select("value").eq("key","manager_pin").maybeSingle();if(pin===(data?.value||"00000000"))onLogin();else{setErr("Wrong PIN");setPin("");}setLoading(false);}
  return(<div className="auth"><button className="back" onClick={onBack}>←</button><div className="atitle">Manager Sign In 🔑</div><div className="asub">Enter your manager PIN</div><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={pin} autoFocus onChange={e=>{setPin(e.target.value);setErr("");}}/>{err&&<div className="err">{err}</div>}<button className="btn" onClick={tryLogin} disabled={pin.length<4||loading}>{loading?"Checking…":"Sign In"}</button><div style={{textAlign:"center",fontSize:13,color:"#aaa",marginTop:14}}>Default PIN: 00000000</div></div>);
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER APP
// ═══════════════════════════════════════════════════════════════════
function ManagerApp({onLogout}){
  const[tab,setTab]=useState("staff");
  const[msg,setMsg]=useState("");
  const[loading,setLoading]=useState(true);
  const[staff,setStaff]=useState([]);
  const[rota,setRota]=useState({});
  const[absences,setAbsences]=useState([]);
  const[clockLogs,setClockLogs]=useState([]);
  const[rejections,setRejections]=useState([]);
  const[takings,setTakings]=useState([]);
  const[expenses,setExpenses]=useState([]);
  const[kitchenStaff,setKitchenStaff]=useState([]);
  const[kitchenHours,setKitchenHours]=useState({});
  const[extras,setExtras]=useState({});
  const[takingDefaults,setTakingDefaults]=useState({});
  const[todayOverride,setTodayOverride]=useState(null);
  const[weekRange,setWeekRange]=useState(()=>payWeekOf(todayISO()));
  const[payrollMonth,setPayrollMonth]=useState(()=>todayISO().slice(0,7));
  const[clearKey,setClearKey]=useState(0);
  const[kpiWeek,setKpiWeek]=useState(()=>snapToSunday(todayISO()));
  const[kpiRange,setKpiRange]=useState(8);
  const[kpiCustomStart,setKpiCustomStart]=useState(()=>snapToSunday(addDays(todayISO(),-55)));
  const[kpiCustomEnd,setKpiCustomEnd]=useState(()=>snapToSunday(todayISO()));
  const[kpiMetrics,setKpiMetrics]=useState({takings:true,wages:true,labour:true,tips:false});
  const[kpiCompare,setKpiCompare]=useState("none");
  const[payrollLoaded,setPayrollLoaded]=useState(false); // gates auto-count display until Load pressed
  const[rotaMon,setRotaMon]=useState(()=>rotaWeekOf(todayISO()).start);
  const[cashPopup,setCashPopup]=useState(false);
  const[pinModal,setPinModal]=useState(false);
  const[settingsModal,setSettingsModal]=useState(false);
  const[absModal,setAbsModal]=useState(false);
  const[shareModal,setShareModal]=useState(null);
  const[rotaRecipient,setRotaRecipient]=useState("");
  const[newKName,setNewKName]=useState("");
  const[absStaff,setAbsStaff]=useState("");const[absDate,setAbsDate]=useState("");const[absPeriod,setAbsPeriod]=useState("");
  const[gsConfig,setGsConfig]=useState({webAppUrl:"",payrollId:"",takingsId:"",clockLogId:"",welcomeMsg:""});
  // Add FOH staff from manager
  const[addStaffModal,setAddStaffModal]=useState(false);
  const[clockDate,setClockDate]=useState(()=>todayISO());
  const[clockShowAll,setClockShowAll]=useState(false);
  const[cardWarning,setCardWarning]=useState(null); // {name, entered, total, focusId}
  function checkCardWarning(name,entered,grossTotal,focusId){
    const val=parseFloat(entered||0);
    if(val>grossTotal+0.001){setCardWarning({name,entered:val.toFixed(2),total:grossTotal.toFixed(2),focusId});}
  }

  const newCount=takings.filter(s=>s.is_new).length;
  function t(m){setMsg(m);setTimeout(()=>setMsg(""),3000);}

  useEffect(()=>{loadAll();},[]);
  useEffect(()=>{if(staff.length)loadRota();},[rotaMon,staff.length]);
  useEffect(()=>{if(kitchenStaff.length)loadKitchenHours();},[weekRange.start,kitchenStaff.length]);
  useEffect(()=>{
    // Reload payroll_extras for the new week so cards auto-fill
    db.from("payroll_extras").select("*").eq("week_start",weekRange.start).then(({data})=>{
      if(!data)return;
      setExtras(p=>{
        const em={...p};
        data.forEach(e=>{em[e.staff_id]={tips:e.tips,additions:e.additions||[],deductions:e.deductions||[],notes:e.notes||[],manualFull:e.manual_full||"",manualNight:e.manual_night||"",manualHrs:e.manual_hrs||"",manualCash:e.manual_cash||"",manualCard:e.manual_card||"",manualTotal:e.manual_total||"",extraTime:e.extra_time||"",id:e.id,ws:e.week_start};});
        return em;
      });
    });
  },[weekRange.start]);

  async function loadAll(){
    setLoading(true);
    const[staffR,absR,logR,rejR,takR,expR,kitR,defR,ovR,extR,gsR]=await Promise.all([
      db.from("staff").select("*").order("name"),
      db.from("absences").select("*").order("date",{ascending:false}),
      db.from("clock_logs").select("*").order("date",{ascending:false}),
      db.from("rejections").select("*"),
      db.from("takings").select("*").order("date",{ascending:false}),
      db.from("expenses").select("*").order("date",{ascending:false}),
      db.from("kitchen_staff").select("*").order("name"),
      db.from("takings_defaults").select("*"),
      db.from("takings_assignment").select("staff_id").eq("date",todayISO()).maybeSingle(),
      db.from("payroll_extras").select("*"),
      db.from("app_settings").select("key,value").in("key",["gs_webapp_url","gs_payroll_id","gs_takings_id","gs_clocklog_id","manager_pin","welcome_message"]),
    ]);
    setStaff((staffR.data||[]).map(s=>({...s,payType:s.pay_type,rate:s.rate,shiftRate:s.shift_rate,nightRate:s.night_rate,cardFixed:s.card_fixed||"0",cardMode:s.card_mode||"fixed",tipsPct:s.tips_pct||"0"})));
    setAbsences(absR.data||[]);setClockLogs(logR.data||[]);setRejections(rejR.data||[]);
    setTakings(takR.data||[]);setExpenses(expR.data||[]);
    setKitchenStaff((kitR.data||[]).map(k=>({...k,payType:k.pay_type||"hourly",shiftRate:k.shift_rate||"0",nightRate:k.night_rate||"0",cardMode:k.card_mode||"fixed",cardFixed:k.card_fixed||"0"})));
    setTodayOverride(ovR.data?.staff_id||null);
    const staffIds=new Set((staffR.data||[]).map(s=>s.id));
    const dd={};(defR.data||[]).forEach(r=>{if(staffIds.has(r.staff_id))dd[r.day_of_week]=r.staff_id;});setTakingDefaults(dd);
    const em={};
    (extR.data||[]).forEach(e=>{em[e.staff_id]={tips:e.tips,additions:e.additions||[],deductions:e.deductions||[],notes:e.notes||[],manualFull:e.manual_full||"",manualNight:e.manual_night||"",manualHrs:e.manual_hrs||"",manualCash:e.manual_cash||"",manualCard:e.manual_card||"",manualTotal:e.manual_total||"",extraTime:e.extra_time||"",id:e.id,ws:e.week_start};});
    setExtras(em);
    const gsRows=gsR.data||[];
    setGsConfig({webAppUrl:gsRows.find(r=>r.key==="gs_webapp_url")?.value||"",payrollId:gsRows.find(r=>r.key==="gs_payroll_id")?.value||"",takingsId:gsRows.find(r=>r.key==="gs_takings_id")?.value||"",clockLogId:gsRows.find(r=>r.key==="gs_clocklog_id")?.value||"",welcomeMsg:gsRows.find(r=>r.key==="welcome_message")?.value||""});
    setLoading(false);
  }

  async function loadRota(){
    if(!staff.length)return;
    const{data}=await db.from("rota").select("*").eq("week_start",rotaMon);
    const rm={};
    staff.forEach(s=>{rm[s.id]=weekDates(rotaMon).map(dateISO=>{const jsDay=new Date(dateISO+"T12:00:00").getDay();const row=(data||[]).find(r=>r.staff_id===s.id&&r.day_index===jsDay);return{date:dateISO,jsDay,type:row?.shift_type||"Off",customIn:row?.custom_in||"",customOut:row?.custom_out||"",rowId:row?.id};});});
    setRota(rm);
  }

  async function loadKitchenHours(){
    const ws=weekRange.start;const ids=kitchenStaff.map(k=>k.id);if(!ids.length)return;
    const{data}=await db.from("kitchen_weekly_hours").select("*").in("kitchen_staff_id",ids).eq("week_start",ws);
    const hm={};(data||[]).forEach(r=>{hm[r.kitchen_staff_id]={id:r.id,hours:r.hours};});setKitchenHours(hm);
  }

  async function saveGsConfig(cfg){
    setGsConfig(cfg);
    for(const[key,value]of[["gs_webapp_url",cfg.webAppUrl],["gs_payroll_id",cfg.payrollId],["gs_takings_id",cfg.takingsId],["gs_clocklog_id",cfg.clockLogId||""],["welcome_message",cfg.welcomeMsg||""]]){
      await db.from("app_settings").upsert({key,value});
    }
    t("✅ Google Sheets config saved!");
  }

  // ── Rota ──
  async function setShift(sId,dayIdx,field,val){
    const days=rota[sId]||[];const day=days[dayIdx];if(!day)return;
    const updated={...day,[field]:val};
    setRota(p=>({...p,[sId]:p[sId].map((d,i)=>i===dayIdx?updated:d)}));
    const payload={staff_id:sId,day_index:day.jsDay,week_start:rotaMon,shift_type:field==="type"?val:day.type,custom_in:field==="customIn"?val:day.customIn,custom_out:field==="customOut"?val:day.customOut};
    if(day.rowId){await db.from("rota").update(payload).eq("id",day.rowId);}
    else{const{data}=await db.from("rota").insert(payload).select().single();if(data)setRota(p=>({...p,[sId]:p[sId].map((d,i)=>i===dayIdx?{...updated,rowId:data.id}:d)}));}
  }

  // ── Takings defaults ──
  async function saveTakingDefault(staffId,dow,assign){
    if(assign){
      const{data:existing}=await db.from("takings_defaults").select("id").eq("day_of_week",dow).maybeSingle();
      if(existing)await db.from("takings_defaults").update({staff_id:staffId}).eq("id",existing.id);
      else await db.from("takings_defaults").insert({staff_id:staffId,day_of_week:dow});
      setTakingDefaults(p=>({...p,[dow]:staffId}));
    }else{
      await db.from("takings_defaults").delete().eq("day_of_week",dow).eq("staff_id",staffId);
      setTakingDefaults(p=>{const n={...p};if(n[dow]===staffId)delete n[dow];return n;});
    }
  }
  async function saveTodayOverride(staffId){
    setTodayOverride(staffId||null);
    const{data:existing}=await db.from("takings_assignment").select("id").eq("date",todayISO()).maybeSingle();
    if(staffId){if(existing)await db.from("takings_assignment").update({staff_id:staffId}).eq("date",todayISO());else await db.from("takings_assignment").insert({staff_id:staffId,date:todayISO()});}
    else{if(existing)await db.from("takings_assignment").delete().eq("date",todayISO());}
    t("✅ Today's assignment saved");
  }
  const todayDow=new Date().getDay();
  const effectiveTodayPerson=todayOverride||takingDefaults[todayDow]||null;
  function staffAssignedDays(staffId){return Object.entries(takingDefaults).filter(([,sid])=>sid===staffId).map(([dow])=>parseInt(dow));}

  // ── Payroll extras ──
  function getExtras(sid){return extras[sid]||{tips:"",additions:[],deductions:[],notes:[],manualFull:"",manualNight:"",manualHrs:"",manualCash:"",manualCard:"",manualTotal:"",extraTime:"",tipsPaid:false,id:null,ws:null};}
  // State-only update — called from PayrollCard inputs so calcPay recomputes immediately.
  // Does NOT write to DB. DB write only happens in exportPayroll flush.
  function setExtrasState(sid,fn){
    setExtras(p=>({...p,[sid]:fn(p[sid]||getExtras(sid))}));
  }
  // Full upsert to DB — only called from exportPayroll flush on Push.
  async function updateExtras(sid,fn){
    const next=fn(getExtras(sid));setExtras(p=>({...p,[sid]:next}));
    const ws=weekRange.start;
    const payload={staff_id:sid,week_start:ws,tips:next.tips||"0",additions:next.additions||[],deductions:next.deductions||[],notes:next.notes||[],manual_full:next.manualFull||null,manual_night:next.manualNight||null,manual_hrs:next.manualHrs||null,manual_cash:next.manualCash||null,manual_card:next.manualCard||null,manual_total:next.manualTotal||null,extra_time:next.extraTime||null};
    const{data}=await db.from("payroll_extras").upsert(payload,{onConflict:"staff_id,week_start"}).select().single();
    if(data)setExtras(p=>({...p,[sid]:{...next,id:data.id,ws}}));
  }

  // ── Pay calculations ──
  // Shared card-split logic for FOH and kitchen. Never silently invents money:
  // if a fixed card amount is bigger than what was actually earned, we flag it
  // (cardExceeds) instead of quietly capping it and moving on — the manager
  // must be shown a warning and correct the fixed amount themselves.
  function splitCard(mode,fixedAmt,total){
    if(mode==="cash")return{cardAmt:0,cashAmt:total,exceeds:false};
    if(mode==="card")return{cardAmt:total,cashAmt:0,exceeds:false};
    const fixed=parseFloat(fixedAmt||0);
    const exceeds=fixed>total+0.001; // small epsilon for float rounding
    const cardAmt=exceeds?total:fixed; // still can't show more card than was earned
    return{cardAmt,cashAmt:Math.max(0,total-cardAmt),exceeds};
  }

  function calcPay(s){
    const ex=getExtras(s.id);
    const hasShiftRate=parseFloat(s.shiftRate||0)>0||parseFloat(s.nightRate||0)>0;
    const myRota=rota[s.id]||[];
    const logsInRange=clockLogs.filter(l=>l.staff_id===s.id&&l.date>=weekRange.start&&l.date<=weekRange.end);

    // ── Shift-paid staff ──
    // Exclude shifts where clock log shows sick_leave for that day
    const sickDates=new Set(logsInRange.filter(l=>l.note==="sick_leave").map(l=>l.date));
    const autoFull=myRota.filter(sh=>sh?.type==="Full Day (11am–close)"&&!sickDates.has(sh.date)).length;
    const autoNight=myRota.filter(sh=>sh?.type==="Night (5:30pm–close)"&&!sickDates.has(sh.date)).length;
    const full=ex.manualFull!==""&&ex.manualFull!=null?parseFloat(ex.manualFull):(hasShiftRate&&payrollLoaded?autoFull:0);
    const night=ex.manualNight!==""&&ex.manualNight!=null?parseFloat(ex.manualNight):(hasShiftRate&&payrollLoaded?autoNight:0);

    // ── Hourly-only staff ──
    let autoHrs=0;let autoOvertimeHrs=0;let autoOvertimeLabel="";
    if(!hasShiftRate){
      const dailyRaw={};
      logsInRange.forEach(l=>{dailyRaw[l.date]=(dailyRaw[l.date]||0)+parseHrs(l.time_in,l.time_out);});
      autoHrs=Object.values(dailyRaw).reduce((a,dayHrs)=>a+roundHrsUp(dayHrs),0);
      // Overtime: compute scheduled hours from rota, compare to clock hours
      let scheduledHrs=0;
      myRota.forEach(sh=>{
        if(sh.date<weekRange.start||sh.date>weekRange.end)return;
        if(sh.type==="Full Day (11am–close)")scheduledHrs+=12; // 11:00-23:00
        else if(sh.type==="Night (5:30pm–close)")scheduledHrs+=5.5; // 17:30-23:00
        else if(sh.type==="Custom"&&sh.customIn&&sh.customOut){scheduledHrs+=parseHrs(sh.customIn,sh.customOut);}
      });
      // Only mark overtime if a clock log note says overtime
      const overtimeLogs=logsInRange.filter(l=>l.note==="overtime");
      if(overtimeLogs.length>0&&scheduledHrs>0){
        const overtimeRaw=Math.max(0,autoHrs-scheduledHrs);
        autoOvertimeHrs=roundHrs025(overtimeRaw);
        if(autoOvertimeHrs>0)autoOvertimeLabel=`Overtime: ${autoOvertimeHrs}h`;
      }
    }
    const hrs=ex.manualHrs!==""&&ex.manualHrs!=null?parseFloat(ex.manualHrs):autoHrs;

    // ── Auto-deduction for shift-paid left_early / late ──
    // For each shift day where clock log has left_early note, calculate deficit hours
    let autoDeductions=[...(ex.deductions||[])];
    if(hasShiftRate){
      myRota.forEach(sh=>{
        if(!sh.date||sh.date<weekRange.start||sh.date>weekRange.end)return;
        const dayLog=logsInRange.find(l=>l.date===sh.date&&l.note==="left_early");
        if(!dayLog||!dayLog.time_out)return;
        // Get scheduled end time for this shift
        let schedEnd=null;
        if(sh.type==="Full Day (11am–close)")schedEnd="23:00";
        else if(sh.type==="Night (5:30pm–close)")schedEnd="23:00";
        else if(sh.type==="Custom"&&sh.customOut)schedEnd=sh.customOut;
        if(!schedEnd)return;
        const [eH,eM]=schedEnd.split(":").map(Number);
        const [oH,oM]=dayLog.time_out.split(":").map(Number);
        const diffMins=(eH*60+eM)-(oH*60+oM);
        if(diffMins>0){
          const dedHrs=roundHrs025(diffMins/60);
          if(dedHrs>0){
            const dedLabel=`Left early ${dispDate(sh.date)} (-${dedHrs}h)`;
            // Only auto-add if not already in deductions
            if(!autoDeductions.some(d=>d.label===dedLabel)){
              autoDeductions=[...autoDeductions,{label:dedLabel,amount:String(r2(dedHrs*parseFloat(s.rate||0))),auto:true}];
            }
          }
        }
      });
    }

    const weekTakings=takings.filter(tk=>tk.date>=weekRange.start&&tk.date<=weekRange.end);
    const weekTipsTotal=weekTakings.reduce((a,tk)=>a+parseFloat(tk.tips_cash||0)+parseFloat(tk.tips_card||0),0);
    const autoTips=r2(weekTipsTotal*parseFloat(s.tipsPct||0)/100);
    const tips=ex.tips!==""&&ex.tips!=null?parseFloat(ex.tips||0):autoTips;
    const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const dedT=autoDeductions.reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const base=hrs*parseFloat(s.rate||0)+full*parseFloat(s.shiftRate||0)+night*parseFloat(s.nightRate||0);
    const salaryTotal=Math.max(0,base+addT-dedT);
    const cardMode=s.cardMode||"fixed";
    const{cardAmt:calcCard,cashAmt:calcCash,exceeds}=splitCard(cardMode,s.cardFixed,salaryTotal);
    const isOverride=!!(ex.manualTotal&&ex.manualTotal!=="");
    const salaryFinal=isOverride?parseFloat(ex.manualTotal):salaryTotal;
    const cardAmt=ex.manualCard&&ex.manualCard!==""?parseFloat(ex.manualCard):calcCard;
    const cashAmt=ex.manualCash&&ex.manualCash!==""?parseFloat(ex.manualCash):calcCash;
    return{full,night,hrs:typeof hrs==="number"?hrs.toFixed(2):hrs,base:base.toFixed(2),tips:tips.toFixed(2),autoTips:autoTips.toFixed(2),addT:addT.toFixed(2),dedT:dedT.toFixed(2),total:salaryFinal.toFixed(2),cardAmt:cardAmt.toFixed(2),cashAmt:cashAmt.toFixed(2),isOverride,grossTotal:salaryTotal,cardExceeds:!isOverride&&cardMode==="fixed"&&exceeds,autoOvertimeHrs,autoOvertimeLabel,sickDays:sickDates.size,autoDeductions};
  }

  function calcKitchenPay(k){
    const sid=kId(k.id);const ex=getExtras(sid);
    const hrs=ex.manualHrs!==""&&ex.manualHrs!=null?parseFloat(ex.manualHrs):0;
    const full=ex.manualFull!==""&&ex.manualFull!=null?parseFloat(ex.manualFull):0;
    const night=ex.manualNight!==""&&ex.manualNight!=null?parseFloat(ex.manualNight):0;
    const tips=parseFloat(ex.tips||0);
    const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const base=hrs*parseFloat(k.rate||0)+full*parseFloat(k.shiftRate||0)+night*parseFloat(k.nightRate||0);
    const calcTotal=Math.max(0,base+tips+addT-dedT);
    const cardMode=k.cardMode||"fixed";
    const{cardAmt:calcCard,cashAmt:calcCash,exceeds}=splitCard(cardMode,k.cardFixed,calcTotal);
    const isOverride=!!(ex.manualTotal&&ex.manualTotal!=="");
    const total=isOverride?parseFloat(ex.manualTotal):calcTotal;
    const cardAmt=ex.manualCard&&ex.manualCard!==""?parseFloat(ex.manualCard):calcCard;
    const cashAmt=ex.manualCash&&ex.manualCash!==""?parseFloat(ex.manualCash):calcCash;
    return{hrs:hrs.toFixed(2),full,night,base:base.toFixed(2),tips:tips.toFixed(2),addT:addT.toFixed(2),dedT:dedT.toFixed(2),total:total.toFixed(2),cardAmt:cardAmt.toFixed(2),cashAmt:cashAmt.toFixed(2),isOverride,grossTotal:calcTotal,cardExceeds:!isOverride&&cardMode==="fixed"&&exceeds};
  }

  function payTotals(){
    let fhCash=0,fhCard=0,fhTips=0,kcCash=0,kcCard=0;
    staff.forEach(s=>{const p=calcPay(s);fhCash+=parseFloat(p.cashAmt);fhCard+=parseFloat(p.cardAmt);fhTips+=parseFloat(p.tips);});
    kitchenStaff.forEach(k=>{const p=calcKitchenPay(k);kcCash+=parseFloat(p.cashAmt);kcCard+=parseFloat(p.cardAmt);});
    const totCash=fhCash+kcCash,totCard=fhCard+kcCard;
    return{
      fhCash:fhCash.toFixed(2),fhCard:fhCard.toFixed(2),fhTips:fhTips.toFixed(2),
      kcCash:kcCash.toFixed(2),kcCard:kcCard.toFixed(2),
      cash:totCash.toFixed(2),card:totCard.toFixed(2),
      gross:(totCash+totCard).toFixed(2)
    };
  }

  // ── Kitchen ──
  async function addKitchen(){
    if(!newKName.trim())return t("Please enter a name");
    const{data,error}=await db.from("kitchen_staff").insert({name:newKName.trim(),cash_card:"cash",pay_type:"hourly",shift_rate:"0",night_rate:"0",rate:"0",card_mode:"fixed",card_fixed:"0"}).select().single();
    if(!error){setKitchenStaff(p=>[...p,{...data,payType:"hourly",shiftRate:"0",nightRate:"0",cardMode:"fixed",cardFixed:"0"}]);setNewKName("");t("✅ "+data.name+" added");}
    else t("❌ "+error.message);
  }
  async function updKitchenField(id,field,val){
    setKitchenStaff(p=>p.map(k=>k.id===id?{...k,[field]:val}:k));
    await db.from("kitchen_staff").update({[field]:val}).eq("id",id);
  }
  async function updKitchenHours(kitchenId,hours){
    const ws=weekRange.start;const existing=kitchenHours[kitchenId];
    setKitchenHours(p=>({...p,[kitchenId]:{...p[kitchenId],hours}}));
    if(existing?.id){await db.from("kitchen_weekly_hours").update({hours}).eq("id",existing.id);}
    else{const{data}=await db.from("kitchen_weekly_hours").insert({kitchen_staff_id:kitchenId,week_start:ws,hours}).select().single();if(data)setKitchenHours(p=>({...p,[kitchenId]:{id:data.id,hours}}));}
  }
  async function delKitchen(id){setKitchenStaff(p=>p.filter(k=>k.id!==id));await db.from("kitchen_staff").delete().eq("id",id);}

  // ── Remove FOH staff ──
  async function removeStaff(s){
    if(!window.confirm(`Remove ${s.name}? This cannot be undone.`))return;
    const{error}=await db.from("staff").delete().eq("id",s.id);
    if(!error){
      setStaff(p=>p.filter(x=>x.id!==s.id));
      // Clean up any takings assignments for removed staff
      await db.from("takings_defaults").delete().eq("staff_id",s.id);
      setTakingDefaults(p=>{const n={...p};Object.keys(n).forEach(k=>{if(n[k]===s.id)delete n[k];});return n;});
      t(`${s.name} removed`);
    }else t("❌ "+error.message);
  }

  // ── Expenses ──
  async function addExpense(desc,amount,payType,date){
    const{data,error}=await db.from("expenses").insert({description:desc,amount:parseFloat(amount),pay_type:payType,date}).select().single();
    if(!error)setExpenses(p=>[data,...p]);return{error};
  }
  async function delExpense(id){setExpenses(p=>p.filter(e=>e.id!==id));await db.from("expenses").delete().eq("id",id);}
  async function updateExpense(id,fields){
    const{error}=await db.from("expenses").update(fields).eq("id",id);
    if(!error)setExpenses(p=>p.map(e=>e.id===id?{...e,...fields}:e));
    return{error};
  }

  // ── Takings overwrite ──
  async function upsertTakings(date,vals,note){
    const existing=takings.find(s=>s.date===date);
    if(existing){
      const{error}=await db.from("takings").update({...vals,note,is_new:false}).eq("id",existing.id);
      if(!error){
        const updated=[...takings.map(x=>x.id===existing.id?{...x,...vals,note,is_new:false}:x)];
        setTakings(updated);
        return{ok:true,updatedTakings:updated};
      }
      return{ok:false,err:error.message};
    }else{
      const{data,error}=await db.from("takings").insert({staff_id:"manager",staff_name:"Manager",date,...vals,note,is_new:false}).select().single();
      if(!error){
        const updated=[data,...takings];
        setTakings(updated);
        return{ok:true,updatedTakings:updated};
      }
      return{ok:false,err:error.message};
    }
  }

  // ── Auto-push single day to Daily sheet with fresh data ──
  async function autoPushDay(date, freshTakings){
    if(!gsConfig.webAppUrl||!gsConfig.takingsId)return;
    const takingsToUse=freshTakings||takings;
    // Build complete Daily and Weekly from fresh data
    function buildDailyFresh(){
      const dates=[...new Set([...takingsToUse.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
      const hdr=["Date","Deliveroo","Uber Eats","Cash","Card","Online","Shop Expenses (£)","Deposit Receipt Cash","Deposit Receipt Card","Voucher Purchase Cash","Voucher Purchase Card","Total","Cash in Hand","Net Total","Tips Cash (£)","Tips Card (£)","Other Expenses Cash (£)","Other Expenses Card (£)","Other Expense Notes"];
      function rowForDate(d){
        const sub=takingsToUse.find(s=>s.date===d)||{};
        const dayExp=expenses.filter(e=>e.date===d);
        const otherExpCash=dayExp.filter(e=>e.pay_type==="cash").reduce((s,e)=>s+e.amount,0);
        const otherExpCard=dayExp.filter(e=>e.pay_type==="card").reduce((s,e)=>s+e.amount,0);
        const otherExpNotes=dayExp.map(e=>`${e.description}(£${e.amount.toFixed(2)},${e.pay_type})`).join("; ");
        const shopExp=parseFloat(sub.shop_expense||0);
        const dep=parseFloat(sub.deposit_receipt||0);
        const depPay=sub.deposit_pay_type||"cash";
        const depCash=depPay==="cash"?dep:0; const depCard=depPay==="card"?dep:0;
        const vp=parseFloat(sub.voucher_purchase||0);
        const vpPay=sub.voucher_pay_type||"cash";
        const vpCash=vpPay==="cash"?vp:0; const vpCard=vpPay==="card"?vp:0;
        const cash=parseFloat(sub.cash||0),card=parseFloat(sub.card||0);
        const deliveroo=parseFloat(sub.deliveroo||0),uber=parseFloat(sub.uber||0),online=parseFloat(sub.online||0);
        const total=r2(deliveroo+uber+cash+card+online-shopExp+dep+vp);
        const cashInHand=r2(cash-shopExp+depCash+vpCash);
        const tCash=r2(parseFloat(sub.tips_cash||0));
        const tCard=r2(parseFloat(sub.tips_card||0));
        return[fmtDate(d),r2(deliveroo),r2(uber),r2(cash),r2(card),r2(online),r2(shopExp),r2(depCash),r2(depCard),r2(vpCash),r2(vpCard),total,cashInHand,total,tCash,tCard,r2(otherExpCash),r2(otherExpCard),otherExpNotes];
      }
      return[hdr,...dates.map(rowForDate)];
    }
    function buildWeeklyFresh(){
      const dates=[...new Set([...takingsToUse.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
      const wm={};dates.forEach(d=>{const{start}=payWeekOf(d);if(!wm[start])wm[start]=[];wm[start].push(d);});
      const hdr=["Date Range","Deliveroo","Uber Eats","Cash","Card","Online","Shop Expenses (£)","Deposit Receipt Cash","Deposit Receipt Card","Voucher Purchase Cash","Voucher Purchase Card","Total","Cash in Hand","Net Total","Tips Cash (£)","Tips Card (£)","Other Expenses Cash (£)","Other Expenses Card (£)"];
      const rows=[hdr];
      Object.entries(wm).sort().forEach(([ws,dates2])=>{
        const{end}=payWeekOf(ws);
        let del=0,uber=0,cash=0,card=0,online=0,shopExp=0,depCash=0,depCard=0,vpCash=0,vpCard=0,otherExpCash=0,otherExpCard=0,tipsCash=0,tipsCard=0;
        dates2.forEach(d=>{
          const sub=takingsToUse.find(s=>s.date===d)||{};
          del+=parseFloat(sub.deliveroo||0);uber+=parseFloat(sub.uber||0);cash+=parseFloat(sub.cash||0);card+=parseFloat(sub.card||0);online+=parseFloat(sub.online||0);shopExp+=parseFloat(sub.shop_expense||0);
          tipsCash+=parseFloat(sub.tips_cash||0);tipsCard+=parseFloat(sub.tips_card||0);
          const dep=parseFloat(sub.deposit_receipt||0);const depPay=sub.deposit_pay_type||"cash";
          if(depPay==="cash")depCash+=dep;else depCard+=dep;
          const vp=parseFloat(sub.voucher_purchase||0);const vpPay=sub.voucher_pay_type||"cash";
          if(vpPay==="cash")vpCash+=vp;else vpCard+=vp;
          const dayExp=expenses.filter(e=>e.date===d);
          otherExpCash+=dayExp.filter(e=>e.pay_type==="cash").reduce((a,e)=>a+e.amount,0);
          otherExpCard+=dayExp.filter(e=>e.pay_type==="card").reduce((a,e)=>a+e.amount,0);
        });
        const total=r2(del+uber+cash+card+online-shopExp+(depCash+depCard)+(vpCash+vpCard));
        const cashInHand=r2(cash-shopExp+depCash+vpCash);
        rows.push([fmtRangeExport(ws,end),del.toFixed(2),uber.toFixed(2),cash.toFixed(2),card.toFixed(2),online.toFixed(2),shopExp.toFixed(2),depCash.toFixed(2),depCard.toFixed(2),vpCash.toFixed(2),vpCard.toFixed(2),total,cashInHand,total,tipsCash.toFixed(2),tipsCard.toFixed(2),otherExpCash.toFixed(2),otherExpCard.toFixed(2)]);
      });
      return rows;
    }
    await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Daily",buildDailyFresh());
    await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Weekly",buildWeeklyFresh());
  }

  // ── Export builders ──
  function buildPayroll(){
    const hdr=["Date Range","Name","Type","Full Shifts","Night Shifts","Hours","Rate/Hour (£)","Rate/Full Shift (£)","Rate/Night Shift (£)","Cash (£)","Card (£)","Tips (£)","Additions (£)","Deductions (£)","Total (£)","Notes","Override?"];
    const rows=[hdr];
    staff.forEach(s=>{
      const p=calcPay(s);const ex=getExtras(s.id);
      rows.push([fmtRangeExport(weekRange.start,weekRange.end),s.name,"FOH",
        p.full,p.night,p.hrs,
        s.rate||"0",s.shiftRate||"0",s.nightRate||"0",
        p.cashAmt,p.cardAmt,p.tips,p.addT,p.dedT,p.total,
        (ex.notes||[]).join("; "),p.isOverride?"MANUAL":""]);
    });
    kitchenStaff.forEach(k=>{
      const p=calcKitchenPay(k);const ex=getExtras(kId(k.id));
      rows.push([fmtRangeExport(weekRange.start,weekRange.end),k.name,"Kitchen",
        p.full,p.night,p.hrs,
        k.rate||"0",k.shiftRate||"0",k.nightRate||"0",
        p.cashAmt,p.cardAmt,p.tips,p.addT,p.dedT,p.total,
        (ex.notes||[]).join("; "),p.isOverride?"MANUAL":""]);
    });
    return rows;
  }
  function buildPayrollWeekly(){
    const hdr=["Date Range","FH Cash (£)","FH Card (£)","FH Tips (£)","Kitchen Cash (£)","Kitchen Card (£)","Total Cash (£)","Total Card (£)","Total (£)"];
    const{fhCash,fhCard,fhTips,kcCash,kcCard,cash,card,gross}=payTotals();
    return[hdr,[fmtRangeExport(weekRange.start,weekRange.end),fhCash,fhCard,fhTips,kcCash,kcCard,cash,card,gross]];
  }
  async function buildPayrollMonthly(yearMonth, allExtrasDb){
    // A week belongs to the month whose LAST day (Saturday=start+6) falls in.
    const hdr=["Date Range","Staff Name","Type","Cash (£)","Card (£)","Tips (£)","Total Bank Transfer (£)"];
    const rows=[hdr];
    const[yr,mo]=yearMonth.split("-").map(Number);
    const monthStart=new Date(yr,mo-1,1);
    const monthEnd=new Date(yr,mo,0);
    const monthStartISO=monthStart.toISOString().split("T")[0];
    const monthEndISO=monthEnd.toISOString().split("T")[0];
    const rangeStr=`${fmtDate(monthStartISO)}-${fmtDate(monthEndISO)}`;

    // If allExtrasDb not passed, fetch from DB
    const allEx=allExtrasDb||(await db.from("payroll_extras").select("*")).data||[];
    if(allEx.length===0)return rows;

    // Find all week_starts whose Saturday falls in this month
    const qualifyingWeeks=new Set();
    allEx.forEach(ex=>{
      if(!ex.week_start)return;
      const wEnd=addDays(ex.week_start,6);
      if(wEnd>=monthStartISO&&wEnd<=monthEndISO)qualifyingWeeks.add(ex.week_start);
    });
    if(qualifyingWeeks.size===0)return rows;

    const allPeople=[
      ...staff.map(s=>({id:s.id,name:s.name,type:"FOH",rate:s.rate,shiftRate:s.shiftRate,nightRate:s.nightRate,cardMode:s.cardMode,cardFixed:s.cardFixed,tipsPct:s.tipsPct||"0",sid:s.id})),
      ...kitchenStaff.map(k=>({id:k.id,name:k.name,type:"Kitchen",rate:k.rate,shiftRate:k.shiftRate,nightRate:k.nightRate,cardMode:k.cardMode,cardFixed:k.cardFixed,tipsPct:"0",sid:kId(k.id)}))
    ];

    allPeople.forEach(person=>{
      let totalCash=0,totalCard=0,totalTips=0;
      qualifyingWeeks.forEach(ws=>{
        const ex=allEx.find(e=>e.staff_id===person.sid&&e.week_start===ws);
        if(!ex)return;
        const hrs=ex.manual_hrs!=null&&ex.manual_hrs!==""?parseFloat(ex.manual_hrs):0;
        const full=ex.manual_full!=null&&ex.manual_full!==""?parseFloat(ex.manual_full):0;
        const night=ex.manual_night!=null&&ex.manual_night!==""?parseFloat(ex.manual_night):0;
        const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const base=hrs*parseFloat(person.rate||0)+full*parseFloat(person.shiftRate||0)+night*parseFloat(person.nightRate||0);
        const sal=ex.manual_total!=null&&ex.manual_total!==""?parseFloat(ex.manual_total):Math.max(0,base+addT-dedT);
        const{cardAmt,cashAmt}=splitCard(person.cardMode||"fixed",person.cardFixed,sal);
        const storedTips=parseFloat(ex.tips||0);
        const weekTakingsForWs=takings.filter(tk=>tk.date>=ws&&tk.date<=addDays(ws,6));
        const weekTipsTotal=weekTakingsForWs.reduce((a,tk)=>a+parseFloat(tk.tips_cash||0)+parseFloat(tk.tips_card||0),0);
        const autoTips=person.type==="FOH"?r2(weekTipsTotal*parseFloat(person.tipsPct||0)/100):0;
        const tips=storedTips>0?storedTips:autoTips;
        totalCash+=ex.manual_cash!=null&&ex.manual_cash!==""?parseFloat(ex.manual_cash):cashAmt;
        totalCard+=ex.manual_card!=null&&ex.manual_card!==""?parseFloat(ex.manual_card):cardAmt;
        totalTips+=tips;
      });
      if(totalCash+totalCard+totalTips===0)return;
      const bankTransfer=r2(totalCard+totalTips);
      rows.push([rangeStr,person.name,person.type,r2(totalCash).toFixed(2),r2(totalCard).toFixed(2),r2(totalTips).toFixed(2),bankTransfer.toFixed(2)]);
    });
    return rows;
  }
  function buildDailyForDate(date){
    const sub=takings.find(s=>s.date===date)||{};
    const dayExp=expenses.filter(e=>e.date===date);
    const otherExpCash=dayExp.filter(e=>e.pay_type==="cash").reduce((s,e)=>s+e.amount,0);
    const otherExpCard=dayExp.filter(e=>e.pay_type==="card").reduce((s,e)=>s+e.amount,0);
    const otherExpNotes=dayExp.map(e=>`${e.description}(£${e.amount.toFixed(2)},${e.pay_type})`).join("; ");
    const shopExp=parseFloat(sub.shop_expense||0);
    const dep=parseFloat(sub.deposit_receipt||0);
    const depPay=sub.deposit_pay_type||"cash";
    const depCash=depPay==="cash"?dep:0;
    const depCard=depPay==="card"?dep:0;
    const vp=parseFloat(sub.voucher_purchase||0);
    const vpPay=sub.voucher_pay_type||"cash";
    const vpCash=vpPay==="cash"?vp:0;
    const vpCard=vpPay==="card"?vp:0;
    const deliveroo=parseFloat(sub.deliveroo||0);
    const uber=parseFloat(sub.uber||0);
    const cash=parseFloat(sub.cash||0);
    const card=parseFloat(sub.card||0);
    const online=parseFloat(sub.online||0);
    // Total and CashInHand do NOT include other expenses (informational only)
    const total=r2(deliveroo+uber+cash+card+online-shopExp+dep+vp);
    const cashInHand=r2(cash-shopExp+depCash+vpCash);
    const tCash=r2(parseFloat(sub.tips_cash||0));
    const tCard=r2(parseFloat(sub.tips_card||0));
    // Column order: ...VPCard, Total, CashInHand, NetTotal, TipsCash, TipsCard, OtherExpCash, OtherExpCard, Notes
    return[[
      fmtDate(date),
      r2(deliveroo), r2(uber), r2(cash), r2(card), r2(online),
      r2(shopExp),
      r2(depCash), r2(depCard),
      r2(vpCash), r2(vpCard),
      total, cashInHand, total,
      tCash, tCard,
      r2(otherExpCash), r2(otherExpCard),
      otherExpNotes
    ]];
  }
  function buildDaily(){
    const dates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
    const hdr=["Date","Deliveroo","Uber Eats","Cash","Card","Online","Shop Expenses (£)","Deposit Receipt Cash","Deposit Receipt Card","Voucher Purchase Cash","Voucher Purchase Card","Total","Cash in Hand","Net Total","Tips Cash (£)","Tips Card (£)","Other Expenses Cash (£)","Other Expenses Card (£)","Other Expense Notes"];
    return[hdr,...dates.map(date=>buildDailyForDate(date)[0])];
  }
  function buildWeekly(){
    const dates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
    const wm={};dates.forEach(d=>{const{start}=payWeekOf(d);if(!wm[start])wm[start]=[];wm[start].push(d);});
    const hdr=["Date Range","Deliveroo","Uber Eats","Cash","Card","Online","Shop Expenses (£)","Deposit Receipt Cash","Deposit Receipt Card","Voucher Purchase Cash","Voucher Purchase Card","Total","Cash in Hand","Net Total","Tips Cash (£)","Tips Card (£)","Other Expenses Cash (£)","Other Expenses Card (£)"];
    const rows=[hdr];
    Object.entries(wm).sort().forEach(([ws,dates2])=>{
      const{end}=payWeekOf(ws);
      let del=0,uber=0,cash=0,card=0,online=0,shopExp=0;
      let depCash=0,depCard=0,vpCash=0,vpCard=0;
      let otherExpCash=0,otherExpCard=0,tipsCash=0,tipsCard=0;
      dates2.forEach(d=>{
        const sub=takings.find(s=>s.date===d)||{};
        del+=parseFloat(sub.deliveroo||0);uber+=parseFloat(sub.uber||0);
        cash+=parseFloat(sub.cash||0);card+=parseFloat(sub.card||0);online+=parseFloat(sub.online||0);
        shopExp+=parseFloat(sub.shop_expense||0);
        tipsCash+=parseFloat(sub.tips_cash||0);
        tipsCard+=parseFloat(sub.tips_card||0);
        const dep=parseFloat(sub.deposit_receipt||0);
        const depPay=sub.deposit_pay_type||"cash";
        if(depPay==="cash")depCash+=dep;else depCard+=dep;
        const vp=parseFloat(sub.voucher_purchase||0);
        const vpPay=sub.voucher_pay_type||"cash";
        if(vpPay==="cash")vpCash+=vp;else vpCard+=vp;
        const dayExp=expenses.filter(e=>e.date===d);
        otherExpCash+=dayExp.filter(e=>e.pay_type==="cash").reduce((a,e)=>a+e.amount,0);
        otherExpCard+=dayExp.filter(e=>e.pay_type==="card").reduce((a,e)=>a+e.amount,0);
      });
      // Total and cashInHand do NOT include other expenses (informational only)
      const total=r2(del+uber+cash+card+online-shopExp+(depCash+depCard)+(vpCash+vpCard));
      const cashInHand=r2(cash-shopExp+depCash+vpCash);
      rows.push([
        fmtRangeExport(ws,end),
        r2(del),r2(uber),r2(cash),r2(card),r2(online),
        r2(shopExp),
        r2(depCash),r2(depCard),
        r2(vpCash),r2(vpCard),
        total,cashInHand,total,
        r2(tipsCash),r2(tipsCard),
        r2(otherExpCash),r2(otherExpCard)
      ]);
    });
    return rows;
  }

  async function exportPayroll(){
    if(!gsConfig.webAppUrl||!gsConfig.payrollId)return t("⚠️ Google Sheets not configured — tap ⚙️ Sheets");

    const ws=weekRange.start;
    // Flush current extras state to DB before fetching allEx
    if(Object.keys(extras).length>0){
      t("⏳ Saving current week data…");
      try{
        const flushOps=Object.entries(extras).map(([sid,ex])=>{
          const payload={staff_id:sid,week_start:ws,tips:ex.tips||"0",additions:ex.additions||[],deductions:ex.deductions||[],notes:ex.notes||[],manual_full:ex.manualFull||null,manual_night:ex.manualNight||null,manual_hrs:ex.manualHrs||null,manual_cash:ex.manualCash||null,manual_card:ex.manualCard||null,manual_total:ex.manualTotal||null,extra_time:ex.extraTime||null};
          // Try with extra_time; if column missing, retry without it
          return db.from("payroll_extras").upsert(payload,{onConflict:"staff_id,week_start"})
            .then(r=>{
              if(r.error&&(r.error.message?.includes("extra_time")||r.error.code==="42703")){
                const{extra_time,...payloadNoET}=payload;
                return db.from("payroll_extras").upsert(payloadNoET,{onConflict:"staff_id,week_start"});
              }
              return r;
            });
        });
        const results=await Promise.all(flushOps);
        const errs=results.filter(r=>r.error).map(r=>r.error.message);
        if(errs.length>0){t("❌ Save error: "+errs[0]);return;}
      }catch(e){t("❌ Save error: "+e.message);return;}
    }

    // Now fetch ALL payroll_extras from DB — guaranteed to include current week
    const{data:allExDb}=await db.from("payroll_extras").select("*");
    if(!allExDb){t("❌ Could not load payroll data from DB");return;}

    // Merge current extras STATE on top of DB rows so unsaved field edits are included.
    // For each staff in current extras, if their week_start matches current week,
    // use the state version (most up-to-date). DB rows for other weeks stay as-is.
    const allEx=[...allExDb];
    Object.entries(extras).forEach(([sid,ex])=>{
      const idx=allEx.findIndex(e=>e.staff_id===sid&&e.week_start===ws);
      const merged={staff_id:sid,week_start:ws,tips:ex.tips||"0",additions:ex.additions||[],deductions:ex.deductions||[],notes:ex.notes||[],manual_full:ex.manualFull||null,manual_night:ex.manualNight||null,manual_hrs:ex.manualHrs||null,manual_cash:ex.manualCash||null,manual_card:ex.manualCard||null,manual_total:ex.manualTotal||null};
      if(idx>=0)allEx[idx]=merged;else allEx.push(merged);
    });

    // ── Build Payroll tab: one row per staff per week, ALL weeks ──
    const payrollHdr=["Date Range","Name","Type","Full Shifts","Night Shifts","Hours","Rate/Hour (£)","Rate/Full Shift (£)","Rate/Night Shift (£)","Cash (£)","Card (£)","Tips (£)","Additions (£)","Deductions (£)","Total (£)","Notes","Extra Time (hrs)","Lost Hours (hrs)","Override?"];
    const payrollRows=[payrollHdr];
    // Group extras by week_start
    const weekStarts=[...new Set(allEx.map(e=>e.week_start).filter(Boolean))].sort();
    weekStarts.forEach(ws=>{
      const wEnd=addDays(ws,6);
      const wRange=fmtRangeExport(ws,wEnd);
      // FOH staff
      staff.forEach(s=>{
        const ex=allEx.find(e=>e.staff_id===s.id&&e.week_start===ws);
        if(!ex)return;
        const hrs=ex.manual_hrs!=null&&ex.manual_hrs!==""?parseFloat(ex.manual_hrs):0;
        const full=ex.manual_full!=null&&ex.manual_full!==""?parseFloat(ex.manual_full):0;
        const night=ex.manual_night!=null&&ex.manual_night!==""?parseFloat(ex.manual_night):0;
        const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const base=hrs*parseFloat(s.rate||0)+full*parseFloat(s.shiftRate||0)+night*parseFloat(s.nightRate||0);
        const salaryTotal=ex.manual_total!=null&&ex.manual_total!==""?parseFloat(ex.manual_total):Math.max(0,base+addT-dedT);
        const{cardAmt,cashAmt}=splitCard(s.cardMode||"fixed",s.cardFixed,salaryTotal);
        const cash=ex.manual_cash!=null&&ex.manual_cash!==""?parseFloat(ex.manual_cash):cashAmt;
        const card=ex.manual_card!=null&&ex.manual_card!==""?parseFloat(ex.manual_card):cardAmt;
        // Auto-calculate tips from takings if not manually set
        const storedTips=parseFloat(ex.tips||0);
        const weekTakingsForWs=takings.filter(tk=>tk.date>=ws&&tk.date<=wEnd);
        const weekTipsTotal=weekTakingsForWs.reduce((a,tk)=>a+parseFloat(tk.tips_cash||0)+parseFloat(tk.tips_card||0),0);
        const autoTips=r2(weekTipsTotal*parseFloat(s.tipsPct||0)/100);
        const tips=storedTips>0?storedTips:autoTips;
        // Compute overtime and lost hours from clock logs for this week
        const fohLogs=clockLogs.filter(l=>l.staff_id===s.id&&l.date>=ws&&l.date<=addDays(ws,6));
        let fohOvertimeHrs=0,fohLostHrs=0;
        const fohRota=rota[s.id]||[];
        fohRota.filter(sh=>sh.date>=ws&&sh.date<=addDays(ws,6)).forEach(sh=>{
          const dayLog=fohLogs.find(l=>l.date===sh.date);
          if(!dayLog||!dayLog.time_out)return;
          let schedEnd=null;
          if(sh.type==="Full Day (11am–close)")schedEnd="23:00";
          else if(sh.type==="Night (5:30pm–close)")schedEnd="23:00";
          else if(sh.type==="Custom"&&sh.customOut)schedEnd=sh.customOut;
          if(!schedEnd)return;
          const[eH,eM]=schedEnd.split(":").map(Number);
          const[oH,oM]=dayLog.time_out.split(":").map(Number);
          const diffMins=(oH*60+oM)-(eH*60+eM);
          if(diffMins>15&&(dayLog.note||"").includes("overtime"))fohOvertimeHrs+=roundHrs025(diffMins/60);
          if(diffMins<0&&(dayLog.note||"").includes("left_early"))fohLostHrs+=roundHrs025(Math.abs(diffMins)/60);
        });
        const extraTimeVal=ex.extra_time||(fohOvertimeHrs>0?String(fohOvertimeHrs):"");
        const lostHrsVal=fohLostHrs>0?String(fohLostHrs):"";
        payrollRows.push([wRange,s.name,"FOH",full,night,r2(hrs).toFixed(2),s.rate||"0",s.shiftRate||"0",s.nightRate||"0",r2(cash).toFixed(2),r2(card).toFixed(2),r2(tips).toFixed(2),r2(addT).toFixed(2),r2(dedT).toFixed(2),r2(salaryTotal).toFixed(2),(ex.notes||[]).join("; "),extraTimeVal,lostHrsVal,ex.manual_total?"MANUAL":""]);
      });
      // Kitchen staff
      kitchenStaff.forEach(k=>{
        const sid=kId(k.id);
        const ex=allEx.find(e=>e.staff_id===sid&&e.week_start===ws);
        if(!ex)return;
        const hrs=ex.manual_hrs!=null&&ex.manual_hrs!==""?parseFloat(ex.manual_hrs):0;
        const full=ex.manual_full!=null&&ex.manual_full!==""?parseFloat(ex.manual_full):0;
        const night=ex.manual_night!=null&&ex.manual_night!==""?parseFloat(ex.manual_night):0;
        const tips=parseFloat(ex.tips||0);
        const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const base=hrs*parseFloat(k.rate||0)+full*parseFloat(k.shiftRate||0)+night*parseFloat(k.nightRate||0);
        const salaryTotal=ex.manual_total!=null&&ex.manual_total!==""?parseFloat(ex.manual_total):Math.max(0,base+addT-dedT);
        const{cardAmt,cashAmt}=splitCard(k.cardMode||"fixed",k.cardFixed,salaryTotal);
        const cash=ex.manual_cash!=null&&ex.manual_cash!==""?parseFloat(ex.manual_cash):cashAmt;
        const card=ex.manual_card!=null&&ex.manual_card!==""?parseFloat(ex.manual_card):cardAmt;
        payrollRows.push([wRange,k.name,"Kitchen",full,night,r2(hrs).toFixed(2),k.rate||"0",k.shiftRate||"0",k.nightRate||"0",r2(cash).toFixed(2),r2(card).toFixed(2),r2(tips).toFixed(2),r2(addT).toFixed(2),r2(dedT).toFixed(2),r2(salaryTotal).toFixed(2),(ex.notes||[]).join("; "),"","",ex.manual_total?"MANUAL":""]);
      });
    });

    // ── Build PayrollWeekly: one row per week aggregated ──
    const wklyHdr=["Date Range","FH Cash (£)","FH Card (£)","FH Tips (£)","Kitchen Cash (£)","Kitchen Card (£)","Total Cash (£)","Total Card (£)","Total (£)"];
    const wklyRows=[wklyHdr];
    weekStarts.forEach(ws=>{
      const wEnd=addDays(ws,6);
      let fhCash=0,fhCard=0,fhTips=0,kcCash=0,kcCard=0;
      staff.forEach(s=>{
        const ex=allEx.find(e=>e.staff_id===s.id&&e.week_start===ws);
        if(!ex)return;
        const hrs=ex.manual_hrs!=null&&ex.manual_hrs!==""?parseFloat(ex.manual_hrs):0;
        const full=ex.manual_full!=null&&ex.manual_full!==""?parseFloat(ex.manual_full):0;
        const night=ex.manual_night!=null&&ex.manual_night!==""?parseFloat(ex.manual_night):0;
        const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const base=hrs*parseFloat(s.rate||0)+full*parseFloat(s.shiftRate||0)+night*parseFloat(s.nightRate||0);
        const sal=ex.manual_total!=null&&ex.manual_total!==""?parseFloat(ex.manual_total):Math.max(0,base+addT-dedT);
        const{cardAmt,cashAmt}=splitCard(s.cardMode||"fixed",s.cardFixed,sal);
        fhCash+=ex.manual_cash!=null&&ex.manual_cash!==""?parseFloat(ex.manual_cash):cashAmt;
        fhCard+=ex.manual_card!=null&&ex.manual_card!==""?parseFloat(ex.manual_card):cardAmt;
        // Auto-tips from takings if not manually set
        const storedTips=parseFloat(ex.tips||0);
        const weekTakingsForWs=takings.filter(tk=>tk.date>=ws&&tk.date<=wEnd);
        const weekTipsTotal=weekTakingsForWs.reduce((a,tk)=>a+parseFloat(tk.tips_cash||0)+parseFloat(tk.tips_card||0),0);
        const autoTips=r2(weekTipsTotal*parseFloat(s.tipsPct||0)/100);
        fhTips+=storedTips>0?storedTips:autoTips;
      });
      kitchenStaff.forEach(k=>{
        const sid=kId(k.id);
        const ex=allEx.find(e=>e.staff_id===sid&&e.week_start===ws);
        if(!ex)return;
        const hrs=ex.manual_hrs!=null&&ex.manual_hrs!==""?parseFloat(ex.manual_hrs):0;
        const full=ex.manual_full!=null&&ex.manual_full!==""?parseFloat(ex.manual_full):0;
        const night=ex.manual_night!=null&&ex.manual_night!==""?parseFloat(ex.manual_night):0;
        const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
        const base=hrs*parseFloat(k.rate||0)+full*parseFloat(k.shiftRate||0)+night*parseFloat(k.nightRate||0);
        const sal=ex.manual_total!=null&&ex.manual_total!==""?parseFloat(ex.manual_total):Math.max(0,base+addT-dedT);
        const{cardAmt,cashAmt}=splitCard(k.cardMode||"fixed",k.cardFixed,sal);
        kcCash+=ex.manual_cash!=null&&ex.manual_cash!==""?parseFloat(ex.manual_cash):cashAmt;
        kcCard+=ex.manual_card!=null&&ex.manual_card!==""?parseFloat(ex.manual_card):cardAmt;
      });
      if(fhCash+fhCard+fhTips+kcCash+kcCard===0)return;
      const totCash=r2(fhCash+kcCash),totCard=r2(fhCard+kcCard),totAll=r2(fhCash+kcCash+fhCard+kcCard);
      wklyRows.push([fmtRangeExport(ws,wEnd),r2(fhCash),r2(fhCard),r2(fhTips),r2(kcCash),r2(kcCard),totCash,totCard,totAll]);
    });

    // Guard: if no data built, surface a clear error instead of pushing empty sheets
    if(payrollRows.length<=1){
      t("❌ No payroll data found in DB. Enter hours/shifts for staff — values save automatically when you leave each field.");
      return;
    }

    // ── Build PayrollMonthly: group by month, one row per staff ──
    const monthlyRows=await buildPayrollMonthly(payrollMonth,allEx);

    t("⏳ Pushing Payroll tab…");
    const wr1=await pushSheet(gsConfig.webAppUrl,gsConfig.payrollId,"Payroll",payrollRows);
    if(!wr1.ok){t("❌ Payroll: "+wr1.err);return;}
    t("⏳ Pushing PayrollWeekly tab…");
    const wr2=await pushSheet(gsConfig.webAppUrl,gsConfig.payrollId,"PayrollWeekly",wklyRows);
    if(!wr2.ok){t("❌ Weekly: "+wr2.err);return;}
    if(monthlyRows.length>1){
      t("⏳ Pushing PayrollMonthly tab…");
      const wr3=await pushSheet(gsConfig.webAppUrl,gsConfig.payrollId,"PayrollMonthly",monthlyRows);
      if(!wr3.ok){t("❌ Monthly: "+wr3.err);return;}
    }
    setExtras({});
    setClearKey(k=>k+1);
    t(`✅ All pushed — ${payrollRows.length-1} staff-weeks, ${wklyRows.length-1} weekly rows, ${monthlyRows.length-1} monthly rows — page cleared!`);
  }
  async function exportPayrollMonthly(){
    if(!gsConfig.webAppUrl||!gsConfig.payrollId)return t("⚠️ Google Sheets not configured — tap ⚙️ Sheets");
    const{data:allEx}=await db.from("payroll_extras").select("*");
    const rows=await buildPayrollMonthly(payrollMonth,allEx||[]);
    if(rows.length<=1)return t("⚠️ No payroll data found for this month — make sure weekly payrolls have been pushed first");
    t(`⏳ Pushing PayrollMonthly tab (${rows.length-1} staff)…`);
    const r=await pushSheet(gsConfig.webAppUrl,gsConfig.payrollId,"PayrollMonthly",rows);
    if(!r.ok){t("❌ "+r.err);return;}
    t("✅ PayrollMonthly updated!");
  }
  async function exportTakings(){
    if(!gsConfig.webAppUrl||!gsConfig.takingsId)return t("⚠️ Google Sheets not configured — tap ⚙️ Sheets");
    const daily=buildDaily();
    const weekly=buildWeekly();
    t(`⏳ Sending Daily tab (${daily.length-1} data rows)…`);
    const r1=await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Daily",daily);
    if(!r1.ok){t("❌ "+r1.err);return;}
    t(`⏳ Sending Weekly tab (${weekly.length-1} data rows)…`);
    const r2=await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Weekly",weekly);
    if(!r2.ok){t("❌ "+r2.err);return;}
    const tabs=(r2.sheets||[]).join(", ")||"unknown";
    t(`✅ Done — ${daily.length-1} daily rows, ${weekly.length-1} weekly rows. Tabs in sheet: [${tabs}]`);
  }
  // Export expenses only — merges into Daily sheet without touching takings columns
  // Columns: 12=Other Exp Cash (0-indexed: 11), 13=Other Exp Card (12), 17=Notes (16)
  async function exportExpensesOnly(){
    if(!gsConfig.webAppUrl||!gsConfig.takingsId)return t("⚠️ Google Sheets not configured — tap ⚙️ Sheets");
    // Get all expense dates
    const expDates=[...new Set(expenses.map(e=>e.date))].filter(Boolean).sort();
    if(expDates.length===0)return t("No expenses to export");
    // For each expense date, build a row: either update existing taking row or create new
    const takingsDates=takings.map(s=>s.date);
    const rows=expDates.map(date=>{
      const dayExp=expenses.filter(e=>e.date===date);
      const expCash=dayExp.filter(e=>e.pay_type==="cash").reduce((s,e)=>s+e.amount,0);
      const expCard=dayExp.filter(e=>e.pay_type==="card").reduce((s,e)=>s+e.amount,0);
      const notes=dayExp.map(e=>`${e.description}(£${e.amount.toFixed(2)},${e.pay_type})`).join("; ");
      const hasTaking=takingsDates.includes(date);
      if(hasTaking){
        // Return the full row so it overwrites correctly in the full Daily sheet
        return buildDailyForDate(date)[0];
      }else{
        // New row: date + blanks for takings columns + expense columns
        const blank="";
        return[fmtDate(date),blank,blank,blank,blank,blank,blank,blank,blank,blank,blank,r2(expCash),r2(expCard),blank,blank,blank,notes];
      }
    });
    // Rebuild full daily with merged expenses and push
    const allDates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
    const allRows=buildDaily(); // uses correct 19-column header including Tips Cash, Tips Card
    t(`⏳ Merging expenses into Daily tab…`);
    const r=await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Daily",allRows);
    if(!r.ok){t("❌ "+r.err);return;}
    t("✅ Expenses merged into Daily sheet!");
  }

  async function pushClockLog(date){
    if(!gsConfig.webAppUrl||!gsConfig.clockLogId)return;
    const hdr=["Date","Staff Name","Rota Type","Clock In","Clock Out","Hours Worked","Break (hrs)","Note","Extra Time (hrs)","Override At"];
    const rows=[hdr];
    const dayLogs=clockLogs.filter(l=>l.date===date);
    dayLogs.forEach(l=>{
      // Rota type for this staff on this date
      const staffRota=rota[l.staff_id]||[];
      const jsDay=new Date(date+"T12:00:00").getDay();
      const rotaEntry=staffRota.find(d=>d.jsDay===jsDay);
      let rotaType="";
      if(rotaEntry){
        if(rotaEntry.type==="Full Day (11am–close)")rotaType="Full Day";
        else if(rotaEntry.type==="Night (5:30pm–close)")rotaType="Night Shift";
        else if(rotaEntry.type==="Custom")rotaType=`Custom ${rotaEntry.customIn||""}–${rotaEntry.customOut||""}`;
        else rotaType=rotaEntry.type;
      }
      // Extra time: clock-out minus scheduled end, rounded to 0/0.5/1/2
      let extraTime=0;
      if(l.time_out&&rotaEntry&&rotaEntry.customOut){
        const[eH,eM]=rotaEntry.customOut.split(":").map(Number);
        const[oH,oM]=l.time_out.split(":").map(Number);
        const diffMins=(oH*60+oM)-(eH*60+eM);
        if(diffMins>15){
          const rawHrs=diffMins/60;
          extraTime=roundHrs025(rawHrs); // nearest 0.25h
        }
      }
      const rawHrs=parseHrs(l.time_in,l.time_out);
      const breakHrs=parseFloat(l.break_time||0);
      const netHrs=rawHrs>0?r2(Math.max(0,rawHrs-breakHrs)):"";
      const NOTE_MAP={"forgot":"Forgot to clock out","overtime":"Working extra time","sick_leave":"Sick leave","left_early":"Left early/late","back-stamped":"Back-stamped"};
      const noteLabel=(l.note||"").split("|").map(n=>n.startsWith("checklist_done")?"✅ End-of-shift checklist done":(NOTE_MAP[n]||n)).filter(Boolean).join(" + ");
      const overrideDate=l.override_at?new Date(l.override_at):null;
      const overrideLabel=(overrideDate&&overrideDate.getFullYear()>2020)?overrideDate.toLocaleDateString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"";
      rows.push([fmtDate(date),l.staff_name,rotaType,l.time_in||"",l.time_out||"",netHrs,parseFloat(l.break_time||0)||"",noteLabel,extraTime>0?extraTime:"",overrideLabel]);
    });
    if(rows.length>1)await pushSheet(gsConfig.webAppUrl,gsConfig.clockLogId,"Clock Log",rows);
  }
  // Check daily auto-push (runs on load, fires if today's log not yet pushed)
  const[lastClockPush,setLastClockPush]=useState(()=>localStorage.getItem("lastClockPush")||"");
  useEffect(()=>{
    if(!gsConfig.clockLogId||!gsConfig.webAppUrl)return;
    function checkAndPush(){
      const yesterday=addDays(todayISO(),-1);
      if(lastClockPush!==yesterday){
        pushClockLog(yesterday).then(()=>{localStorage.setItem("lastClockPush",yesterday);setLastClockPush(yesterday);});
      }
    }
    checkAndPush(); // run on load
    const interval=setInterval(checkAndPush,60000); // check every minute for midnight cross
    return()=>clearInterval(interval);
  },[gsConfig.clockLogId,lastClockPush]);
  function buildRotaText(sId){
    const s=staff.find(x=>x.id===sId);if(!s)return"";
    const days=rota[sId]||[];
    const lines=days.map(d=>{const dayName=DAYS_MON[jsToMon(d.jsDay)];const shift=d.type==="Off"?"Off":d.type==="Custom"?`${d.customIn||"?"}–${d.customOut||"?"}`:d.type;return`${dayName} ${fmtDate(d.date)}: ${s.name} — ${shift}`;});
    return`Rota for ${s.name}\n${fmtDate(rotaMon)} – ${fmtDate(addDays(rotaMon,6))}\n\n${lines.join("\n")}`;
  }
  function buildFullRotaText(recipientId){
    const recipientName=staff.find(s=>s.id===recipientId)?.name||"Team";
    const weekStart=rotaMon;
    const weekEnd=addDays(rotaMon,6);
    const header=`Rota — Week of ${fmtDate(weekStart)} to ${fmtDate(weekEnd)}\nPrepared for: ${recipientName}\n`;
    // Build one line per day Mon–Sun, listing only staff who are working (not Off)
    const days=weekDates(rotaMon); // 7 ISO dates Mon–Sun
    function shiftLabel(sh){
      if(!sh||sh.type==="Off")return null;
      if(sh.type==="Full Day (11am–close)")return"full day 11-close";
      if(sh.type==="Night (5:30pm–close)")return"night 5:30-close";
      if(sh.type==="Custom")return`${sh.customIn||"?"}–${sh.customOut||"?"}`;
      return sh.type;
    }
    const lines=days.map((dateISO,idx)=>{
      const dayName=DAYS_MON[idx]; // Mon,Tue,...Sun
      const dateStr=fmtDate(dateISO); // dd/mm/yyyy
      const jsDay=new Date(dateISO+"T12:00:00").getDay();
      // Collect all working staff for this day
      const working=staff.map(s=>{
        const dayRota=(rota[s.id]||[]).find(d=>d.jsDay===jsDay);
        const label=shiftLabel(dayRota);
        return label?`${s.name.split(" ")[0]} (${label})`:null;
      }).filter(Boolean);
      if(working.length===0)return null; // skip days with no one working
      return`${dayName} ${dateStr.slice(0,5)}: ${working.join(", ")}`;
    }).filter(Boolean);
    return`${header}\n${lines.join("\n")}`;
  }

  // ── Absence conflicts ──
  function absConflicts(staffId){
    const mr=rota[staffId]||[];
    return absences.filter(a=>a.staff_id===staffId).filter(a=>{
      const dow=new Date(a.date+"T12:00:00").getDay();const sh=mr.find(d=>d.jsDay===dow);
      if(!sh||sh.type==="Off")return false;
      if(a.period==="Full Day")return true;
      if(a.period==="Morning"&&sh.type==="Full Day (11am–close)")return true;
      if(a.period==="Evening"&&(sh.type.includes("Night")||sh.type==="Full Day (11am–close)"))return true;
      return false;
    });
  }

  // ── AdjustmentsRow (merged add/deduct) ──
  function AdjustmentsRow({sid}){
    const ex=getExtras(sid);
    const addItems=(ex.additions||[]).map(a=>({...a,signed:parseFloat(a.amount)}));
    const dedItems=(ex.deductions||[]).map(d=>({...d,signed:-parseFloat(d.amount)}));
    const allItems=[...addItems,...dedItems];
    const[amount,setAmount]=useState("");const[reason,setReason]=useState("Bonus");const[custom,setCustom]=useState("");
    const REASONS=["Sick leave","Left early","Bank holiday","Red day","Custom"];
    const NOTE_REASONS=["Bank holiday — extra day off","Custom note"];
    return(
      <div>
        {allItems.map((item,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px dashed #F0F0F0"}}>
          <span style={{fontSize:12,color:"#555"}}>{item.label}{item.signed!==0&&<span style={{fontWeight:700,color:item.signed>0?"#065F46":"#E05252",marginLeft:6}}>{item.signed>0?"+":""}£{Math.abs(item.signed).toFixed(2)}</span>}</span>
          <button onClick={()=>{
            if(i<addItems.length)setExtrasState(sid,ex=>({...ex,additions:(ex.additions||[]).filter((_,j)=>j!==i)}));
            else setExtrasState(sid,ex=>({...ex,deductions:(ex.deductions||[]).filter((_,j)=>j!==i-addItems.length)}));
          }} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"#ccc"}}>✕</button>
        </div>)}
        <div className="addrow">
          <select className="addinp" style={{flex:"none",padding:"6px 7px",fontSize:11}} value={reason} onChange={e=>setReason(e.target.value)}>
            <optgroup label="Adjustments (+ or -)">
              {REASONS.map(r=><option key={r}>{r}</option>)}
            </optgroup>
            <optgroup label="Notes only (no £)">
              {NOTE_REASONS.map(r=><option key={r}>{r}</option>)}
            </optgroup>
          </select>
          {!NOTE_REASONS.includes(reason)&&<input className="addinp" type="number" placeholder="+ or - £" value={amount} onChange={e=>setAmount(e.target.value)} style={{width:80}}/>}
          <button className="addbtn" onClick={()=>{
            const label=reason==="Custom"&&custom?custom:reason==="Custom note"&&custom?custom:reason;const amt=parseFloat(amount)||0;
            if(NOTE_REASONS.includes(reason)){setExtrasState(sid,ex=>({...ex,notes:[...(ex.notes||[]),label]}));}
            else if(amt>0)setExtrasState(sid,ex=>({...ex,additions:[...(ex.additions||[]),{label,amount:String(amt)}]}));
            else if(amt<0)setExtrasState(sid,ex=>({...ex,deductions:[...(ex.deductions||[]),{label,amount:String(Math.abs(amt))}]}));
            setAmount("");setCustom("");
          }}>+ Add</button>
        </div>
        {(reason==="Custom"||reason==="Custom note")&&<input className="addinp" style={{marginTop:5,width:"100%"}} placeholder="Custom reason…" value={custom} onChange={e=>setCustom(e.target.value)}/>}
      </div>
    );
  }

  // ── Payroll card (shared for FOH and kitchen) ──
  function PayrollCard({name,icon,sid,payType,rate,shiftRate,nightRate,calcFn,isKitchen,kitchenId,cardMode,cardFixed,staffId}){
    const p=calcFn();const ex=getExtras(sid);
    const[showOverride,setShowOverride]=useState(!!(ex.manualTotal&&ex.manualTotal!==""));
    const[localCardFixed,setLocalCardFixed]=useState(cardFixed||"0");
    // Local input state — avoids re-rendering whole list on every keystroke (fix for scroll-jump bug)
    const[lFull,setLFull]=useState(ex.manualFull||"");
    const[lNight,setLNight]=useState(ex.manualNight||"");
    const[lHrs,setLHrs]=useState(ex.manualHrs||"");
    const[lTips,setLTips]=useState(ex.tips||"");
    const[lExtraTime,setLExtraTime]=useState(ex.extraTime||"");
    const[lCash,setLCash]=useState(ex.manualCash||"");
    const[lCard,setLCard]=useState(ex.manualCard||"");
    const[lTotal,setLTotal]=useState(ex.manualTotal||"");
    const[countsEdited,setCountsEdited]=useState(false); // only show card warning after counts are edited
    useEffect(()=>{setLocalCardFixed(cardFixed||"0");},[cardFixed]);
    // Sync all local inputs when extras changes (e.g. after manager taps Load week)
    useEffect(()=>{
      setLFull(ex.manualFull||"");
      setLNight(ex.manualNight||"");
      setLHrs(ex.manualHrs||"");
      setLTips(ex.tips||"");
      setLExtraTime(ex.extraTime||"");
      setLCash(ex.manualCash||"");
      setLCard(ex.manualCard||"");
      setLTotal(ex.manualTotal||"");
    },[ex.manualFull,ex.manualNight,ex.manualHrs,ex.tips,ex.manualCash,ex.manualCard,ex.manualTotal,ex.extraTime]);
    return(
      <div className="paycard">
        <div className="phead">
          <div className="pname">{icon} {name}{p.isOverride&&<span className="chip a" style={{marginLeft:6}}>Manual</span>}</div>
          <div className="ptotal">£{p.total}</div>
        </div>
        <div className="pbody">
          {/* Edit Counts — show only what's relevant for this staff member's pay type */}
          <div style={{background:"#FFF5EF",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:8}}>EDIT COUNTS <span style={{fontWeight:400}}>(blank = auto from rota/clock)</span></div>
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>Full Shifts</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0" value={lFull} onChange={e=>{setLFull(e.target.value);setCountsEdited(true);}} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualFull:e.target.value}))}/></div>
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>Night Shifts</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0" value={lNight} onChange={e=>{setLNight(e.target.value);setCountsEdited(true);}} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualNight:e.target.value}))}/></div>
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>Hours</div><input type="number" min="0" step="0.5" className="inp sm" style={{width:"100%"}} placeholder="0" value={lHrs} onChange={e=>{setLHrs(e.target.value);setCountsEdited(true);}} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualHrs:e.target.value}))}/></div>
            </div>
          </div>
          <div className="row"><span>Hours</span><span className="rowb">{p.hrs}h × £{rate} = £{(parseFloat(p.hrs||0)*parseFloat(rate||0)).toFixed(2)}</span></div>
          {!isKitchen&&p.autoOvertimeHrs>0&&<div className="row" style={{background:"#FEF3C7"}}><span>⏱ {p.autoOvertimeLabel}</span><span className="rowb" style={{color:"#78350F"}}>info only</span></div>}
          {!isKitchen&&p.sickDays>0&&<div className="row" style={{background:"#FEE2E2"}}><span>🤒 Sick days excluded</span><span className="rowb" style={{color:"#7F1D1D"}}>{p.sickDays} shift(s)</span></div>}
          {p.autoDeductions&&p.autoDeductions.filter(d=>d.auto).map((d,i)=><div key={"ad"+i} className="row" style={{background:"#FEE2E2"}}><span style={{fontSize:11}}>📉 {d.label}</span><span className="rowb" style={{color:"#7F1D1D"}}>-£{parseFloat(d.amount).toFixed(2)}</span></div>)}
          <div className="row"><span>Full Day shifts</span><span className="rowb">{p.full} × £{shiftRate} = £{(p.full*parseFloat(shiftRate||0)).toFixed(2)}</span></div>
          <div className="row"><span>Night shifts</span><span className="rowb">{p.night} × £{nightRate} = £{(p.night*parseFloat(nightRate||0)).toFixed(2)}</span></div>
          <div className="row"><span>Tips (£) {!isKitchen&&p.autoTips!=="0.00"&&<span style={{fontSize:10,color:"#aaa"}}>(auto: £{p.autoTips})</span>}</span><input type="number" className="mini" min="0" placeholder={!isKitchen?p.autoTips:"0.00"} value={lTips} onChange={e=>setLTips(e.target.value)} onBlur={e=>setExtrasState(sid,ex=>({...ex,tips:e.target.value}))}/></div>
          <div style={{marginTop:8}}><div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>ADJUSTMENTS <span style={{fontWeight:400}}>(+ add / - deduct / note only)</span></div><AdjustmentsRow sid={sid}/></div>
          <div className="divider"/>
          {/* Card payment mode — editable directly in payroll, same for FOH and kitchen */}
          {p.cardExceeds&&countsEdited&&(
            <div style={{background:"#FEE2E2",border:"1.5px solid #E05252",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
              <div style={{fontSize:12,fontWeight:800,color:"#7F1D1D",marginBottom:4}}>⚠️ Fixed card amount is more than was earned</div>
              <div style={{fontSize:11,color:"#991B1B",marginBottom:8}}>Fixed at £{parseFloat(cardFixed||0).toFixed(2)} but only £{p.grossTotal.toFixed(2)} was earned this week. Please correct the amount below.</div>
              <button className="btn danger" style={{marginTop:0,padding:"7px"}} onClick={()=>{const el=document.getElementById(isKitchen?`cf-pk-${kitchenId}`:`cf-ps-${staffId}`);el?.focus();el?.scrollIntoView({behavior:"smooth",block:"center"});}}>Edit Fixed Amount</button>
            </div>
          )}
          <div style={{background:"#FFF5EF",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:8}}>CARD PAYMENT</div>
            <div className="toggle" style={{marginBottom:cardMode==="fixed"?10:0,width:"100%"}}>
              <button className={`tgl${cardMode==="fixed"?" on":""}`} style={{flex:1}} onClick={async()=>{if(isKitchen){setKitchenStaff(p=>p.map(x=>x.id===kitchenId?{...x,cardMode:"fixed"}:x));await db.from("kitchen_staff").update({card_mode:"fixed"}).eq("id",kitchenId);}else{setStaff(p=>p.map(x=>x.id===staffId?{...x,cardMode:"fixed"}:x));await db.from("staff").update({card_mode:"fixed"}).eq("id",staffId);}}}>Fixed £</button>
              <button className={`tgl${cardMode==="cash"?" on":""}`} style={{flex:1}} onClick={async()=>{if(isKitchen){setKitchenStaff(p=>p.map(x=>x.id===kitchenId?{...x,cardMode:"cash"}:x));await db.from("kitchen_staff").update({card_mode:"cash"}).eq("id",kitchenId);}else{setStaff(p=>p.map(x=>x.id===staffId?{...x,cardMode:"cash"}:x));await db.from("staff").update({card_mode:"cash"}).eq("id",staffId);}}}>All Cash</button>
              <button className={`tgl${cardMode==="card"?" on":""}`} style={{flex:1}} onClick={async()=>{if(isKitchen){setKitchenStaff(p=>p.map(x=>x.id===kitchenId?{...x,cardMode:"card"}:x));await db.from("kitchen_staff").update({card_mode:"card"}).eq("id",kitchenId);}else{setStaff(p=>p.map(x=>x.id===staffId?{...x,cardMode:"card"}:x));await db.from("staff").update({card_mode:"card"}).eq("id",staffId);}}}>All Card</button>
            </div>
            {cardMode==="fixed"&&(
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:12,color:"#555"}}>Fixed card amount (£)</span>
                <input id={isKitchen?`cf-pk-${kitchenId}`:`cf-ps-${staffId}`} type="number" className="mini" min="0" placeholder="0.00" value={localCardFixed} onChange={e=>setLocalCardFixed(e.target.value)} onBlur={async e=>{
                  checkCardWarning(name,e.target.value,p.grossTotal,isKitchen?`cf-pk-${kitchenId}`:`cf-ps-${staffId}`);
                  if(isKitchen){setKitchenStaff(p=>p.map(x=>x.id===kitchenId?{...x,cardFixed:e.target.value}:x));await db.from("kitchen_staff").update({card_fixed:e.target.value}).eq("id",kitchenId);}
                  else{setStaff(p=>p.map(x=>x.id===staffId?{...x,cardFixed:e.target.value}:x));await db.from("staff").update({card_fixed:e.target.value}).eq("id",staffId);}
                }}/>
              </div>
            )}
            <div style={{fontSize:10,color:"#aaa",marginTop:6}}>{cardMode==="fixed"?"Card never exceeds what was earned — rest is cash":cardMode==="cash"?"Entire amount paid in cash":"Entire amount paid by card"}</div>
          </div>
          <div className="row"><span>💵 Cash</span><span className="rowb">£{p.cashAmt}</span></div>
          <div className="row"><span>💳 Card</span><span className="rowb">£{p.cardAmt}</span></div>
          <div className="row"><span style={{fontWeight:800}}>Salary Total</span><span style={{fontWeight:900,color:"#E8620A",fontSize:15}}>£{p.total}</span></div>
          {!isKitchen&&<div className="row" style={{borderTop:"1px dashed #E5E5E5",marginTop:4,paddingTop:4}}><span>💳 Tips (card) {p.autoTips!=="0.00"&&!ex.tips&&<span style={{fontSize:10,color:"#aaa"}}>(auto from takings)</span>}</span><span className="rowb" style={{color:"#50DC78"}}>£{p.tips}</span></div>}
          {/* Manual override — overrides ALL exported values including shifts/hours */}
          <button style={{marginTop:8,background:showOverride?"#FEF3C7":"#F0F0F0",border:"none",borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",width:"100%",color:showOverride?"#78350F":"#555"}} onClick={()=>setShowOverride(v=>!v)}>
            {showOverride?"▲ Hide Override":"✏️ Override Exported Values (shifts, hours, cash, card, total)"}
          </button>
          {showOverride&&<div className="override-box">
            <div style={{fontSize:11,color:"#78350F",marginBottom:8,fontWeight:700}}>These values replace everything in the spreadsheet export. Leave blank to use calculated values.</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {payType==="shift"&&<><div style={{flex:1,minWidth:60}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>FULL SHIFTS</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0" value={lFull} onChange={e=>setLFull(e.target.value)}/></div><div style={{flex:1,minWidth:60}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>NIGHT SHIFTS</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0" value={lNight} onChange={e=>setLNight(e.target.value)} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualNight:e.target.value}))}/></div></>}
              {payType==="hourly"&&<div style={{flex:1,minWidth:60}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>HOURS</div><input type="number" min="0" step="0.25" className="inp sm" style={{width:"100%"}} placeholder="0" value={lHrs} onChange={e=>setLHrs(e.target.value)} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualHrs:e.target.value}))}/></div>}
              <div style={{flex:1,minWidth:60}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>CASH £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={lCash} onChange={e=>setLCash(e.target.value)} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualCash:e.target.value}))}/></div>
              <div style={{flex:1,minWidth:60}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>CARD £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={lCard} onChange={e=>setLCard(e.target.value)} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualCard:e.target.value}))}/></div>
              <div style={{flex:1,minWidth:60}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>TOTAL £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={lTotal} onChange={e=>setLTotal(e.target.value)} onBlur={e=>setExtrasState(sid,ex=>({...ex,manualTotal:e.target.value}))}/></div>
            </div>
            <button className="btn danger" style={{marginTop:8,padding:"8px"}} onClick={()=>{updateExtras(sid,ex=>({...ex,manualCash:"",manualCard:"",manualTotal:"",manualFull:"",manualNight:"",manualHrs:""}));setLCash("");setLCard("");setLTotal("");setLFull("");setLNight("");setLHrs("");}}>Clear All Overrides</button>
          </div>}
        </div>
      </div>
    );
  }

  // ── Modals ──
  function AddStaffModal({onClose}){
    const[type,setType]=useState("foh"); // "foh" | "kitchen"
    const[name,setName]=useState("");const[code,setCode]=useState("");const[rate,setRate]=useState("");const[shiftRate,setSR]=useState("");const[nightRate,setNR]=useState("");const[cardFixed,setCF]=useState("0");const[err,setErr]=useState("");const[saving,setSaving]=useState(false);
    async function save(){
      setErr("");if(!name.trim())return setErr("Enter a name");
      setSaving(true);
      if(type==="foh"){
        if(!/^\d{8}$/.test(code)){setSaving(false);return setErr("Code must be 8 digits");}
        const{data:newStaff,error}=await db.from("staff").insert({id:code,name:name.trim(),code,pay_type:"hourly",rate:rate||"0",shift_rate:shiftRate||"0",night_rate:nightRate||"0",card_fixed:cardFixed||"0",card_mode:"fixed"}).select().single();
        if(error){setSaving(false);return setErr(error.code==="23505"?"Code already taken":error.message);}
        setStaff(p=>[...p,{...newStaff,payType:"hourly",rate:rate||"0",shiftRate:shiftRate||"0",nightRate:nightRate||"0",cardFixed:cardFixed||"0",cardMode:"fixed",tipsPct:"0"}].sort((a,b)=>a.name.localeCompare(b.name)));
        t("✅ "+name.trim()+" (FOH) added");
      }else{
        const{data,error}=await db.from("kitchen_staff").insert({name:name.trim(),cash_card:"cash",pay_type:"hourly",shift_rate:shiftRate||"0",night_rate:nightRate||"0",rate:rate||"0",card_mode:"fixed",card_fixed:cardFixed||"0"}).select().single();
        if(error){setSaving(false);return setErr(error.message);}
        setKitchenStaff(p=>[...p,{...data,payType:"hourly",shiftRate:shiftRate||"0",nightRate:nightRate||"0",cardMode:"fixed",cardFixed:cardFixed||"0"}]);
        t("✅ "+name.trim()+" (Kitchen) added");
      }
      onClose();setSaving(false);
    }
    return(
      <div className="overlay" onClick={onClose}><div className="sheet" onClick={e=>e.stopPropagation()}>
        <div className="stitle">➕ Add Staff Member</div>
        <label className="lbl">Staff Type</label>
        <div className="toggle" style={{marginBottom:14}}>
          <button className={`tgl${type==="foh"?" on":""}`} onClick={()=>{setType("foh");setErr("");}}>👤 Front of House</button>
          <button className={`tgl${type==="kitchen"?" on":""}`} onClick={()=>{setType("kitchen");setErr("");}}>👨‍🍳 Kitchen</button>
        </div>
        <label className="lbl">Full Name</label>
        <input className="inp" placeholder={type==="foh"?"e.g. Amy Chen":"e.g. Marco"} value={name} onChange={e=>setName(e.target.value)}/>
        {type==="foh"&&<>
          <label className="lbl">8-Digit Login Code</label>
          <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} onChange={e=>setCode(e.target.value)}/>
        </>}
        <div style={{display:"flex",gap:8}}>
          <div style={{flex:1}}><label className="lbl">£/HR</label><input className="inp" type="number" placeholder="0.00" value={rate} onChange={e=>setRate(e.target.value)}/></div>
          <div style={{flex:1}}><label className="lbl">Full Shift £</label><input className="inp" type="number" placeholder="0.00" value={shiftRate} onChange={e=>setSR(e.target.value)}/></div>
          <div style={{flex:1}}><label className="lbl">Night £</label><input className="inp" type="number" placeholder="0.00" value={nightRate} onChange={e=>setNR(e.target.value)}/></div>
        </div>
        <label className="lbl">Fixed Card Payment (£)</label>
        <input className="inp" type="number" placeholder="0.00" value={cardFixed} onChange={e=>setCF(e.target.value)}/>
        {err&&<div className="err">{err}</div>}
        <button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Add Staff Member"}</button>
        <button className="btn sec" onClick={onClose}>Cancel</button>
      </div></div>
    );
  }

  function PinModal({onClose}){
    const[curr,setCurr]=useState("");const[n1,setN1]=useState("");const[n2,setN2]=useState("");const[err,setErr]=useState("");const[saving,setSaving]=useState(false);
    async function save(){setErr("");setSaving(true);const{data}=await db.from("app_settings").select("value").eq("key","manager_pin").maybeSingle();if(curr!==(data?.value||"00000000")){setErr("Current PIN wrong");setSaving(false);return;}if(!/^\d{8}$/.test(n1)){setErr("New PIN must be 8 digits");setSaving(false);return;}if(n1!==n2){setErr("PINs don't match");setSaving(false);return;}await db.from("app_settings").upsert({key:"manager_pin",value:n1});t("✅ PIN updated!");onClose();setSaving(false);}
    return(<div className="overlay" onClick={onClose}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">🔒 Change Manager PIN</div><label className="lbl">Current PIN</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={curr} onChange={e=>setCurr(e.target.value)}/><label className="lbl">New PIN</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={n1} onChange={e=>setN1(e.target.value)}/><label className="lbl">Confirm New PIN</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={n2} onChange={e=>setN2(e.target.value)}/>{err&&<div className="err">{err}</div>}<button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Change PIN"}</button><button className="btn sec" onClick={onClose}>Cancel</button></div></div>);
  }

  function SettingsModal({onClose}){
    const[webAppUrl,setWebAppUrl]=useState(gsConfig.webAppUrl||"");
    const[payrollId,setPayrollId]=useState(gsConfig.payrollId||"");
    const[takingsId,setTakingsId]=useState(gsConfig.takingsId||"");
    const[clockLogId,setClockLogId]=useState(gsConfig.clockLogId||"");
    const[welcomeMsg,setWelcomeMsg]=useState(gsConfig.welcomeMsg||"");
    const[saving,setSaving]=useState(false);
    const[showScript,setShowScript]=useState(false);
    const[testing,setTesting]=useState(false);
    const[testResult,setTestResult]=useState(null);

    const urlTrimmed=webAppUrl.trim();
    const urlLooksValid=urlTrimmed.startsWith("https://script.google.com/macros/s/")&&urlTrimmed.endsWith("/exec");
    const urlHasDev=urlTrimmed.endsWith("/dev");

    // Auto-extract spreadsheet ID if user pastes full URL
    function extractSheetId(val){
      const v=val.trim();
      const m=v.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if(m)return m[1];
      // if it looks like just an ID already (no slashes, no spaces)
      if(/^[a-zA-Z0-9_-]+$/.test(v))return v;
      return v;
    }
    const cleanPayrollId=extractSheetId(payrollId);
    const cleanTakingsId=extractSheetId(takingsId);
    const payrollIdValid=/^[a-zA-Z0-9_-]{20,}$/.test(cleanPayrollId);
    const takingsIdValid=/^[a-zA-Z0-9_-]{20,}$/.test(cleanTakingsId);

    async function save(){
      setSaving(true);
      await saveGsConfig({webAppUrl:urlTrimmed,payrollId:cleanPayrollId,takingsId:cleanTakingsId,clockLogId:clockLogId.trim(),welcomeMsg:welcomeMsg.trim()});
      setSaving(false);onClose();
    }
    async function runTest(){setTesting(true);setTestResult(null);const r=await testWebApp(urlTrimmed);setTestResult(r);setTesting(false);}
    async function testIds(){
      setTesting(true);setTestResult(null);
      const results=[];
      for(const[label,id] of [["Payroll",cleanPayrollId],["Takings",cleanTakingsId],["Clock Log",clockLogId.trim()]]){
        if(!id){results.push(`${label}: no ID entered`);continue;}
        const payload=encodeURIComponent(JSON.stringify({
          spreadsheetId:id,tab:"TestConnection",
          rows:[["Test",label,new Date().toLocaleString()]],
          startRow:1,clear:true,ts:Date.now()
        }));
        try{
          const res=await fetch(`${urlTrimmed}?payload=${payload}`,{method:"GET",cache:"no-store"});
          const data=await res.json().catch(()=>null);
          if(data&&data.ok){
            results.push(`✅ ${label} ID works — tabs in that sheet: [${(data.sheets||[]).join(", ")}]`);
          }else{
            results.push(`❌ ${label} ID FAILED — "${data?.error||"no response"}" — ID used: "${id}"`);
          }
        }catch(e){results.push(`❌ ${label}: network error — ${e.message}`);}
      }
      setTestResult({ok:results.every(r=>r.startsWith("✅")),msg:results.join("\n\n")});
      setTesting(false);
    }

    const scriptCode=`function doGet(e) {\n  if (!e.parameter || !e.parameter.payload) {\n    return ContentService.createTextOutput(JSON.stringify({ok:true,msg:"Sheets bridge is live"})).setMimeType(ContentService.MimeType.JSON);\n  }\n  try {\n    var body = JSON.parse(e.parameter.payload);\n    var ss = SpreadsheetApp.openById(body.spreadsheetId);\n    var sheet = ss.getSheetByName(body.tab);\n    if (!sheet) sheet = ss.insertSheet(body.tab);\n    // getInfo mode: return current row count without writing\n    if (body.getInfo) {\n      var sheets = ss.getSheets().map(function(s){return s.getName();});\n      return ContentService.createTextOutput(JSON.stringify({ok:true,rowCount:sheet.getLastRow(),sheets:sheets})).setMimeType(ContentService.MimeType.JSON);\n    }\n    if (body.clear) sheet.clearContents();\n    var rows = body.rows || [];\n    var written = 0;\n    if (rows.length > 0) {\n      var startRow = body.startRow || 1;\n      var maxCols = 0;\n      for (var i = 0; i < rows.length; i++) if (rows[i].length > maxCols) maxCols = rows[i].length;\n      for (var j = 0; j < rows.length; j++) {\n        while (rows[j].length < maxCols) rows[j].push("");\n      }\n      sheet.getRange(startRow, 1, rows.length, maxCols).setValues(rows);\n      written = rows.length;\n    }\n    SpreadsheetApp.flush();\n    var sheets = ss.getSheets().map(function(s){return s.getName();});\n    return ContentService.createTextOutput(JSON.stringify({ok:true,written:written,tab:body.tab,sheets:sheets,startRow:body.startRow||1})).setMimeType(ContentService.MimeType.JSON);\n  } catch (err) {\n    return ContentService.createTextOutput(JSON.stringify({ok:false,error:err.message,spreadsheetId:body?body.spreadsheetId:"unknown",tab:body?body.tab:"unknown"})).setMimeType(ContentService.MimeType.JSON);\n  }\n}\n\nfunction doPost(e) { return doGet(e); }`;

    return(
      <div className="overlay" onClick={onClose}>
        <div className="sheet" onClick={e=>e.stopPropagation()}>
          <div className="stitle">🔗 Google Sheets</div>
          <div className="ssub2">Saved permanently in Supabase — set once, never lost</div>

          <button className="btn sec" style={{marginTop:0,marginBottom:14}} onClick={()=>setShowScript(v=>!v)}>{showScript?"▲ Hide setup steps":"▼ Show 3-minute setup steps"}</button>
          {showScript&&(
            <div style={{background:"#FFF5EF",borderRadius:10,padding:"12px 13px",fontSize:12,color:"#444",marginBottom:14,lineHeight:1.8}}>
              <strong>Step 1</strong> — Go to <strong>script.google.com</strong> → click <strong>New project</strong><br/>
              <strong>Step 2</strong> — Delete everything in the editor, paste in this code:
              <textarea readOnly className="lognote" rows={12} style={{fontFamily:"monospace",fontSize:10,marginTop:6,marginBottom:6,background:"#fff"}} value={scriptCode} onClick={e=>e.target.select()}/>
              <button className="btn sm" style={{marginBottom:10}} onClick={()=>{navigator.clipboard.writeText(scriptCode);t("📋 Script copied!");}}>📋 Copy Script</button><br/>
              <strong>Step 3</strong> — Click <strong>Deploy</strong> (top right) → <strong>New deployment</strong><br/>
              <strong>Step 4</strong> — Click ⚙️ gear next to "Select type" → choose <strong>Web app</strong><br/>
              <div style={{background:"#FEE2E2",border:"1px solid #E05252",borderRadius:8,padding:"8px 10px",margin:"6px 0"}}>
                <strong>Step 5 — most common mistake:</strong> "Execute as" = <strong>Me</strong>. "Who has access" = <strong>Anyone</strong> — NOT "Anyone with Google account". Wrong choice = Google login page = app cannot connect.
              </div>
              <strong>Step 6</strong> — Click <strong>Deploy</strong> → authorize when asked (it is your own script)<br/>
              <div style={{background:"#FEE2E2",border:"1px solid #E05252",borderRadius:8,padding:"8px 10px",margin:"6px 0"}}>
                <strong>Step 7 — copy the correct URL:</strong> The URL must end in <strong>/exec</strong> — NOT /dev. The /dev URL requires a Google login. Copy the <strong>Web app URL</strong> from the deployment dialog.
              </div>
              <strong>Step 8</strong> — Paste the URL below, tap <strong>Test Connection</strong>, confirm it says "Connected", then save<br/>
              <strong>Step 9</strong> — Both spreadsheets must be set to <strong>"Anyone with the link can edit"</strong>
            </div>
          )}

          <label className="lbl">Web App URL</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:4,borderColor:urlTrimmed?(urlLooksValid?"#50DC78":"#E05252"):"#E5E5E5"}}
            placeholder="https://script.google.com/macros/s/…/exec"
            value={webAppUrl}
            onChange={e=>{setWebAppUrl(e.target.value);setTestResult(null);}}
          />
          {urlHasDev&&<div style={{color:"#E05252",fontSize:11,fontWeight:700,marginBottom:8}}>⚠️ URL ends in /dev — this will never work. Copy the Web app URL (ends in /exec) from your deployment.</div>}
          {urlTrimmed&&!urlLooksValid&&!urlHasDev&&<div style={{color:"#E05252",fontSize:11,fontWeight:700,marginBottom:8}}>⚠️ URL must start with https://script.google.com/macros/s/ and end with /exec</div>}
          {urlLooksValid&&<div style={{color:"#065F46",fontSize:11,fontWeight:700,marginBottom:8}}>✓ URL format looks correct ({urlTrimmed.length} characters)</div>}
          {urlTrimmed&&webAppUrl!==urlTrimmed&&<div style={{color:"#E05252",fontSize:11,fontWeight:700,marginBottom:8}}>⚠️ Invisible spaces detected and will be stripped on save</div>}
          {urlTrimmed&&<div style={{marginBottom:12}}>
            <a href={urlTrimmed} target="_blank" rel="noreferrer" style={{fontSize:12,color:"#1E40AF",fontWeight:700}}>🌐 Open URL in browser tab →</a>
            <div style={{fontSize:11,color:"#888",marginTop:3}}>Should show: <code style={{background:"#F0F0F0",padding:"1px 4px",borderRadius:3}}>{"{"}"ok":true,"msg":"Sheets bridge is live"{"}"}</code>. If it asks you to log in, "Who has access" is set wrong.</div>
          </div>}

          <button className="btn sec" style={{marginTop:0,marginBottom:8}} onClick={runTest} disabled={testing||!urlTrimmed}>{testing?"Testing…":"🔍 Test Connection"}</button>
          {testResult&&(
            <div style={{background:testResult.ok?"#D1FAE5":"#FEE2E2",border:`1.5px solid ${testResult.ok?"#50DC78":"#E05252"}`,borderRadius:10,padding:"10px 12px",marginBottom:8,fontSize:12,color:testResult.ok?"#065F46":"#7F1D1D",lineHeight:1.8,whiteSpace:"pre-wrap"}}>
              {testResult.msg||testResult.err||""}
            </div>
          )}

          <label className="lbl">Payroll Spreadsheet ID</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:4,borderColor:payrollId?(payrollIdValid?"#50DC78":"#E05252"):"#E5E5E5"}} placeholder="Paste the spreadsheet ID or the full URL" value={payrollId} onChange={e=>setPayrollId(e.target.value)}/>
          {payrollId&&!payrollIdValid&&<div style={{color:"#E05252",fontSize:11,fontWeight:700,marginBottom:4}}>⚠️ Doesn't look like a valid spreadsheet ID. Paste the full spreadsheet URL and we'll extract it automatically.</div>}
          {payrollId&&payrollIdValid&&cleanPayrollId!==payrollId.trim()&&<div style={{color:"#065F46",fontSize:11,fontWeight:700,marginBottom:4}}>✓ Will save ID: <code style={{background:"#F0F0F0",padding:"1px 4px",borderRadius:3}}>{cleanPayrollId}</code></div>}
          {payrollId&&payrollIdValid&&cleanPayrollId===payrollId.trim()&&<div style={{color:"#065F46",fontSize:11,fontWeight:700,marginBottom:4}}>✓ ID looks valid</div>}
          <div style={{fontSize:11,color:"#888",marginBottom:14}}>Paste the full sheet URL or just the ID — we auto-extract it</div>

          <label className="lbl">Takings Spreadsheet ID</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:4,borderColor:takingsId?(takingsIdValid?"#50DC78":"#E05252"):"#E5E5E5"}} placeholder="Paste the spreadsheet ID or the full URL" value={takingsId} onChange={e=>setTakingsId(e.target.value)}/>
          {takingsId&&!takingsIdValid&&<div style={{color:"#E05252",fontSize:11,fontWeight:700,marginBottom:4}}>⚠️ Doesn't look like a valid spreadsheet ID. Paste the full spreadsheet URL and we'll extract it automatically.</div>}
          {takingsId&&takingsIdValid&&cleanTakingsId!==takingsId.trim()&&<div style={{color:"#065F46",fontSize:11,fontWeight:700,marginBottom:4}}>✓ Will save ID: <code style={{background:"#F0F0F0",padding:"1px 4px",borderRadius:3}}>{cleanTakingsId}</code></div>}
          {takingsId&&takingsIdValid&&cleanTakingsId===takingsId.trim()&&<div style={{color:"#065F46",fontSize:11,fontWeight:700,marginBottom:4}}>✓ ID looks valid</div>}
          <div style={{fontSize:11,color:"#888",marginBottom:14}}>Paste the full sheet URL or just the ID — we auto-extract it</div>

          <label className="lbl">Clock Log Spreadsheet ID</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:4,borderColor:clockLogId?(clockLogId.length>20?"#50DC78":"#E05252"):"#E5E5E5"}} placeholder="Paste the ID or full URL of Ming's clock log sheet" value={clockLogId} onChange={e=>setClockLogId(e.target.value)}/>
          <div style={{fontSize:11,color:"#888",marginBottom:14}}>The spreadsheet for daily clock log auto-push (Ming's clock log)</div>

          {/* Test whether the IDs actually open real spreadsheets */}
          {urlLooksValid&&(cleanPayrollId||cleanTakingsId)&&(
            <div style={{marginBottom:14}}>
              <button className="btn sec" style={{marginTop:0}} onClick={testIds} disabled={testing}>
                {testing?"Testing…":"🧪 Test Spreadsheet IDs (try a test write)"}
              </button>
              <div style={{fontSize:11,color:"#888",marginTop:6}}>This writes one test row to a "TestConnection" tab — confirms your spreadsheet IDs are correct before saving.</div>
            </div>
          )}

          <label className="lbl">Welcome Message for Staff</label>
          <textarea className="lognote" rows={3} style={{marginBottom:14,fontSize:14}} placeholder="e.g. Welcome back! Remember: Friday is early close at 10pm." value={welcomeMsg} onChange={e=>setWelcomeMsg(e.target.value)}/>
          <div style={{fontSize:11,color:"#888",marginBottom:14}}>This message shows to all staff when they log in. Leave blank to show nothing.</div>

          <button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Save & Connect"}</button>
          <button className="btn sec" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  if(loading)return<Loading text="Loading manager data…"/>;
  const{cash:totCash,card:totCard,gross:totGross}=payTotals();
  const gsReady=!!(gsConfig.webAppUrl&&gsConfig.payrollId&&gsConfig.takingsId);

  return(
    <div className="app">
      <Toast msg={msg}/>
      <div className="mhdr">
        <div><div className="mtitle">🔑 Manager Panel</div><div className="msub">Restaurant back office</div></div>
        <div style={{display:"flex",gap:7,alignItems:"center"}}>
          <button onClick={()=>setSettingsModal(true)} style={{background:"rgba(255,255,255,.12)",border:"none",color:gsReady?"#50DC78":"#E8620A",borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:12}}>⚙️ Sheets</button>
          <button onClick={()=>setPinModal(true)} style={{background:"rgba(255,255,255,.12)",border:"none",color:"rgba(255,255,255,.7)",borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:12}}>🔒 PIN</button>
          <button className="mlo" onClick={onLogout}>Sign out</button>
        </div>
      </div>

      <div className="mtabs">
        {[{id:"staff",label:"👥 Staff"},{id:"rota",label:`📋 Rota${rejections.length>0?` (${rejections.length})`:""}`},{id:"clock",label:"⏱ Clock"},{id:"payroll",label:"💷 Payroll"},{id:"takings",label:`📊 Takings${newCount>0?` (${newCount})`:""}`},{id:"expenses",label:"🧾 Expenses"},{id:"absence",label:"📅 Absences"},{id:"kpi",label:"📈 KPI"}]
          .map(tb=><button key={tb.id} className={`mtab${tab===tb.id?" on":""}${tb.id==="rota"&&rejections.length>0?" rej":""}`} onClick={()=>setTab(tb.id)}>{tb.label}</button>)}
      </div>

      <div className="mbody">

        {/* ══ STAFF ══ */}
        {tab==="staff"&&(
          <>
            <div className="sec">Staff Management</div>
            <button className="btn navy" style={{marginBottom:14}} onClick={()=>setAddStaffModal(true)}>➕ Add Staff Member</button>

            {staff.length===0&&<div className="empty"><div className="emptyicon">👥</div><div className="emptytxt">No staff yet — add one above</div></div>}
            {staff.map((s,idx)=>{
              return(
                <React.Fragment key={s.id}>
                <div className="card w" style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{display:"flex",gap:10,alignItems:"center"}}>
                      <div className="avatar" style={{width:38,height:38,fontSize:15}}>{s.name[0]}</div>
                      <div><div style={{fontSize:15,fontWeight:800,color:"#1A1A2E"}}>{s.name}</div><div style={{fontSize:11,color:"#aaa"}}>Code: {s.code}</div></div>
                    </div>
                  </div>
                  <div style={{background:"#FFF5EF",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                    <div style={{fontSize:11,color:"#888"}}>
                      {(s.cardMode||"fixed")==="cash"?"💵 Always paid in cash":s.cardMode==="card"?"💳 Always paid by card":`💳 Card fixed: £${s.cardFixed||"0"} · 💵 Rest is cash`}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <div style={{flex:1,minWidth:80}}>
                      <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:3}}>£/HR</div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.rate||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,rate:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({rate:e.target.value}).eq("id",s.id);t(`${s.name} rate saved`);}}/>
                    </div>
                    <div style={{flex:1,minWidth:80}}>
                      <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:3}}>FULL SHIFT £</div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.shiftRate||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,shiftRate:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({shift_rate:e.target.value}).eq("id",s.id);t(`${s.name} full shift rate saved`);}}/>
                    </div>
                    <div style={{flex:1,minWidth:80}}>
                      <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:3}}>NIGHT £</div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.nightRate||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,nightRate:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({night_rate:e.target.value}).eq("id",s.id);t(`${s.name} night rate saved`);}}/>
                    </div>
                  </div>

                  <label className="lbl" style={{marginTop:12}}>Card Payment</label>
                  <div className="toggle" style={{marginBottom:10,width:"100%"}}>
                    <button className={`tgl${(s.cardMode||"fixed")==="fixed"?" on":""}`} style={{flex:1}} onClick={async()=>{setStaff(p=>p.map(x=>x.id===s.id?{...x,cardMode:"fixed"}:x));await db.from("staff").update({card_mode:"fixed"}).eq("id",s.id);}}>Fixed £</button>
                    <button className={`tgl${s.cardMode==="cash"?" on":""}`} style={{flex:1}} onClick={async()=>{setStaff(p=>p.map(x=>x.id===s.id?{...x,cardMode:"cash"}:x));await db.from("staff").update({card_mode:"cash"}).eq("id",s.id);}}>All Cash</button>
                    <button className={`tgl${s.cardMode==="card"?" on":""}`} style={{flex:1}} onClick={async()=>{setStaff(p=>p.map(x=>x.id===s.id?{...x,cardMode:"card"}:x));await db.from("staff").update({card_mode:"card"}).eq("id",s.id);}}>All Card</button>
                  </div>
                  {(s.cardMode||"fixed")==="fixed"&&(
                    <div style={{marginBottom:4}}>
                      <div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>FIXED CARD AMOUNT (£) <span style={{fontWeight:400}}>— the rest is paid as cash</span></div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.cardFixed||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,cardFixed:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({card_fixed:e.target.value}).eq("id",s.id);t(`${s.name} card amount saved`);}} id={`cf-s-${s.id}`}/>
                    </div>
                  )}
                  <div style={{marginTop:10,paddingTop:10,borderTop:"1px dashed #E5E5E5"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:3}}>TIPS % <span style={{fontWeight:400}}>— share of weekly takings tips allocated to this staff</span></div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <input type="number" min="0" max="100" className="inp sm" style={{width:80}} placeholder="0" value={s.tipsPct||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,tipsPct:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({tips_pct:e.target.value}).eq("id",s.id);t(`${s.name} tips % saved`);}}/>
                      <span style={{fontSize:12,color:"#888"}}>%</span>
                    </div>
                  </div>

                  <button className="btn danger" style={{marginTop:10,padding:"10px"}} onClick={()=>removeStaff(s)}>🗑️ Remove {s.name.split(" ")[0]}</button>
                </div>
                {idx===staff.length-1&&(()=>{
                  const total=staff.reduce((a,s)=>a+parseFloat(s.tipsPct||0),0);
                  const ok=Math.abs(total-100)<0.01;
                  return(<div style={{background:ok?"#D1FAE5":"#FEE2E2",border:`1.5px solid ${ok?"#50DC78":"#E05252"}`,borderRadius:10,padding:"10px 14px",marginBottom:10,marginTop:4}}>
                    <div style={{fontSize:13,fontWeight:800,color:ok?"#065F46":"#7F1D1D"}}>
                      {ok?"✅ Tips % total: 100% — all accounted for":`⚠️ Tips % total: ${total.toFixed(0)}% — does not add up to 100%`}
                    </div>
                    <div style={{fontSize:11,color:ok?"#047857":"#991B1B",marginTop:3}}>
                      {staff.map(s=>`${s.name.split(" ")[0]}: ${s.tipsPct||0}%`).join(" · ")}
                    </div>
                  </div>);
                })()}
                </React.Fragment>
              );
            })}

            <div className="sec" style={{marginTop:20}}>Kitchen Staff</div>
            <div style={{display:"flex",gap:6,marginBottom:10}}>
              <input className="inp sm" style={{flex:1}} placeholder="Kitchen staff name…" value={newKName} onChange={e=>setNewKName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addKitchen()}/>
              <button className="btn sm navy" onClick={addKitchen}>Add</button>
            </div>
            {kitchenStaff.length===0&&<div style={{fontSize:13,color:"#ccc",marginBottom:10,fontStyle:"italic"}}>No kitchen staff yet</div>}
            {kitchenStaff.map(k=>(
              <div key={k.id} className="card w" style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div style={{display:"flex",gap:10,alignItems:"center"}}>
                    <div className="avatar" style={{width:38,height:38,fontSize:15,background:"#065F46"}}>👨‍🍳</div>
                    <div style={{fontSize:15,fontWeight:800,color:"#1A1A2E"}}>{k.name}</div>
                  </div>
                  <button onClick={()=>delKitchen(k.id)} style={{background:"none",border:"none",cursor:"pointer",fontSize:15,color:"#ddd"}}>🗑️</button>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                  <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,color:"#555",fontWeight:700,marginBottom:3}}>£/HR</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.rate||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,rate:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"rate",e.target.value)}/></div>
                  <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,color:"#555",fontWeight:700,marginBottom:3}}>FULL SHIFT £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.shiftRate||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,shiftRate:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"shift_rate",e.target.value)}/></div>
                  <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,color:"#555",fontWeight:700,marginBottom:3}}>NIGHT £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.nightRate||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,nightRate:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"night_rate",e.target.value)}/></div>
                </div>
                <label className="lbl" style={{marginTop:12}}>Card Payment</label>
                <div className="toggle" style={{marginBottom:10,width:"100%"}}>
                  <button className={`tgl${(k.cardMode||"fixed")==="fixed"?" on":""}`} style={{flex:1}} onClick={()=>{updKitchenField(k.id,"card_mode","fixed");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardMode:"fixed"}:x));}}>Fixed £</button>
                  <button className={`tgl${k.cardMode==="cash"?" on":""}`} style={{flex:1}} onClick={()=>{updKitchenField(k.id,"card_mode","cash");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardMode:"cash"}:x));}}>All Cash</button>
                  <button className={`tgl${k.cardMode==="card"?" on":""}`} style={{flex:1}} onClick={()=>{updKitchenField(k.id,"card_mode","card");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardMode:"card"}:x));}}>All Card</button>
                </div>
                {(k.cardMode||"fixed")==="fixed"&&(
                  <div style={{marginBottom:4}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>FIXED CARD AMOUNT (£) <span style={{fontWeight:400}}>— the rest is paid as cash</span></div>
                    <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.cardFixed||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardFixed:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"card_fixed",e.target.value)} id={`cf-k-${k.id}`}/>
                  </div>
                )}
              </div>
            ))}
            <div style={{background:"#FFF5EF",borderRadius:12,padding:"12px 14px",fontSize:12,color:"#888",lineHeight:1.6,marginTop:8}}>
              <strong style={{color:"#1A1A2E"}}>Self-registration:</strong> Staff can also register themselves via the Staff login screen.
            </div>
          </>
        )}

        {/* ══ ROTA ══ */}
        {tab==="rota"&&(
          <>
            <div className="sec">Assign Rota</div>
            {getWeekAlerts(rotaMon).map((a,i)=><div key={i} style={{background:a.type==="bh"?"#FEF3C7":"#EFF6FF",border:`1.5px solid ${a.type==="bh"?"#F59E0B":"#BFDBFE"}`,borderRadius:10,padding:"8px 12px",marginBottom:8,fontSize:13,color:a.type==="bh"?"#78350F":"#1E40AF"}}>{a.type==="bh"?"⚠️ Bank Holiday:":"📅"} {a.label}</div>)}
            <div className="wnav">
              <button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,-7))}>‹</button>
              <div className="wnavlbl">{fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon,6))}</div>
              <button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,7))}>›</button>
            </div>
            {rejections.length>0&&<div style={{marginBottom:10}}><div style={{fontSize:12,fontWeight:700,color:"#E05252",marginBottom:6}}>⚠️ Rejections</div>{rejections.map(r=><div key={r.id} className="rejbanner"><span><strong>{r.staff_name}</strong> can't do <strong>{r.day}</strong>{r.reason?` — "${r.reason}"`:""}</span><button onClick={async()=>{
              // Delete the rejection record
              await db.from("rejections").delete().eq("id",r.id);
              setRejections(p=>p.filter(x=>x.id!==r.id));
              // Set that shift to Off in the rota
              const dayIdx=DAYS_MON.indexOf(r.day);
              if(dayIdx>=0){
                const jsDay=dayIdx; // DAYS_MON is Sun-based, indexOf directly = jsDay (0=Sun,1=Mon,...,6=Sat)
                const rotaEntry=(rota[r.staff_id]||[]).find(d=>d.jsDay===jsDay);
                if(rotaEntry&&rotaEntry.rowId){
                  await db.from("rota").update({shift_type:"Off"}).eq("id",rotaEntry.rowId);
                  setRota(p=>({...p,[r.staff_id]:(p[r.staff_id]||[]).map(d=>d.jsDay===jsDay?{...d,type:"Off"}:d)}));
                }
              }
              t(`✓ Acknowledged — ${r.staff_name}'s ${r.day} shift set to Off`);
            }} style={{background:"none",border:"none",cursor:"pointer",fontSize:16}}>✓</button></div>)}</div>}
            {staff.map(s=>{const days=rota[s.id]||[];const conflicts=absConflicts(s.id);return(
              <div key={s.id} className="card">
                <div className="chead">
                  <div><div className="cname">👤 {s.name}</div><div className="csub">£{s.rate||"0"}/hr · Full £{s.shiftRate||"0"} · Night £{s.nightRate||"0"}</div></div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>setShareModal(s.id)} style={{background:"#DBEAFE",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",color:"#1E40AF"}}>📤 Share</button>
                  </div>
                </div>
                {conflicts.length>0&&<div className="warn"><div className="warn-t">⚠️ Absence Conflict</div><div className="warn-s">{conflicts.map(c=>`${dispDate(c.date,true)} (${c.period})`).join(", ")}</div></div>}
                {days.map((d,idx)=>(
                  <div key={idx} style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
                    <div style={{minWidth:56,fontSize:11,fontWeight:700}}><div style={{color:"#555"}}>{DAYS_MON[jsToMon(d.jsDay)]}</div><div style={{color:"#aaa",fontSize:10}}>{fmtDate(d.date)}</div></div>
                    <select className="inp sm" style={{flex:1}} value={d.type||"Off"} onChange={e=>setShift(s.id,idx,"type",e.target.value)}>{SHIFTS.map(o=><option key={o}>{o}</option>)}</select>
                    {d.type==="Custom"&&<><input type="time" className="inp time" value={d.customIn||""} onChange={e=>setShift(s.id,idx,"customIn",e.target.value)}/><span style={{fontSize:10,color:"#aaa"}}>–</span><input type="time" className="inp time" value={d.customOut||""} onChange={e=>setShift(s.id,idx,"customOut",e.target.value)}/></>}
                  </div>
                ))}
                <button className="btn green" style={{marginTop:8,padding:"11px"}} onClick={()=>t(`✅ Rota saved for ${s.name}!`)}>📤 Send Rota to {s.name.split(" ")[0]}</button>
              </div>
            );})}

            {/* ── Push Full Rota ── */}
            {staff.length>0&&(
              <div className="card" style={{marginTop:10,background:"#1A1A2E",borderRadius:16}}>
                <div style={{fontSize:14,fontWeight:800,color:"#fff",marginBottom:4}}>📋 Push Full Week Rota</div>
                <div style={{fontSize:12,color:"rgba(255,255,255,.55)",marginBottom:12}}>Select the lead staff member who receives the full rota, then copy to clipboard to send via WhatsApp or message.</div>
                <select className="inp sm" style={{display:"block",width:"100%",marginBottom:10,background:"rgba(255,255,255,.1)",border:"1.5px solid rgba(255,255,255,.2)",color:"#fff"}} value={rotaRecipient} onChange={e=>setRotaRecipient(e.target.value)}>
                  <option value="" style={{color:"#000"}}>— Select recipient —</option>
                  {staff.map(s=><option key={s.id} value={s.id} style={{color:"#000"}}>{s.name}</option>)}
                </select>
                <button className="btn" style={{background:"#E8620A",color:"#1A1A2E",marginTop:0}} disabled={!rotaRecipient} onClick={()=>{
                  const text=buildFullRotaText(rotaRecipient);
                  navigator.clipboard.writeText(text)
                    .then(()=>t(`📋 Full rota copied for ${staff.find(s=>s.id===rotaRecipient)?.name?.split(" ")[0]}! Paste into WhatsApp or message.`))
                    .catch(()=>t("❌ Copy failed"));
                }}>
                  📋 Copy Full Rota{rotaRecipient?` for ${staff.find(s=>s.id===rotaRecipient)?.name?.split(" ")[0]}!`:""}
                </button>
              </div>
            )}
          </>
        )}

        {/* ══ CLOCK ══ */}
        {tab==="clock"&&(
          <>
            <div className="sec">Clock Logs</div>
            <div className="wnav">
              <button className="wnavbtn" onClick={()=>setClockDate(addDays(clockDate,-1))} disabled={clockShowAll}>‹</button>
              <div className="wnavlbl">{clockShowAll?"Showing all history":dispDate(clockDate,true)}</div>
              <button className="wnavbtn" onClick={()=>setClockDate(addDays(clockDate,1))} disabled={clockShowAll}>›</button>
            </div>
            <div style={{display:"flex",gap:6,marginBottom:14,alignItems:"center"}}>
              <input type="date" className="inp sm" style={{flex:1}} value={clockDate} onChange={e=>{setClockDate(e.target.value);setClockShowAll(false);}} disabled={clockShowAll}/>
              <button className="btn sm sec" onClick={()=>{setClockDate(todayISO());setClockShowAll(false);}}>Today</button>
              {gsConfig.clockLogId&&<button className="btn sm navy" onClick={()=>{pushClockLog(clockDate);t("⏳ Pushing clock log…");}}>📤 Push Clock Log</button>}
              <button className={`btn sm${clockShowAll?" navy":" sec"}`} onClick={()=>setClockShowAll(v=>!v)}>{clockShowAll?"✓ All Dates":"All Dates"}</button>
            </div>
            {staff.map(s=>{
              const sLogsAll=clockLogs.filter(l=>l.staff_id===s.id);
              const sLogs=clockShowAll?sLogsAll:sLogsAll.filter(l=>l.date===clockDate);
              const totalH=sLogs.reduce((a,l)=>a+parseHrs(l.time_in,l.time_out),0);
              return(
              <div key={s.id} className="card">
                <div className="cname">👤 {s.name}</div><div className="csub" style={{marginBottom:10}}>{clockShowAll?"All time":dispDate(clockDate,true)} total: {totalH.toFixed(2)} hrs</div>
                {sLogs.length===0&&<div style={{fontSize:12,color:"#ccc",fontStyle:"italic"}}>No records {clockShowAll?"yet":"for this date"}</div>}
                {sLogs.map(l=>(
                  <div key={l.id} className="logentry">
                    <div className="logtop">
                      <span style={{fontSize:13,fontWeight:700,color:"#1A1A2E"}}>{dispDate(l.date,true)}</span>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <span style={{fontSize:13,fontWeight:800,color:l.time_out?"#1A1A2E":"#50DC78"}}>{l.time_out?parseHrs(l.time_in,l.time_out).toFixed(2)+"h":"active"}</span>
                        <button onClick={async()=>{if(!window.confirm(`Delete this entry for ${s.name} on ${dispDate(l.date,true)}?`))return;const{error}=await db.from("clock_logs").delete().eq("id",l.id);if(!error){setClockLogs(p=>p.filter(x=>x.id!==l.id));t("🗑️ Entry deleted");}else t("❌ "+error.message);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"#E05252",padding:"2px 4px"}}>🗑️</button>
                      </div>
                    </div>
                    {l.override_at&&<div style={{fontSize:10,color:"#aaa",marginBottom:3}}>✏️ Edited by manager {new Date(l.override_at).toLocaleDateString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>}
                    <div className="logedit">
                      <span className="logelbl">In</span>
                      <input type="time" className="inp time" value={l.time_in||""} onChange={e=>{const v=e.target.value;setClockLogs(p=>p.map(x=>x.id===l.id?{...x,time_in:v}:x));}} onBlur={e=>{const v=e.target.value;const oa=new Date().toISOString();db.from("clock_logs").update({time_in:v,override_at:oa}).eq("id",l.id);setClockLogs(p=>p.map(x=>x.id===l.id?{...x,time_in:v,override_at:oa}:x));}}/>
                      <span className="logelbl">Out</span>
                      <input type="time" className="inp time" value={l.time_out||""} onChange={e=>{const v=e.target.value;setClockLogs(p=>p.map(x=>x.id===l.id?{...x,time_out:v}:x));}} onBlur={e=>{const v=e.target.value;const oa=new Date().toISOString();db.from("clock_logs").update({time_out:v,override_at:oa}).eq("id",l.id);setClockLogs(p=>p.map(x=>x.id===l.id?{...x,time_out:v,override_at:oa}:x));}}/>
                    </div>
                    <select className="lognote" style={{marginBottom:4}} value={l.note||""} onChange={e=>{const v=e.target.value;const oa=new Date().toISOString();setClockLogs(p=>p.map(x=>x.id===l.id?{...x,note:v,override_at:oa}:x));db.from("clock_logs").update({note:v,override_at:oa}).eq("id",l.id);}}>
                      <option value="">— No note —</option>
                      <option value="forgot">Forgot to clock out</option>
                      <option value="left_early">Left early / came in late</option>
                      <option value="overtime">Working extra time</option>
                      <option value="sick_leave">Sick leave (full shift)</option>
                      <option value="back-stamped">Back-stamped (forgot to clock in)</option>
                      <option value="custom">Custom…</option>
                    </select>
                    {l.note==="custom"&&<textarea className="lognote" rows={1} placeholder="Custom note…" value={l.customNote||""} onChange={e=>{const v=e.target.value;setClockLogs(p=>p.map(x=>x.id===l.id?{...x,customNote:v}:x));db.from("clock_logs").update({note:"custom:"+v}).eq("id",l.id);}}/> }
                  </div>
                ))}
                <button className="btn sm" style={{marginTop:9,background:"#E8620A"}} onClick={async()=>{const dateForEntry=clockShowAll?todayISO():clockDate;const{data,error}=await db.from("clock_logs").insert({staff_id:s.id,staff_name:s.name,date:dateForEntry,time_in:"",time_out:"",note:""}).select().single();if(!error)setClockLogs(p=>[data,...p]);else t("❌ "+error.message);}}>+ Add Entry {clockShowAll?"":`for ${dispDate(clockDate)}`}</button>
              </div>
            );})}

            {/* ── Weekly Clock Summary ── */}
            <div style={{marginTop:16}}>
              <div className="sec">📊 Weekly Clock Summary</div>
              <div style={{fontSize:12,color:"#888",marginBottom:10}}>Week of {fmtDate(snapToSunday(clockDate))} – {fmtDate(addDays(snapToSunday(clockDate),6))}</div>
              {staff.map(s=>{
                const ws=snapToSunday(clockDate);const we=addDays(ws,6);
                const sLogs=clockLogs.filter(l=>l.staff_id===s.id&&l.date>=ws&&l.date<=we);
                const hasOvertime=sLogs.some(l=>l.note==="overtime"||(l.note||"").includes("overtime"));
                const hasSick=sLogs.some(l=>l.note==="sick_leave"||(l.note||"").includes("sick_leave"));
                const hasLate=sLogs.some(l=>{
                  const dayRota=(rota[s.id]||[]).find(d=>d.date===l.date);
                  if(!dayRota||!dayRota.customIn)return false;
                  const[sH,sM]=dayRota.customIn.split(":").map(Number);
                  const[lH,lM]=(l.time_in||"00:00").split(":").map(Number);
                  return(lH*60+lM)-(sH*60+sM)>10;
                });
                const leftEarlyLogs=sLogs.filter(l=>l.note==="left_early"||(l.note||"").includes("left_early"));
                const hasLeftEarly=leftEarlyLogs.length>0;
                // Calculate total lost hours for left_early entries
                const lostHrs=r2(leftEarlyLogs.reduce((acc,l)=>{
                  const dayRota=(rota[s.id]||[]).find(d=>d.date===l.date);
                  if(!dayRota||!l.time_out)return acc;
                  let schedEnd=null;
                  if(dayRota.type==="Full Day (11am–close)")schedEnd="23:00";
                  else if(dayRota.type==="Night (5:30pm–close)")schedEnd="23:00";
                  else if(dayRota.type==="Custom"&&dayRota.customOut)schedEnd=dayRota.customOut;
                  if(!schedEnd)return acc;
                  const[eH,eM]=schedEnd.split(":").map(Number);
                  const[oH,oM]=l.time_out.split(":").map(Number);
                  const diffMins=(eH*60+eM)-(oH*60+oM);
                  return acc+(diffMins>0?roundHrs025(diffMins/60):0);
                },0));
                const hasFlag=hasOvertime||hasSick||hasLate||hasLeftEarly;
                const dailyRaw={};
                sLogs.forEach(l=>{dailyRaw[l.date]=(dailyRaw[l.date]||0)+parseHrs(l.time_in,l.time_out);});
                const clockHrs=r2(Object.values(dailyRaw).reduce((a,h)=>a+roundHrsUp(h),0));
                const autoFull=(rota[s.id]||[]).filter(sh=>sh?.type==="Full Day (11am–close)"&&sh.date>=ws&&sh.date<=we).length;
                const autoNight=(rota[s.id]||[]).filter(sh=>sh?.type==="Night (5:30pm–close)"&&sh.date>=ws&&sh.date<=we).length;
                const dots=[-3,-2,-1,0].map(wOffset=>{
                  const w=addDays(ws,wOffset*7);const wE=addDays(w,6);
                  const wLogs=clockLogs.filter(l=>l.staff_id===s.id&&l.date>=w&&l.date<=wE);
                  if(!wLogs.length)return"⬜";
                  const anyLate=wLogs.some(l=>{const dr=(rota[s.id]||[]).find(d=>d.date===l.date);if(!dr||!dr.customIn)return false;const[sh,sm]=dr.customIn.split(":").map(Number);const[lh,lm]=(l.time_in||"00:00").split(":").map(Number);return(lh*60+lm)-(sh*60+sm)>20;});
                  const slight=wLogs.some(l=>{const dr=(rota[s.id]||[]).find(d=>d.date===l.date);if(!dr||!dr.customIn)return false;const[sh,sm]=dr.customIn.split(":").map(Number);const[lh,lm]=(l.time_in||"00:00").split(":").map(Number);const d=(lh*60+lm)-(sh*60+sm);return d>10&&d<=20;});
                  return anyLate?"🔴":slight?"🟡":"🟢";
                });
                return(
                  <div key={s.id} style={{background:"#FFF5EF",borderRadius:12,padding:"11px 13px",marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <div style={{fontSize:14,fontWeight:800,color:"#1A1A2E"}}>{s.name}{hasFlag&&" ⚠️"}</div>
                      <div style={{fontSize:12}}>{dots.join(" ")}</div>
                    </div>
                    <div style={{fontSize:12,color:"#555",marginBottom:6}}>
                      {hasOvertime&&<span style={{background:"#FEF3C7",color:"#78350F",padding:"2px 7px",borderRadius:20,marginRight:5,fontSize:11}}>Overtime</span>}
                      {hasSick&&<span style={{background:"#FEE2E2",color:"#7F1D1D",padding:"2px 7px",borderRadius:20,marginRight:5,fontSize:11}}>Sick</span>}
                      {hasLate&&<span style={{background:"#FEE2E2",color:"#7F1D1D",padding:"2px 7px",borderRadius:20,marginRight:5,fontSize:11}}>Late</span>}
                      {hasLeftEarly&&<span style={{background:"#DBEAFE",color:"#1E40AF",padding:"2px 7px",borderRadius:20,marginLeft:5,fontSize:11}}>Left Early{lostHrs>0?` (-${lostHrs}h)`:""}</span>}
                    </div>
                    <div style={{fontSize:12,color:"#888",marginBottom:8}}>Clock hours: <strong>{clockHrs}h</strong>{autoFull>0&&<span> · Rota: <strong>{autoFull}F {autoNight}N shifts</strong></span>}</div>
                    <button className="btn sm" style={{background:"#E8620A",color:"#fff"}} onClick={()=>{
                      // Only authorise if the clock summary week matches the payroll page week range
                      if(ws!==weekRange.start){
                        t(`⚠️ Payroll is set to week of ${fmtDate(weekRange.start)} but you're viewing clock data for ${fmtDate(ws)}. Switch payroll to the same week first.`);
                        return;
                      }
                      const hasShiftRate=parseFloat(s.shiftRate||0)>0;
                      setExtras(p=>{
                        const ex=p[s.id]||getExtras(s.id);
                        const updated={...ex};
                        if(!hasShiftRate){if(!ex.manualHrs||ex.manualHrs==="")updated.manualHrs=String(clockHrs);}
                        else{if(!ex.manualFull||ex.manualFull==="")updated.manualFull=String(autoFull);if(!ex.manualNight||ex.manualNight==="")updated.manualNight=String(autoNight);}
                        return{...p,[s.id]:updated};
                      });
                      t(`✅ ${s.name.split(" ")[0]} authorised for week of ${fmtDate(ws)} → check payroll card`);
                    }}>✓ Authorise → Payroll</button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ══ PAYROLL ══ */}
        {tab==="payroll"&&(
          <>
            <div className="sec">Payroll</div>
            <div className="ssub">Private — staff never see salaries</div>
            <div style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
              <input type="date" className="inp sm" style={{flex:1}} value={weekRange.start} onChange={e=>{const s=snapToSunday(e.target.value);setWeekRange({start:s,end:addDays(s,6)});setPayrollLoaded(false);}}/>
              <span style={{fontSize:12,color:"#aaa"}}>→</span>
              <input type="date" className="inp sm" style={{flex:1}} value={weekRange.end} onChange={e=>setWeekRange(p=>({...p,end:e.target.value}))}/>
              <button className="btn sm navy" onClick={async()=>{
                t("⏳ Loading week data…");
                const{data}=await db.from("payroll_extras").select("*").eq("week_start",weekRange.start);
                if(data&&data.length){
                  const em={};
                  data.forEach(e=>{em[e.staff_id]={tips:e.tips,additions:e.additions||[],deductions:e.deductions||[],notes:e.notes||[],manualFull:e.manual_full||"",manualNight:e.manual_night||"",manualHrs:e.manual_hrs||"",manualCash:e.manual_cash||"",manualCard:e.manual_card||"",manualTotal:e.manual_total||"",extraTime:e.extra_time||"",id:e.id,ws:e.week_start};});
                  setExtras(em);
                  t("✅ Loaded data for "+data.length+" staff");
                }else{
                  setExtras({});
                  t("No saved data for this week — cards cleared");
                }
                setPayrollLoaded(true);
              }}>Load</button>
            </div>
            <div style={{fontSize:11,color:"#888",marginBottom:8}}>Pick the week start (Sunday), tap Load to fill cards, make edits, then Push.</div>
            {getWeekAlerts(weekRange.start).map((a,i)=><div key={i} style={{background:a.type==="bh"?"#FEF3C7":"#EFF6FF",border:`1.5px solid ${a.type==="bh"?"#F59E0B":"#BFDBFE"}`,borderRadius:10,padding:"8px 12px",marginBottom:8,fontSize:13,color:a.type==="bh"?"#78350F":"#1E40AF"}}>{a.type==="bh"?"⚠️":"📅"} {a.label}</div>)}
            <div style={{fontSize:13,fontWeight:800,color:"#1A1A2E",marginBottom:8}}>Front of House</div>
            {staff.map(s=><PayrollCard key={s.id+'-'+clearKey} name={s.name} icon="👤" sid={s.id} payType={s.payType} rate={s.rate} shiftRate={s.shiftRate} nightRate={s.nightRate} calcFn={()=>calcPay(s)} isKitchen={false} cardMode={s.cardMode||"fixed"} cardFixed={s.cardFixed} staffId={s.id}/>)}
            <div style={{fontSize:13,fontWeight:800,color:"#1A1A2E",margin:"14px 0 8px"}}>Kitchen Staff</div>
            <div style={{display:"flex",gap:6,marginBottom:10}}>
              <input className="inp sm" style={{flex:1}} placeholder="Add kitchen staff name…" value={newKName} onChange={e=>setNewKName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addKitchen()}/>
              <button className="btn sm navy" onClick={addKitchen}>Add</button>
            </div>
            {kitchenStaff.length===0&&<div style={{fontSize:13,color:"#ccc",marginBottom:10,fontStyle:"italic"}}>No kitchen staff yet — add via Staff tab</div>}
            {kitchenStaff.map(k=><PayrollCard key={k.id+'-'+clearKey} name={k.name} icon="👨‍🍳" sid={kId(k.id)} payType={k.payType||"hourly"} rate={k.rate} shiftRate={k.shiftRate} nightRate={k.nightRate} calcFn={()=>calcKitchenPay(k)} isKitchen={true} kitchenId={k.id} cardMode={k.cardMode||"fixed"} cardFixed={k.cardFixed}/>)}
            <div className="psum">
              <div className="psumtitle">Week Summary — {fmtRange(weekRange.start,weekRange.end)}</div>
              <div className="psumrow"><span>💵 Total Cash</span><span className="psumamt">£{totCash}</span></div>
              <div className="psumrow"><span>💳 Total Card</span><span className="psumamt">£{totCard}</span></div>
              <div className="psumrow"><span>💳 FH Tips (card)</span><span className="psumamt">£{payTotals().fhTips}</span></div>
              <div className="psumrow"><span>Grand Total (salary)</span><span className="psumamt">£{totGross}</span></div>
            </div>
            <div className="expsec">
              <div className="exptitle">📤 Export Payroll</div>
              {!gsReady&&<div className="gs-banner">⚠️ <strong>Google Sheets not connected.</strong> Tap ⚙️ Sheets in header.</div>}
              <div style={{fontSize:12,color:"#888",marginBottom:10,lineHeight:1.6}}>
                Edit the counts and amounts in the cards above, then push. After a successful push the page clears for the next week.<br/>
                To reload saved data for a week: change the start date — the cards will auto-fill from what's stored.
              </div>
              <button className="expbtn p" onClick={exportPayroll}>🔗 Push to Payroll Sheet (Staff + Weekly tabs)</button>
              <button className="expbtn s" onClick={()=>copyTSV(buildPayroll(),t)}>📋 Copy Staff Data</button>
              <button className="expbtn s" onClick={()=>copyTSV(buildPayrollWeekly(),t)}>📋 Copy Weekly Summary</button>
              <button className="expbtn s" onClick={()=>setCashPopup(true)}>💵 View Cash Payments</button>
              <div style={{borderTop:"1px dashed #E5E5E5",marginTop:10,paddingTop:10}}>
                <div style={{fontSize:12,fontWeight:700,color:"#1A1A2E",marginBottom:6}}>📅 Monthly Payroll</div>
                <div style={{fontSize:11,color:"#888",marginBottom:8}}>Selects all weeks whose Saturday (pay-end date) falls within this month.</div>
                <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                  <input type="month" className="inp sm" style={{flex:1}} value={payrollMonth} onChange={e=>setPayrollMonth(e.target.value)}/>
                </div>
                <button className="expbtn p" style={{background:"#2C3E6B"}} onClick={exportPayrollMonthly}>🔗 Push to PayrollMonthly Tab</button>
              </div>
            </div>
          </>
        )}

        {/* ══ TAKINGS ══ */}
        {tab==="takings"&&(
          <TakingsTab
            staff={staff} takings={takings} setTakings={setTakings}
            expenses={expenses} takingDefaults={takingDefaults} todayOverride={todayOverride}
            saveTakingDefault={saveTakingDefault} saveTodayOverride={saveTodayOverride}
            effectiveTodayPerson={effectiveTodayPerson} todayDow={todayDow}
            staffAssignedDays={staffAssignedDays}
            gsReady={gsReady} gsConfig={gsConfig}
            buildDaily={buildDaily} buildWeekly={buildWeekly}
            autoPushDay={autoPushDay} upsertTakings={upsertTakings}
            exportTakings={exportTakings} copyTSV={copyTSV} toast={t}
          />
        )}

        {/* ══ EXPENSES ══ */}
        {tab==="expenses"&&<ExpensesTab expenses={expenses} onAdd={addExpense} onDelete={delExpense} onUpdate={updateExpense} toast={t} gsReady={gsReady} gsConfig={gsConfig} buildDaily={buildDaily} buildWeekly={buildWeekly} exportTakings={exportTakings} exportExpensesOnly={exportExpensesOnly}/>}

        {/* ══ ABSENCES ══ */}
        {tab==="absence"&&(
          <>
            <div className="sec">Absences</div>
            <button className="btn navy" style={{marginBottom:14}} onClick={()=>{setAbsModal(true);setAbsStaff("");setAbsDate("");setAbsPeriod("");}}>+ Log Absence for Staff</button>
            {absences.length===0?<div className="empty"><div className="emptyicon">📅</div><div className="emptytxt">No absences reported</div></div>
              :absences.map(a=><div key={a.id} style={{background:"#FFF8EC",border:"1.5px solid #E8620A",borderRadius:12,padding:"10px 13px",marginBottom:9,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontWeight:800,color:"#1A1A2E",fontSize:13}}>👤 {a.staff_name}</div><div style={{fontSize:12,color:"#888",marginTop:2}}>{dispDate(a.date,true)} — {a.period}</div></div><button onClick={async()=>{await db.from("absences").delete().eq("id",a.id);setAbsences(p=>p.filter(x=>x.id!==a.id));}} style={{background:"none",border:"none",cursor:"pointer",fontSize:15,color:"#ccc"}}>🗑️</button></div>)}
          </>
        )}
      </div>

      {/* Modals */}
      {addStaffModal&&<AddStaffModal onClose={()=>setAddStaffModal(false)}/>}
      {pinModal&&<PinModal onClose={()=>setPinModal(false)}/>}
      {settingsModal&&<SettingsModal onClose={()=>setSettingsModal(false)}/>}

      {cardWarning&&(
        <div className="overlay" onClick={()=>setCardWarning(null)}>
          <div className="sheet" onClick={e=>e.stopPropagation()}>
            <div className="stitle">⚠️ Card Amount Too High</div>
            <div className="ssub2">{cardWarning.name}'s fixed card payment is more than they earned</div>
            <div style={{background:"#FEE2E2",border:"1.5px solid #E05252",borderRadius:10,padding:"12px 14px",marginBottom:16}}>
              <div style={{fontSize:13,color:"#7F1D1D",lineHeight:1.7}}>
                You entered a fixed card amount of <strong>£{cardWarning.entered}</strong>, but {cardWarning.name} only earned <strong>£{cardWarning.total}</strong> this week.<br/><br/>
                Please go back and correct the fixed amount — it should never be more than the total earned.
              </div>
            </div>
            <button className="btn" onClick={()=>{const el=document.getElementById(cardWarning.focusId);setCardWarning(null);setTimeout(()=>{el?.focus();el?.select?.();el?.scrollIntoView({behavior:"smooth",block:"center"});},50);}}>Edit Fixed Amount Now</button>
            <button className="btn sec" onClick={()=>setCardWarning(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {cashPopup&&<div className="overlay" onClick={()=>setCashPopup(false)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">💵 Cash Payments</div><div className="ssub2">{fmtRange(weekRange.start,weekRange.end)}</div>{staff.filter(s=>parseFloat(calcPay(s).cashAmt)>0).map(s=>{const p=calcPay(s);return<div key={s.id} className="cashrow"><span className="cashname">{s.name}</span><span className="cashamt">£{p.cashAmt}</span></div>;})}  {kitchenStaff.filter(k=>parseFloat(calcKitchenPay(k).cashAmt)>0).map(k=>{const p=calcKitchenPay(k);return<div key={k.id} className="cashrow"><span className="cashname">👨‍🍳 {k.name}</span><span className="cashamt">£{p.cashAmt}</span></div>;})} <div style={{borderTop:"2px solid #F0F0F0",marginTop:10,paddingTop:10,display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:800,color:"#1A1A2E"}}><span>Total Cash Out</span><span>£{totCash}</span></div><button className="btn sec" style={{marginTop:14}} onClick={()=>setCashPopup(false)}>Close</button></div></div>}
      {shareModal&&<div className="overlay" onClick={()=>setShareModal(null)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">📤 Share Rota</div><div className="ssub2">{staff.find(s=>s.id===shareModal)?.name}</div><textarea className="lognote" rows={12} readOnly style={{fontFamily:"monospace",fontSize:12,background:"#FFF5EF"}} value={buildRotaText(shareModal)}/><button className="btn" style={{marginTop:12}} onClick={()=>{navigator.clipboard.writeText(buildRotaText(shareModal)).then(()=>t("📋 Copied!"));setShareModal(null);}}>📋 Copy</button><button className="btn sec" onClick={()=>setShareModal(null)}>Close</button></div></div>}
        {/* ══ KPI ══ */}
        {tab==="kpi"&&(()=>{
          // All state at ManagerApp top level (no hooks violation)
          function weekKPI(ws){
            const we=addDays(ws,6);
            const wTakings=takings.filter(t=>t.date>=ws&&t.date<=we);
            const totalTakings=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.deliveroo||0)+parseFloat(t2.uber||0)+parseFloat(t2.cash||0)+parseFloat(t2.card||0)+parseFloat(t2.online||0),0));
            let totalWages=0;
            staff.forEach(s=>{const ex2=extras[s.id];if(ex2&&ex2.ws===ws){totalWages+=parseFloat(calcPay(s).total||0);}});
            kitchenStaff.forEach(k=>{const ex2=extras[kId(k.id)];if(ex2&&ex2.ws===ws){totalWages+=parseFloat(calcKitchenPay(k).total||0);}});
            totalWages=r2(totalWages);
            const labourPct=totalTakings>0?r2(totalWages/totalTakings*100):0;
            const wTips=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.tips_cash||0)+parseFloat(t2.tips_card||0),0));
            const wDeliveroo=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.deliveroo||0),0));
            const wUber=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.uber||0),0));
            const wCash=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.cash||0),0));
            const wCard=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.card||0),0));
            const wOnline=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.online||0),0));
            const wShopExp=r2(wTakings.reduce((a,t2)=>a+parseFloat(t2.shop_expense||0),0));
            return{ws,we,takings:totalTakings,wages:totalWages,labour:labourPct,tips:wTips,deliveroo:wDeliveroo,uber:wUber,cash:wCash,card:wCard,online:wOnline,shopExp:wShopExp};
          }
          // Build weeks array based on range setting
          function buildWeeks(){
            if(kpiRange==="custom"){
              const weeks=[];let cur=snapToSunday(kpiCustomStart);
              while(cur<=kpiCustomEnd){weeks.push(cur);cur=addDays(cur,7);}
              return weeks;
            }
            const n=parseInt(kpiRange)||8;
            const weeks=[];
            for(let i=n-1;i>=0;i--){weeks.push(snapToSunday(addDays(kpiWeek,-i*7)));}
            return weeks;
          }
          const weeks=buildWeeks();
          const mainData=weeks.map(ws=>({...weekKPI(ws),label:fmtDate(ws).slice(0,5)}));

          // Comparison series
          function buildCompareData(){
            if(kpiCompare==="none")return null;
            if(kpiCompare==="prevPeriod"){
              const offset=weeks.length*7;
              return weeks.map((ws,i)=>({...weekKPI(addDays(ws,-offset)),label:mainData[i].label}));
            }
            if(kpiCompare==="prevYear"){
              return weeks.map((ws,i)=>({...weekKPI(addDays(ws,-364)),label:mainData[i].label}));
            }
            if(kpiCompare==="thisMonthAvg"||kpiCompare==="prevMonthAvg"){
              const now=new Date(todayISO()+"T12:00:00");
              const mo=kpiCompare==="thisMonthAvg"?now.getMonth():now.getMonth()-1;
              const yr=kpiCompare==="thisMonthAvg"?now.getFullYear():(mo<0?now.getFullYear()-1:now.getFullYear());
              const mStart=new Date(yr,((mo+12)%12),1).toISOString().split("T")[0];
              const mEnd=new Date(yr,((mo+12)%12)+1,0).toISOString().split("T")[0];
              const mTakings=takings.filter(t=>t.date>=mStart&&t.date<=mEnd);
              const mWeeks=mTakings.length>0?Math.ceil((new Date(mEnd)-new Date(mStart))/(7*86400000)):1;
              const avgTakings=r2(mTakings.reduce((a,t2)=>a+parseFloat(t2.deliveroo||0)+parseFloat(t2.uber||0)+parseFloat(t2.cash||0)+parseFloat(t2.card||0)+parseFloat(t2.online||0),0)/mWeeks);
              return weeks.map((_,i)=>({takings:avgTakings,wages:0,labour:0,tips:0,label:mainData[i].label}));
            }
            return null;
          }
          const compareData=buildCompareData();

          // Stats bar
          function stats(arr,key){
            const vals=arr.map(d=>d[key]).filter(v=>v>0);
            if(!vals.length)return{avg:0,max:0,min:0,trend:"→"};
            const avg=r2(vals.reduce((a,v)=>a+v,0)/vals.length);
            const max=Math.max(...vals);const min=Math.min(...vals);
            const trend=vals.length>1?(vals[vals.length-1]>vals[0]?"↑":"↓"):"→";
            return{avg,max,min,trend};
          }

          const METRIC_CFG={
            takings:{label:"Takings",color:"#E8620A",fmt:v=>`£${v}`},
            wages:{label:"Wages",color:"#1A1A2E",fmt:v=>`£${v}`},
            labour:{label:"Labour %",color:"#F59E0B",fmt:v=>`${v}%`},
            tips:{label:"Tips",color:"#50DC78",fmt:v=>`£${v}`},
          };
          const activeMetrics=Object.keys(kpiMetrics).filter(k=>kpiMetrics[k]);
          const selected=weekKPI(kpiWeek);
          const alerts=getWeekAlerts(kpiWeek);

          // Simple SVG line chart (no recharts dependency issues)
          function LineChart({data,compareData,metrics}){
            const W=360,H=180,padL=36,padR=10,padT=10,padB=28;
            const chartW=W-padL-padR,chartH=H-padT-padB;
            if(!data.length)return<div style={{textAlign:"center",color:"#ccc",padding:20}}>No data</div>;
            // Compute y scale across all active metrics and both series
            let allVals=[];
            metrics.forEach(m=>{
              data.forEach(d=>{if(d[m]!=null)allVals.push(d[m]);});
              if(compareData)compareData.forEach(d=>{if(d[m]!=null)allVals.push(d[m]);});
            });
            const yMin=0,yMax=Math.max(...allVals,1)*1.15;
            const xStep=chartW/(Math.max(data.length-1,1));
            function px(i){return padL+i*xStep;}
            function py(v){return padT+chartH*(1-(v-yMin)/(yMax-yMin));}
            function makePath(series,key){
              return series.map((d,i)=>`${i===0?"M":"L"}${px(i).toFixed(1)},${py(d[key]||0).toFixed(1)}`).join(" ");
            }
            return(
              <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",overflow:"visible"}}>
                {/* Y grid lines */}
                {[0,.25,.5,.75,1].map(f=>{
                  const yv=yMin+(yMax-yMin)*f;
                  const y=py(yv);
                  return<g key={f}><line x1={padL} y1={y} x2={W-padR} y2={y} stroke="#F0F0F0" strokeWidth="1"/><text x={padL-3} y={y+4} textAnchor="end" fontSize="8" fill="#bbb">{yv>=1000?`${(yv/1000).toFixed(1)}k`:yv.toFixed(0)}</text></g>;
                })}
                {/* X labels */}
                {data.map((d,i)=>i%Math.ceil(data.length/5)===0&&<text key={i} x={px(i)} y={H-padB+16} textAnchor="middle" fontSize="8" fill="#bbb">{d.label}</text>)}
                {/* Main series lines */}
                {metrics.map(m=><path key={m} d={makePath(data,m)} fill="none" stroke={METRIC_CFG[m].color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>)}
                {/* Compare series (dashed) */}
                {compareData&&metrics.map(m=><path key={"c"+m} d={makePath(compareData,m)} fill="none" stroke={METRIC_CFG[m].color} strokeWidth="1.5" strokeDasharray="4 3" opacity="0.5"/>)}
                {/* Dots on main series */}
                {metrics.map(m=>data.map((d,i)=><circle key={m+i} cx={px(i)} cy={py(d[m]||0)} r="3" fill={METRIC_CFG[m].color}/>))}
              </svg>
            );
          }

          return(
            <div className="mbody">
              <div className="sec">📈 KPI Dashboard</div>

              {/* Week selector */}
              <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:10}}>
                <button className="btn sm sec" style={{padding:"6px 10px"}} onClick={()=>setKpiWeek(snapToSunday(addDays(kpiWeek,-7)))}>‹</button>
                <span style={{flex:1,textAlign:"center",fontSize:12,fontWeight:700,color:"#888"}}>{fmtDate(kpiWeek)} – {fmtDate(addDays(kpiWeek,6))}</span>
                <button className="btn sm sec" style={{padding:"6px 10px"}} onClick={()=>setKpiWeek(snapToSunday(addDays(kpiWeek,7)))}>›</button>
              </div>

              {/* Alerts */}
              {alerts.map((a,i)=><div key={i} style={{background:a.type==="bh"?"#FEF3C7":"#EFF6FF",border:`1.5px solid ${a.type==="bh"?"#F59E0B":"#BFDBFE"}`,borderRadius:9,padding:"7px 11px",marginBottom:6,fontSize:12,color:a.type==="bh"?"#78350F":"#1E40AF"}}>{a.type==="bh"?"⚠️":"📅"} {a.label}</div>)}

              {/* KPI metric cards */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                {Object.entries(METRIC_CFG).map(([k,cfg])=>{
                  const v=selected[k];
                  const s=stats(mainData,k);
                  return(<div key={k} style={{background:kpiMetrics[k]?"#FFF5EF":"#F8F8F8",borderRadius:12,padding:"12px 11px",border:`1.5px solid ${kpiMetrics[k]?cfg.color:"#F0F0F0"}`,cursor:"pointer"}} onClick={()=>setKpiMetrics(p=>({...p,[k]:!p[k]}))}>
                    <div style={{fontSize:11,color:"#aaa",marginBottom:2}}>{cfg.label} {kpiMetrics[k]?"✓":""}</div>
                    <div style={{fontSize:20,fontWeight:900,color:k==="labour"?(v>35?"#E05252":v>28?"#F59E0B":"#50DC78"):cfg.color}}>{cfg.fmt(v)}</div>
                    <div style={{fontSize:10,color:"#bbb",marginTop:2}}>avg {cfg.fmt(s.avg)} {s.trend}</div>
                  </div>);
                })}
              </div>

              {/* Chart controls */}
              <div style={{background:"#FFF5EF",borderRadius:12,padding:"11px 12px",marginBottom:12}}>
                <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,fontWeight:700,color:"#888",marginRight:2}}>RANGE</span>
                  {[["1","1wk"],["4","4wk"],["8","8wk"],["12","12wk"],["custom","Custom"]].map(([v,lbl])=>(
                    <button key={v} className={`tgl${kpiRange===v?" on":""}`} style={{padding:"5px 9px",fontSize:11}} onClick={()=>setKpiRange(v)}>{lbl}</button>
                  ))}
                </div>
                {kpiRange==="custom"&&<div style={{display:"flex",gap:6,marginBottom:8,alignItems:"center"}}>
                  <input type="date" className="inp sm" style={{flex:1}} value={kpiCustomStart} onChange={e=>setKpiCustomStart(snapToSunday(e.target.value))}/>
                  <span style={{fontSize:12,color:"#888"}}>to</span>
                  <input type="date" className="inp sm" style={{flex:1}} value={kpiCustomEnd} onChange={e=>setKpiCustomEnd(snapToSunday(e.target.value))}/>
                </div>}
                <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                  <span style={{fontSize:11,fontWeight:700,color:"#888",marginRight:2}}>COMPARE</span>
                  {[["none","None"],["prevPeriod","Prev period"],["prevYear","Same wk last yr"],["thisMonthAvg","This mo. avg"],["prevMonthAvg","Prev mo. avg"]].map(([v,lbl])=>(
                    <button key={v} className={`tgl${kpiCompare===v?" on":""}`} style={{padding:"5px 9px",fontSize:11}} onClick={()=>setKpiCompare(v)}>{lbl}</button>
                  ))}
                </div>
              </div>

              {/* Line chart */}
              {activeMetrics.length>0&&<div style={{background:"#fff",borderRadius:12,padding:"12px 10px",marginBottom:12,border:"1.5px solid #F0F0F0"}}>
                <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:8}}>
                  {activeMetrics.map(m=><div key={m} style={{display:"flex",alignItems:"center",gap:4}}>
                    <div style={{width:16,height:3,background:METRIC_CFG[m].color,borderRadius:2}}/>
                    <span style={{fontSize:11,color:"#888"}}>{METRIC_CFG[m].label}</span>
                    {compareData&&<><div style={{width:12,height:2,background:METRIC_CFG[m].color,opacity:.5,borderRadius:2,marginLeft:4}}/><span style={{fontSize:10,color:"#ccc"}}>{kpiCompare==="prevPeriod"?"prev":kpiCompare==="prevYear"?"yr-1":"avg"}</span></>}
                  </div>)}
                </div>
                <LineChart data={mainData} compareData={compareData} metrics={activeMetrics}/>
              </div>}

              {/* Channel Breakdown */}
              {(()=>{
                const tot=selected.takings;
                if(tot<=0)return null;
                const channels=[
                  {label:"Deliveroo",val:selected.deliveroo,color:"#00A6A6"},
                  {label:"Uber Eats",val:selected.uber,color:"#06C167"},
                  {label:"Cash",val:selected.cash,color:"#50DC78"},
                  {label:"Card",val:selected.card,color:"#3B82F6"},
                  {label:"Online",val:selected.online,color:"#8B5CF6"},
                  {label:"Shop Expenses",val:selected.shopExp,color:"#E05252",deduct:true},
                ];
                return(<div style={{background:"#FFF5EF",borderRadius:12,padding:"12px 13px",marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:800,color:"#888",marginBottom:10}}>📊 Revenue Channels — week of {fmtDate(kpiWeek)}</div>
                  {channels.filter(c=>c.val>0).map(c=>{
                    const pct=r2(c.val/tot*100);
                    return(<div key={c.label} style={{marginBottom:7}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
                        <span style={{fontWeight:700,color:c.deduct?"#E05252":"#555"}}>{c.label}{c.deduct?" (deducted)":""}</span>
                        <span style={{fontWeight:800,color:c.color}}>£{c.val} — {pct}%</span>
                      </div>
                      <div style={{background:"#F0F0F0",borderRadius:4,height:8,overflow:"hidden"}}>
                        <div style={{width:pct+"%",background:c.color,height:"100%",borderRadius:4,transition:"width .3s"}}/>
                      </div>
                    </div>);
                  })}
                </div>);
              })()}

              {/* Stats bar */}
              {activeMetrics.length>0&&<div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto"}}>
                {activeMetrics.map(m=>{const s=stats(mainData,m);return(<div key={m} style={{background:"#FFF5EF",borderRadius:10,padding:"8px 11px",minWidth:90,flex:1}}>
                  <div style={{fontSize:10,color:"#aaa",marginBottom:2}}>{METRIC_CFG[m].label}</div>
                  <div style={{fontSize:11,color:"#888"}}>↑ {METRIC_CFG[m].fmt(s.max)}</div>
                  <div style={{fontSize:11,color:"#888"}}>↓ {METRIC_CFG[m].fmt(s.min)}</div>
                  <div style={{fontSize:12,fontWeight:800,color:METRIC_CFG[m].color}}>⌀ {METRIC_CFG[m].fmt(s.avg)} {s.trend}</div>
                </div>);})}
              </div>}

              {/* Data table */}
              <div className="sec" style={{fontSize:13}}>Weekly Breakdown</div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead><tr style={{background:"#FFF5EF"}}>{["Week",...activeMetrics.map(m=>METRIC_CFG[m].label)].map(h=><th key={h} style={{padding:"6px 7px",textAlign:"left",fontWeight:700,color:"#888",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                  <tbody>{mainData.map((w,i)=><tr key={i} style={{borderBottom:"1px solid #F0F0F0",background:w.ws===kpiWeek?"#FFF5EF":"transparent"}}>
                    <td style={{padding:"6px 7px",whiteSpace:"nowrap",fontWeight:w.ws===kpiWeek?800:400}}>{w.label}</td>
                    {activeMetrics.map(m=><td key={m} style={{padding:"6px 7px",color:m==="labour"?(w[m]>35?"#E05252":w[m]>28?"#F59E0B":"#50DC78"):METRIC_CFG[m].color,fontWeight:700}}>{METRIC_CFG[m].fmt(w[m])}</td>)}
                  </tr>)}</tbody>
                </table>
              </div>
            </div>
          );
        })()}

      {absModal&&<div className="overlay" onClick={()=>setAbsModal(false)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">📅 Log Absence</div><label className="lbl">Staff Member</label><select className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} value={absStaff} onChange={e=>setAbsStaff(e.target.value)}><option value="">— Select —</option>{staff.length>0&&<optgroup label="Front of House">{staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}{kitchenStaff.length>0&&<optgroup label="Kitchen">{kitchenStaff.map(k=><option key={"k_"+k.id} value={"k_"+k.id}>{"👨‍🍳 "+k.name}</option>)}</optgroup>}</select><label className="lbl">Date</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} value={absDate} onChange={e=>setAbsDate(e.target.value)}/><label className="lbl" style={{marginBottom:8}}>Period</label><div className="peribtns">{["Morning","Evening","Full Day"].map(p=><button key={p} className={`pbtn${absPeriod===p?" sel":""}`} onClick={()=>setAbsPeriod(p)}>{p==="Morning"?"🌅":p==="Evening"?"🌙":"☀️"}<br/>{p}</button>)}</div><button className="btn" style={{marginTop:12}} onClick={async()=>{if(!absStaff||!absDate||!absPeriod)return t("Fill in all fields");const isKitchen=absStaff.startsWith("k_");const foundFoh=staff.find(x=>x.id===absStaff);const foundKit=kitchenStaff.find(x=>"k_"+x.id===absStaff);const personName=(foundFoh||foundKit)?.name||"";const{data,error}=await db.from("absences").insert({staff_id:absStaff,staff_name:personName,date:absDate,period:absPeriod}).select().single();if(!error){setAbsences(p=>[...p,data]);setAbsModal(false);t("📅 Absence logged");}else t("❌ "+error.message);}}>Save Absence</button><button className="btn sec" onClick={()=>setAbsModal(false)}>Cancel</button></div></div>}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// TAKINGS TAB (extracted for clarity)
// ═══════════════════════════════════════════════════════════════════
function TakingsTab({staff,takings,setTakings,expenses,takingDefaults,todayOverride,saveTakingDefault,saveTodayOverride,effectiveTodayPerson,todayDow,staffAssignedDays,gsReady,gsConfig,buildDaily,buildWeekly,autoPushDay,upsertTakings,exportTakings,copyTSV,toast}){
  const[editDate,setEditDate]=useState("");
  const[editMode,setEditMode]=useState(false);
  const pendingTakings=takings.filter(s=>s.is_new);

  async function markSeen(sub){
    const{error}=await db.from("takings").update({is_new:false}).eq("id",sub.id);
    if(!error){
      const freshTakings=takings.map(x=>x.id===sub.id?{...x,is_new:false}:x);
      setTakings(freshTakings);
      if(gsReady&&sub.staff_id!=="manager"){
        await autoPushDay(sub.date,freshTakings);
        toast("✅ Marked seen & pushed to Sheets");
      }else toast("✅ Marked as seen");
    }else toast("❌ "+error.message);
  }

  return(
    <>
      <div className="sec">Daily Takings</div>

      {/* Pending Review — unseen submissions */}
      {pendingTakings.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:800,color:"#E05252",marginBottom:8}}>
            🔔 Pending Review
            <span className="pending-badge">{pendingTakings.length}</span>
          </div>
          {pendingTakings.sort((a,b)=>b.date.localeCompare(a.date)).map(sub=>{
            const _dep=parseFloat(sub.deposit_receipt||0);const _vp=parseFloat(sub.voucher_purchase||0);
            const total=r2(parseFloat(sub.deliveroo||0)+parseFloat(sub.uber||0)+parseFloat(sub.cash||0)+parseFloat(sub.card||0)+parseFloat(sub.online||0)-parseFloat(sub.shop_expense||0)+_dep+_vp);
            return(
              <div key={sub.id} className="tmsg new">
                <div className="tmsg-h">🆕 {sub.staff_name} · {dispDate(sub.date,true)}<span style={{float:"right",fontSize:14,fontWeight:900}}>£{total.toFixed(2)}</span></div>
                <div className="tmsg-d">{TKFIELDS.filter(f=>parseFloat(sub[f.db]||0)>0).map(f=>`${f.label.replace(/[🛵💵💳🌐🎟️🎫]/g,"").trim()}: £${sub[f.db]}`).join(" · ")}</div>
                {sub.note&&<div style={{marginTop:4,fontSize:12,opacity:.8}}>📝 {sub.note}</div>}
                <button className="btn sm" style={{marginTop:8,background:"#065F46",color:"#fff"}} onClick={()=>markSeen(sub)}>
                  Mark Seen ✓ {gsReady?"& Push to Sheets":""}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Assignment */}
      <div className="card">
        <div className="cname" style={{marginBottom:4}}>📅 Who Records Takings</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Assign up to 2 staff. Each day can only have one person.</div>
        {staff.slice(0,2).map(s=>{
          const myDays=staffAssignedDays(s.id);
          return(
            <div key={s.id} style={{marginBottom:14,paddingBottom:14,borderBottom:"1px dashed #E5E5E5"}}>
              <div style={{fontSize:13,fontWeight:800,color:"#1A1A2E",marginBottom:8}}>👤 {s.name}</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {DAYS_MON.map((dayName,monIdx)=>{
                  const dow=monIdx===6?0:monIdx+1;
                  const isOn=takingDefaults[dow]===s.id;
                  const takenByOther=takingDefaults[dow]&&takingDefaults[dow]!==s.id;
                  return(<button key={dow} className={`day-tog${isOn?" on":""}`} disabled={takenByOther} title={takenByOther?`Assigned to ${staff.find(x=>x.id===takingDefaults[dow])?.name}`:""}
                    onClick={()=>saveTakingDefault(s.id,dow,!isOn)}>{dayName}</button>);
                })}
              </div>
              {myDays.length>0&&<div style={{fontSize:11,color:"#888",marginTop:6}}>Assigned: {myDays.map(dow=>DAYS_SUN[dow]).join(", ")}</div>}
            </div>
          );
        })}
      </div>

      {/* Today override */}
      <div className="card">
        <div className="cname" style={{marginBottom:4}}>🔄 Override for Today Only</div>
        <select className="inp sm" style={{display:"block",width:"100%",marginBottom:8}} value={todayOverride||""} onChange={e=>saveTodayOverride(e.target.value||null)}>
          <option value="">— Use day default —</option>
          {staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div style={{fontSize:12,color:"#888"}}>Today ({DAYS_SUN[todayDow]}): <strong>{staff.find(s=>s.id===effectiveTodayPerson)?.name||"Manager"}</strong></div>
      </div>


      {/* Manager entry / overwrite */}
      <div className="card" style={{marginTop:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div className="cname">✏️ {editMode?"Edit Existing Takings":"Enter Takings Manually"}</div>
          <button style={{background:editMode?"#FEE2E2":"#DBEAFE",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",color:editMode?"#7F1D1D":"#1E40AF"}} onClick={()=>setEditMode(v=>!v)}>
            {editMode?"+ New Entry":"✏️ Edit Existing"}
          </button>
        </div>
        {editMode?(
          <TakingsEditForm takings={takings} upsertTakings={upsertTakings} toast={toast} autoPushDay={autoPushDay} gsReady={gsReady}/>
        ):(
          <TakingsForm setTakings={setTakings} toast={toast}/>
        )}
      </div>

      <div className="expsec">
        <div className="exptitle">📤 Export Takings</div>
        {!gsReady&&<div className="gs-banner">⚠️ <strong>Google Sheets not connected.</strong> Tap ⚙️ Sheets in header.</div>}
        <button className="expbtn p" onClick={exportTakings}>🔗 Push to Takings Sheet (Daily + Weekly)</button>
        <button className="expbtn s" onClick={()=>copyTSV([...buildDaily(),[],[]], toast)}>📋 Copy Daily Data</button>
      </div>

      {/* Recent Takings — at bottom */}
      {takings.filter(s=>!s.is_new).length>0&&(
        <div style={{marginTop:10}}>
          <div style={{fontSize:13,fontWeight:800,color:"#1A1A2E",marginBottom:8}}>📋 Recent Takings (last 7)</div>
          {[...takings].filter(s=>!s.is_new).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7).map(sub=>{
            const _dep=parseFloat(sub.deposit_receipt||0);const _vp=parseFloat(sub.voucher_purchase||0);
            const total=r2(parseFloat(sub.deliveroo||0)+parseFloat(sub.uber||0)+parseFloat(sub.cash||0)+parseFloat(sub.card||0)+parseFloat(sub.online||0)-parseFloat(sub.shop_expense||0)+_dep+_vp);
            return(<div key={sub.id} className="tmsg"><div className="tmsg-h">{sub.staff_id==="manager"?"📝":"✓"} {sub.staff_name} · {dispDate(sub.date,true)}<span style={{float:"right",fontSize:14,fontWeight:900}}>£{total.toFixed(2)}</span></div><div className="tmsg-d">{TKFIELDS.filter(f=>parseFloat(sub[f.db]||0)>0).map(f=>`${f.label.replace(/[🛵💵💳🌐🎟️🎫🧾]/g,"").trim()}: £${sub[f.db]}`).join(" · ")}</div></div>);
          })}
        </div>
      )}
    </>
  );
}

// ── Takings edit existing form ──
function TakingsEditForm({takings,upsertTakings,toast,autoPushDay,gsReady}){
  const[date,setDate]=useState(todayISO());
  const[values,setValues]=useState({});const[cc,setCC]=useState({});const[note,setNote]=useState("");const[saving,setSaving]=useState(false);
  const[loaded,setLoaded]=useState(false);

  function loadForDate(d){
    // Load any taking for this date (staff or manager logged) — manager can edit either
    const existing=takings.find(s=>s.date===d);
    if(existing){const v={};TKFIELDS.forEach(f=>{const raw=parseFloat(existing[f.db]||0);v[f.key]=raw>0?String(r2(raw)):"";});const c={};TKFIELDS.filter(f=>f.ccDb).forEach(f=>{c[f.key]=existing[f.ccDb]||"cash";});setValues(v);setCC(c);setNote(existing.note||"");}
    else{setValues({});setCC({});setNote("");}
    setLoaded(true);
  }

  async function save(){
    setSaving(true);
    const vals={};TKFIELDS.forEach(f=>{vals[f.db]=parseFloat(values[f.key]||0);if(f.ccDb)vals[f.ccDb]=cc[f.key]||"cash";});
    const r=await upsertTakings(date,vals,note);
    if(r.ok){
      toast("✅ Takings updated!");
      if(gsReady&&autoPushDay){await autoPushDay(date,r.updatedTakings);toast("✅ Saved & pushed to Sheets");}
    }else toast("❌ "+r.err);
    setSaving(false);
  }

  const existingRecord=takings.find(s=>s.date===date);

  return(
    <>
      <div style={{fontSize:12,color:"#888",marginBottom:10}}>Select a date to edit or overwrite existing takings for that day.</div>
      <label className="lbl">Date</label>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <input type="date" className="inp sm" style={{flex:1}} value={date} onChange={e=>{setDate(e.target.value);setLoaded(false);}}/>
        <button className="btn sm navy" onClick={()=>loadForDate(date)}>Load</button>
      </div>
      {loaded&&<>
        <div style={{fontSize:12,color:existingRecord?"#065F46":"#888",fontWeight:700,marginBottom:10}}>
          {existingRecord?`✅ ${existingRecord.staff_name}'s record loaded — editing will overwrite`:"📝 No entry for this date — will create new"}
        </div>
        {TKFIELDS.map(f=><div key={f.key} className="tfield"><div className="tlbl"><span>{f.label}</span>{f.cc&&<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl${(cc[f.key]||"cash")===c?" on":""}`} onClick={()=>setCC(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>}</div>{f.hint&&<div className="thint">{f.hint}</div>}<input className="inp sm" style={{display:"block",width:"100%",marginTop:3}} type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" onKeyDown={e=>{if(["e","E","+","-"].includes(e.key))e.preventDefault();}} value={values[f.key]||""} onChange={e=>setValues(p=>({...p,[f.key]:e.target.value}))}/></div>)}
        <label className="lbl" style={{marginTop:8}}>Note</label>
        <textarea className="lognote" rows={2} style={{marginBottom:10}} placeholder="Any notes…" value={note} onChange={e=>setNote(e.target.value)}/>
        <button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Save / Overwrite"}</button>
      </>}
    </>
  );
}

// ── Takings new entry form ──
function TakingsForm({setTakings,toast}){
  const[values,setValues]=useState({});const[cc,setCC]=useState({});const[note,setNote]=useState("");const[date,setDate]=useState(todayISO());const[saving,setSaving]=useState(false);
  async function submit(){
    setSaving(true);const vals={};TKFIELDS.forEach(f=>{vals[f.db]=parseFloat(values[f.key]||0);if(f.ccDb)vals[f.ccDb]=cc[f.key]||"cash";});
    const{data,error}=await db.from("takings").insert({staff_id:"manager",staff_name:"Manager",date,...vals,note,is_new:false}).select().single();
    if(!error){setTakings(p=>[data,...p]);setValues({});setNote("");setDate(todayISO());toast("✅ Takings saved!");}else toast("❌ "+error.message);setSaving(false);
  }
  return(
    <>
      <label className="lbl">Date</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:12}} value={date} onChange={e=>setDate(e.target.value)}/>
      {TKFIELDS.map(f=><div key={f.key} className="tfield"><div className="tlbl"><span>{f.label}</span>{f.cc&&<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl${(cc[f.key]||"cash")===c?" on":""}`} onClick={()=>setCC(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>}</div>{f.hint&&<div className="thint">{f.hint}</div>}<input className="inp sm" style={{display:"block",width:"100%",marginTop:3}} type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" onKeyDown={e=>{if(["e","E","+","-"].includes(e.key))e.preventDefault();}} value={values[f.key]||""} onChange={e=>setValues(p=>({...p,[f.key]:e.target.value}))}/></div>)}
      <label className="lbl" style={{marginTop:8}}>Note</label><textarea className="lognote" rows={2} style={{marginBottom:10}} placeholder="Any notes…" value={note} onChange={e=>setNote(e.target.value)}/>
      <button className="btn" onClick={submit} disabled={saving}>{saving?"Saving…":"Save Takings"}</button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EXPENSES TAB
// ═══════════════════════════════════════════════════════════════════
function ExpensesTab({expenses,onAdd,onDelete,onUpdate,toast,gsReady,gsConfig,buildDaily,buildWeekly,exportTakings,exportExpensesOnly}){
  const[desc,setDesc]=useState("");const[amount,setAmount]=useState("");const[payType,setPayType]=useState("cash");const[date,setDate]=useState(todayISO());const[saving,setSaving]=useState(false);
  const[editMode,setEditMode]=useState(false);
  const[filterDate,setFilterDate]=useState(todayISO());
  const[editExpense,setEditExpense]=useState(null);

  async function add(){
    if(!desc||!amount)return toast("Fill in description and amount");
    setSaving(true);const{error}=await onAdd(desc,amount,payType,date);
    if(!error){setDesc("");setAmount("");toast("✓ Expense added");}else toast("❌ "+error.message);setSaving(false);
  }
  async function saveEdit(){
    if(!editExpense)return;setSaving(true);
    const{error}=await onUpdate(editExpense.id,{description:editExpense.description,amount:parseFloat(editExpense.amount),pay_type:editExpense.pay_type,date:editExpense.date});
    if(!error){setEditExpense(null);toast("✅ Expense updated");}else toast("❌ "+error.message);setSaving(false);
  }

  const filteredForEdit=expenses.filter(e=>e.date===filterDate);
  const total=expenses.reduce((a,e)=>a+e.amount,0);

  return(
    <>
      <div className="sec">Shop Expenses</div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:13,fontWeight:700,color:"#1A1A2E"}}>Add / Edit</div>
        <button style={{background:editMode?"#FEE2E2":"#DBEAFE",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",color:editMode?"#7F1D1D":"#1E40AF"}} onClick={()=>{setEditMode(v=>!v);setEditExpense(null);}}>
          {editMode?"+ Add New":"✏️ Edit Existing"}
        </button>
      </div>

      {!editMode?(
        <div className="card">
          <label className="lbl">Date</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:10}} value={date} onChange={e=>setDate(e.target.value)}/>
          <label className="lbl">Description</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:10}} placeholder="e.g. Cleaning supplies" value={desc} onChange={e=>setDesc(e.target.value)}/>
          <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"flex-end"}}>
            <div style={{flex:1}}><label className="lbl">Amount (£)</label><input className="inp sm" style={{width:"100%"}} type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" onKeyDown={e=>{if(["e","E","+","-"].includes(e.key))e.preventDefault();}} value={amount} onChange={e=>setAmount(e.target.value)}/></div>
            <div><label className="lbl">Paid by</label><div className="toggle">{["cash","card"].map(c=><button key={c} className={`tgl${payType===c?" on":""}`} onClick={()=>setPayType(c)}>{c==="cash"?"💵":"💳"} {c}</button>)}</div></div>
          </div>
          <button className="btn" onClick={add} disabled={saving}>{saving?"Adding…":"Add Expense"}</button>
        </div>
      ):(
        <div className="card">
          <div style={{fontSize:12,color:"#888",marginBottom:10}}>Select a date, then tap an expense to edit it.</div>
          <label className="lbl">Filter by Date</label>
          <input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:12}} value={filterDate} onChange={e=>{setFilterDate(e.target.value);setEditExpense(null);}}/>
          {filteredForEdit.length===0&&<div style={{fontSize:12,color:"#ccc",fontStyle:"italic"}}>No expenses on this date</div>}
          {filteredForEdit.map(e=>(
            <div key={e.id} style={{padding:"8px 0",borderBottom:"1px dashed #E5E5E5",cursor:"pointer"}} onClick={()=>setEditExpense({...e})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div><div style={{fontSize:13,fontWeight:700,color:editExpense?.id===e.id?"#E8620A":"#1A1A2E"}}>{e.description}</div><div style={{fontSize:11,color:"#aaa"}}>{e.pay_type==="cash"?"💵":"💳"} £{e.amount.toFixed(2)}</div></div>
                <span style={{fontSize:11,color:"#E8620A",fontWeight:700}}>{editExpense?.id===e.id?"editing ✏️":"tap to edit"}</span>
              </div>
            </div>
          ))}
          {editExpense&&(
            <div style={{marginTop:12,padding:"12px",background:"#FFF8EC",borderRadius:10,border:"1.5px solid #E8620A"}}>
              <div style={{fontSize:12,fontWeight:800,color:"#92400E",marginBottom:8}}>Editing: {editExpense.description}</div>
              <label className="lbl">Description</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:8}} value={editExpense.description} onChange={e=>setEditExpense(p=>({...p,description:e.target.value}))}/>
              <label className="lbl">Amount (£)</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:8}} type="number" min="0" value={editExpense.amount} onChange={e=>setEditExpense(p=>({...p,amount:e.target.value}))}/>
              <label className="lbl">Date</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:8}} value={editExpense.date} onChange={e=>setEditExpense(p=>({...p,date:e.target.value}))}/>
              <label className="lbl">Paid by</label><div className="toggle" style={{marginBottom:10}}>{["cash","card"].map(c=><button key={c} className={`tgl${editExpense.pay_type===c?" on":""}`} onClick={()=>setEditExpense(p=>({...p,pay_type:c}))}>{c==="cash"?"💵":"💳"} {c}</button>)}</div>
              <div style={{display:"flex",gap:8}}>
                <button className="btn" style={{flex:1,marginTop:0}} onClick={saveEdit} disabled={saving}>{saving?"Saving…":"Save Changes"}</button>
                <button className="btn danger" style={{flex:1,marginTop:0}} onClick={async()=>{await onDelete(editExpense.id);setEditExpense(null);toast("🗑️ Deleted");}}>Delete</button>
              </div>
            </div>
          )}
        </div>
      )}

      {expenses.length===0?<div className="empty"><div className="emptyicon">🧾</div><div className="emptytxt">No expenses yet</div></div>:(
        <>
          <div className="sec">Recent Expenses {expenses.length>10&&<span style={{fontSize:11,color:"#aaa",fontWeight:400}}>(showing 10 of {expenses.length})</span>}</div>
          {[...expenses].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10).map(e=>(
            <div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #F0F0F0"}}>
              <div><div style={{fontSize:13,fontWeight:700,color:"#1A1A2E"}}>{e.description}</div><div style={{fontSize:11,color:"#aaa"}}>{dispDate(e.date,true)} · {e.pay_type==="cash"?"💵 Cash":"💳 Card"}</div></div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}><div style={{fontSize:13,fontWeight:800,color:"#E05252"}}>-£{e.amount.toFixed(2)}</div><button onClick={()=>onDelete(e.id)} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"#ccc"}}>🗑️</button></div>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0 0",fontSize:14,fontWeight:800,color:"#1A1A2E",borderTop:"2px solid #F0F0F0",marginTop:4}}><span>Total</span><span>£{total.toFixed(2)}</span></div>
        </>
      )}
      <div className="expsec" style={{marginTop:14}}>
        <div className="exptitle">📤 Export to Takings Spreadsheet</div>
        <div style={{fontSize:12,color:"#888",marginBottom:10}}>Expenses (Other Expenses Cash, Other Expenses Card, Note) are included automatically in the Takings Daily and Weekly sheets whenever you export from the Takings page. Use the button below to push now with the latest expense data.</div>
        {!gsReady&&<div className="gs-banner">⚠️ <strong>Google Sheets not connected.</strong> Tap ⚙️ Sheets in the header.</div>}
        <button className="expbtn p" onClick={exportExpensesOnly}>🔗 Push Expenses to Takings Sheet</button>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════
export default function App(){
  const[screen,setScreen]=useState("role");
  const[user,setUser]=useState(null);
  const[allStaff,setAllStaff]=useState([]);
  const[loadingStaff,setLoadingStaff]=useState(false);
  const[effectiveTakingsPerson,setEffectiveTakingsPerson]=useState(null);

  useEffect(()=>{
    if(screen==="staffLogin"){
      setLoadingStaff(true);
      db.from("staff").select("id,name,code,rate,shift_rate,night_rate,card_mode,card_fixed,tips_pct").order("name").then(({data})=>{setAllStaff((data||[]).map(s=>({...s,rate:s.rate||"0",shiftRate:s.shift_rate||"0",nightRate:s.night_rate||"0",cardMode:s.card_mode||"fixed",cardFixed:s.card_fixed||"0",tipsPct:s.tips_pct||"0"})));setLoadingStaff(false);});
    }
  },[screen]);

  useEffect(()=>{
    if(screen==="staff"&&user){
      const dow=new Date().getDay();
      Promise.all([
        db.from("takings_assignment").select("staff_id").eq("date",todayISO()).maybeSingle(),
        db.from("takings_defaults").select("staff_id").eq("day_of_week",dow).maybeSingle(),
        db.from("app_settings").select("value").eq("key","welcome_message").maybeSingle(),
      ]).then(([ovR,defR,wmR])=>{
        setEffectiveTakingsPerson(ovR.data?.staff_id||defR.data?.staff_id||null);
        if(wmR.data?.value)setUser(p=>({...p,welcomeMsg:wmR.data.value}));
      });
    }
  },[screen,user]);

  return(
    <>
      <style>{CSS}</style>
      <div className="app">
        {screen==="role"&&<RolePicker onPick={r=>setScreen(r==="staff"?"staffLogin":"managerLogin")}/>}
        {screen==="staffLogin"&&(loadingStaff?<Loading text="Loading…"/>:<StaffLogin staff={allStaff} onLogin={u=>{setUser(u);setScreen("staff");}} onBack={()=>setScreen("role")} onRegister={()=>setScreen("staffRegister")}/>)}
        {screen==="staffRegister"&&<StaffRegister onBack={()=>setScreen("staffLogin")} onRegister={u=>{setUser(u);setScreen("staff");}}/>}
        {screen==="managerLogin"&&<ManagerLogin onLogin={()=>setScreen("manager")} onBack={()=>setScreen("role")}/>}
        {screen==="staff"&&user&&<StaffApp user={user} onLogout={()=>{setUser(null);setScreen("role");}} effectiveTakingsPerson={effectiveTakingsPerson}/>}
        {screen==="manager"&&<ManagerApp onLogout={()=>setScreen("role")}/>}
      </div>
    </>
  );
}
