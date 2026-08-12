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
  const url = webAppUrl.trim();
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
  { key:"depositReceipt",    label:"Deposit Receipt",      db:"deposit_receipt",   sign: 1, cc:true, ccDb:"deposit_pay_type" },
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
const r2 = v => Math.round((parseFloat(v)||0)*100)/100;
const addDays   = (iso,n) => { const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; };
const dispDate  = (iso,wd=false) => { if(!iso)return""; const d=new Date(iso+"T12:00:00"); return wd?d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}):d.toLocaleDateString("en-GB",{day:"numeric",month:"short"}); };
const fmtRange  = (s,e) => `${fmtDate(s)} – ${fmtDate(e)}`;
const fmtRangeExport = (s,e) => `${fmtDate(s)}-${fmtDate(e)}`;
const parseHrs  = (i,o) => { if(!i||!o)return 0; const p=t=>{const[h,m]=t.split(":").map(Number);return h+m/60;}; return Math.max(0,p(o)-p(i)); };
const roundHrsUp = hrs => hrs<=0?0:Math.ceil(hrs*4-1e-9)/4;
const roundHrs025 = hrs => hrs<=0?0:Math.round(hrs*4)/4;
const jsToMon   = d => d;
const weekDates = monISO => Array.from({length:7},(_,i)=>addDays(monISO,i));
const kId       = id => `k_${id}`;

function payWeekOf(iso) {
  const d=new Date(iso+"T12:00:00"),dow=d.getDay();
  const sun=new Date(d); sun.setDate(d.getDate()-dow);
  const sat=new Date(sun); sat.setDate(sun.getDate()+6);
  return{start:sun.toISOString().split("T")[0],end:sat.toISOString().split("T")[0]};
}
function rotaWeekOf(iso) {
  return{start:snapToSunday(iso),end:addDays(snapToSunday(iso),6)};
}

// ─── CSS ─────────────────────────────────────────────────────────────
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
button,a{touch-action:manipulation;}
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
.okbtn{border:none;background:#D1FAE5;color:#065F46;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;touch-action:manipulation;user-select:none;}
.nobtn{border:none;background:#FEE2E2;color:#E05252;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;touch-action:manipulation;user-select:none;}
.abscard{background:#FFF8EC;border:2px solid #E8620A;border-radius:16px;padding:16px;margin-bottom:14px;}
.peribtns{display:flex;gap:6px;margin-bottom:12px;}
.pbtn{flex:1;padding:10px 4px;border:2px solid #E5E5E5;border-radius:10px;background:#fff;font-size:12px;font-weight:700;color:#1A1A2E;cursor:pointer;text-align:center;}
.pbtn.sel{border-color:#E8620A;background:#FFF8EC;}
.toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#E8620A;color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;font-weight:700;z-index:999;white-space:normal;max-width:88vw;text-align:center;word-break:break-word;animation:fio 15s forwards;pointer-events:none;}
@keyframes fio{0%{opacity:0;top:10px}3%{opacity:1;top:24px}88%{opacity:1}100%{opacity:0}}
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
.tfield{margin-bottom:12px;}
.tlbl{font-size:16px;font-weight:700;color:#555;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;}
.thint{font-size:13px;color:#aaa;margin-top:3px;font-style:italic;line-height:1.5;}
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
export default function RolePicker({onPick}){
  return(
    <div className="role-screen">
      <style>{CSS}</style>
      <div className="role-logo">🍱</div>
      <div className="role-title">Staff Portal</div>
      <div className="role-sub">Select your portal to continue</div>
      <button className="role-btn staff" onClick={()=>onPick("staff")}>
        <span className="ri">👤</span>
        <div>
          <span className="rl">Staff Login</span>
          <span className="rd">Clock in, view rota &amp; request shifts</span>
        </div>
      </button>
      <button className="role-btn manager" onClick={()=>onPick("manager")}>
        <span className="ri">🔐</span>
        <div>
          <span className="rl">Manager Mode</span>
          <span className="rd">Manage rota, payroll, till &amp; settings</span>
        </div>
      </button>
    </div>
  );
}
