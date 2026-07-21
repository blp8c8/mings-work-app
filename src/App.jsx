import { useState, useEffect, useCallback } from "react";
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
  const payload = JSON.stringify({ spreadsheetId, tab: tabName, rows });
  try {
    const res = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight, which Apps Script doesn't handle
      body: payload
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) return { ok: false, err: data?.error || `Sheets sync failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    // Some browsers/networks block reading the response from an Apps Script
    // redirect even when everything is configured correctly. Fall back to a
    // "fire and forget" no-cors request — Google still receives and runs it,
    // we just can't read the confirmation back this way.
    try {
      await fetch(webAppUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: payload
      });
      return { ok: true, unconfirmed: true };
    } catch (e2) {
      return { ok: false, err: "Could not reach the Sheets bridge at all. Check in ⚙️ Sheets: the Web App URL is correct (ends in /exec), access is set to \"Anyone\" (not \"Anyone with Google account\"), and you redeployed after any script changes." };
    }
  }
}
// Simple connectivity check used by the "Test Connection" button in Settings.
async function testWebApp(webAppUrl) {
  if (!webAppUrl) return { ok: false, err: "Enter a Web App URL first" };
  try {
    const res = await fetch(webAppUrl, { method: "GET" });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (data && data.ok) return { ok: true };
    if (text.includes("accounts.google.com") || text.includes("ServiceLogin")) return { ok: false, err: "Google is asking to sign in — deployment access must be set to \"Anyone\", not \"Anyone with Google account\"." };
    return { ok: false, err: `Unexpected response (HTTP ${res.status}) — check the URL ends in /exec and the script was deployed as a Web App.` };
  } catch (e) {
    return { ok: false, err: "Could not reach that URL at all. Double check it was copied correctly from the Deploy dialog." };
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
const DAYS_MON = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const SHIFTS   = ["Off","Full Day (11am–close)","Night (5:30pm–close)","Custom"];
const ADD_LBLS = ["Bank Holiday","Red Day","Other"];
const DED_LBLS = ["Left Early","Sick Leave","Other"];
const TKFIELDS = [
  { key:"deliveroo",         label:"Deliveroo 🛵",         db:"deliveroo",          sign: 1 },
  { key:"uber",              label:"Uber Eats 🛵",          db:"uber",               sign: 1 },
  { key:"cash",              label:"Cash 💵",               db:"cash",               sign: 1 },
  { key:"card",              label:"Card 💳",               db:"card",               sign: 1 },
  { key:"online",            label:"Online 🌐",             db:"online",             sign: 1 },
  { key:"depositReceipt",    label:"Deposit Receipt",       db:"deposit_receipt",    sign: 1, cc:true, ccDb:"deposit_pay_type" },
  { key:"voucherRedemption", label:"Voucher Redemption 🎟️", db:"voucher_redemption", sign:-1, hint:"Enter as positive — deducted automatically" },
  { key:"voucherPurchase",   label:"Voucher Purchase 🎫",   db:"voucher_purchase",   sign: 1, cc:true, ccDb:"voucher_pay_type" },
];

// ─── Helpers ─────────────────────────────────────────────────────────
const todayISO  = () => new Date().toISOString().split("T")[0];
const nowTime   = () => new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
const fmtDate   = iso => { if(!iso)return""; const[y,m,d]=iso.split("-"); return`${d}/${m}/${y}`; };
const addDays   = (iso,n) => { const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; };
const dispDate  = (iso,wd=false) => { if(!iso)return""; const d=new Date(iso+"T12:00:00"); return wd?d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}):d.toLocaleDateString("en-GB",{day:"numeric",month:"short"}); };
const fmtRange  = (s,e) => `${fmtDate(s)} – ${fmtDate(e)}`;
const parseHrs  = (i,o) => { if(!i||!o)return 0; const p=t=>{const[h,m]=t.split(":").map(Number);return h+m/60;}; return Math.max(0,p(o)-p(i)); };
// Rounds a clocked duration UP to the nearest 15-minute mark before converting to hours,
// e.g. 3:00pm–5:12pm (2h12m) becomes 2h15m = 2.25h. Only matters for hourly-paid staff.
const roundHrsUp = hrs => hrs<=0?0:Math.ceil(hrs*4-1e-9)/4;
const jsToMon   = d => d===0?6:d-1;
const weekDates = monISO => Array.from({length:7},(_,i)=>addDays(monISO,i));
const kId       = id => `k_${id}`; // kitchen staff key prefix for payroll_extras

function payWeekOf(iso) {
  const d=new Date(iso+"T12:00:00"),dow=d.getDay();
  const sun=new Date(d); sun.setDate(d.getDate()-dow);
  const sat=new Date(sun); sat.setDate(sun.getDate()+6);
  return{start:sun.toISOString().split("T")[0],end:sat.toISOString().split("T")[0]};
}
function rotaWeekOf(iso) {
  const d=new Date(iso+"T12:00:00"),dow=d.getDay();
  const mon=new Date(d); mon.setDate(d.getDate()-(dow===0?6:dow-1));
  const sun=new Date(mon); sun.setDate(mon.getDate()+6);
  return{start:mon.toISOString().split("T")[0],end:sun.toISOString().split("T")[0]};
}

// ─── CSS ─────────────────────────────────────────────────────────────
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#F7F4EF;-webkit-tap-highlight-color:transparent;overscroll-behavior:none;}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;position:relative;overflow-x:hidden;}
.role-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;background:linear-gradient(160deg,#1A2744,#2C3E6B);}
.role-logo{font-size:52px;margin-bottom:12px;}.role-title{font-size:28px;font-weight:900;color:#fff;text-align:center;margin-bottom:6px;}
.role-sub{font-size:14px;color:rgba(255,255,255,.55);margin-bottom:36px;text-align:center;}
.role-btn{width:100%;padding:20px;border-radius:18px;border:none;cursor:pointer;margin-bottom:12px;display:flex;align-items:center;gap:14px;transition:transform .1s;}
.role-btn:active{transform:scale(.97);}.role-btn.staff{background:#F5A623;color:#1A2744;}.role-btn.manager{background:#fff;color:#1A2744;}
.ri{font-size:30px;}.rl{font-size:17px;font-weight:800;display:block;}.rd{font-size:12px;font-weight:500;opacity:.6;display:block;}
.auth{min-height:100vh;padding:48px 24px 32px;display:flex;flex-direction:column;}
.back{background:none;border:none;font-size:26px;cursor:pointer;align-self:flex-start;margin-bottom:20px;color:#1A2744;}
.atitle{font-size:25px;font-weight:900;color:#1A2744;margin-bottom:6px;}
.asub{font-size:14px;color:#888;margin-bottom:24px;line-height:1.6;}
.lbl{font-size:12px;font-weight:700;color:#888;margin-bottom:5px;display:block;text-transform:uppercase;letter-spacing:.5px;}
.inp{width:100%;padding:14px;border:2px solid #E5E5E5;border-radius:12px;font-size:15px;font-family:inherit;margin-bottom:14px;outline:none;transition:border-color .2s;background:#fff;}
.inp:focus{border-color:#F5A623;}.inp.code{font-size:26px;letter-spacing:8px;font-weight:800;text-align:center;color:#1A2744;}
.inp.sm{padding:9px 11px;font-size:13px;margin-bottom:0;border-radius:9px;}
.inp.time{padding:8px 9px;font-size:12px;margin-bottom:0;flex:1;border-radius:8px;}
.btn{width:100%;padding:16px;background:#F5A623;border:none;border-radius:14px;font-size:15px;font-weight:800;color:#1A2744;cursor:pointer;margin-top:8px;transition:transform .1s;display:block;text-align:center;}
.btn:active{transform:scale(.98);}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn.sec{background:#F0F0F0;color:#1A2744;margin-top:10px;}.btn.danger{background:#E05252;color:#fff;}
.btn.green{background:#50DC78;color:#1A2744;}.btn.navy{background:#1A2744;color:#fff;}
.btn.sm{padding:9px 14px;font-size:12px;width:auto;margin-top:0;border-radius:9px;}
.err{color:#E05252;font-weight:700;font-size:13px;margin-bottom:10px;}
.slist{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;}
.sitem{padding:14px 16px;background:#F7F4EF;border-radius:12px;display:flex;align-items:center;gap:12px;cursor:pointer;border:2px solid transparent;}
.sitem:hover{border-color:#ddd;}
.avatar{width:42px;height:42px;border-radius:21px;background:#1A2744;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;flex-shrink:0;}
.hdr{padding:18px 18px 8px;display:flex;align-items:center;justify-content:space-between;}
.hdr-name{font-size:19px;font-weight:900;color:#1A2744;}.hdr-greet{font-size:12px;color:#aaa;font-weight:500;}
.body{padding:0 16px 110px;}
.sec{font-size:16px;font-weight:800;color:#1A2744;margin:16px 0 10px;}
.ssub{font-size:12px;color:#aaa;margin-top:-6px;margin-bottom:10px;}
.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:#fff;border-top:1px solid #F0F0F0;display:flex;padding:8px 0 env(safe-area-inset-bottom,18px);z-index:100;}
.nbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;border:none;background:none;cursor:pointer;padding:4px;position:relative;}
.ni{font-size:20px;}.nl{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:.3px;}.nbtn.on .nl{color:#F5A623;}
.nbadge{position:absolute;top:0;right:calc(50% - 18px);background:#E05252;color:#fff;border-radius:10px;font-size:10px;font-weight:800;padding:1px 5px;min-width:16px;text-align:center;}
.clkcard{background:linear-gradient(135deg,#1A2744,#2C3E6B);border-radius:20px;padding:20px;margin-bottom:14px;color:#fff;}
.clktime{font-size:40px;font-weight:900;letter-spacing:-1px;}.clkdate{font-size:12px;color:rgba(255,255,255,.5);margin-bottom:12px;}
.clkst{display:inline-block;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:700;margin-bottom:14px;}
.clkst.in{background:rgba(80,220,120,.2);color:#50DC78;}.clkst.out{background:rgba(255,255,255,.1);color:rgba(255,255,255,.4);}
.clkbtns{display:flex;gap:8px;}
.clkbtn{flex:1;padding:13px;border-radius:11px;border:none;font-size:13px;font-weight:800;cursor:pointer;}
.clkbtn.in{background:#50DC78;color:#1A2744;}.clkbtn.out{background:#E05252;color:#fff;}.clkbtn:disabled{opacity:.3;cursor:not-allowed;}
.clkhist{margin-top:12px;}
.clkrow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:11px;color:rgba(255,255,255,.65);}
.clkrow:last-child{border:none;}
.rday{background:#F7F4EF;border-radius:13px;padding:11px 13px;margin-bottom:7px;display:flex;align-items:center;gap:8px;}
.rday.today{background:#FFF8EC;border:2px solid #F5A623;}.rday.off{opacity:.4;}
.rdaylbl{min-width:60px;}.rdayname{font-size:12px;font-weight:800;color:#1A2744;}
.rdaydate{font-size:10px;color:#aaa;}.rdayflag{font-size:9px;font-weight:700;color:#F5A623;}
.rdayshift{flex:1;font-size:13px;font-weight:700;color:#1A2744;}
.rdaybtns{display:flex;gap:5px;}
.okbtn{border:none;background:#D1FAE5;color:#065F46;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;}
.nobtn{border:none;background:#FEE2E2;color:#E05252;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;}
.abscard{background:#FFF8EC;border:2px solid #F5A623;border-radius:16px;padding:16px;margin-bottom:14px;}
.peribtns{display:flex;gap:6px;margin-bottom:12px;}
.pbtn{flex:1;padding:10px 4px;border:2px solid #E5E5E5;border-radius:10px;background:#fff;font-size:12px;font-weight:700;color:#1A2744;cursor:pointer;text-align:center;}
.pbtn.sel{border-color:#F5A623;background:#FFF8EC;}
.toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#1A2744;color:#fff;padding:10px 18px;border-radius:40px;font-size:13px;font-weight:700;z-index:999;white-space:nowrap;animation:fio 2.8s forwards;pointer-events:none;}
@keyframes fio{0%{opacity:0;top:10px}12%{opacity:1;top:24px}80%{opacity:1}100%{opacity:0}}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:200;}
.sheet{background:#fff;border-radius:24px 24px 0 0;padding:24px 20px 44px;width:100%;max-width:430px;max-height:90vh;overflow-y:auto;}
.stitle{font-size:19px;font-weight:900;color:#1A2744;margin-bottom:4px;}
.ssub2{font-size:13px;color:#888;margin-bottom:14px;}
.toggle{display:flex;border:2px solid #E5E5E5;border-radius:10px;overflow:hidden;width:fit-content;}
.tgl{padding:6px 13px;border:none;background:#fff;font-size:12px;font-weight:700;cursor:pointer;color:#888;}
.tgl.on{background:#1A2744;color:#fff;}
.day-tog{padding:5px 8px;border:1.5px solid #E5E5E5;border-radius:7px;background:#fff;font-size:11px;font-weight:700;cursor:pointer;color:#888;}
.day-tog.on{background:#F5A623;border-color:#F5A623;color:#1A2744;}
.day-tog:disabled{opacity:.35;cursor:not-allowed;}
.mhdr{background:linear-gradient(135deg,#1A2744,#0F1D3A);padding:22px 16px 14px;display:flex;justify-content:space-between;align-items:flex-start;}
.mtitle{font-size:20px;font-weight:900;color:#fff;}.msub{font-size:11px;color:rgba(255,255,255,.4);}
.mlo{background:rgba(255,255,255,.12);border:none;color:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600;}
.mtabs{display:flex;overflow-x:auto;gap:2px;padding:0 12px;border-bottom:2px solid #F0F0F0;scrollbar-width:none;}
.mtabs::-webkit-scrollbar{display:none;}
.mtab{white-space:nowrap;padding:10px 11px;border:none;background:none;font-size:12px;font-weight:700;color:#bbb;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;}
.mtab.on{color:#1A2744;border-bottom-color:#F5A623;}
.mbody{padding:12px 16px 110px;}
.card{background:#F7F4EF;border-radius:14px;padding:13px 14px;margin-bottom:10px;}
.card.w{background:#fff;border:1.5px solid #F0F0F0;}
.chead{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.cname{font-size:14px;font-weight:800;color:#1A2744;}.csub{font-size:11px;color:#888;margin-top:2px;}
.chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;}
.chip.g{background:#D1FAE5;color:#065F46;}.chip.r{background:#FEE2E2;color:#7F1D1D;}.chip.a{background:#FEF3C7;color:#78350F;}
.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #F0F0F0;font-size:13px;color:#555;}
.row:last-child{border:none;}.rowb{font-weight:800;color:#1A2744;}
.paycard{background:#fff;border:2px solid #F0F0F0;border-radius:14px;margin-bottom:10px;overflow:hidden;}
.phead{background:#F7F4EF;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;}
.pname{font-size:14px;font-weight:800;color:#1A2744;}.ptotal{font-size:18px;font-weight:900;color:#F5A623;}
.pbody{padding:11px 14px;}
.mini{width:72px;padding:5px 7px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-family:inherit;outline:none;}
.mini:focus{border-color:#F5A623;}
.addrow{display:flex;gap:5px;align-items:center;margin-top:6px;}
.addinp{flex:1;padding:7px 9px;border:1.5px solid #E5E5E5;border-radius:8px;font-size:12px;font-family:inherit;outline:none;}
.addinp:focus{border-color:#F5A623;}
.addbtn{padding:7px 11px;background:#F5A623;border:none;border-radius:7px;font-size:11px;font-weight:800;color:#1A2744;cursor:pointer;}
.addbtn.r{background:#FEE2E2;color:#7F1D1D;}
.psum{background:linear-gradient(135deg,#1A2744,#2C3E6B);border-radius:16px;padding:16px;margin-top:14px;color:#fff;}
.psumtitle{font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;}
.psumrow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:14px;color:rgba(255,255,255,.8);}
.psumrow:last-child{border:none;}.psumamt{font-weight:900;color:#F5A623;}
.expsec{background:#F7F4EF;border-radius:14px;padding:13px;margin-top:12px;}
.exptitle{font-size:13px;font-weight:800;color:#1A2744;margin-bottom:9px;}
.expbtn{width:100%;padding:13px;border:none;border-radius:11px;font-size:13px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:7px;}
.expbtn:last-child{margin-bottom:0;}.expbtn.p{background:#1A2744;color:#fff;}.expbtn.s{background:#E8F0E9;color:#1A2744;}
.tfield{margin-bottom:9px;}
.tlbl{font-size:12px;font-weight:700;color:#555;margin-bottom:3px;display:flex;justify-content:space-between;align-items:center;}
.thint{font-size:10px;color:#aaa;margin-top:2px;font-style:italic;}
.tmsg{background:#D1FAE5;border:1.5px solid #50DC78;border-radius:13px;padding:12px 14px;margin-bottom:10px;}
.tmsg-h{font-size:13px;font-weight:800;color:#065F46;margin-bottom:3px;}
.tmsg-d{font-size:12px;color:#047857;}
.tmsg.new{background:#FFF8EC;border-color:#F5A623;}
.tmsg.new .tmsg-h{color:#78350F;}.tmsg.new .tmsg-d{color:#92400E;}
.notif{background:linear-gradient(135deg,#F5A623,#E8940A);border-radius:14px;padding:14px;margin-bottom:14px;cursor:pointer;}
.notif-t{font-size:14px;font-weight:900;color:#1A2744;margin-bottom:3px;}
.notif-s{font-size:12px;color:rgba(26,39,68,.7);}
.warn{background:#FEE2E2;border:2px solid #E05252;border-radius:13px;padding:12px 14px;margin-bottom:12px;}
.warn-t{font-size:13px;font-weight:800;color:#7F1D1D;margin-bottom:3px;}.warn-s{font-size:12px;color:#991B1B;}
.rejbanner{background:#FEE2E2;border:1.5px solid #E05252;border-radius:11px;padding:9px 13px;margin-bottom:8px;font-size:12px;color:#7F1D1D;font-weight:600;display:flex;justify-content:space-between;align-items:center;}
.logentry{padding:9px 0;border-bottom:1px dashed #E5E5E5;}.logentry:last-child{border:none;}
.logtop{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;}
.lognote{width:100%;padding:7px 9px;border:1.5px solid #E5E5E5;border-radius:8px;font-size:12px;font-family:inherit;outline:none;margin-top:4px;background:#fff;resize:none;}
.lognote:focus{border-color:#F5A623;}
.logedit{display:flex;gap:5px;align-items:center;margin-bottom:5px;}
.logelbl{font-size:10px;font-weight:700;color:#aaa;min-width:24px;}
.wnav{display:flex;align-items:center;gap:8px;background:#FFF8EC;border:1.5px solid #F5A623;border-radius:12px;padding:10px 14px;margin-bottom:12px;}
.wnavbtn{background:#fff;border:1.5px solid #E5E5E5;border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;flex-shrink:0;}
.wnavlbl{flex:1;text-align:center;font-size:12px;font-weight:700;color:#92400E;line-height:1.4;}
.divider{height:1px;background:#F0F0F0;margin:10px 0;}
.empty{text-align:center;padding:36px 20px;color:#ccc;}
.emptyicon{font-size:42px;margin-bottom:8px;}.emptytxt{font-size:14px;font-weight:600;}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#F7F4EF;gap:16px;}
.spinner{width:40px;height:40px;border:4px solid #E5E5E5;border-top-color:#F5A623;border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}.loadtxt{font-size:14px;font-weight:600;color:#888;}
.cashrow{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #F0F0F0;font-size:15px;}
.cashrow:last-child{border:none;}.cashname{font-weight:700;color:#1A2744;}.cashamt{font-weight:900;color:#065F46;font-size:16px;}
.gs-banner{background:#FFF8EC;border:1.5px solid #F5A623;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#78350F;}
.override-box{background:#FFF3CD;border:1.5px solid #F5A623;border-radius:10px;padding:10px 12px;margin-top:8px;}
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
            <div><div style={{fontSize:15,fontWeight:700,color:"#1A2744"}}>{s.name}</div><div style={{fontSize:11,color:"#aaa"}}>Tap to sign in</div></div>
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
  const[clockedIn,setClockedIn]=useState(false);const[clockInTime,setClockInTime]=useState(null);
  const[logs,setLogs]=useState([]);const[rota,setRota]=useState([]);
  const[absences,setAbsences]=useState([]);const[rejections,setRejections]=useState([]);
  const[confirmations,setConfirmations]=useState([]);
  const[absDate,setAbsDate]=useState("");const[absPeriod,setAbsPeriod]=useState("");
  const[rejectModal,setRejectModal]=useState(null);const[rejectReason,setRejectReason]=useState("");
  const[tVals,setTVals]=useState({});const[tCC,setTCC]=useState({});const[tNote,setTNote]=useState("");
  const[submitted,setSubmitted]=useState(false);const[loading,setLoading]=useState(true);
  const[rotaMon,setRotaMon]=useState(()=>rotaWeekOf(todayISO()).start);
  const assigned=effectiveTakingsPerson===user.id;
  const now=new Date();
  function t(m){setMsg(m);setTimeout(()=>setMsg(""),2800);}
  useEffect(()=>{loadData();},[]);
  useEffect(()=>{loadRota();},[rotaMon]);

  async function loadData(){
    setLoading(true);
    const[logR,absR,rejR,confR,subR]=await Promise.all([
      db.from("clock_logs").select("*").eq("staff_id",user.id).order("date",{ascending:false}).limit(20),
      db.from("absences").select("*").eq("staff_id",user.id).order("date",{ascending:false}),
      db.from("rejections").select("*").eq("staff_id",user.id),
      db.from("confirmations").select("*").eq("staff_id",user.id),
      db.from("takings").select("id").eq("staff_id",user.id).eq("date",todayISO()),
    ]);
    setLogs(logR.data||[]);setAbsences(absR.data||[]);setRejections(rejR.data||[]);setConfirmations(confR.data||[]);
    setSubmitted((subR.data||[]).length>0);
    const active=(logR.data||[]).find(l=>l.date===todayISO()&&l.time_in&&!l.time_out);
    if(active){setClockedIn(true);setClockInTime(active.time_in);}
    await loadRota();setLoading(false);
  }
  async function loadRota(){
    const dates=weekDates(rotaMon);
    const{data}=await db.from("rota").select("*").eq("staff_id",user.id).eq("week_start",rotaMon);
    setRota(dates.map(dateISO=>{const jsDay=new Date(dateISO+"T12:00:00").getDay();const row=(data||[]).find(r=>r.day_index===jsDay);return{date:dateISO,jsDay,type:row?.shift_type||"Off",customIn:row?.custom_in||"",customOut:row?.custom_out||""};}));
  }
  async function clockIn(){const time=nowTime();const{data,error}=await db.from("clock_logs").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),time_in:time,note:""}).select().single();if(!error){setLogs(p=>[data,...p]);setClockedIn(true);setClockInTime(time);t("✅ Clocked in at "+time);}else t("❌ "+error.message);}
  async function clockOut(){const active=logs.find(l=>l.date===todayISO()&&l.time_in&&!l.time_out);if(!active)return;const time=nowTime();const{error}=await db.from("clock_logs").update({time_out:time}).eq("id",active.id);if(!error){setLogs(p=>p.map(l=>l.id===active.id?{...l,time_out:time}:l));setClockedIn(false);t("👋 Clocked out at "+time);}else t("❌ "+error.message);}
  async function reportAbsence(){if(!absDate||!absPeriod)return t("Please pick a date and period");const{data,error}=await db.from("absences").insert({staff_id:user.id,staff_name:user.name,date:absDate,period:absPeriod}).select().single();if(!error){setAbsences(p=>[...p,data]);setAbsDate("");setAbsPeriod("");t("📅 Absence sent!");}else t("❌ "+error.message);}
  async function confirmShift(idx){const{data,error}=await db.from("confirmations").insert({staff_id:user.id,staff_name:user.name,day:DAYS_MON[idx]}).select().single();if(!error){setConfirmations(p=>[...p,data]);t("✅ Confirmed!");}else t("❌ "+error.message);}
  async function rejectShift(){const{data,error}=await db.from("rejections").insert({staff_id:user.id,staff_name:user.name,day:DAYS_MON[rejectModal],reason:rejectReason}).select().single();if(!error){setRejections(p=>[...p,data]);setRejectModal(null);t("Rejection sent");}else t("❌ "+error.message);}
  async function submitTakings(){const vals={};TKFIELDS.forEach(f=>{vals[f.db]=parseFloat(tVals[f.key]||0);if(f.ccDb)vals[f.ccDb]=tCC[f.key]||"cash";});const{error}=await db.from("takings").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),...vals,note:tNote,is_new:true});if(!error){setTVals({});setTCC({});setTNote("");setSubmitted(true);t("📊 Submitted!");setTab("home");}else t("❌ "+error.message);}
  function shiftLabel(sh){if(!sh||sh.type==="Off")return"Day off";if(sh.type==="Full Day (11am–close)")return"Full Day 11am–close";if(sh.type==="Night (5:30pm–close)")return"Night 5:30pm–close";if(sh.type==="Custom")return`${sh.customIn||"?"}–${sh.customOut||"?"}`;return sh.type;}
  if(loading)return<Loading text="Loading your data…"/>;

  function RotaList(){return rota.map((sh,idx)=>{const isToday=sh.date===todayISO();const dayName=DAYS_MON[idx];const rejected=rejections.some(r=>r.day===dayName);const confirmed=confirmations.some(r=>r.day===dayName);const isOff=sh.type==="Off";return(<div key={idx} className={`rday${isToday?" today":""}${isOff?" off":""}`}><div className="rdaylbl"><div className="rdayname">{dayName}</div><div className="rdaydate">{dispDate(sh.date)}</div>{isToday&&<div className="rdayflag">TODAY</div>}</div><div className="rdayshift">{shiftLabel(sh)}</div>{!isOff&&!rejected&&!confirmed&&<div className="rdaybtns"><button className="okbtn" onClick={()=>confirmShift(idx)}>✓ OK</button><button className="nobtn" onClick={()=>{setRejectModal(idx);setRejectReason("");}}>✕ Can't</button></div>}{confirmed&&<span className="chip g">✓ OK</span>}{rejected&&<span className="chip r">Rejected</span>}</div>);});}

  const navItems=[{id:"home",icon:"🏠",label:"Home"},{id:"rota",icon:"📋",label:"Rota"},{id:"absence",icon:"📅",label:"Absence"},...(assigned?[{id:"takings",icon:"📊",label:"Takings",badge:!submitted}]:[])];
  return(
    <div className="app">
      <Toast msg={msg}/>
      <div className="hdr"><div><div className="hdr-greet">Good {now.getHours()<12?"morning":now.getHours()<18?"afternoon":"evening"},</div><div className="hdr-name">{user.name.split(" ")[0]} 👋</div></div><button style={{background:"none",border:"none",fontSize:22,cursor:"pointer"}} onClick={onLogout}>🚪</button></div>
      {tab==="home"&&<div className="body">{assigned&&!submitted&&<div className="notif" onClick={()=>setTab("takings")}><div className="notif-t">📊 You're today's Takings Person!</div><div className="notif-s">Tap to record today's takings →</div></div>}<div className="clkcard"><div className="clktime">{now.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div><div className="clkdate">{now.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</div><div className={`clkst ${clockedIn?"in":"out"}`}>{clockedIn?`● Clocked in at ${clockInTime}`:"● Not clocked in"}</div><div className="clkbtns"><button className="clkbtn in" onClick={clockIn} disabled={clockedIn}>🟢 Clock In</button><button className="clkbtn out" onClick={clockOut} disabled={!clockedIn}>🔴 Clock Out</button></div>{logs.slice(0,3).length>0&&<div className="clkhist">{logs.slice(0,3).map(l=><div key={l.id} className="clkrow"><span>{dispDate(l.date,true)}</span><span>{l.time_in}→{l.time_out||"active"}</span><span style={{fontWeight:700}}>{l.time_out?parseHrs(l.time_in,l.time_out).toFixed(1)+"h":""}</span></div>)}</div>}</div><div className="sec">This Week</div><RotaList/></div>}
      {tab==="rota"&&<div className="body"><div className="sec">My Rota</div><div className="wnav"><button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,-7))}>‹</button><div className="wnavlbl">{fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon,6))}</div><button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,7))}>›</button></div><RotaList/></div>}
      {tab==="absence"&&<div className="body"><div className="sec">Report Absence</div><div className="abscard"><div style={{fontSize:14,fontWeight:800,color:"#1A2744",marginBottom:4}}>📅 Can't come in?</div><div style={{fontSize:12,color:"#888",marginBottom:12}}>Pick the date and when you can't work</div><label className="lbl">Which day?</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:12}} value={absDate} min={todayISO()} onChange={e=>setAbsDate(e.target.value)}/><label className="lbl" style={{marginBottom:7}}>Which part?</label><div className="peribtns">{["Morning","Evening","Full Day"].map(p=><button key={p} className={`pbtn${absPeriod===p?" sel":""}`} onClick={()=>setAbsPeriod(p)}>{p==="Morning"?"🌅":p==="Evening"?"🌙":"☀️"}<br/>{p}</button>)}</div><button className="btn" style={{marginTop:10}} onClick={reportAbsence} disabled={!absDate||!absPeriod}>Send to Manager</button></div>{absences.length>0&&<>{<div className="sec">Reported</div>}{absences.map(a=><div key={a.id} style={{background:"#F7F4EF",borderRadius:12,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}><div><div style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>{dispDate(a.date,true)}</div><div style={{fontSize:11,color:"#aaa"}}>{a.period}</div></div><span className="chip a">Sent ✓</span></div>)}</>}</div>}
      {tab==="takings"&&<div className="body"><div className="sec">📊 Daily Takings</div>{submitted?<div className="empty"><div className="emptyicon">✅</div><div className="emptytxt">Already submitted today!</div></div>:!assigned?<div className="empty"><div className="emptyicon">🔒</div><div className="emptytxt">Not assigned today</div></div>:<>{<div style={{fontSize:12,color:"#888",marginBottom:14}}>For {dispDate(todayISO(),true)}. <strong>Enter all amounts as positive numbers.</strong></div>}{TKFIELDS.map(f=><div key={f.key} className="tfield"><div className="tlbl"><span>{f.label}</span>{f.cc&&<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl${(tCC[f.key]||"cash")===c?" on":""}`} onClick={()=>setTCC(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>}</div>{f.hint&&<div className="thint">{f.hint}</div>}<input className="inp sm" style={{display:"block",width:"100%",marginTop:4}} type="number" min="0" placeholder="0.00" value={tVals[f.key]||""} onChange={e=>setTVals(p=>({...p,[f.key]:e.target.value}))}/></div>)}<label className="lbl" style={{marginTop:10}}>Note (optional)</label><textarea className="lognote" rows={3} style={{marginBottom:12}} placeholder="Any notes…" value={tNote} onChange={e=>setTNote(e.target.value)}/><button className="btn green" onClick={submitTakings}>Submit to Manager ✓</button></>}</div>}
      <div className="bnav">{navItems.map(n=><button key={n.id} className={`nbtn${tab===n.id?" on":""}`} onClick={()=>setTab(n.id)}>{n.badge&&<span className="nbadge">!</span>}<span className="ni">{n.icon}</span><span className="nl">{n.label}</span></button>)}</div>
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
  const[rotaMon,setRotaMon]=useState(()=>rotaWeekOf(todayISO()).start);
  const[cashPopup,setCashPopup]=useState(false);
  const[pinModal,setPinModal]=useState(false);
  const[settingsModal,setSettingsModal]=useState(false);
  const[absModal,setAbsModal]=useState(false);
  const[shareModal,setShareModal]=useState(null);
  const[newKName,setNewKName]=useState("");
  const[absStaff,setAbsStaff]=useState("");const[absDate,setAbsDate]=useState("");const[absPeriod,setAbsPeriod]=useState("");
  const[gsConfig,setGsConfig]=useState({webAppUrl:"",payrollId:"",takingsId:""});
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
      db.from("app_settings").select("key,value").in("key",["gs_webapp_url","gs_payroll_id","gs_takings_id","manager_pin"]),
    ]);
    setStaff((staffR.data||[]).map(s=>({...s,payType:s.pay_type,rate:s.rate,shiftRate:s.shift_rate,nightRate:s.night_rate,cardFixed:s.card_fixed||"0",cardMode:s.card_mode||"fixed"})));
    setAbsences(absR.data||[]);setClockLogs(logR.data||[]);setRejections(rejR.data||[]);
    setTakings(takR.data||[]);setExpenses(expR.data||[]);
    setKitchenStaff((kitR.data||[]).map(k=>({...k,payType:k.pay_type||"hourly",shiftRate:k.shift_rate||"0",nightRate:k.night_rate||"0",cardMode:k.card_mode||"fixed",cardFixed:k.card_fixed||"0"})));
    setTodayOverride(ovR.data?.staff_id||null);
    const dd={};(defR.data||[]).forEach(r=>{dd[r.day_of_week]=r.staff_id;});setTakingDefaults(dd);
    const em={};
    (extR.data||[]).forEach(e=>{em[e.staff_id]={tips:e.tips,additions:e.additions||[],deductions:e.deductions||[],notes:e.notes||[],manualFull:e.manual_full||"",manualNight:e.manual_night||"",manualHrs:e.manual_hrs||"",manualCash:e.manual_cash||"",manualCard:e.manual_card||"",manualTotal:e.manual_total||"",id:e.id,ws:e.week_start};});
    setExtras(em);
    const gsRows=gsR.data||[];
    setGsConfig({webAppUrl:gsRows.find(r=>r.key==="gs_webapp_url")?.value||"",payrollId:gsRows.find(r=>r.key==="gs_payroll_id")?.value||"",takingsId:gsRows.find(r=>r.key==="gs_takings_id")?.value||""});
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
    for(const[key,value]of[["gs_webapp_url",cfg.webAppUrl],["gs_payroll_id",cfg.payrollId],["gs_takings_id",cfg.takingsId]]){
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
  function getExtras(sid){return extras[sid]||{tips:"",additions:[],deductions:[],notes:[],manualFull:"",manualNight:"",manualHrs:"",manualCash:"",manualCard:"",manualTotal:"",id:null,ws:null};}
  async function updateExtras(sid,fn){
    const next=fn(getExtras(sid));setExtras(p=>({...p,[sid]:next}));
    const ws=weekRange.start;
    const payload={staff_id:sid,week_start:ws,tips:next.tips||"0",additions:next.additions||[],deductions:next.deductions||[],notes:next.notes||[],manual_full:next.manualFull||null,manual_night:next.manualNight||null,manual_hrs:next.manualHrs||null,manual_cash:next.manualCash||null,manual_card:next.manualCard||null,manual_total:next.manualTotal||null};
    if(next.id&&next.ws===ws){await db.from("payroll_extras").update(payload).eq("id",next.id);}
    else{const{data}=await db.from("payroll_extras").insert(payload).select().single();if(data)setExtras(p=>({...p,[sid]:{...next,id:data.id,ws}}));}
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
    const myRota=rota[s.id]||[];const logsInRange=clockLogs.filter(l=>l.staff_id===s.id&&l.date>=weekRange.start&&l.date<=weekRange.end);
    const ex=getExtras(s.id);
    let full=ex.manualFull!==""&&ex.manualFull!=null?parseFloat(ex.manualFull):myRota.filter(sh=>sh?.type==="Full Day (11am–close)").length;
    let night=ex.manualNight!==""&&ex.manualNight!=null?parseFloat(ex.manualNight):myRota.filter(sh=>sh?.type==="Night (5:30pm–close)").length;
    let hrs=ex.manualHrs!==""&&ex.manualHrs!=null?parseFloat(ex.manualHrs):logsInRange.reduce((a,l)=>a+roundHrsUp(parseHrs(l.time_in,l.time_out)),0);
    const tips=parseFloat(ex.tips||0);
    const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const base=s.payType==="hourly"?hrs*parseFloat(s.rate||0):full*parseFloat(s.shiftRate||0)+night*parseFloat(s.nightRate||0);
    const calcTotal=Math.max(0,base+tips+addT-dedT);
    const cardMode=s.cardMode||"fixed";
    const{cardAmt:calcCard,cashAmt:calcCash,exceeds}=splitCard(cardMode,s.cardFixed,calcTotal);
    // Manual overwrite takes priority over everything above (and clears the warning)
    const isOverride=!!(ex.manualTotal&&ex.manualTotal!=="");
    const total=isOverride?parseFloat(ex.manualTotal):calcTotal;
    const cardAmt=ex.manualCard&&ex.manualCard!==""?parseFloat(ex.manualCard):calcCard;
    const cashAmt=ex.manualCash&&ex.manualCash!==""?parseFloat(ex.manualCash):calcCash;
    return{full,night,hrs:typeof hrs==="number"?hrs.toFixed(2):hrs,base:base.toFixed(2),tips:tips.toFixed(2),addT:addT.toFixed(2),dedT:dedT.toFixed(2),total:total.toFixed(2),cardAmt:cardAmt.toFixed(2),cashAmt:cashAmt.toFixed(2),isOverride,grossTotal:calcTotal,cardExceeds:!isOverride&&cardMode==="fixed"&&exceeds};
  }

  function calcKitchenPay(k){
    const sid=kId(k.id);const ex=getExtras(sid);
    const kh=kitchenHours[k.id]||{hours:""};
    let hrs=ex.manualHrs!==""&&ex.manualHrs!=null?parseFloat(ex.manualHrs):parseFloat(kh.hours||0);
    let full=ex.manualFull!==""&&ex.manualFull!=null?parseFloat(ex.manualFull):0;
    let night=ex.manualNight!==""&&ex.manualNight!=null?parseFloat(ex.manualNight):0;
    const tips=parseFloat(ex.tips||0);
    const addT=(ex.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const dedT=(ex.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const base=(k.payType||"hourly")==="hourly"?hrs*parseFloat(k.rate||0):full*parseFloat(k.shiftRate||0)+night*parseFloat(k.nightRate||0);
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
    let cash=0,card=0,gross=0;
    staff.forEach(s=>{const p=calcPay(s);cash+=parseFloat(p.cashAmt);card+=parseFloat(p.cardAmt);gross+=parseFloat(p.total);});
    kitchenStaff.forEach(k=>{const p=calcKitchenPay(k);cash+=parseFloat(p.cashAmt);card+=parseFloat(p.cardAmt);gross+=parseFloat(p.total);});
    return{cash:cash.toFixed(2),card:card.toFixed(2),gross:gross.toFixed(2)};
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
    if(!error){setStaff(p=>p.filter(x=>x.id!==s.id));t(`${s.name} removed`);}else t("❌ "+error.message);
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
    const existing=takings.find(s=>s.date===date&&s.staff_id==="manager");
    if(existing){
      const{error}=await db.from("takings").update({...vals,note}).eq("id",existing.id);
      if(!error){setTakings(p=>p.map(x=>x.id===existing.id?{...x,...vals,note}:x));return{ok:true};}
      return{ok:false,err:error.message};
    }else{
      const{data,error}=await db.from("takings").insert({staff_id:"manager",staff_name:"Manager",date,...vals,note,is_new:false}).select().single();
      if(!error){setTakings(p=>[data,...p]);return{ok:true};}
      return{ok:false,err:error.message};
    }
  }

  // ── Auto-push single day to Daily sheet ──
  async function autoPushDay(date){
    if(!gsConfig.webAppUrl||!gsConfig.takingsId)return;
    const dayRows=buildDailyForDate(date);
    // Append to daily by rebuilding full sheet
    const allRows=buildDaily();
    await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Daily",allRows);
  }

  // ── Export builders ──
  function buildPayroll(){
    const hdr=["Date Range","Name","Type","Full Shifts","Night Shifts","Hours","Cash (£)","Card (£)","Tips (£)","Additions (£)","Deductions (£)","Total (£)","Notes","Override?"];
    const rows=[hdr];
    staff.forEach(s=>{const p=calcPay(s);const ex=getExtras(s.id);rows.push([fmtRange(weekRange.start,weekRange.end),s.name,"FOH",p.full,p.night,p.hrs,p.cashAmt,p.cardAmt,p.tips,p.addT,p.dedT,p.total,(ex.notes||[]).join("; "),p.isOverride?"MANUAL":""]);});
    kitchenStaff.forEach(k=>{const p=calcKitchenPay(k);const ex=getExtras(kId(k.id));rows.push([fmtRange(weekRange.start,weekRange.end),k.name,"Kitchen",p.full||"",p.night||"",p.hrs,p.cashAmt,p.cardAmt,p.tips,p.addT,p.dedT,p.total,(ex.notes||[]).join("; "),p.isOverride?"MANUAL":""]);});
    return rows;
  }
  function buildPayrollWeekly(){
    // One row per pay week — totals from ALL staff
    const hdr=["Date Range","Cash Total (£)","Card Total (£)","Grand Total (£)"];
    const rows=[["PAYROLL WEEKLY SUMMARY"],hdr];
    // Group by week_start from extras, plus current weekRange
    const weeks=new Set([weekRange.start,...Object.values(extras).map(e=>e.ws).filter(Boolean)]);
    // For simplicity, show current week only (user navigates weeks via date pickers)
    const{cash,card,gross}=payTotals();
    rows.push([fmtRange(weekRange.start,weekRange.end),cash,card,gross]);
    return rows;
  }
  function buildDailyForDate(date){
    const sub=takings.find(s=>s.date===date)||{};
    const dayExp=expenses.filter(e=>e.date===date);
    const total=TKFIELDS.reduce((s,f)=>s+parseFloat(sub[f.db]||0)*f.sign,0);
    const cashExp=dayExp.filter(e=>e.pay_type==="cash").reduce((s,e)=>s+e.amount,0);
    return[[fmtDate(date),sub.deliveroo||0,sub.uber||0,sub.cash||0,sub.card||0,sub.online||0,sub.deposit_receipt||0,sub.voucher_redemption||0,sub.voucher_purchase||0,total.toFixed(2),(parseFloat(sub.cash||0)-cashExp).toFixed(2),(total-cashExp).toFixed(2),dayExp.map(e=>`${e.description}(£${e.amount.toFixed(2)},${e.pay_type})`).join("; ")]];
  }
  function buildDaily(){
    const dates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
    const hdr=["Date","Deliveroo","Uber Eats","Cash","Card","Online","Deposit Receipt","Voucher Redemption","Voucher Purchase","Total","Cash in Hand","Net Total","Expenses"];
    return[hdr,...dates.map(date=>buildDailyForDate(date)[0])];
  }
  function buildWeekly(){
    const dates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].filter(d=>d&&!d.startsWith("__")).sort();
    const wm={};dates.forEach(d=>{const{start}=payWeekOf(d);if(!wm[start])wm[start]=[];wm[start].push(d);});
    const hdr=["Week (Sun–Sat)","Deliveroo","Uber Eats","Cash","Card","Online","Deposit Receipt","Voucher Redemption","Voucher Purchase","Total","Cash in Hand","Net Total"];
    const rows=[["WEEKLY SUMMARY"],hdr];
    Object.entries(wm).sort().forEach(([ws,dates2])=>{
      const{end}=payWeekOf(ws);let tot={};TKFIELDS.forEach(f=>tot[f.db]=0);let cashExp=0;
      dates2.forEach(d=>{const sub=takings.find(s=>s.date===d);if(sub)TKFIELDS.forEach(f=>{tot[f.db]+=parseFloat(sub[f.db]||0);});cashExp+=expenses.filter(e=>e.date===d&&e.pay_type==="cash").reduce((a,e)=>a+e.amount,0);});
      const total=TKFIELDS.reduce((s,f)=>s+tot[f.db]*f.sign,0);
      rows.push([fmtRange(ws,end),tot.deliveroo.toFixed(2),tot.uber.toFixed(2),tot.cash.toFixed(2),tot.card.toFixed(2),tot.online.toFixed(2),tot.deposit_receipt.toFixed(2),tot.voucher_redemption.toFixed(2),tot.voucher_purchase.toFixed(2),total.toFixed(2),(tot.cash-cashExp).toFixed(2),(total-cashExp).toFixed(2)]);
    });
    return rows;
  }

  async function exportPayroll(){
    if(!gsConfig.webAppUrl||!gsConfig.payrollId)return t("⚠️ Google Sheets not configured — tap ⚙️ Sheets");
    t("⏳ Pushing Payroll tab…");
    const r1=await pushSheet(gsConfig.webAppUrl,gsConfig.payrollId,"Payroll",buildPayroll());
    if(!r1.ok){t("❌ "+r1.err);return;}
    t("⏳ Pushing PayrollWeekly tab…");
    const r2=await pushSheet(gsConfig.webAppUrl,gsConfig.payrollId,"PayrollWeekly",buildPayrollWeekly());
    if(!r2.ok){t("❌ "+r2.err);return;}
    t((r1.unconfirmed||r2.unconfirmed)?"✅ Sent — please double-check the sheet (couldn't confirm delivery)":"✅ Payroll & Weekly tabs updated!");
  }
  async function exportTakings(){
    if(!gsConfig.webAppUrl||!gsConfig.takingsId)return t("⚠️ Google Sheets not configured — tap ⚙️ Sheets");
    t("⏳ Updating Daily tab…");
    const r1=await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Daily",buildDaily());
    if(!r1.ok){t("❌ "+r1.err);return;}
    t("⏳ Updating Weekly tab…");
    const r2=await pushSheet(gsConfig.webAppUrl,gsConfig.takingsId,"Weekly",buildWeekly());
    if(!r2.ok){t("❌ "+r2.err);return;}
    t((r1.unconfirmed||r2.unconfirmed)?"✅ Sent — please double-check the sheet (couldn't confirm delivery)":"✅ Takings sheets updated!");
  }

  // ── Rota share ──
  function buildRotaText(sId){
    const s=staff.find(x=>x.id===sId);if(!s)return"";
    const days=rota[sId]||[];
    const lines=days.map(d=>{const dayName=DAYS_MON[jsToMon(d.jsDay)];const shift=d.type==="Off"?"Off":d.type==="Custom"?`${d.customIn||"?"}–${d.customOut||"?"}`:d.type;return`${dayName} ${fmtDate(d.date)}: ${s.name} — ${shift}`;});
    return`Rota for ${s.name}\n${fmtDate(rotaMon)} – ${fmtDate(addDays(rotaMon,6))}\n\n${lines.join("\n")}`;
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

  // ── AddDeductRow ──
  function AddDeductRow({sid,type}){
    const ex=getExtras(sid);const key=type==="add"?"additions":"deductions";const items=ex[key]||[];const labels=type==="add"?ADD_LBLS:DED_LBLS;
    const[amount,setAmount]=useState("");const[label,setLabel]=useState(labels[0]);const[custom,setCustom]=useState("");
    return(
      <div>
        {items.map((item,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px dashed #F0F0F0"}}><span style={{fontSize:12,color:"#555"}}>{item.label}: £{item.amount}</span><button onClick={()=>updateExtras(sid,ex=>({...ex,[key]:items.filter((_,j)=>j!==i)}))} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"#ccc"}}>✕</button></div>)}
        <div className="addrow">
          <select className="addinp" style={{flex:"none",width:"auto",padding:"6px 7px",fontSize:11}} value={label} onChange={e=>setLabel(e.target.value)}>{labels.map(l=><option key={l}>{l}</option>)}</select>
          <input className="addinp" type="number" min="0" placeholder="£0" value={amount} onChange={e=>setAmount(e.target.value)} style={{width:62}}/>
          <button className={`addbtn${type==="ded"?" r":""}`} onClick={()=>{if(!amount)return;const fl=label==="Other"&&custom?custom:label;updateExtras(sid,ex=>({...ex,[key]:[...(ex[key]||[]),{label:fl,amount}]}));setAmount("");setCustom("");}}>+ Add</button>
        </div>
        {label==="Other"&&<input className="addinp" style={{marginTop:5,width:"100%"}} placeholder="Custom label…" value={custom} onChange={e=>setCustom(e.target.value)}/>}
      </div>
    );
  }

  // ── Payroll card (shared for FOH and kitchen) ──
  function PayrollCard({name,icon,sid,payType,rate,shiftRate,nightRate,calcFn,isKitchen,kitchenId,cardMode,cardFixed,staffId}){
    const p=calcFn();const ex=getExtras(sid);
    const[showOverride,setShowOverride]=useState(!!(ex.manualTotal&&ex.manualTotal!==""));
    const[localCardFixed,setLocalCardFixed]=useState(cardFixed||"0");
    useEffect(()=>{setLocalCardFixed(cardFixed||"0");},[cardFixed]);
    return(
      <div className="paycard">
        <div className="phead">
          <div className="pname">{icon} {name}{p.isOverride&&<span className="chip a" style={{marginLeft:6}}>Manual</span>}</div>
          <div className="ptotal">£{p.total}</div>
        </div>
        <div className="pbody">
          {/* Edit counts */}
          <div style={{background:"#F7F4EF",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:8}}>EDIT COUNTS <span style={{fontWeight:400}}>(blank = auto from rota/clock)</span></div>
            <div style={{display:"flex",gap:8}}>
              {(payType==="shift")&&<><div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>Full Shifts</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder={String(p.full)} value={ex.manualFull||""} onChange={e=>updateExtras(sid,ex=>({...ex,manualFull:e.target.value}))}/></div><div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>Night Shifts</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder={String(p.night)} value={ex.manualNight||""} onChange={e=>updateExtras(sid,ex=>({...ex,manualNight:e.target.value}))}/></div></>}
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>Hours</div><input type="number" min="0" step="0.5" className="inp sm" style={{width:"100%"}} placeholder={p.hrs} value={ex.manualHrs||""} onChange={e=>updateExtras(sid,ex=>({...ex,manualHrs:e.target.value}))}/></div>
            </div>
          </div>
          {payType==="shift"?(<><div className="row"><span>Full Day shifts</span><span className="rowb">{p.full} × £{shiftRate} = £{(p.full*parseFloat(shiftRate||0)).toFixed(2)}</span></div><div className="row"><span>Night shifts</span><span className="rowb">{p.night} × £{nightRate} = £{(p.night*parseFloat(nightRate||0)).toFixed(2)}</span></div></>):(<div className="row"><span>Hours</span><span className="rowb">{p.hrs}h × £{rate} = £{p.base}</span></div>)}
          {isKitchen&&<div style={{marginBottom:8}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>HOURS THIS WEEK</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0" value={kitchenHours[kitchenId]?.hours||""} onChange={e=>updKitchenHours(kitchenId,e.target.value)}/></div>}
          <div className="row"><span>Tips (£)</span><input type="number" className="mini" min="0" placeholder="0.00" value={ex.tips||""} onChange={e=>updateExtras(sid,ex=>({...ex,tips:e.target.value}))}/></div>
          <div style={{marginTop:8}}><div style={{fontSize:11,fontWeight:700,color:"#50DC78",marginBottom:4}}>ADDITIONS</div><AddDeductRow sid={sid} type="add"/></div>
          <div style={{marginTop:8}}><div style={{fontSize:11,fontWeight:700,color:"#E05252",marginBottom:4}}>DEDUCTIONS</div><AddDeductRow sid={sid} type="ded"/></div>
          {/* Notes */}
          <div style={{marginTop:8}}>
            <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>NOTES</div>
            {(ex.notes||[]).map((n,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"2px 0"}}><span style={{fontSize:12,color:"#555"}}>📌 {n}</span><button onClick={()=>updateExtras(sid,ex=>({...ex,notes:ex.notes.filter((_,j)=>j!==i)}))} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:"#ccc"}}>✕</button></div>)}
            <div className="addrow" style={{marginTop:5}}>
              <select className="addinp" style={{fontSize:11,padding:"5px 7px"}} id={`ns-${sid}`}>{["Bank Holiday","Red Day","Custom"].map(l=><option key={l}>{l}</option>)}</select>
              <button className="addbtn" onClick={()=>{const sel=document.getElementById(`ns-${sid}`);if(sel.value==="Custom"){const cn=window.prompt("Enter custom note:");if(cn)updateExtras(sid,ex=>({...ex,notes:[...(ex.notes||[]),cn]}));}else updateExtras(sid,ex=>({...ex,notes:[...(ex.notes||[]),sel.value]}));}}>+ Note</button>
            </div>
          </div>
          <div className="divider"/>
          {/* Card payment mode — editable directly in payroll, same for FOH and kitchen */}
          {p.cardExceeds&&(
            <div style={{background:"#FEE2E2",border:"1.5px solid #E05252",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
              <div style={{fontSize:12,fontWeight:800,color:"#7F1D1D",marginBottom:4}}>⚠️ Fixed card amount is more than was earned</div>
              <div style={{fontSize:11,color:"#991B1B",marginBottom:8}}>Fixed at £{parseFloat(cardFixed||0).toFixed(2)} but only £{p.grossTotal.toFixed(2)} was earned this week. Please correct the amount below.</div>
              <button className="btn danger" style={{marginTop:0,padding:"7px"}} onClick={()=>{const el=document.getElementById(isKitchen?`cf-pk-${kitchenId}`:`cf-ps-${staffId}`);el?.focus();el?.scrollIntoView({behavior:"smooth",block:"center"});}}>Edit Fixed Amount</button>
            </div>
          )}
          <div style={{background:"#F7F4EF",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
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
          <div className="row"><span style={{fontWeight:800}}>Total</span><span style={{fontWeight:900,color:"#F5A623",fontSize:15}}>£{p.total}</span></div>
          {/* Manual override toggle */}
          <button style={{marginTop:8,background:showOverride?"#FEF3C7":"#F0F0F0",border:"none",borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",width:"100%",color:showOverride?"#78350F":"#555"}} onClick={()=>setShowOverride(v=>!v)}>
            {showOverride?"▲ Hide Manual Override":"✏️ Manual Override (fix mistakes)"}
          </button>
          {showOverride&&<div className="override-box">
            <div style={{fontSize:11,color:"#78350F",marginBottom:8,fontWeight:700}}>Enter correct final numbers — overrides all calculations above</div>
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>CASH £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={ex.manualCash||""} onChange={e=>updateExtras(sid,ex=>({...ex,manualCash:e.target.value}))}/></div>
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>CARD £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={ex.manualCard||""} onChange={e=>updateExtras(sid,ex=>({...ex,manualCard:e.target.value}))}/></div>
              <div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>TOTAL £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={ex.manualTotal||""} onChange={e=>updateExtras(sid,ex=>({...ex,manualTotal:e.target.value}))}/></div>
            </div>
            <button className="btn danger" style={{marginTop:8,padding:"8px"}} onClick={()=>updateExtras(sid,ex=>({...ex,manualCash:"",manualCard:"",manualTotal:""}))}>Clear Override</button>
          </div>}
        </div>
      </div>
    );
  }

  // ── Modals ──
  function AddStaffModal({onClose}){
    const[name,setName]=useState("");const[code,setCode]=useState("");const[payType,setPT]=useState("hourly");const[rate,setRate]=useState("");const[shiftRate,setSR]=useState("");const[nightRate,setNR]=useState("");const[cardFixed,setCF]=useState("0");const[err,setErr]=useState("");const[saving,setSaving]=useState(false);
    async function save(){
      setErr("");if(!name.trim())return setErr("Enter a name");if(!/^\d{8}$/.test(code))return setErr("Code must be 8 digits");
      setSaving(true);
      const{error}=await db.from("staff").insert({id:code,name:name.trim(),code,pay_type:payType,rate:rate||"0",shift_rate:shiftRate||"0",night_rate:nightRate||"0",card_fixed:cardFixed||"0",card_mode:"fixed"});
      if(error){setSaving(false);return setErr(error.code==="23505"?"Code already taken":error.message);}
      setStaff(p=>[...p,{id:code,name:name.trim(),code,payType,rate:rate||"0",shiftRate:shiftRate||"0",nightRate:nightRate||"0",cardFixed:cardFixed||"0",cardMode:"fixed"}].sort((a,b)=>a.name.localeCompare(b.name)));
      t("✅ "+name.trim()+" added");onClose();setSaving(false);
    }
    return(<div className="overlay" onClick={onClose}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">➕ Add Staff Member</div><div className="ssub2">Front of house staff added directly by manager</div>
      <label className="lbl">Full Name</label><input className="inp" placeholder="e.g. Amy Chen" value={name} onChange={e=>setName(e.target.value)}/>
      <label className="lbl">8-Digit Code</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} onChange={e=>setCode(e.target.value)}/>
      <label className="lbl">Pay Method</label><div className="toggle" style={{marginBottom:14}}><button className={`tgl${payType==="hourly"?" on":""}`} onClick={()=>setPT("hourly")}>By Hour</button><button className={`tgl${payType==="shift"?" on":""}`} onClick={()=>setPT("shift")}>By Shift</button></div>
      <div style={{display:"flex",gap:8}}>
        <div style={{flex:1}}><label className="lbl">£/HR</label><input className="inp" type="number" placeholder="0.00" value={rate} onChange={e=>setRate(e.target.value)}/></div>
        <div style={{flex:1}}><label className="lbl">Full Shift £</label><input className="inp" type="number" placeholder="0.00" value={shiftRate} onChange={e=>setSR(e.target.value)}/></div>
        <div style={{flex:1}}><label className="lbl">Night £</label><input className="inp" type="number" placeholder="0.00" value={nightRate} onChange={e=>setNR(e.target.value)}/></div>
      </div>
      <label className="lbl">Fixed Card Payment (£)</label><input className="inp" type="number" placeholder="0.00" value={cardFixed} onChange={e=>setCF(e.target.value)}/>
      {err&&<div className="err">{err}</div>}
      <button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Add Staff Member"}</button>
      <button className="btn sec" onClick={onClose}>Cancel</button>
    </div></div>);
  }

  function PinModal({onClose}){
    const[curr,setCurr]=useState("");const[n1,setN1]=useState("");const[n2,setN2]=useState("");const[err,setErr]=useState("");const[saving,setSaving]=useState(false);
    async function save(){setErr("");setSaving(true);const{data}=await db.from("app_settings").select("value").eq("key","manager_pin").maybeSingle();if(curr!==(data?.value||"00000000")){setErr("Current PIN wrong");setSaving(false);return;}if(!/^\d{8}$/.test(n1)){setErr("New PIN must be 8 digits");setSaving(false);return;}if(n1!==n2){setErr("PINs don't match");setSaving(false);return;}await db.from("app_settings").upsert({key:"manager_pin",value:n1});t("✅ PIN updated!");onClose();setSaving(false);}
    return(<div className="overlay" onClick={onClose}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">🔒 Change Manager PIN</div><label className="lbl">Current PIN</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={curr} onChange={e=>setCurr(e.target.value)}/><label className="lbl">New PIN</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={n1} onChange={e=>setN1(e.target.value)}/><label className="lbl">Confirm New PIN</label><input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={n2} onChange={e=>setN2(e.target.value)}/>{err&&<div className="err">{err}</div>}<button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Change PIN"}</button><button className="btn sec" onClick={onClose}>Cancel</button></div></div>);
  }

  function SettingsModal({onClose}){
    const[webAppUrl,setWebAppUrl]=useState(gsConfig.webAppUrl||"");const[payrollId,setPayrollId]=useState(gsConfig.payrollId||"");const[takingsId,setTakingsId]=useState(gsConfig.takingsId||"");const[saving,setSaving]=useState(false);const[showScript,setShowScript]=useState(false);const[testing,setTesting]=useState(false);const[testResult,setTestResult]=useState(null);
    async function save(){setSaving(true);await saveGsConfig({webAppUrl,payrollId,takingsId});setSaving(false);onClose();}
    async function runTest(){setTesting(true);setTestResult(null);const r=await testWebApp(webAppUrl);setTestResult(r);setTesting(false);}
    const scriptCode=`function doGet(e) {\n  return ContentService.createTextOutput(JSON.stringify({ok:true,msg:"Sheets bridge is live"})).setMimeType(ContentService.MimeType.JSON);\n}\n\nfunction doPost(e) {\n  try {\n    var body = JSON.parse(e.postData.contents);\n    var ss = SpreadsheetApp.openById(body.spreadsheetId);\n    var sheet = ss.getSheetByName(body.tab);\n    if (!sheet) sheet = ss.insertSheet(body.tab);\n    sheet.clearContents();\n    if (body.rows && body.rows.length > 0) {\n      sheet.getRange(1, 1, body.rows.length, body.rows[0].length).setValues(body.rows);\n    }\n    return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);\n  } catch (err) {\n    return ContentService.createTextOutput(JSON.stringify({ok:false,error:err.message})).setMimeType(ContentService.MimeType.JSON);\n  }\n}`;
    return(<div className="overlay" onClick={onClose}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">🔗 Google Sheets</div><div className="ssub2">Saved permanently in Supabase — set once, never lost</div>
      <div style={{background:"#FEE2E2",border:"1.5px solid #E05252",borderRadius:10,padding:"10px 12px",fontSize:12,color:"#7F1D1D",marginBottom:14,lineHeight:1.6}}>
        <strong>Important:</strong> Google no longer allows a simple API key to write to Sheets (only to read). Instead this app talks to a tiny free script that runs on your own Google account — a "Web App". You only set this up once, it takes about 3 minutes.
      </div>
      <button className="btn sec" style={{marginTop:0,marginBottom:14}} onClick={()=>setShowScript(v=>!v)}>{showScript?"▲ Hide setup steps":"▼ Show 3-minute setup steps"}</button>
      {showScript&&(
        <div style={{background:"#F7F4EF",borderRadius:10,padding:"12px 13px",fontSize:12,color:"#444",marginBottom:14,lineHeight:1.8}}>
          <strong>Step 1</strong> — Go to <strong>script.google.com</strong> → click <strong>New project</strong><br/>
          <strong>Step 2</strong> — Delete anything in the editor, paste in this code:
          <textarea readOnly className="lognote" rows={12} style={{fontFamily:"monospace",fontSize:10,marginTop:6,marginBottom:6,background:"#fff"}} value={scriptCode} onClick={e=>e.target.select()}/>
          <button className="btn sm" style={{marginBottom:10}} onClick={()=>{navigator.clipboard.writeText(scriptCode);t("📋 Script copied!");}}>📋 Copy Script</button><br/>
          <strong>Step 3</strong> — Click <strong>Deploy</strong> (top right) → <strong>New deployment</strong><br/>
          <strong>Step 4</strong> — Click the gear ⚙️ next to "Select type" → choose <strong>Web app</strong><br/>
          <div style={{background:"#FEE2E2",border:"1px solid #E05252",borderRadius:8,padding:"8px 10px",margin:"6px 0"}}>
            <strong>Step 5 — the step people get wrong:</strong> Set "Execute as" = <strong>Me</strong>. Set "Who has access" = <strong>Anyone</strong> — NOT "Anyone with Google account". Picking the wrong one makes it ask for a Google sign-in and the app can't reach it.
          </div>
          <strong>Step 6</strong> — Click <strong>Deploy</strong> — it will ask to authorize, click through and allow it (this is your own script on your own account)<br/>
          <strong>Step 7</strong> — Copy the <strong>Web app URL</strong> it gives you — it must end in <strong>/exec</strong> (not /dev) — and paste it below<br/>
          <strong>Step 8</strong> — Make sure both your Google Sheets are set to <strong>"Anyone with the link can edit"</strong><br/>
          <div style={{background:"#FFF8EC",border:"1px solid #F5A623",borderRadius:8,padding:"8px 10px",marginTop:6}}>
            <strong>If you ever edit the script later:</strong> you must go to Deploy → Manage deployments → ✏️ edit → Version: <strong>New version</strong> → Deploy again, or your changes won't take effect.
          </div>
        </div>
      )}
      <label className="lbl">Web App URL</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:8}} placeholder="https://script.google.com/macros/s/…/exec" value={webAppUrl} onChange={e=>{setWebAppUrl(e.target.value);setTestResult(null);}}/>
      <button className="btn sec" style={{marginTop:0,marginBottom:14}} onClick={runTest} disabled={testing||!webAppUrl}>{testing?"Testing…":"🔍 Test Connection"}</button>
      {testResult&&(
        <div style={{background:testResult.ok?"#D1FAE5":"#FEE2E2",border:`1.5px solid ${testResult.ok?"#50DC78":"#E05252"}`,borderRadius:10,padding:"10px 12px",marginBottom:14,fontSize:12,color:testResult.ok?"#065F46":"#7F1D1D"}}>
          {testResult.ok?"✅ Connected! The script is reachable and working.":`❌ ${testResult.err}`}
        </div>
      )}
      <label className="lbl">Payroll Spreadsheet ID</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} placeholder="1Wj0EH…" value={payrollId} onChange={e=>setPayrollId(e.target.value)}/>
      <label className="lbl">Takings Spreadsheet ID</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} placeholder="1K-UMB…" value={takingsId} onChange={e=>setTakingsId(e.target.value)}/>
      <div style={{fontSize:11,color:"#aaa",marginBottom:10}}>The Spreadsheet ID is the long code in the sheet's URL between <strong>/d/</strong> and <strong>/edit</strong>.</div>
      <button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Save & Connect"}</button><button className="btn sec" onClick={onClose}>Cancel</button>
    </div></div>);
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
          <button onClick={()=>setSettingsModal(true)} style={{background:"rgba(255,255,255,.12)",border:"none",color:gsReady?"#50DC78":"#F5A623",borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:12}}>⚙️ Sheets</button>
          <button onClick={()=>setPinModal(true)} style={{background:"rgba(255,255,255,.12)",border:"none",color:"rgba(255,255,255,.7)",borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:12}}>🔒 PIN</button>
          <button className="mlo" onClick={onLogout}>Sign out</button>
        </div>
      </div>

      <div className="mtabs">
        {[{id:"staff",label:"👥 Staff"},{id:"rota",label:"📋 Rota"},{id:"clock",label:"⏱ Clock"},{id:"payroll",label:"💷 Payroll"},{id:"takings",label:`📊 Takings${newCount>0?` (${newCount})`:""}`},{id:"expenses",label:"🧾 Expenses"},{id:"absence",label:"📅 Absences"}]
          .map(tb=><button key={tb.id} className={`mtab${tab===tb.id?" on":""}`} onClick={()=>setTab(tb.id)}>{tb.label}</button>)}
      </div>

      <div className="mbody">

        {/* ══ STAFF ══ */}
        {tab==="staff"&&(
          <>
            <div className="sec">Staff Management</div>
            <button className="btn navy" style={{marginBottom:14}} onClick={()=>setAddStaffModal(true)}>➕ Add Staff Member</button>

            {staff.length===0&&<div className="empty"><div className="emptyicon">👥</div><div className="emptytxt">No staff yet — add one above</div></div>}
            {staff.map(s=>{
              const payLabel=s.payType==="shift"?`Full £${s.shiftRate||"0"} / Night £${s.nightRate||"0"} per shift`:`£${s.rate||"0"} per hour`;
              return(
                <div key={s.id} className="card w" style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{display:"flex",gap:10,alignItems:"center"}}>
                      <div className="avatar" style={{width:38,height:38,fontSize:15}}>{s.name[0]}</div>
                      <div><div style={{fontSize:15,fontWeight:800,color:"#1A2744"}}>{s.name}</div><div style={{fontSize:11,color:"#aaa"}}>Code: {s.code}</div></div>
                    </div>
                    <span className="chip" style={{background:s.payType==="shift"?"#DBEAFE":"#D1FAE5",color:s.payType==="shift"?"#1E40AF":"#065F46"}}>{s.payType==="shift"?"By Shift":"By Hour"}</span>
                  </div>
                  <div style={{background:"#F7F4EF",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                    <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:4}}>{payLabel}</div>
                    <div style={{fontSize:11,color:"#888"}}>{(s.cardMode||"fixed")==="cash"?"💵 Always paid in cash":s.cardMode==="card"?"💳 Always paid by card":`💳 Card fixed: £${s.cardFixed||"0"} · 💵 Rest is cash`}</div>
                  </div>
                  <label className="lbl">Pay Method</label>
                  <div className="toggle" style={{marginBottom:12}}>
                    <button className={`tgl${s.payType==="hourly"?" on":""}`} onClick={async()=>{setStaff(p=>p.map(x=>x.id===s.id?{...x,payType:"hourly"}:x));await db.from("staff").update({pay_type:"hourly"}).eq("id",s.id);t(`${s.name} → By Hour`);}}>By Hour</button>
                    <button className={`tgl${s.payType==="shift"?" on":""}`} onClick={async()=>{setStaff(p=>p.map(x=>x.id===s.id?{...x,payType:"shift"}:x));await db.from("staff").update({pay_type:"shift"}).eq("id",s.id);t(`${s.name} → By Shift`);}}>By Shift</button>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <div style={{flex:1,minWidth:80}}>
                      <div style={{fontSize:10,fontWeight:700,color:s.payType==="hourly"?"#065F46":"#aaa",marginBottom:3}}>£/HR{s.payType==="hourly"?" ✅":""}</div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%",borderColor:s.payType==="hourly"?"#50DC78":"#E5E5E5"}} placeholder="0.00" value={s.rate||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,rate:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({rate:e.target.value}).eq("id",s.id);t(`${s.name} rate saved`);}}/>
                    </div>
                    <div style={{flex:1,minWidth:80}}>
                      <div style={{fontSize:10,fontWeight:700,color:s.payType==="shift"?"#1E40AF":"#aaa",marginBottom:3}}>FULL £{s.payType==="shift"?" ✅":""}</div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%",borderColor:s.payType==="shift"?"#BFDBFE":"#E5E5E5"}} placeholder="0.00" value={s.shiftRate||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,shiftRate:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({shift_rate:e.target.value}).eq("id",s.id);t(`${s.name} full shift rate saved`);}}/>
                    </div>
                    <div style={{flex:1,minWidth:80}}>
                      <div style={{fontSize:10,fontWeight:700,color:s.payType==="shift"?"#1E40AF":"#aaa",marginBottom:3}}>NIGHT £{s.payType==="shift"?" ✅":""}</div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%",borderColor:s.payType==="shift"?"#BFDBFE":"#E5E5E5"}} placeholder="0.00" value={s.nightRate||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,nightRate:e.target.value}:x))} onBlur={async e=>{await db.from("staff").update({night_rate:e.target.value}).eq("id",s.id);t(`${s.name} night rate saved`);}}/>
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
                      <div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>FIXED CARD AMOUNT (£) <span style={{fontWeight:400}}>— rest is cash, never exceeds what's earned</span></div>
                      <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.cardFixed||""} onChange={e=>setStaff(p=>p.map(x=>x.id===s.id?{...x,cardFixed:e.target.value}:x))} onBlur={async e=>{checkCardWarning(s.name,e.target.value,calcPay(s).grossTotal,`cf-s-${s.id}`);await db.from("staff").update({card_fixed:e.target.value}).eq("id",s.id);t(`${s.name} card amount saved`);}} id={`cf-s-${s.id}`}/>
                    </div>
                  )}

                  <button className="btn danger" style={{marginTop:10,padding:"10px"}} onClick={()=>removeStaff(s)}>🗑️ Remove {s.name.split(" ")[0]}</button>
                </div>
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
                    <div style={{fontSize:15,fontWeight:800,color:"#1A2744"}}>{k.name}</div>
                  </div>
                  <button onClick={()=>delKitchen(k.id)} style={{background:"none",border:"none",cursor:"pointer",fontSize:15,color:"#ddd"}}>🗑️</button>
                </div>
                <label className="lbl">Pay Method</label>
                <div className="toggle" style={{marginBottom:12}}>
                  <button className={`tgl${(k.payType||"hourly")==="hourly"?" on":""}`} onClick={()=>{updKitchenField(k.id,"pay_type","hourly");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,payType:"hourly"}:x));}}>By Hour</button>
                  <button className={`tgl${k.payType==="shift"?" on":""}`} onClick={()=>{updKitchenField(k.id,"pay_type","shift");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,payType:"shift"}:x));}}>By Shift</button>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                  <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>£/HR</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.rate||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,rate:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"rate",e.target.value)}/></div>
                  <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>FULL SHIFT £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.shiftRate||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,shiftRate:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"shift_rate",e.target.value)}/></div>
                  <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>NIGHT £</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.nightRate||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,nightRate:e.target.value}:x))} onBlur={e=>updKitchenField(k.id,"night_rate",e.target.value)}/></div>
                </div>
                <label className="lbl" style={{marginTop:12}}>Card Payment</label>
                <div className="toggle" style={{marginBottom:10,width:"100%"}}>
                  <button className={`tgl${(k.cardMode||"fixed")==="fixed"?" on":""}`} style={{flex:1}} onClick={()=>{updKitchenField(k.id,"card_mode","fixed");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardMode:"fixed"}:x));}}>Fixed £</button>
                  <button className={`tgl${k.cardMode==="cash"?" on":""}`} style={{flex:1}} onClick={()=>{updKitchenField(k.id,"card_mode","cash");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardMode:"cash"}:x));}}>All Cash</button>
                  <button className={`tgl${k.cardMode==="card"?" on":""}`} style={{flex:1}} onClick={()=>{updKitchenField(k.id,"card_mode","card");setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardMode:"card"}:x));}}>All Card</button>
                </div>
                {(k.cardMode||"fixed")==="fixed"&&(
                  <div style={{marginBottom:4}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>FIXED CARD AMOUNT (£) <span style={{fontWeight:400}}>— rest is cash, never exceeds what's earned</span></div>
                    <input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.cardFixed||""} onChange={e=>setKitchenStaff(p=>p.map(x=>x.id===k.id?{...x,cardFixed:e.target.value}:x))} onBlur={e=>{checkCardWarning(k.name,e.target.value,calcKitchenPay(k).grossTotal,`cf-k-${k.id}`);updKitchenField(k.id,"card_fixed",e.target.value);}} id={`cf-k-${k.id}`}/>
                  </div>
                )}
              </div>
            ))}
            <div style={{background:"#F7F4EF",borderRadius:12,padding:"12px 14px",fontSize:12,color:"#888",lineHeight:1.6,marginTop:8}}>
              <strong style={{color:"#1A2744"}}>Self-registration:</strong> Staff can also register themselves via the Staff login screen.
            </div>
          </>
        )}

        {/* ══ ROTA ══ */}
        {tab==="rota"&&(
          <>
            <div className="sec">Assign Rota</div>
            <div className="wnav">
              <button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,-7))}>‹</button>
              <div className="wnavlbl">{fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon,6))}</div>
              <button className="wnavbtn" onClick={()=>setRotaMon(addDays(rotaMon,7))}>›</button>
            </div>
            {rejections.length>0&&<div style={{marginBottom:10}}><div style={{fontSize:12,fontWeight:700,color:"#E05252",marginBottom:6}}>⚠️ Rejections</div>{rejections.map(r=><div key={r.id} className="rejbanner"><span><strong>{r.staff_name}</strong> can't do <strong>{r.day}</strong>{r.reason?` — "${r.reason}"`:""}</span><button onClick={async()=>{await db.from("rejections").delete().eq("id",r.id);setRejections(p=>p.filter(x=>x.id!==r.id));}} style={{background:"none",border:"none",cursor:"pointer",fontSize:16}}>✓</button></div>)}</div>}
            {staff.map(s=>{const days=rota[s.id]||[];const conflicts=absConflicts(s.id);return(
              <div key={s.id} className="card">
                <div className="chead">
                  <div><div className="cname">👤 {s.name}</div><div className="csub">{s.payType==="shift"?`Full £${s.shiftRate}/Night £${s.nightRate}`:`£${s.rate}/hr`}</div></div>
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
              <button className={`btn sm${clockShowAll?" navy":" sec"}`} onClick={()=>setClockShowAll(v=>!v)}>{clockShowAll?"✓ All Dates":"All Dates"}</button>
            </div>
            {staff.map(s=>{
              const sLogsAll=clockLogs.filter(l=>l.staff_id===s.id);
              const sLogs=clockShowAll?sLogsAll:sLogsAll.filter(l=>l.date===clockDate);
              const totalH=sLogs.reduce((a,l)=>a+roundHrsUp(parseHrs(l.time_in,l.time_out)),0);
              return(
              <div key={s.id} className="card">
                <div className="cname">👤 {s.name}</div><div className="csub" style={{marginBottom:10}}>{clockShowAll?"All time":dispDate(clockDate,true)} total: {totalH.toFixed(2)} hrs</div>
                {sLogs.length===0&&<div style={{fontSize:12,color:"#ccc",fontStyle:"italic"}}>No records {clockShowAll?"yet":"for this date"}</div>}
                {sLogs.map(l=>(
                  <div key={l.id} className="logentry">
                    <div className="logtop"><span style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>{dispDate(l.date,true)}</span><span style={{fontSize:13,fontWeight:800,color:l.time_out?"#1A2744":"#50DC78"}}>{l.time_out?roundHrsUp(parseHrs(l.time_in,l.time_out)).toFixed(2)+"h":"active"}</span></div>
                    <div className="logedit"><span className="logelbl">In</span><input type="time" className="inp time" value={l.time_in||""} onChange={e=>{const v=e.target.value;setClockLogs(p=>p.map(x=>x.id===l.id?{...x,time_in:v}:x));db.from("clock_logs").update({time_in:v}).eq("id",l.id);}}/><span className="logelbl">Out</span><input type="time" className="inp time" value={l.time_out||""} onChange={e=>{const v=e.target.value;setClockLogs(p=>p.map(x=>x.id===l.id?{...x,time_out:v}:x));db.from("clock_logs").update({time_out:v}).eq("id",l.id);}}/></div>
                    <textarea className="lognote" rows={2} placeholder="Note…" value={l.note||""} onChange={e=>{const v=e.target.value;setClockLogs(p=>p.map(x=>x.id===l.id?{...x,note:v}:x));db.from("clock_logs").update({note:v}).eq("id",l.id);}}/>
                  </div>
                ))}
                <button className="btn sm" style={{marginTop:9,background:"#F5A623"}} onClick={async()=>{const dateForEntry=clockShowAll?todayISO():clockDate;const{data,error}=await db.from("clock_logs").insert({staff_id:s.id,staff_name:s.name,date:dateForEntry,time_in:"",time_out:"",note:""}).select().single();if(!error)setClockLogs(p=>[data,...p]);else t("❌ "+error.message);}}>+ Add Entry {clockShowAll?"":`for ${dispDate(clockDate)}`}</button>
              </div>
            );})}
          </>
        )}

        {/* ══ PAYROLL ══ */}
        {tab==="payroll"&&(
          <>
            <div className="sec">Payroll</div>
            <div className="ssub">Private — staff never see salaries</div>
            <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center"}}>
              <input type="date" className="inp sm" style={{flex:1}} value={weekRange.start} onChange={e=>setWeekRange(p=>({...p,start:e.target.value}))}/>
              <span style={{fontSize:12,color:"#aaa"}}>→</span>
              <input type="date" className="inp sm" style={{flex:1}} value={weekRange.end} onChange={e=>setWeekRange(p=>({...p,end:e.target.value}))}/>
            </div>
            <div style={{fontSize:13,fontWeight:800,color:"#1A2744",marginBottom:8}}>Front of House</div>
            {staff.map(s=><PayrollCard key={s.id} name={s.name} icon="👤" sid={s.id} payType={s.payType} rate={s.rate} shiftRate={s.shiftRate} nightRate={s.nightRate} calcFn={()=>calcPay(s)} isKitchen={false} cardMode={s.cardMode||"fixed"} cardFixed={s.cardFixed} staffId={s.id}/>)}
            <div style={{fontSize:13,fontWeight:800,color:"#1A2744",margin:"14px 0 8px"}}>Kitchen Staff</div>
            <div style={{display:"flex",gap:6,marginBottom:10}}>
              <input className="inp sm" style={{flex:1}} placeholder="Add kitchen staff name…" value={newKName} onChange={e=>setNewKName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addKitchen()}/>
              <button className="btn sm navy" onClick={addKitchen}>Add</button>
            </div>
            {kitchenStaff.length===0&&<div style={{fontSize:13,color:"#ccc",marginBottom:10,fontStyle:"italic"}}>No kitchen staff yet — add via Staff tab</div>}
            {kitchenStaff.map(k=><PayrollCard key={k.id} name={k.name} icon="👨‍🍳" sid={kId(k.id)} payType={k.payType||"hourly"} rate={k.rate} shiftRate={k.shiftRate} nightRate={k.nightRate} calcFn={()=>calcKitchenPay(k)} isKitchen={true} kitchenId={k.id} cardMode={k.cardMode||"fixed"} cardFixed={k.cardFixed}/>)}
            <div className="psum">
              <div className="psumtitle">Week Summary — {fmtRange(weekRange.start,weekRange.end)}</div>
              <div className="psumrow"><span>💵 Total Cash</span><span className="psumamt">£{totCash}</span></div>
              <div className="psumrow"><span>💳 Total Card</span><span className="psumamt">£{totCard}</span></div>
              <div className="psumrow"><span>Grand Total</span><span className="psumamt">£{totGross}</span></div>
            </div>
            <div className="expsec">
              <div className="exptitle">📤 Export Payroll</div>
              {!gsReady&&<div className="gs-banner">⚠️ <strong>Google Sheets not connected.</strong> Tap ⚙️ Sheets in header.</div>}
              <button className="expbtn p" onClick={exportPayroll}>🔗 Push to Payroll Sheet (Staff + Weekly tabs)</button>
              <button className="expbtn s" onClick={()=>copyTSV(buildPayroll(),t)}>📋 Copy Staff Data</button>
              <button className="expbtn s" onClick={()=>copyTSV(buildPayrollWeekly(),t)}>📋 Copy Weekly Summary</button>
              <button className="expbtn s" onClick={()=>setCashPopup(true)}>💵 View Cash Payments</button>
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
        {tab==="expenses"&&<ExpensesTab expenses={expenses} onAdd={addExpense} onDelete={delExpense} onUpdate={updateExpense} toast={t}/>}

        {/* ══ ABSENCES ══ */}
        {tab==="absence"&&(
          <>
            <div className="sec">Absences</div>
            <button className="btn navy" style={{marginBottom:14}} onClick={()=>{setAbsModal(true);setAbsStaff("");setAbsDate("");setAbsPeriod("");}}>+ Log Absence for Staff</button>
            {absences.length===0?<div className="empty"><div className="emptyicon">📅</div><div className="emptytxt">No absences reported</div></div>
              :absences.map(a=><div key={a.id} style={{background:"#FFF8EC",border:"1.5px solid #F5A623",borderRadius:12,padding:"10px 13px",marginBottom:9,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontWeight:800,color:"#1A2744",fontSize:13}}>👤 {a.staff_name}</div><div style={{fontSize:12,color:"#888",marginTop:2}}>{dispDate(a.date,true)} — {a.period}</div></div><button onClick={async()=>{await db.from("absences").delete().eq("id",a.id);setAbsences(p=>p.filter(x=>x.id!==a.id));}} style={{background:"none",border:"none",cursor:"pointer",fontSize:15,color:"#ccc"}}>🗑️</button></div>)}
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

      {cashPopup&&<div className="overlay" onClick={()=>setCashPopup(false)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">💵 Cash Payments</div><div className="ssub2">{fmtRange(weekRange.start,weekRange.end)}</div>{staff.filter(s=>parseFloat(calcPay(s).cashAmt)>0).map(s=>{const p=calcPay(s);return<div key={s.id} className="cashrow"><span className="cashname">{s.name}</span><span className="cashamt">£{p.cashAmt}</span></div>;})}  {kitchenStaff.filter(k=>parseFloat(calcKitchenPay(k).cashAmt)>0).map(k=>{const p=calcKitchenPay(k);return<div key={k.id} className="cashrow"><span className="cashname">👨‍🍳 {k.name}</span><span className="cashamt">£{p.cashAmt}</span></div>;})} <div style={{borderTop:"2px solid #F0F0F0",marginTop:10,paddingTop:10,display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:800,color:"#1A2744"}}><span>Total Cash Out</span><span>£{totCash}</span></div><button className="btn sec" style={{marginTop:14}} onClick={()=>setCashPopup(false)}>Close</button></div></div>}
      {shareModal&&<div className="overlay" onClick={()=>setShareModal(null)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">📤 Share Rota</div><div className="ssub2">{staff.find(s=>s.id===shareModal)?.name}</div><textarea className="lognote" rows={12} readOnly style={{fontFamily:"monospace",fontSize:12,background:"#F7F4EF"}} value={buildRotaText(shareModal)}/><button className="btn" style={{marginTop:12}} onClick={()=>{navigator.clipboard.writeText(buildRotaText(shareModal)).then(()=>t("📋 Copied!"));setShareModal(null);}}>📋 Copy</button><button className="btn sec" onClick={()=>setShareModal(null)}>Close</button></div></div>}
      {absModal&&<div className="overlay" onClick={()=>setAbsModal(false)}><div className="sheet" onClick={e=>e.stopPropagation()}><div className="stitle">📅 Log Absence</div><label className="lbl">Staff Member</label><select className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} value={absStaff} onChange={e=>setAbsStaff(e.target.value)}><option value="">— Select —</option>{staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><label className="lbl">Date</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} value={absDate} onChange={e=>setAbsDate(e.target.value)}/><label className="lbl" style={{marginBottom:8}}>Period</label><div className="peribtns">{["Morning","Evening","Full Day"].map(p=><button key={p} className={`pbtn${absPeriod===p?" sel":""}`} onClick={()=>setAbsPeriod(p)}>{p==="Morning"?"🌅":p==="Evening"?"🌙":"☀️"}<br/>{p}</button>)}</div><button className="btn" style={{marginTop:12}} onClick={async()=>{if(!absStaff||!absDate||!absPeriod)return t("Fill in all fields");const s=staff.find(x=>x.id===absStaff);const{data,error}=await db.from("absences").insert({staff_id:absStaff,staff_name:s?.name||"",date:absDate,period:absPeriod}).select().single();if(!error){setAbsences(p=>[...p,data]);setAbsModal(false);t("📅 Absence logged");}else t("❌ "+error.message);}}>Save Absence</button><button className="btn sec" onClick={()=>setAbsModal(false)}>Cancel</button></div></div>}
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
      setTakings(p=>p.map(x=>x.id===sub.id?{...x,is_new:false}:x));
      // Auto-push to Google Sheets if connected and this was a staff submission
      if(gsReady&&sub.staff_id!=="manager"){await autoPushDay(sub.date);toast("✅ Marked seen & pushed to Sheets");}
      else toast("✅ Marked as seen");
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
            const total=TKFIELDS.reduce((s,f)=>s+parseFloat(sub[f.db]||0)*f.sign,0);
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
              <div style={{fontSize:13,fontWeight:800,color:"#1A2744",marginBottom:8}}>👤 {s.name}</div>
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

      {/* All seen submissions */}
      {takings.filter(s=>!s.is_new&&s.staff_id!=="manager").length>0&&(
        <>
          <div style={{fontSize:13,fontWeight:800,color:"#1A2744",marginBottom:8}}>✅ Reviewed Submissions</div>
          {[...takings].filter(s=>!s.is_new&&s.staff_id!=="manager").sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10).map(sub=>{
            const total=TKFIELDS.reduce((s,f)=>s+parseFloat(sub[f.db]||0)*f.sign,0);
            return(<div key={sub.id} className="tmsg"><div className="tmsg-h">✓ {sub.staff_name} · {dispDate(sub.date,true)}<span style={{float:"right",fontSize:14,fontWeight:900}}>£{total.toFixed(2)}</span></div><div className="tmsg-d">{TKFIELDS.filter(f=>parseFloat(sub[f.db]||0)>0).map(f=>`${f.label.replace(/[🛵💵💳🌐🎟️🎫]/g,"").trim()}: £${sub[f.db]}`).join(" · ")}</div></div>);
          })}
        </>
      )}

      {/* Manager entry / overwrite */}
      <div className="card" style={{marginTop:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div className="cname">✏️ {editMode?"Edit Existing Takings":"Enter Takings Manually"}</div>
          <button style={{background:editMode?"#FEE2E2":"#DBEAFE",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",color:editMode?"#7F1D1D":"#1E40AF"}} onClick={()=>setEditMode(v=>!v)}>
            {editMode?"+ New Entry":"✏️ Edit Existing"}
          </button>
        </div>
        {editMode?(
          <TakingsEditForm takings={takings} upsertTakings={upsertTakings} toast={toast}/>
        ):(
          <TakingsForm setTakings={setTakings} toast={toast}/>
        )}
      </div>

      <div className="expsec">
        <div className="exptitle">📤 Export Takings</div>
        {!gsReady&&<div className="gs-banner">⚠️ <strong>Google Sheets not connected.</strong> Tap ⚙️ Sheets in header.</div>}
        <button className="expbtn p" onClick={exportTakings}>🔗 Push to Takings Sheet (Daily + Weekly)</button>
        <button className="expbtn s" onClick={()=>copyTSV([...buildDaily(),[""],[""]], toast)}>📋 Copy Daily Data</button>
      </div>
    </>
  );
}

// ── Takings edit existing form ──
function TakingsEditForm({takings,upsertTakings,toast}){
  const[date,setDate]=useState(todayISO());
  const[values,setValues]=useState({});const[cc,setCC]=useState({});const[note,setNote]=useState("");const[saving,setSaving]=useState(false);
  const[loaded,setLoaded]=useState(false);

  function loadForDate(d){
    const existing=takings.find(s=>s.date===d&&s.staff_id==="manager");
    if(existing){const v={};TKFIELDS.forEach(f=>{v[f.key]=String(existing[f.db]||"");});const c={};TKFIELDS.filter(f=>f.ccDb).forEach(f=>{c[f.key]=existing[f.ccDb]||"cash";});setValues(v);setCC(c);setNote(existing.note||"");}
    else{setValues({});setCC({});setNote("");}
    setLoaded(true);
  }

  async function save(){
    setSaving(true);
    const vals={};TKFIELDS.forEach(f=>{vals[f.db]=parseFloat(values[f.key]||0);if(f.ccDb)vals[f.ccDb]=cc[f.key]||"cash";});
    const r=await upsertTakings(date,vals,note);
    if(r.ok)toast("✅ Takings updated!");else toast("❌ "+r.err);
    setSaving(false);
  }

  return(
    <>
      <div style={{fontSize:12,color:"#888",marginBottom:10}}>Select a date to edit or overwrite existing takings for that day.</div>
      <label className="lbl">Date</label>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <input type="date" className="inp sm" style={{flex:1}} value={date} onChange={e=>{setDate(e.target.value);setLoaded(false);}}/>
        <button className="btn sm navy" onClick={()=>loadForDate(date)}>Load</button>
      </div>
      {loaded&&<>
        <div style={{fontSize:12,color:takings.find(s=>s.date===date&&s.staff_id==="manager")?"#065F46":"#888",fontWeight:700,marginBottom:10}}>
          {takings.find(s=>s.date===date&&s.staff_id==="manager")?"✅ Existing record loaded — editing will overwrite":"📝 No existing manager entry — will create new"}
        </div>
        {TKFIELDS.map(f=><div key={f.key} className="tfield"><div className="tlbl"><span>{f.label}</span>{f.cc&&<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl${(cc[f.key]||"cash")===c?" on":""}`} onClick={()=>setCC(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>}</div>{f.hint&&<div className="thint">{f.hint}</div>}<input className="inp sm" style={{display:"block",width:"100%",marginTop:3}} type="number" min="0" placeholder="0.00" value={values[f.key]||""} onChange={e=>setValues(p=>({...p,[f.key]:e.target.value}))}/></div>)}
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
      {TKFIELDS.map(f=><div key={f.key} className="tfield"><div className="tlbl"><span>{f.label}</span>{f.cc&&<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl${(cc[f.key]||"cash")===c?" on":""}`} onClick={()=>setCC(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>}</div>{f.hint&&<div className="thint">{f.hint}</div>}<input className="inp sm" style={{display:"block",width:"100%",marginTop:3}} type="number" min="0" placeholder="0.00" value={values[f.key]||""} onChange={e=>setValues(p=>({...p,[f.key]:e.target.value}))}/></div>)}
      <label className="lbl" style={{marginTop:8}}>Note</label><textarea className="lognote" rows={2} style={{marginBottom:10}} placeholder="Any notes…" value={note} onChange={e=>setNote(e.target.value)}/>
      <button className="btn" onClick={submit} disabled={saving}>{saving?"Saving…":"Save Takings"}</button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EXPENSES TAB
// ═══════════════════════════════════════════════════════════════════
function ExpensesTab({expenses,onAdd,onDelete,onUpdate,toast}){
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
        <div style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>Add / Edit</div>
        <button style={{background:editMode?"#FEE2E2":"#DBEAFE",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",color:editMode?"#7F1D1D":"#1E40AF"}} onClick={()=>{setEditMode(v=>!v);setEditExpense(null);}}>
          {editMode?"+ Add New":"✏️ Edit Existing"}
        </button>
      </div>

      {!editMode?(
        <div className="card">
          <label className="lbl">Date</label><input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:10}} value={date} onChange={e=>setDate(e.target.value)}/>
          <label className="lbl">Description</label><input className="inp sm" style={{display:"block",width:"100%",marginBottom:10}} placeholder="e.g. Cleaning supplies" value={desc} onChange={e=>setDesc(e.target.value)}/>
          <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"flex-end"}}>
            <div style={{flex:1}}><label className="lbl">Amount (£)</label><input className="inp sm" style={{width:"100%"}} type="number" min="0" placeholder="0.00" value={amount} onChange={e=>setAmount(e.target.value)}/></div>
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
                <div><div style={{fontSize:13,fontWeight:700,color:editExpense?.id===e.id?"#F5A623":"#1A2744"}}>{e.description}</div><div style={{fontSize:11,color:"#aaa"}}>{e.pay_type==="cash"?"💵":"💳"} £{e.amount.toFixed(2)}</div></div>
                <span style={{fontSize:11,color:"#F5A623",fontWeight:700}}>{editExpense?.id===e.id?"editing ✏️":"tap to edit"}</span>
              </div>
            </div>
          ))}
          {editExpense&&(
            <div style={{marginTop:12,padding:"12px",background:"#FFF8EC",borderRadius:10,border:"1.5px solid #F5A623"}}>
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
          <div className="sec">All Expenses</div>
          {[...expenses].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>(
            <div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #F0F0F0"}}>
              <div><div style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>{e.description}</div><div style={{fontSize:11,color:"#aaa"}}>{dispDate(e.date,true)} · {e.pay_type==="cash"?"💵 Cash":"💳 Card"}</div></div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}><div style={{fontSize:13,fontWeight:800,color:"#E05252"}}>-£{e.amount.toFixed(2)}</div><button onClick={()=>onDelete(e.id)} style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"#ccc"}}>🗑️</button></div>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0 0",fontSize:14,fontWeight:800,color:"#1A2744",borderTop:"2px solid #F0F0F0",marginTop:4}}><span>Total</span><span>£{total.toFixed(2)}</span></div>
        </>
      )}
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
      db.from("staff").select("id,name,code").order("name").then(({data})=>{setAllStaff(data||[]);setLoadingStaff(false);});
    }
  },[screen]);

  useEffect(()=>{
    if(screen==="staff"&&user){
      const dow=new Date().getDay();
      Promise.all([
        db.from("takings_assignment").select("staff_id").eq("date",todayISO()).maybeSingle(),
        db.from("takings_defaults").select("staff_id").eq("day_of_week",dow).maybeSingle(),
      ]).then(([ovR,defR])=>{setEffectiveTakingsPerson(ovR.data?.staff_id||defR.data?.staff_id||null);});
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
