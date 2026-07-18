import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

// ═══════════════════════════════════════════════════════════════════
// SUPABASE CLIENT
// vite.config.js maps SUPABASE_URL → VITE_SUPABASE_URL automatically
// so no manual env var setup is needed after Vercel-Supabase integration
// ═══════════════════════════════════════════════════════════════════
const db = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// ═══════════════════════════════════════════════════════════════════
// GOOGLE SHEETS — hardcoded, no setup needed
// ═══════════════════════════════════════════════════════════════════
const GS_KEY        = "AIzaSyAp0HeG4XqYV48iKu2-Hc5D7LDDsz8zOvE";
const GS_PAYROLL_ID = "1Wj0EHKejhpEWU_bjvN1pNc4MqFwcraOncnRS5Ih5OEY";
const GS_TAKINGS_ID = "1K-UMBoepGs3g7CZBlyk_muSh5uT1tFfX96s8xcAdblU";

async function pushSheet(sheetId, tabName, rows) {
  try {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
    const tab  = encodeURIComponent(`${tabName}!A1`);
    await fetch(`${base}/values/${encodeURIComponent(tabName+"!A1:Z2000")}:clear?key=${GS_KEY}`, { method:"POST" });
    const res  = await fetch(`${base}/values/${tab}?valueInputOption=USER_ENTERED&key=${GS_KEY}`, {
      method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ values: rows })
    });
    if (!res.ok) { const e = await res.json(); return { ok:false, err:e.error?.message||"Sheets API error" }; }
    return { ok:true };
  } catch(e) { return { ok:false, err:e.message }; }
}
function copyTSV(rows, toast) {
  const tsv = rows.map(r => r.map(c => String(c ?? "")).join("\t")).join("\n");
  navigator.clipboard.writeText(tsv)
    .then(()  => toast("📋 Copied! Open Google Sheets → click A1 → Ctrl+V"))
    .catch(()  => toast("❌ Copy failed — try a different browser"));
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════════════════════════
const DAYS_SUN  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]; // indexed by JS getDay()
const DAYS_MON  = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]; // Mon-first display
const SHIFTS    = ["Off","Full Day (11am–close)","Night (5:30pm–close)","Custom"];
const ADD_LBLS  = ["Bank Holiday","Red Day","Other"];
const DED_LBLS  = ["Left Early","Sick Leave","Other"];

const TKFIELDS = [
  { key:"deliveroo",         label:"Deliveroo 🛵",         db:"deliveroo",          sign: 1 },
  { key:"uber",              label:"Uber Eats 🛵",          db:"uber",               sign: 1 },
  { key:"cash",              label:"Cash 💵",               db:"cash",               sign: 1 },
  { key:"card",              label:"Card 💳",               db:"card",               sign: 1 },
  { key:"online",            label:"Online 🌐",             db:"online",             sign: 1 },
  { key:"depositReceipt",    label:"Deposit Receipt",       db:"deposit_receipt",    sign: 1, cc:true, ccDb:"deposit_pay_type" },
  { key:"voucherRedemption", label:"Voucher Redemption 🎟️",db:"voucher_redemption", sign:-1, hint:"Enter as a positive number — deducted automatically" },
  { key:"voucherPurchase",   label:"Voucher Purchase 🎫",   db:"voucher_purchase",   sign: 1, cc:true, ccDb:"voucher_pay_type" },
];

const todayISO = () => new Date().toISOString().split("T")[0];
const nowTime  = () => new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
const fmtDate  = iso => { if(!iso)return""; const[y,m,d]=iso.split("-"); return`${d}/${m}/${y}`; };
const addDays  = (iso,n) => { const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().split("T")[0]; };
const dispDate = (iso,wd=false) => {
  if(!iso)return"";
  const d=new Date(iso+"T12:00:00");
  return wd ? d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})
             : d.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
};
const fmtRange = (s,e) => `${fmtDate(s)} – ${fmtDate(e)}`;
const parseHrs = (i,o) => { if(!i||!o)return 0; const p=t=>{const[h,m]=t.split(":").map(Number);return h+m/60;}; return Math.max(0,p(o)-p(i)); };
const jsToMon  = d => d===0?6:d-1; // JS day (0=Sun) → Mon-first index (0=Mon…6=Sun)

function payWeekOf(iso) {
  const d=new Date(iso+"T12:00:00"), dow=d.getDay();
  const sun=new Date(d); sun.setDate(d.getDate()-dow);
  const sat=new Date(sun); sat.setDate(sun.getDate()+6);
  return { start:sun.toISOString().split("T")[0], end:sat.toISOString().split("T")[0] };
}
function rotaWeekOf(iso) {
  const d=new Date(iso+"T12:00:00"), dow=d.getDay();
  const mon=new Date(d); mon.setDate(d.getDate()-(dow===0?6:dow-1));
  const sun=new Date(mon); sun.setDate(mon.getDate()+6);
  return { start:mon.toISOString().split("T")[0], end:sun.toISOString().split("T")[0] };
}
const weekDates = monISO => Array.from({length:7},(_,i)=>addDays(monISO,i));

// ═══════════════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════════════
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#F7F4EF;-webkit-tap-highlight-color:transparent;overscroll-behavior:none;}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;position:relative;overflow-x:hidden;}
.role-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;background:linear-gradient(160deg,#1A2744,#2C3E6B);}
.role-logo{font-size:52px;margin-bottom:12px;}.role-title{font-size:28px;font-weight:900;color:#fff;text-align:center;margin-bottom:6px;}
.role-sub{font-size:14px;color:rgba(255,255,255,.55);margin-bottom:36px;text-align:center;}
.role-btn{width:100%;padding:20px;border-radius:18px;border:none;cursor:pointer;margin-bottom:12px;display:flex;align-items:center;gap:14px;transition:transform .1s;}
.role-btn:active{transform:scale(.97);}.role-btn.staff{background:#F5A623;color:#1A2744;}.role-btn.manager{background:#fff;color:#1A2744;}
.role-icon{font-size:30px;}.role-lbl{font-size:17px;font-weight:800;display:block;}.role-desc{font-size:12px;font-weight:500;opacity:.6;display:block;}
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
.ni{font-size:20px;}.nl{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:.3px;}.nbtn.active .nl{color:#F5A623;}
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
.chip.g{background:#D1FAE5;color:#065F46;}.chip.r{background:#FEE2E2;color:#7F1D1D;}
.chip.a{background:#FEF3C7;color:#78350F;}
.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #F0F0F0;font-size:13px;color:#555;}
.row:last-child{border:none;}.rowb{font-weight:800;color:#1A2744;}
.paycard{background:#fff;border:2px solid #F0F0F0;border-radius:14px;margin-bottom:10px;overflow:hidden;}
.phead{background:#F7F4EF;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;}
.pname{font-size:14px;font-weight:800;color:#1A2744;}.ptotal{font-size:18px;font-weight:900;color:#F5A623;}
.pbody{padding:11px 14px;}
.mini{width:80px;padding:5px 7px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-family:inherit;outline:none;}
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
.dayrow{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
.daylbl{font-size:12px;font-weight:700;color:#1A2744;min-width:34px;}
`;

// ═══════════════════════════════════════════════════════════════════
// TINY SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════════
function Toast({ msg }) { return msg ? <div className="toast">{msg}</div> : null; }
function Loading({ text = "Loading…" }) {
  return <div className="loading"><div className="spinner" /><div className="loadtxt">{text}</div></div>;
}

// ═══════════════════════════════════════════════════════════════════
// ROLE PICKER
// ═══════════════════════════════════════════════════════════════════
function RolePicker({ onPick }) {
  return (
    <div className="role-screen">
      <div className="role-logo">🍽️</div>
      <div className="role-title">Restaurant Staff App</div>
      <div className="role-sub">Who is using this device?</div>
      <button className="role-btn staff" onClick={() => onPick("staff")}>
        <span className="role-icon">👤</span>
        <span><span className="role-lbl">I'm a Staff Member</span><span className="role-desc">Clock in/out · Rota · Absence</span></span>
      </button>
      <button className="role-btn manager" onClick={() => onPick("manager")}>
        <span className="role-icon">🔑</span>
        <span><span className="role-lbl">I'm the Manager</span><span className="role-desc">Rota · Payroll · Takings · Expenses</span></span>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF AUTH
// ═══════════════════════════════════════════════════════════════════
function StaffLogin({ staff, onLogin, onBack, onRegister }) {
  const [sel, setSel] = useState(null);
  const [code, setCode] = useState("");
  const [step, setStep] = useState("pick");
  const [err, setErr] = useState("");

  if (step === "code") return (
    <div className="auth">
      <button className="back" onClick={() => { setStep("pick"); setErr(""); }}>←</button>
      <div className="atitle">Hi {sel.name.split(" ")[0]}! 👋</div>
      <div className="asub">Enter your 8-digit code</div>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8}
        placeholder="••••••••" value={code} autoFocus
        onChange={e => { setCode(e.target.value); setErr(""); }} />
      {err && <div className="err">{err}</div>}
      <button className="btn" disabled={code.length !== 8}
        onClick={() => { if (code === sel.code) onLogin(sel); else { setErr("Wrong code — try again"); setCode(""); } }}>
        Sign In
      </button>
      <div style={{ textAlign:"center", fontSize:13, color:"#aaa", marginTop:14 }}>Forgot your code? Ask the manager</div>
    </div>
  );

  return (
    <div className="auth">
      <button className="back" onClick={onBack}>←</button>
      <div className="atitle">Who are you? 👋</div>
      <div className="asub">Tap your name then enter your code</div>
      <div className="slist">
        {staff.map(s => (
          <div key={s.id} className="sitem" onClick={() => { setSel(s); setStep("code"); setCode(""); setErr(""); }}>
            <div className="avatar">{s.name[0]}</div>
            <div><div style={{ fontSize:15, fontWeight:700, color:"#1A2744" }}>{s.name}</div><div style={{ fontSize:11, color:"#aaa" }}>Tap to sign in</div></div>
          </div>
        ))}
      </div>
      <button className="btn sec" onClick={onRegister}>➕ New here? Register</button>
    </div>
  );
}

function StaffRegister({ onBack, onRegister }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  async function handle() {
    setErr("");
    if (!name.trim()) return setErr("Please type your name");
    if (!/^\d{8}$/.test(code)) return setErr("Code must be exactly 8 digits");
    if (code !== confirm) return setErr("Codes don't match — try again");
    setSaving(true);
    const { error } = await db.from("staff").insert({
      id: code,
      name: name.trim(),
      code: code,
      pay_type: "hourly",
      rate: "0",
      shift_rate: "0",
      night_rate: "0",
      card_fixed: "0",
      card_override: "0"
    });
    if (error) {
      setSaving(false);
      if (error.code === "23505") return setErr("That code is already taken — pick a different one");
      return setErr("Error saving: " + error.message);
    }
    onRegister({ id:code, name:name.trim(), code });
  }

  return (
    <div className="auth">
      <button className="back" onClick={onBack}>←</button>
      <div className="atitle">Create Account 🎉</div>
      <div className="asub">Pick 8 numbers you'll remember — like your birthday: 01051990</div>
      <label className="lbl">Your Full Name</label>
      <input className="inp" placeholder="e.g. Amy Chen" value={name} onChange={e => setName(e.target.value)} />
      <label className="lbl">Choose 8-Digit Code</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} onChange={e => setCode(e.target.value)} />
      <label className="lbl">Type Code Again to Confirm</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} />
      {err && <div className="err">{err}</div>}
      <button className="btn" onClick={handle} disabled={saving}>{saving ? "Creating account…" : "Create Account"}</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF APP
// ═══════════════════════════════════════════════════════════════════
function StaffApp({ user, onLogout, effectiveTakingsPerson }) {
  const [tab, setTab] = useState("home");
  const [msg, setMsg] = useState("");
  const [clockedIn, setClockedIn] = useState(false);
  const [clockInTime, setClockInTime] = useState(null);
  const [logs, setLogs] = useState([]);
  const [rota, setRota] = useState([]);
  const [absences, setAbsences] = useState([]);
  const [rejections, setRejections] = useState([]);
  const [confirmations, setConfirmations] = useState([]);
  const [absDate, setAbsDate] = useState("");
  const [absPeriod, setAbsPeriod] = useState("");
  const [rejectModal, setRejectModal] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [tVals, setTVals] = useState({});
  const [tCC, setTCC] = useState({});
  const [tNote, setTNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rotaMon, setRotaMon] = useState(rotaWeekOf(todayISO()).start);

  const assigned = effectiveTakingsPerson === user.id;
  const now = new Date();
  function t(m) { setMsg(m); setTimeout(() => setMsg(""), 2800); }

  useEffect(() => { loadData(); }, []);
  useEffect(() => { loadRota(); }, [rotaMon]);

  async function loadData() {
    setLoading(true);
    const [logR, absR, rejR, confR, subR] = await Promise.all([
      db.from("clock_logs").select("*").eq("staff_id", user.id).order("date", { ascending:false }).limit(20),
      db.from("absences").select("*").eq("staff_id", user.id).order("date", { ascending:false }),
      db.from("rejections").select("*").eq("staff_id", user.id),
      db.from("confirmations").select("*").eq("staff_id", user.id),
      db.from("takings").select("id").eq("staff_id", user.id).eq("date", todayISO()),
    ]);
    setLogs(logR.data || []);
    setAbsences(absR.data || []);
    setRejections(rejR.data || []);
    setConfirmations(confR.data || []);
    setSubmitted((subR.data || []).length > 0);
    const active = (logR.data || []).find(l => l.date === todayISO() && l.time_in && !l.time_out);
    if (active) { setClockedIn(true); setClockInTime(active.time_in); }
    await loadRota();
    setLoading(false);
  }

  async function loadRota() {
    const dates = weekDates(rotaMon);
    const { data } = await db.from("rota").select("*").eq("staff_id", user.id).eq("week_start", rotaMon);
    setRota(dates.map(dateISO => {
      const jsDay = new Date(dateISO + "T12:00:00").getDay();
      const row = (data || []).find(r => r.day_index === jsDay);
      return { date:dateISO, jsDay, type:row?.shift_type||"Off", customIn:row?.custom_in||"", customOut:row?.custom_out||"" };
    }));
  }

  async function clockIn() {
    const time = nowTime();
    const { data, error } = await db.from("clock_logs").insert({ staff_id:user.id, staff_name:user.name, date:todayISO(), time_in:time, note:"" }).select().single();
    if (!error) { setLogs(p => [data, ...p]); setClockedIn(true); setClockInTime(time); t("✅ Clocked in at " + time); }
    else t("❌ " + error.message);
  }

  async function clockOut() {
    const active = logs.find(l => l.date === todayISO() && l.time_in && !l.time_out);
    if (!active) return;
    const time = nowTime();
    const { error } = await db.from("clock_logs").update({ time_out:time }).eq("id", active.id);
    if (!error) { setLogs(p => p.map(l => l.id === active.id ? { ...l, time_out:time } : l)); setClockedIn(false); t("👋 Clocked out at " + time); }
    else t("❌ " + error.message);
  }

  async function reportAbsence() {
    if (!absDate || !absPeriod) return t("Please pick a date and period");
    const { data, error } = await db.from("absences").insert({ staff_id:user.id, staff_name:user.name, date:absDate, period:absPeriod }).select().single();
    if (!error) { setAbsences(p => [...p, data]); setAbsDate(""); setAbsPeriod(""); t("📅 Absence sent to manager!"); }
    else t("❌ " + error.message);
  }

  async function confirmShift(idx) {
    const dayName = DAYS_MON[idx];
    const { data, error } = await db.from("confirmations").insert({ staff_id:user.id, staff_name:user.name, day:dayName }).select().single();
    if (!error) { setConfirmations(p => [...p, data]); t("✅ Shift confirmed!"); }
  }

  async function rejectShift() {
    const dayName = DAYS_MON[rejectModal];
    const { data, error } = await db.from("rejections").insert({ staff_id:user.id, staff_name:user.name, day:dayName, reason:rejectReason }).select().single();
    if (!error) { setRejections(p => [...p, data]); setRejectModal(null); t("Rejection sent to manager"); }
    else t("❌ " + error.message);
  }

  async function submitTakings() {
    const vals = {};
    TKFIELDS.forEach(f => { vals[f.db] = parseFloat(tVals[f.key] || 0); if (f.ccDb) vals[f.ccDb] = tCC[f.key] || "cash"; });
    const { error } = await db.from("takings").insert({ staff_id:user.id, staff_name:user.name, date:todayISO(), ...vals, note:tNote, is_new:true });
    if (!error) { setTVals({}); setTCC({}); setTNote(""); setSubmitted(true); t("📊 Submitted!"); setTab("home"); }
    else t("❌ " + error.message);
  }

  function shiftLabel(sh) {
    if (!sh || sh.type === "Off") return "Day off";
    if (sh.type === "Full Day (11am–close)") return "Full Day 11am–close";
    if (sh.type === "Night (5:30pm–close)") return "Night 5:30pm–close";
    if (sh.type === "Custom") return `${sh.customIn || "?"}–${sh.customOut || "?"}`;
    return sh.type;
  }

  if (loading) return <Loading text="Loading your data…" />;

  function RotaList() {
    return rota.map((sh, idx) => {
      const isToday = sh.date === todayISO();
      const dayName = DAYS_MON[idx];
      const rejected = rejections.some(r => r.day === dayName);
      const confirmed = confirmations.some(r => r.day === dayName);
      const isOff = sh.type === "Off";
      return (
        <div key={idx} className={`rday${isToday ? " today" : ""}${isOff ? " off" : ""}`}>
          <div className="rdaylbl">
            <div className="rdayname">{dayName}</div>
            <div className="rdaydate">{dispDate(sh.date)}</div>
            {isToday && <div className="rdayflag">TODAY</div>}
          </div>
          <div className="rdayshift">{shiftLabel(sh)}</div>
          {!isOff && !rejected && !confirmed && (
            <div className="rdaybtns">
              <button className="okbtn" onClick={() => confirmShift(idx)}>✓ OK</button>
              <button className="nobtn" onClick={() => { setRejectModal(idx); setRejectReason(""); }}>✕ Can't</button>
            </div>
          )}
          {confirmed && <span className="chip g">✓ OK</span>}
          {rejected && <span className="chip r">Rejected</span>}
        </div>
      );
    });
  }

  const navItems = [
    { id:"home", icon:"🏠", label:"Home" },
    { id:"rota", icon:"📋", label:"Rota" },
    { id:"absence", icon:"📅", label:"Absence" },
    ...(assigned ? [{ id:"takings", icon:"📊", label:"Takings", badge:!submitted }] : []),
  ];

  return (
    <div className="app">
      <Toast msg={msg} />
      <div className="hdr">
        <div>
          <div className="hdr-greet">Good {now.getHours() < 12 ? "morning" : now.getHours() < 18 ? "afternoon" : "evening"},</div>
          <div className="hdr-name">{user.name.split(" ")[0]} 👋</div>
        </div>
        <button style={{ background:"none", border:"none", fontSize:22, cursor:"pointer" }} onClick={onLogout}>🚪</button>
      </div>

      {tab === "home" && (
        <div className="body">
          {assigned && !submitted && (
            <div className="notif" onClick={() => setTab("takings")}>
              <div className="notif-t">📊 You're today's Takings Person!</div>
              <div className="notif-s">Tap to record today's takings →</div>
            </div>
          )}
          <div className="clkcard">
            <div className="clktime">{now.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" })}</div>
            <div className="clkdate">{now.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long" })}</div>
            <div className={`clkst ${clockedIn ? "in" : "out"}`}>{clockedIn ? `● Clocked in at ${clockInTime}` : "● Not clocked in"}</div>
            <div className="clkbtns">
              <button className="clkbtn in" onClick={clockIn} disabled={clockedIn}>🟢 Clock In</button>
              <button className="clkbtn out" onClick={clockOut} disabled={!clockedIn}>🔴 Clock Out</button>
            </div>
            {logs.slice(0, 3).length > 0 && (
              <div className="clkhist">
                {logs.slice(0, 3).map(l => (
                  <div key={l.id} className="clkrow">
                    <span>{dispDate(l.date, true)}</span>
                    <span>{l.time_in} → {l.time_out || "active"}</span>
                    <span style={{ fontWeight:700 }}>{l.time_out ? parseHrs(l.time_in, l.time_out).toFixed(1) + "h" : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="sec">This Week</div>
          <RotaList />
        </div>
      )}

      {tab === "rota" && (
        <div className="body">
          <div className="sec">My Rota</div>
          <div className="wnav">
            <button className="wnavbtn" onClick={() => setRotaMon(addDays(rotaMon, -7))}>‹</button>
            <div className="wnavlbl">{fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon, 6))}</div>
            <button className="wnavbtn" onClick={() => setRotaMon(addDays(rotaMon, 7))}>›</button>
          </div>
          <RotaList />
        </div>
      )}

      {tab === "absence" && (
        <div className="body">
          <div className="sec">Report Absence</div>
          <div className="abscard">
            <div style={{ fontSize:14, fontWeight:800, color:"#1A2744", marginBottom:4 }}>📅 Can't come in?</div>
            <div style={{ fontSize:12, color:"#888", marginBottom:12 }}>Pick the date and when you can't work</div>
            <label className="lbl">Which day?</label>
            <input type="date" className="inp sm" style={{ display:"block", width:"100%", marginBottom:12 }} value={absDate} min={todayISO()} onChange={e => setAbsDate(e.target.value)} />
            <label className="lbl" style={{ marginBottom:7 }}>Which part?</label>
            <div className="peribtns">
              {["Morning","Evening","Full Day"].map(p => (
                <button key={p} className={`pbtn${absPeriod === p ? " sel" : ""}`} onClick={() => setAbsPeriod(p)}>
                  {p === "Morning" ? "🌅" : p === "Evening" ? "🌙" : "☀️"}<br />{p}
                </button>
              ))}
            </div>
            <button className="btn" style={{ marginTop:10 }} onClick={reportAbsence} disabled={!absDate || !absPeriod}>Send to Manager</button>
          </div>
          {absences.length > 0 && (
            <>
              <div className="sec">Reported</div>
              {absences.map(a => (
                <div key={a.id} style={{ background:"#F7F4EF", borderRadius:12, padding:"10px 12px", display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
                  <div><div style={{ fontSize:13, fontWeight:700, color:"#1A2744" }}>{dispDate(a.date, true)}</div><div style={{ fontSize:11, color:"#aaa" }}>{a.period}</div></div>
                  <span className="chip a">Sent ✓</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === "takings" && (
        <div className="body">
          <div className="sec">📊 Daily Takings</div>
          {submitted ? (
            <div className="empty"><div className="emptyicon">✅</div><div className="emptytxt">Already submitted today!</div></div>
          ) : !assigned ? (
            <div className="empty"><div className="emptyicon">🔒</div><div className="emptytxt">Not assigned today</div></div>
          ) : (
            <>
              <div style={{ fontSize:12, color:"#888", marginBottom:14 }}>For {dispDate(todayISO(), true)}. <strong>Enter all amounts as positive numbers.</strong></div>
              {TKFIELDS.map(f => (
                <div key={f.key} className="tfield">
                  <div className="tlbl">
                    <span>{f.label}</span>
                    {f.cc && (
                      <div className="toggle" style={{ transform:"scale(.8)", transformOrigin:"right" }}>
                        {["cash","card"].map(c => <button key={c} className={`tgl${(tCC[f.key]||"cash")===c?" on":""}`} onClick={() => setTCC(p => ({ ...p, [f.key]:c }))}>{c}</button>)}
                      </div>
                    )}
                  </div>
                  {f.hint && <div className="thint">{f.hint}</div>}
                  <input className="inp sm" style={{ display:"block", width:"100%", marginTop:4 }} type="number" min="0" placeholder="0.00" value={tVals[f.key] || ""} onChange={e => setTVals(p => ({ ...p, [f.key]:e.target.value }))} />
                </div>
              ))}
              <label className="lbl" style={{ marginTop:10 }}>Note (optional)</label>
              <textarea className="lognote" rows={3} style={{ marginBottom:12 }} placeholder="Any notes…" value={tNote} onChange={e => setTNote(e.target.value)} />
              <button className="btn green" onClick={submitTakings}>Submit to Manager ✓</button>
            </>
          )}
        </div>
      )}

      <div className="bnav">
        {navItems.map(n => (
          <button key={n.id} className={`nbtn${tab === n.id ? " active" : ""}`} onClick={() => setTab(n.id)}>
            {n.badge && <span className="nbadge">!</span>}
            <span className="ni">{n.icon}</span>
            <span className="nl">{n.label}</span>
          </button>
        ))}
      </div>

      {rejectModal !== null && (
        <div className="overlay" onClick={() => setRejectModal(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="stitle">Can't work {DAYS_MON[rejectModal]}?</div>
            <div className="ssub2">Tell the manager why (optional)</div>
            <textarea className="lognote" rows={3} placeholder="e.g. Doctor appointment…" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            <button className="btn danger" style={{ marginTop:12 }} onClick={rejectShift}>Send Rejection</button>
            <button className="btn sec" onClick={() => setRejectModal(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER AUTH
// ═══════════════════════════════════════════════════════════════════
function ManagerLogin({ onLogin, onBack }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function tryLogin() {
    setLoading(true);
    const { data } = await db.from("app_settings").select("value").eq("key", "manager_pin").maybeSingle();
    const correct = data?.value || "00000000";
    if (pin === correct) onLogin();
    else { setErr("Wrong PIN — try again"); setPin(""); }
    setLoading(false);
  }

  return (
    <div className="auth">
      <button className="back" onClick={onBack}>←</button>
      <div className="atitle">Manager Sign In 🔑</div>
      <div className="asub">Enter your manager PIN</div>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8}
        placeholder="••••••••" value={pin} autoFocus
        onChange={e => { setPin(e.target.value); setErr(""); }} />
      {err && <div className="err">{err}</div>}
      <button className="btn" onClick={tryLogin} disabled={pin.length < 4 || loading}>{loading ? "Checking…" : "Sign In"}</button>
      <div style={{ textAlign:"center", fontSize:13, color:"#aaa", marginTop:14 }}>Default PIN: 00000000</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER APP
// ═══════════════════════════════════════════════════════════════════
function ManagerApp({ onLogout }) {
  const [tab, setTab] = useState("rota");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState([]);
  const [rota, setRota] = useState({});
  const [absences, setAbsences] = useState([]);
  const [clockLogs, setClockLogs] = useState([]);
  const [rejections, setRejections] = useState([]);
  const [takings, setTakings] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [kitchenStaff, setKitchenStaff] = useState([]);
  const [extras, setExtras] = useState({});
  // dayDefaults: { dow: { slot1: staffId, slot2: staffId } }
  const [dayDefaults, setDayDefaults] = useState({});
  const [todayOverride, setTodayOverride] = useState(null);
  const [weekRange, setWeekRange] = useState(() => payWeekOf(todayISO()));
  const [rotaMon, setRotaMon] = useState(() => rotaWeekOf(todayISO()).start);
  const [setupModal, setSetupModal] = useState(null);
  const [cashPopup, setCashPopup] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [absModal, setAbsModal] = useState(false);
  const [shareModal, setShareModal] = useState(null);
  const [newKName, setNewKName] = useState("");
  const [absStaff, setAbsStaff] = useState("");
  const [absDate, setAbsDate] = useState("");
  const [absPeriod, setAbsPeriod] = useState("");

  const newCount = takings.filter(s => s.is_new).length;
  function t(m) { setMsg(m); setTimeout(() => setMsg(""), 3000); }

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (staff.length) loadRota(); }, [rotaMon, staff.length]);

  async function loadAll() {
    setLoading(true);
    const [staffR, absR, logR, rejR, takR, expR, kitR, defR, ovR, extR] = await Promise.all([
      db.from("staff").select("*").order("name"),
      db.from("absences").select("*").order("date", { ascending:false }),
      db.from("clock_logs").select("*").order("date", { ascending:false }),
      db.from("rejections").select("*"),
      db.from("takings").select("*").order("date", { ascending:false }),
      db.from("expenses").select("*").order("date", { ascending:false }),
      db.from("kitchen_staff").select("*").order("name"),
      db.from("takings_defaults").select("*"),
      db.from("takings_assignment").select("*").eq("date", todayISO()).maybeSingle(),
      db.from("payroll_extras").select("*"),
    ]);
    setStaff((staffR.data || []).map(s => ({ ...s, payType:s.pay_type, rate:s.rate, shiftRate:s.shift_rate, nightRate:s.night_rate, cardFixed:s.card_fixed||"0", cardOverride:s.card_override||"0" })));
    setAbsences(absR.data || []);
    setClockLogs(logR.data || []);
    setRejections(rejR.data || []);
    setTakings(takR.data || []);
    setExpenses(expR.data || []);
    setKitchenStaff(kitR.data || []);
    setTodayOverride(ovR.data?.staff_id || null);
    // Build dayDefaults map: { dow: { slot1: staffId, slot2: staffId } }
    const dd = {};
    (defR.data || []).forEach(r => {
      if (!dd[r.day_of_week]) dd[r.day_of_week] = {};
      dd[r.day_of_week][`slot${r.slot}`] = r.staff_id;
    });
    setDayDefaults(dd);
    const em = {};
    (extR.data || []).forEach(e => { em[e.staff_id] = { tips:e.tips, additions:e.additions||[], deductions:e.deductions||[], notes:e.notes||[], id:e.id, ws:e.week_start }; });
    setExtras(em);
    setLoading(false);
  }

  async function loadRota() {
    if (!staff.length) return;
    const { data } = await db.from("rota").select("*").eq("week_start", rotaMon);
    const rm = {};
    staff.forEach(s => {
      rm[s.id] = weekDates(rotaMon).map(dateISO => {
        const jsDay = new Date(dateISO + "T12:00:00").getDay();
        const row = (data || []).find(r => r.staff_id === s.id && r.day_index === jsDay);
        return { date:dateISO, jsDay, type:row?.shift_type||"Off", customIn:row?.custom_in||"", customOut:row?.custom_out||"", rowId:row?.id };
      });
    });
    setRota(rm);
  }

  async function setShift(sId, dayIdx, field, val) {
    const days = rota[sId] || [];
    const day = days[dayIdx];
    if (!day) return;
    const updated = { ...day, [field]:val };
    setRota(p => ({ ...p, [sId]:p[sId].map((d, i) => i === dayIdx ? updated : d) }));
    const payload = { staff_id:sId, day_index:day.jsDay, week_start:rotaMon, shift_type:field==="type"?val:day.type, custom_in:field==="customIn"?val:day.customIn, custom_out:field==="customOut"?val:day.customOut };
    if (day.rowId) { await db.from("rota").update(payload).eq("id", day.rowId); }
    else {
      const { data } = await db.from("rota").insert(payload).select().single();
      if (data) setRota(p => ({ ...p, [sId]:p[sId].map((d, i) => i === dayIdx ? { ...updated, rowId:data.id } : d) }));
    }
  }

  // ── Takings defaults: 2 slots per day ──
  async function saveDaySlot(dow, slot, staffId) {
    setDayDefaults(p => ({ ...p, [dow]:{ ...(p[dow]||{}), [`slot${slot}`]:staffId||null } }));
    const { data:existing } = await db.from("takings_defaults").select("id").eq("day_of_week", dow).eq("slot", slot).maybeSingle();
    if (staffId) {
      if (existing) await db.from("takings_defaults").update({ staff_id:staffId }).eq("id", existing.id);
      else await db.from("takings_defaults").insert({ day_of_week:dow, slot, staff_id:staffId });
    } else {
      if (existing) await db.from("takings_defaults").delete().eq("id", existing.id);
    }
  }

  async function saveTodayOverride(staffId) {
    setTodayOverride(staffId || null);
    const { data:existing } = await db.from("takings_assignment").select("id").eq("date", todayISO()).maybeSingle();
    if (staffId) {
      if (existing) await db.from("takings_assignment").update({ staff_id:staffId }).eq("date", todayISO());
      else await db.from("takings_assignment").insert({ staff_id:staffId, date:todayISO() });
    } else {
      if (existing) await db.from("takings_assignment").delete().eq("date", todayISO());
    }
    t("✅ Today's assignment saved");
  }

  const todayDow = new Date().getDay();
  const todaySlot1 = dayDefaults[todayDow]?.slot1 || null;
  const todaySlot2 = dayDefaults[todayDow]?.slot2 || null;
  // effectiveTakingsPerson for staff side: first slot1 then slot2 (passed down via root)

  // ── Payroll ──
  function getExtras(sId) { return extras[sId] || { tips:"", additions:[], deductions:[], notes:[] }; }

  async function updateExtras(sId, fn) {
    const next = fn(getExtras(sId));
    setExtras(p => ({ ...p, [sId]:next }));
    const ws = weekRange.start;
    const payload = { staff_id:sId, week_start:ws, tips:next.tips||"0", additions:next.additions||[], deductions:next.deductions||[], notes:next.notes||[] };
    if (next.id && next.ws === ws) { await db.from("payroll_extras").update(payload).eq("id", next.id); }
    else {
      const { data } = await db.from("payroll_extras").insert(payload).select().single();
      if (data) setExtras(p => ({ ...p, [sId]:{ ...next, id:data.id, ws } }));
    }
  }

  function calcPay(s) {
    const myRota = rota[s.id] || [];
    const logsInRange = clockLogs.filter(l => l.staff_id === s.id && l.date >= weekRange.start && l.date <= weekRange.end);
    let full = 0, night = 0, hrs = 0;
    myRota.forEach(sh => { if (!sh || sh.type === "Off") return; if (sh.type === "Full Day (11am–close)") full++; else if (sh.type === "Night (5:30pm–close)") night++; });
    logsInRange.forEach(l => { hrs += parseHrs(l.time_in, l.time_out); });
    const ex = getExtras(s.id);
    const tips = parseFloat(ex.tips || 0);
    const addT = (ex.additions || []).reduce((a, x) => a + parseFloat(x.amount || 0), 0);
    const dedT = (ex.deductions || []).reduce((a, x) => a + parseFloat(x.amount || 0), 0);
    const base = s.payType === "hourly" ? hrs * parseFloat(s.rate || 0) : full * parseFloat(s.shiftRate || 0) + night * parseFloat(s.nightRate || 0);
    const total = Math.max(0, base + tips + addT - dedT);
    const cardAmt = parseFloat(s.cardOverride && s.cardOverride !== "0" ? s.cardOverride : s.cardFixed || 0);
    const cashAmt = Math.max(0, total - cardAmt);
    return { full, night, hrs:hrs.toFixed(2), base:base.toFixed(2), tips:tips.toFixed(2), addT:addT.toFixed(2), dedT:dedT.toFixed(2), total:total.toFixed(2), cardAmt:cardAmt.toFixed(2), cashAmt:cashAmt.toFixed(2) };
  }

  function payTotals() {
    let cash = 0, card = 0, gross = 0;
    staff.forEach(s => { const p = calcPay(s); cash += parseFloat(p.cashAmt); card += parseFloat(p.cardAmt); gross += parseFloat(p.total); });
    return { cash:cash.toFixed(2), card:card.toFixed(2), gross:gross.toFixed(2) };
  }

  // ── Kitchen ──
  async function addKitchen() {
    if (!newKName.trim()) return t("Please enter a name");
    const { data, error } = await db.from("kitchen_staff").insert({ name:newKName.trim(), hours:"", rate:"", cash_card:"cash" }).select().single();
    if (!error) { setKitchenStaff(p => [...p, data]); setNewKName(""); t("✅ " + newKName.trim() + " added"); }
    else t("❌ Error adding kitchen staff: " + error.message);
  }
  async function updKitchen(id, field, val) {
    setKitchenStaff(p => p.map(k => k.id === id ? { ...k, [field]:val } : k));
    const { error } = await db.from("kitchen_staff").update({ [field]:val }).eq("id", id);
    if (error) t("❌ Save error: " + error.message);
  }
  async function delKitchen(id) {
    setKitchenStaff(p => p.filter(k => k.id !== id));
    await db.from("kitchen_staff").delete().eq("id", id);
  }

  // ── Remove staff ──
  async function removeStaff(s) {
    if (!window.confirm(`Remove ${s.name}? This cannot be undone.`)) return;
    const { error } = await db.from("staff").delete().eq("id", s.id);
    if (!error) { setStaff(p => p.filter(x => x.id !== s.id)); t(`${s.name} removed`); }
    else t("❌ " + error.message);
  }

  // ── Expenses ──
  async function addExpense(desc, amount, payType, date) {
    const { data, error } = await db.from("expenses").insert({ description:desc, amount:parseFloat(amount), pay_type:payType, date }).select().single();
    if (!error) setExpenses(p => [data, ...p]);
    return { error };
  }
  async function delExpense(id) { setExpenses(p => p.filter(e => e.id !== id)); await db.from("expenses").delete().eq("id", id); }

  // ── Export rows ──
  function buildPayroll() {
    const hdr = ["Date Range","Name","Full Day Shifts","Night Shifts","Hours","Cash (£)","Card (£)","Tips (£)","Additions (£)","Deductions (£)","Total (£)","Notes"];
    const rows = [hdr];
    staff.forEach(s => { const p = calcPay(s); const ex = getExtras(s.id); rows.push([fmtRange(weekRange.start, weekRange.end), s.name, p.full, p.night, p.hrs, p.cashAmt, p.cardAmt, p.tips, p.addT, p.dedT, p.total, (ex.notes || []).join("; ")]); });
    return rows;
  }
  function buildDaily() {
    const dates = [...new Set([...takings.map(s => s.date), ...expenses.map(e => e.date)])].filter(d => d && d !== "default" && !d.startsWith("__")).sort();
    const hdr = ["Date","Deliveroo","Uber Eats","Cash","Card","Online","Deposit Receipt","Voucher Redemption","Voucher Purchase","Total","Cash in Hand","Net Total","Expenses"];
    const rows = [hdr];
    dates.forEach(date => {
      const sub = takings.find(s => s.date === date) || {};
      const dayExp = expenses.filter(e => e.date === date);
      const total = TKFIELDS.reduce((s, f) => s + parseFloat(sub[f.db] || 0) * f.sign, 0);
      const cashExp = dayExp.filter(e => e.pay_type === "cash").reduce((s, e) => s + e.amount, 0);
      rows.push([fmtDate(date), sub.deliveroo||0, sub.uber||0, sub.cash||0, sub.card||0, sub.online||0, sub.deposit_receipt||0, sub.voucher_redemption||0, sub.voucher_purchase||0, total.toFixed(2), (parseFloat(sub.cash||0)-cashExp).toFixed(2), (total-cashExp).toFixed(2), dayExp.map(e => `${e.description}(£${e.amount.toFixed(2)},${e.pay_type})`).join("; ")]);
    });
    return rows;
  }
  function buildWeekly() {
    const dates = [...new Set([...takings.map(s => s.date), ...expenses.map(e => e.date)])].filter(d => d && d !== "default" && !d.startsWith("__")).sort();
    const wm = {};
    dates.forEach(d => { const { start } = payWeekOf(d); if (!wm[start]) wm[start] = []; wm[start].push(d); });
    const hdr = ["Week (Sun–Sat)","Deliveroo","Uber Eats","Cash","Card","Online","Deposit Receipt","Voucher Redemption","Voucher Purchase","Total","Cash in Hand","Net Total"];
    const rows = [["WEEKLY SUMMARY"], hdr];
    Object.entries(wm).sort().forEach(([ws, dates2]) => {
      const { end } = payWeekOf(ws);
      let tot = {}; TKFIELDS.forEach(f => tot[f.db] = 0); let cashExp = 0;
      dates2.forEach(d => {
        const sub = takings.find(s => s.date === d);
        if (sub) TKFIELDS.forEach(f => { tot[f.db] += parseFloat(sub[f.db] || 0); });
        cashExp += expenses.filter(e => e.date === d && e.pay_type === "cash").reduce((a, e) => a + e.amount, 0);
      });
      const total = TKFIELDS.reduce((s, f) => s + tot[f.db] * f.sign, 0);
      rows.push([fmtRange(ws, end), tot.deliveroo.toFixed(2), tot.uber.toFixed(2), tot.cash.toFixed(2), tot.card.toFixed(2), tot.online.toFixed(2), tot.deposit_receipt.toFixed(2), tot.voucher_redemption.toFixed(2), tot.voucher_purchase.toFixed(2), total.toFixed(2), (tot.cash - cashExp).toFixed(2), (total - cashExp).toFixed(2)]);
    });
    return rows;
  }

  async function exportPayroll() {
    t("⏳ Pushing to Payroll sheet…");
    const r = await pushSheet(GS_PAYROLL_ID, "Payroll", buildPayroll());
    t(r.ok ? "✅ Payroll sheet updated!" : "❌ " + r.err);
  }
  async function exportTakings() {
    t("⏳ Updating Daily tab…");
    const r1 = await pushSheet(GS_TAKINGS_ID, "Daily", buildDaily());
    if (!r1.ok) { t("❌ " + r1.err); return; }
    t("⏳ Updating Weekly tab…");
    const r2 = await pushSheet(GS_TAKINGS_ID, "Weekly", buildWeekly());
    t(r2.ok ? "✅ Takings sheet updated!" : "❌ " + r2.err);
  }

  // ── Rota share text ──
  function buildRotaText(sId) {
    const s = staff.find(x => x.id === sId); if (!s) return "";
    const days = rota[sId] || [];
    const lines = days.map(d => {
      const dayName = DAYS_MON[jsToMon(d.jsDay)];
      let shift = d.type === "Off" ? "Off" : d.type === "Custom" ? `${d.customIn||"?"}–${d.customOut||"?"}` : d.type;
      return `${dayName} ${fmtDate(d.date)}: ${s.name} — ${shift}`;
    });
    return `Rota for ${s.name}\n${fmtDate(rotaMon)} – ${fmtDate(addDays(rotaMon, 6))}\n\n${lines.join("\n")}`;
  }

  // ── Absence conflicts ──
  function absConflicts(staffId) {
    const mr = rota[staffId] || [];
    return absences.filter(a => a.staff_id === staffId).filter(a => {
      const dow = new Date(a.date + "T12:00:00").getDay();
      const sh = mr.find(d => d.jsDay === dow);
      if (!sh || sh.type === "Off") return false;
      if (a.period === "Full Day") return true;
      if (a.period === "Morning" && sh.type === "Full Day (11am–close)") return true;
      if (a.period === "Evening" && (sh.type.includes("Night") || sh.type === "Full Day (11am–close)")) return true;
      return false;
    });
  }

  // ── AddDeductRow component ──
  function AddDeductRow({ sId, type }) {
    const ex = getExtras(sId);
    const key = type === "add" ? "additions" : "deductions";
    const items = ex[key] || [];
    const labels = type === "add" ? ADD_LBLS : DED_LBLS;
    const [amount, setAmount] = useState("");
    const [label, setLabel] = useState(labels[0]);
    const [custom, setCustom] = useState("");
    return (
      <div>
        {items.map((item, i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px dashed #F0F0F0" }}>
            <span style={{ fontSize:12, color:"#555" }}>{item.label}: £{item.amount}</span>
            <button onClick={() => updateExtras(sId, ex => ({ ...ex, [key]:items.filter((_, j) => j !== i) }))} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, color:"#ccc" }}>✕</button>
          </div>
        ))}
        <div className="addrow">
          <select className="addinp" style={{ flex:"none", width:"auto", padding:"6px 7px", fontSize:11 }} value={label} onChange={e => setLabel(e.target.value)}>
            {labels.map(l => <option key={l}>{l}</option>)}
          </select>
          <input className="addinp" type="number" min="0" placeholder="£0" value={amount} onChange={e => setAmount(e.target.value)} style={{ width:62 }} />
          <button className={`addbtn${type === "ded" ? " r" : ""}`} onClick={() => {
            if (!amount) return;
            const fl = label === "Other" && custom ? custom : label;
            updateExtras(sId, ex => ({ ...ex, [key]:[...(ex[key]||[]), { label:fl, amount }] }));
            setAmount(""); setCustom("");
          }}>+ Add</button>
        </div>
        {label === "Other" && <input className="addinp" style={{ marginTop:5, width:"100%" }} placeholder="Custom label…" value={custom} onChange={e => setCustom(e.target.value)} />}
      </div>
    );
  }

  // ── Staff Pay Settings Modal ──
  function SetupModal({ s, onClose }) {
    const [payType, setPT] = useState(s.payType || "hourly");
    const [rate, setRate] = useState(s.rate || "");
    const [shiftRate, setSR] = useState(s.shiftRate || "");
    const [nightRate, setNR] = useState(s.nightRate || "");
    const [cardFixed, setCF] = useState(s.cardFixed || "0");
    const [cardOverride, setCO] = useState(s.cardOverride || "0");
    const [saving, setSaving] = useState(false);

    async function save() {
      setSaving(true);
      const { error } = await db.from("staff").update({ pay_type:payType, rate, shift_rate:shiftRate, night_rate:nightRate, card_fixed:cardFixed, card_override:cardOverride }).eq("id", s.id);
      if (!error) { setStaff(p => p.map(x => x.id === s.id ? { ...x, payType, rate, shiftRate, nightRate, cardFixed, cardOverride } : x)); t(`✅ ${s.name} settings saved`); onClose(); }
      else t("❌ " + error.message);
      setSaving(false);
    }

    return (
      <div className="overlay" onClick={onClose}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
          <div className="stitle">⚙️ {s.name}</div>
          <div className="ssub2">Pay settings — private</div>
          <label className="lbl">Pay Method</label>
          <div className="toggle" style={{ marginBottom:14 }}>
            <button className={`tgl${payType==="hourly"?" on":""}`} onClick={() => setPT("hourly")}>By Hour</button>
            <button className={`tgl${payType==="shift"?" on":""}`} onClick={() => setPT("shift")}>By Shift</button>
          </div>
          {payType === "hourly" ? (
            <><label className="lbl">Hourly Rate (£)</label><input className="inp" type="number" placeholder="e.g. 12.50" value={rate} onChange={e => setRate(e.target.value)} /></>
          ) : (
            <>
              <label className="lbl">Full Day Shift Rate (£)</label>
              <input className="inp" type="number" placeholder="e.g. 80.00" value={shiftRate} onChange={e => setSR(e.target.value)} />
              <label className="lbl">Night Shift Rate (£)</label>
              <input className="inp" type="number" placeholder="e.g. 60.00" value={nightRate} onChange={e => setNR(e.target.value)} />
            </>
          )}
          <label className="lbl">Fixed Card Payment (£)</label>
          <div style={{ fontSize:12, color:"#888", marginBottom:6 }}>Permanent default — cash auto-calculates as Total minus this</div>
          <input className="inp" type="number" placeholder="e.g. 200.00" value={cardFixed} onChange={e => setCF(e.target.value)} />
          <label className="lbl">This Week Card Override (£)</label>
          <div style={{ fontSize:12, color:"#888", marginBottom:6 }}>Leave as 0 to use the fixed amount above</div>
          <input className="inp" type="number" placeholder="0 = use fixed amount" value={cardOverride} onChange={e => setCO(e.target.value)} />
          <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Settings"}</button>
          <button className="btn sec" onClick={onClose}>Cancel</button>
          <div style={{ marginTop:14, paddingTop:12, borderTop:"1px dashed #F0F0F0" }}>
            <button className="btn danger" onClick={() => { onClose(); removeStaff(s); }}>🗑️ Remove {s.name} from system</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Change PIN Modal ──
  function PinModal({ onClose }) {
    const [curr, setCurr] = useState("");
    const [n1, setN1] = useState("");
    const [n2, setN2] = useState("");
    const [err, setErr] = useState("");
    const [saving, setSaving] = useState(false);

    async function save() {
      setErr(""); setSaving(true);
      const { data } = await db.from("app_settings").select("value").eq("key", "manager_pin").maybeSingle();
      if (curr !== (data?.value || "00000000")) { setErr("Current PIN is wrong"); setSaving(false); return; }
      if (!/^\d{8}$/.test(n1)) { setErr("New PIN must be exactly 8 digits"); setSaving(false); return; }
      if (n1 !== n2) { setErr("New PINs don't match"); setSaving(false); return; }
      await db.from("app_settings").upsert({ key:"manager_pin", value:n1 });
      t("✅ Manager PIN updated!"); onClose(); setSaving(false);
    }

    return (
      <div className="overlay" onClick={onClose}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
          <div className="stitle">🔒 Change Manager PIN</div>
          <label className="lbl">Current PIN</label>
          <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={curr} onChange={e => setCurr(e.target.value)} />
          <label className="lbl">New PIN (8 digits)</label>
          <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={n1} onChange={e => setN1(e.target.value)} />
          <label className="lbl">Confirm New PIN</label>
          <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={n2} onChange={e => setN2(e.target.value)} />
          {err && <div className="err">{err}</div>}
          <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Change PIN"}</button>
          <button className="btn sec" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  if (loading) return <Loading text="Loading manager data…" />;
  const { cash:totCash, card:totCard, gross:totGross } = payTotals();

  return (
    <div className="app">
      <Toast msg={msg} />
      <div className="mhdr">
        <div><div className="mtitle">🔑 Manager Panel</div><div className="msub">Restaurant back office</div></div>
        <div style={{ display:"flex", gap:7, alignItems:"center" }}>
          <button onClick={() => setPinModal(true)} style={{ background:"rgba(255,255,255,.12)", border:"none", color:"rgba(255,255,255,.7)", borderRadius:7, padding:"5px 9px", cursor:"pointer", fontSize:12 }}>🔒 PIN</button>
          <button className="mlo" onClick={onLogout}>Sign out</button>
        </div>
      </div>

      <div className="mtabs">
        {[
          { id:"rota", label:"📋 Rota" },
          { id:"clock", label:"⏱ Clock" },
          { id:"payroll", label:"💷 Payroll" },
          { id:"takings", label:`📊 Takings${newCount > 0 ? ` (${newCount})` : ""}` },
          { id:"expenses", label:"🧾 Expenses" },
          { id:"absence", label:"📅 Absences" },
        ].map(tb => <button key={tb.id} className={`mtab${tab === tb.id ? " on" : ""}`} onClick={() => setTab(tb.id)}>{tb.label}</button>)}
      </div>

      <div className="mbody">

        {/* ── ROTA ── */}
        {tab === "rota" && (
          <>
            <div className="sec">Assign Rota</div>
            <div className="wnav">
              <button className="wnavbtn" onClick={() => setRotaMon(addDays(rotaMon, -7))}>‹</button>
              <div className="wnavlbl">{fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon, 6))}</div>
              <button className="wnavbtn" onClick={() => setRotaMon(addDays(rotaMon, 7))}>›</button>
            </div>
            {rejections.length > 0 && (
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#E05252", marginBottom:6 }}>⚠️ Rejections</div>
                {rejections.map(r => (
                  <div key={r.id} className="rejbanner">
                    <span><strong>{r.staff_name}</strong> can't do <strong>{r.day}</strong>{r.reason ? ` — "${r.reason}"` : ""}</span>
                    <button onClick={async () => { await db.from("rejections").delete().eq("id", r.id); setRejections(p => p.filter(x => x.id !== r.id)); }} style={{ background:"none", border:"none", cursor:"pointer", fontSize:16 }}>✓</button>
                  </div>
                ))}
              </div>
            )}
            {staff.map(s => {
              const days = rota[s.id] || [];
              const conflicts = absConflicts(s.id);
              return (
                <div key={s.id} className="card">
                  <div className="chead">
                    <div><div className="cname">👤 {s.name}</div><div className="csub">{s.payType === "shift" ? `Full £${s.shiftRate} / Night £${s.nightRate}` : `£${s.rate}/hr`}</div></div>
                    <div style={{ display:"flex", gap:6 }}>
                      <button onClick={() => setShareModal(s.id)} style={{ background:"#DBEAFE", border:"none", borderRadius:7, padding:"5px 10px", fontSize:11, fontWeight:700, cursor:"pointer", color:"#1E40AF" }}>📤 Share</button>
                      <button onClick={() => setSetupModal(s)} style={{ background:"#E8F0E9", border:"none", borderRadius:7, padding:"5px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}>⚙️ Pay</button>
                    </div>
                  </div>
                  {conflicts.length > 0 && <div className="warn"><div className="warn-t">⚠️ Absence Conflict</div><div className="warn-s">{conflicts.map(c => `${dispDate(c.date, true)} (${c.period})`).join(", ")}</div></div>}
                  {days.map((d, idx) => (
                    <div key={idx} style={{ display:"flex", alignItems:"center", gap:5, marginBottom:5 }}>
                      <div style={{ minWidth:56, fontSize:11, fontWeight:700 }}>
                        <div style={{ color:"#555" }}>{DAYS_MON[jsToMon(d.jsDay)]}</div>
                        <div style={{ color:"#aaa", fontSize:10 }}>{fmtDate(d.date)}</div>
                      </div>
                      <select className="inp sm" style={{ flex:1 }} value={d.type || "Off"} onChange={e => setShift(s.id, idx, "type", e.target.value)}>
                        {SHIFTS.map(o => <option key={o}>{o}</option>)}
                      </select>
                      {d.type === "Custom" && (
                        <>
                          <input type="time" className="inp time" value={d.customIn || ""} onChange={e => setShift(s.id, idx, "customIn", e.target.value)} />
                          <span style={{ fontSize:10, color:"#aaa" }}>–</span>
                          <input type="time" className="inp time" value={d.customOut || ""} onChange={e => setShift(s.id, idx, "customOut", e.target.value)} />
                        </>
                      )}
                    </div>
                  ))}
                  <button className="btn green" style={{ marginTop:8, padding:"11px" }} onClick={() => t(`✅ Rota saved for ${s.name}!`)}>📤 Send Rota to {s.name.split(" ")[0]}</button>
                </div>
              );
            })}
          </>
        )}

        {/* ── CLOCK ── */}
        {tab === "clock" && (
          <>
            <div className="sec">Clock Logs</div>
            {staff.map(s => {
              const sLogs = clockLogs.filter(l => l.staff_id === s.id);
              const totalH = sLogs.reduce((a, l) => a + parseHrs(l.time_in, l.time_out), 0);
              return (
                <div key={s.id} className="card">
                  <div className="cname">👤 {s.name}</div>
                  <div className="csub" style={{ marginBottom:10 }}>Total: {totalH.toFixed(1)} hrs</div>
                  {sLogs.length === 0 && <div style={{ fontSize:12, color:"#ccc", fontStyle:"italic" }}>No records yet</div>}
                  {sLogs.map(l => (
                    <div key={l.id} className="logentry">
                      <div className="logtop">
                        <span style={{ fontSize:13, fontWeight:700, color:"#1A2744" }}>{dispDate(l.date, true)}</span>
                        <span style={{ fontSize:13, fontWeight:800, color:l.time_out ? "#1A2744" : "#50DC78" }}>{l.time_out ? parseHrs(l.time_in, l.time_out).toFixed(1) + "h" : "active"}</span>
                      </div>
                      <div className="logedit">
                        <span className="logelbl">In</span>
                        <input type="time" className="inp time" value={l.time_in || ""} onChange={e => { const v = e.target.value; setClockLogs(p => p.map(x => x.id === l.id ? { ...x, time_in:v } : x)); db.from("clock_logs").update({ time_in:v }).eq("id", l.id); }} />
                        <span className="logelbl">Out</span>
                        <input type="time" className="inp time" value={l.time_out || ""} onChange={e => { const v = e.target.value; setClockLogs(p => p.map(x => x.id === l.id ? { ...x, time_out:v } : x)); db.from("clock_logs").update({ time_out:v }).eq("id", l.id); }} />
                      </div>
                      <textarea className="lognote" rows={2} placeholder="Note…" value={l.note || ""} onChange={e => { const v = e.target.value; setClockLogs(p => p.map(x => x.id === l.id ? { ...x, note:v } : x)); db.from("clock_logs").update({ note:v }).eq("id", l.id); }} />
                    </div>
                  ))}
                  <button className="btn sm" style={{ marginTop:9, background:"#F5A623" }} onClick={async () => {
                    const { data, error } = await db.from("clock_logs").insert({ staff_id:s.id, staff_name:s.name, date:todayISO(), time_in:"", time_out:"", note:"" }).select().single();
                    if (!error) setClockLogs(p => [data, ...p]);
                    else t("❌ " + error.message);
                  }}>+ Add Entry</button>
                </div>
              );
            })}
          </>
        )}

        {/* ── PAYROLL ── */}
        {tab === "payroll" && (
          <>
            <div className="sec">Payroll</div>
            <div className="ssub">Private — staff never see salaries</div>
            <div style={{ display:"flex", gap:6, marginBottom:12, alignItems:"center" }}>
              <input type="date" className="inp sm" style={{ flex:1 }} value={weekRange.start} onChange={e => setWeekRange(p => ({ ...p, start:e.target.value }))} />
              <span style={{ fontSize:12, color:"#aaa" }}>→</span>
              <input type="date" className="inp sm" style={{ flex:1 }} value={weekRange.end} onChange={e => setWeekRange(p => ({ ...p, end:e.target.value }))} />
            </div>
            <div style={{ fontSize:13, fontWeight:800, color:"#1A2744", marginBottom:8 }}>Front of House</div>
            {staff.map(s => {
              const p = calcPay(s);
              const ex = getExtras(s.id);
              return (
                <div key={s.id} className="paycard">
                  <div className="phead">
                    <div className="pname">👤 {s.name}</div>
                    <div className="ptotal">£{p.total}</div>
                  </div>
                  <div className="pbody">
                    {s.payType === "shift" ? (
                      <>
                        <div className="row"><span>Full Day shifts</span><span className="rowb">{p.full} × £{s.shiftRate} = £{(p.full * parseFloat(s.shiftRate || 0)).toFixed(2)}</span></div>
                        <div className="row"><span>Night shifts</span><span className="rowb">{p.night} × £{s.nightRate} = £{(p.night * parseFloat(s.nightRate || 0)).toFixed(2)}</span></div>
                      </>
                    ) : (
                      <div className="row"><span>Hours</span><span className="rowb">{p.hrs}h × £{s.rate} = £{p.base}</span></div>
                    )}
                    <div className="row"><span>Tips (£)</span><input type="number" className="mini" min="0" placeholder="0.00" value={ex.tips || ""} onChange={e => updateExtras(s.id, ex => ({ ...ex, tips:e.target.value }))} /></div>
                    <div style={{ marginTop:8 }}><div style={{ fontSize:11, fontWeight:700, color:"#50DC78", marginBottom:4 }}>ADDITIONS</div><AddDeductRow sId={s.id} type="add" /></div>
                    <div style={{ marginTop:8 }}><div style={{ fontSize:11, fontWeight:700, color:"#E05252", marginBottom:4 }}>DEDUCTIONS</div><AddDeductRow sId={s.id} type="ded" /></div>
                    <div style={{ marginTop:8 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:"#888", marginBottom:4 }}>NOTES</div>
                      {(ex.notes || []).map((n, i) => (
                        <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"2px 0" }}>
                          <span style={{ fontSize:12, color:"#555" }}>📌 {n}</span>
                          <button onClick={() => updateExtras(s.id, ex => ({ ...ex, notes:ex.notes.filter((_, j) => j !== i) }))} style={{ background:"none", border:"none", cursor:"pointer", fontSize:12, color:"#ccc" }}>✕</button>
                        </div>
                      ))}
                      <div className="addrow" style={{ marginTop:5 }}>
                        <select className="addinp" style={{ fontSize:11, padding:"5px 7px" }} id={`ns-${s.id}`}>
                          {["Bank Holiday","Red Day","Custom"].map(l => <option key={l}>{l}</option>)}
                        </select>
                        <button className="addbtn" onClick={() => {
                          const sel = document.getElementById(`ns-${s.id}`);
                          if (sel.value === "Custom") { const cn = window.prompt("Enter custom note:"); if (cn) updateExtras(s.id, ex => ({ ...ex, notes:[...(ex.notes||[]), cn] })); }
                          else updateExtras(s.id, ex => ({ ...ex, notes:[...(ex.notes||[]), sel.value] }));
                        }}>+ Note</button>
                      </div>
                    </div>
                    <div className="divider" />
                    <div className="row"><span>💵 Cash (auto)</span><span className="rowb">£{p.cashAmt}</span></div>
                    <div className="row"><span>💳 Card <span style={{ fontSize:10, color:"#aaa" }}>(edit in ⚙️ Pay)</span></span><span className="rowb">£{p.cardAmt}</span></div>
                    <div className="row"><span style={{ fontWeight:800 }}>Total</span><span style={{ fontWeight:900, color:"#F5A623", fontSize:15 }}>£{p.total}</span></div>
                  </div>
                </div>
              );
            })}

            {/* Kitchen */}
            <div style={{ fontSize:13, fontWeight:800, color:"#1A2744", margin:"14px 0 8px" }}>Kitchen Staff</div>
            <div style={{ display:"flex", gap:6, marginBottom:10 }}>
              <input className="inp sm" style={{ flex:1 }} placeholder="Kitchen staff name…" value={newKName} onChange={e => setNewKName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addKitchen()} />
              <button className="btn sm navy" onClick={addKitchen}>Add</button>
            </div>
            {kitchenStaff.length === 0 && <div style={{ fontSize:13, color:"#ccc", marginBottom:10, fontStyle:"italic" }}>No kitchen staff added yet</div>}
            {kitchenStaff.map(k => {
              const pay = (parseFloat(k.hours || 0) * parseFloat(k.rate || 0)).toFixed(2);
              return (
                <div key={k.id} className="card w">
                  <div className="chead">
                    <div className="cname">👨‍🍳 {k.name}</div>
                    <button onClick={() => delKitchen(k.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, color:"#ddd" }}>🗑️</button>
                  </div>
                  <div style={{ display:"flex", gap:7, marginBottom:8, flexWrap:"wrap" }}>
                    <div style={{ flex:1, minWidth:76 }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#aaa", marginBottom:3 }}>HOURS</div>
                      <input type="number" min="0" className="inp sm" style={{ width:"100%" }} placeholder="0" value={k.hours || ""} onChange={e => updKitchen(k.id, "hours", e.target.value)} />
                    </div>
                    <div style={{ flex:1, minWidth:76 }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#aaa", marginBottom:3 }}>£/HR</div>
                      <input type="number" min="0" className="inp sm" style={{ width:"100%" }} placeholder="0.00" value={k.rate || ""} onChange={e => updKitchen(k.id, "rate", e.target.value)} />
                    </div>
                    <div style={{ flex:1, minWidth:76 }}>
                      <div style={{ fontSize:10, fontWeight:700, color:"#aaa", marginBottom:3 }}>GROSS</div>
                      <div style={{ fontSize:16, fontWeight:900, color:"#F5A623", paddingTop:5 }}>£{pay}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div style={{ fontSize:11, color:"#888", fontWeight:700 }}>Pay by:</div>
                    <div className="toggle">
                      {["cash","card"].map(c => <button key={c} className={`tgl${k.cash_card===c?" on":""}`} onClick={() => updKitchen(k.id, "cash_card", c)}>{c === "cash" ? "💵" : "💳"} {c}</button>)}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Summary */}
            <div className="psum">
              <div className="psumtitle">Week Summary — {fmtRange(weekRange.start, weekRange.end)}</div>
              <div className="psumrow"><span>💵 Total Cash</span><span className="psumamt">£{totCash}</span></div>
              <div className="psumrow"><span>💳 Total Card</span><span className="psumamt">£{totCard}</span></div>
              <div className="psumrow"><span>Grand Total</span><span className="psumamt">£{totGross}</span></div>
            </div>
            <div className="expsec">
              <div className="exptitle">📤 Export Payroll</div>
              <button className="expbtn p" onClick={exportPayroll}>🔗 Push to Payroll Sheet</button>
              <button className="expbtn s" onClick={() => copyTSV(buildPayroll(), t)}>📋 Copy — Paste into Sheet</button>
              <button className="expbtn s" onClick={() => setCashPopup(true)}>💵 View Cash Payments</button>
            </div>
          </>
        )}

        {/* ── TAKINGS ── */}
        {tab === "takings" && (
          <>
            <div className="sec">Daily Takings</div>

            {/* Per-day defaults — 2 slots */}
            <div className="card">
              <div className="cname" style={{ marginBottom:4 }}>📅 Default Takings Person by Day</div>
              <div style={{ fontSize:12, color:"#888", marginBottom:10 }}>Set once. Auto-assigned every week. Two options per day.</div>
              {DAYS_SUN.map((dayName, dow) => (
                <div key={dow} style={{ marginBottom:10, paddingBottom:10, borderBottom:"1px dashed #E5E5E5" }}>
                  <div style={{ fontSize:12, fontWeight:800, color:"#1A2744", marginBottom:5 }}>{dayName}</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                    {[1, 2].map(slot => (
                      <div key={slot} className="dayrow">
                        <div className="daylbl" style={{ fontSize:11, color:"#aaa" }}>Option {slot}</div>
                        <select className="inp sm" style={{ flex:1 }} value={dayDefaults[dow]?.[`slot${slot}`] || ""} onChange={e => saveDaySlot(dow, slot, e.target.value || null)}>
                          <option value="">— None —</option>
                          {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Today override */}
            <div className="card">
              <div className="cname" style={{ marginBottom:4 }}>🔄 Override for Today Only</div>
              <select className="inp sm" style={{ display:"block", width:"100%", marginBottom:8 }} value={todayOverride || ""} onChange={e => saveTodayOverride(e.target.value || null)}>
                <option value="">— Use day default —</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <div style={{ fontSize:12, color:"#888" }}>
                Today ({DAYS_SUN[todayDow]}) defaults: {[todaySlot1, todaySlot2].filter(Boolean).map(id => staff.find(s => s.id === id)?.name).filter(Boolean).join(" & ") || "Manager"}
              </div>
            </div>

            {/* Submissions */}
            {takings.filter(s => s.staff_id !== "manager").length > 0 && (
              <>
                <div style={{ fontSize:13, fontWeight:800, color:"#1A2744", marginBottom:8 }}>📨 Staff Submissions</div>
                {[...takings].filter(s => s.staff_id !== "manager").sort((a, b) => b.date.localeCompare(a.date)).map(sub => {
                  const total = TKFIELDS.reduce((s, f) => s + parseFloat(sub[f.db] || 0) * f.sign, 0);
                  return (
                    <div key={sub.id} className={`tmsg${sub.is_new ? " new" : ""}`}>
                      <div className="tmsg-h">{sub.is_new ? "🆕 New — " : "✓ "}{sub.staff_name} · {dispDate(sub.date, true)}<span style={{ float:"right", fontSize:14, fontWeight:900 }}>£{total.toFixed(2)}</span></div>
                      <div className="tmsg-d">{TKFIELDS.filter(f => parseFloat(sub[f.db] || 0) > 0).map(f => `${f.label.replace(/[🛵💵💳🌐🎟️🎫]/g, "").trim()}: £${sub[f.db]}`).join(" · ")}</div>
                      {sub.note && <div style={{ marginTop:4, fontSize:12, opacity:.8 }}>📝 {sub.note}</div>}
                      {sub.is_new && <button className="btn sm" style={{ marginTop:8, background:"#065F46", color:"#fff" }} onClick={async () => { await db.from("takings").update({ is_new:false }).eq("id", sub.id); setTakings(p => p.map(x => x.id === sub.id ? { ...x, is_new:false } : x)); }}>Mark Seen ✓</button>}
                    </div>
                  );
                })}
              </>
            )}

            {/* Manager manual entry */}
            <div className="card" style={{ marginTop:10 }}>
              <div className="cname" style={{ marginBottom:8 }}>✏️ Enter Takings Manually</div>
              <TakingsForm setTakings={setTakings} toast={t} />
            </div>

            <div className="expsec">
              <div className="exptitle">📤 Export Takings</div>
              <button className="expbtn p" onClick={exportTakings}>🔗 Push to Takings Sheet (Daily + Weekly)</button>
              <button className="expbtn s" onClick={() => copyTSV([...buildDaily(), [""], [""], ...buildWeekly()], t)}>📋 Copy — Paste into Sheet</button>
            </div>
          </>
        )}

        {/* ── EXPENSES ── */}
        {tab === "expenses" && <ExpensesTab expenses={expenses} onAdd={addExpense} onDelete={delExpense} toast={t} />}

        {/* ── ABSENCES ── */}
        {tab === "absence" && (
          <>
            <div className="sec">Absences</div>
            <button className="btn navy" style={{ marginBottom:14 }} onClick={() => { setAbsModal(true); setAbsStaff(""); setAbsDate(""); setAbsPeriod(""); }}>+ Log Absence for Staff</button>
            {absences.length === 0
              ? <div className="empty"><div className="emptyicon">📅</div><div className="emptytxt">No absences reported</div></div>
              : absences.map(a => (
                <div key={a.id} style={{ background:"#FFF8EC", border:"1.5px solid #F5A623", borderRadius:12, padding:"10px 13px", marginBottom:9, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div><div style={{ fontWeight:800, color:"#1A2744", fontSize:13 }}>👤 {a.staff_name}</div><div style={{ fontSize:12, color:"#888", marginTop:2 }}>{dispDate(a.date, true)} — {a.period}</div></div>
                  <button onClick={async () => { await db.from("absences").delete().eq("id", a.id); setAbsences(p => p.filter(x => x.id !== a.id)); }} style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, color:"#ccc" }}>🗑️</button>
                </div>
              ))
            }
          </>
        )}
      </div>

      {/* Modals */}
      {setupModal && <SetupModal s={setupModal} onClose={() => setSetupModal(null)} />}
      {pinModal && <PinModal onClose={() => setPinModal(false)} />}

      {cashPopup && (
        <div className="overlay" onClick={() => setCashPopup(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="stitle">💵 Cash Payments</div>
            <div className="ssub2">{fmtRange(weekRange.start, weekRange.end)}</div>
            {staff.filter(s => parseFloat(calcPay(s).cashAmt) > 0).map(s => {
              const p = calcPay(s);
              return <div key={s.id} className="cashrow"><span className="cashname">{s.name}</span><span className="cashamt">£{p.cashAmt}</span></div>;
            })}
            {staff.filter(s => parseFloat(calcPay(s).cashAmt) > 0).length === 0 && <div style={{ textAlign:"center", color:"#aaa", padding:"20px 0" }}>No cash payments this week</div>}
            <div style={{ borderTop:"2px solid #F0F0F0", marginTop:10, paddingTop:10, display:"flex", justifyContent:"space-between", fontSize:15, fontWeight:800, color:"#1A2744" }}>
              <span>Total Cash Out</span><span>£{totCash}</span>
            </div>
            <button className="btn sec" style={{ marginTop:14 }} onClick={() => setCashPopup(false)}>Close</button>
          </div>
        </div>
      )}

      {shareModal && (
        <div className="overlay" onClick={() => setShareModal(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="stitle">📤 Share Rota</div>
            <div className="ssub2">{staff.find(s => s.id === shareModal)?.name} · {fmtDate(rotaMon)} – {fmtDate(addDays(rotaMon, 6))}</div>
            <textarea className="lognote" rows={12} readOnly style={{ fontFamily:"monospace", fontSize:12, background:"#F7F4EF" }} value={buildRotaText(shareModal)} />
            <button className="btn" style={{ marginTop:12 }} onClick={() => { navigator.clipboard.writeText(buildRotaText(shareModal)).then(() => t("📋 Rota copied!")); setShareModal(null); }}>📋 Copy to Clipboard</button>
            <button className="btn sec" onClick={() => setShareModal(null)}>Close</button>
          </div>
        </div>
      )}

      {absModal && (
        <div className="overlay" onClick={() => setAbsModal(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="stitle">📅 Log Absence</div>
            <label className="lbl">Staff Member</label>
            <select className="inp sm" style={{ display:"block", width:"100%", marginBottom:14 }} value={absStaff} onChange={e => setAbsStaff(e.target.value)}>
              <option value="">— Select staff —</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <label className="lbl">Date</label>
            <input type="date" className="inp sm" style={{ display:"block", width:"100%", marginBottom:14 }} value={absDate} onChange={e => setAbsDate(e.target.value)} />
            <label className="lbl" style={{ marginBottom:8 }}>Period</label>
            <div className="peribtns">
              {["Morning","Evening","Full Day"].map(p => (
                <button key={p} className={`pbtn${absPeriod === p ? " sel" : ""}`} onClick={() => setAbsPeriod(p)}>
                  {p === "Morning" ? "🌅" : p === "Evening" ? "🌙" : "☀️"}<br />{p}
                </button>
              ))}
            </div>
            <button className="btn" style={{ marginTop:12 }} onClick={async () => {
              if (!absStaff || !absDate || !absPeriod) return t("Fill in all fields");
              const s = staff.find(x => x.id === absStaff);
              const { data, error } = await db.from("absences").insert({ staff_id:absStaff, staff_name:s?.name||"", date:absDate, period:absPeriod }).select().single();
              if (!error) { setAbsences(p => [...p, data]); setAbsModal(false); t("📅 Absence logged"); }
              else t("❌ " + error.message);
            }}>Save Absence</button>
            <button className="btn sec" onClick={() => setAbsModal(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TAKINGS FORM (manager manual entry)
// ═══════════════════════════════════════════════════════════════════
function TakingsForm({ setTakings, toast }) {
  const [values, setValues] = useState({});
  const [cc, setCC] = useState({});
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayISO());
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const vals = {};
    TKFIELDS.forEach(f => { vals[f.db] = parseFloat(values[f.key] || 0); if (f.ccDb) vals[f.ccDb] = cc[f.key] || "cash"; });
    const { data, error } = await db.from("takings").insert({ staff_id:"manager", staff_name:"Manager", date, ...vals, note, is_new:false }).select().single();
    if (!error) { setTakings(p => [data, ...p]); setValues({}); setNote(""); setDate(todayISO()); toast("✅ Takings saved!"); }
    else toast("❌ " + error.message);
    setSaving(false);
  }

  return (
    <>
      <label className="lbl">Date</label>
      <input type="date" className="inp sm" style={{ display:"block", width:"100%", marginBottom:12 }} value={date} onChange={e => setDate(e.target.value)} />
      {TKFIELDS.map(f => (
        <div key={f.key} className="tfield">
          <div className="tlbl">
            <span>{f.label}</span>
            {f.cc && (
              <div className="toggle" style={{ transform:"scale(.8)", transformOrigin:"right" }}>
                {["cash","card"].map(c => <button key={c} className={`tgl${(cc[f.key]||"cash")===c?" on":""}`} onClick={() => setCC(p => ({ ...p, [f.key]:c }))}>{c}</button>)}
              </div>
            )}
          </div>
          {f.hint && <div className="thint">{f.hint}</div>}
          <input className="inp sm" style={{ display:"block", width:"100%", marginTop:3 }} type="number" min="0" placeholder="0.00" value={values[f.key] || ""} onChange={e => setValues(p => ({ ...p, [f.key]:e.target.value }))} />
        </div>
      ))}
      <label className="lbl" style={{ marginTop:8 }}>Note</label>
      <textarea className="lognote" rows={2} style={{ marginBottom:10 }} placeholder="Any notes…" value={note} onChange={e => setNote(e.target.value)} />
      <button className="btn" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save Takings"}</button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EXPENSES TAB
// ═══════════════════════════════════════════════════════════════════
function ExpensesTab({ expenses, onAdd, onDelete, toast }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [payType, setPayType] = useState("cash");
  const [date, setDate] = useState(todayISO());
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!desc || !amount) return toast("Fill in description and amount");
    setSaving(true);
    const { error } = await onAdd(desc, amount, payType, date);
    if (!error) { setDesc(""); setAmount(""); toast("✓ Expense added"); }
    else toast("❌ " + error.message);
    setSaving(false);
  }

  const total = expenses.reduce((a, e) => a + e.amount, 0);

  return (
    <>
      <div className="sec">Shop Expenses</div>
      <div className="card">
        <label className="lbl">Date of Expense</label>
        <input type="date" className="inp sm" style={{ display:"block", width:"100%", marginBottom:10 }} value={date} onChange={e => setDate(e.target.value)} />
        <label className="lbl">Description</label>
        <input className="inp sm" style={{ display:"block", width:"100%", marginBottom:10 }} placeholder="e.g. Cleaning supplies" value={desc} onChange={e => setDesc(e.target.value)} />
        <div style={{ display:"flex", gap:8, marginBottom:10, alignItems:"flex-end" }}>
          <div style={{ flex:1 }}>
            <label className="lbl">Amount (£)</label>
            <input className="inp sm" style={{ width:"100%" }} type="number" min="0" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="lbl">Paid by</label>
            <div className="toggle">
              {["cash","card"].map(c => <button key={c} className={`tgl${payType===c?" on":""}`} onClick={() => setPayType(c)}>{c === "cash" ? "💵" : "💳"} {c}</button>)}
            </div>
          </div>
        </div>
        <button className="btn" onClick={add} disabled={saving}>{saving ? "Adding…" : "Add Expense"}</button>
      </div>
      {expenses.length === 0
        ? <div className="empty"><div className="emptyicon">🧾</div><div className="emptytxt">No expenses yet</div></div>
        : (
          <>
            <div className="sec">Logged Expenses</div>
            {[...expenses].sort((a, b) => b.date.localeCompare(a.date)).map(e => (
              <div key={e.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom:"1px solid #F0F0F0" }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:"#1A2744" }}>{e.description}</div>
                  <div style={{ fontSize:11, color:"#aaa" }}>{fmtDate(e.date)} · {e.pay_type === "cash" ? "💵 Cash" : "💳 Card"}</div>
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <div style={{ fontSize:13, fontWeight:800, color:"#E05252" }}>-£{e.amount.toFixed(2)}</div>
                  <button onClick={() => onDelete(e.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, color:"#ccc" }}>🗑️</button>
                </div>
              </div>
            ))}
            <div style={{ display:"flex", justifyContent:"space-between", padding:"10px 0 0", fontSize:14, fontWeight:800, color:"#1A2744", borderTop:"2px solid #F0F0F0", marginTop:4 }}>
              <span>Total</span><span>£{total.toFixed(2)}</span>
            </div>
          </>
        )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState("role");
  const [user, setUser] = useState(null);
  const [allStaff, setAllStaff] = useState([]);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [effectiveTakingsPerson, setEffectiveTakingsPerson] = useState(null);

  useEffect(() => {
    if (screen === "staffLogin") {
      setLoadingStaff(true);
      db.from("staff").select("id,name,code").order("name")
        .then(({ data }) => { setAllStaff(data || []); setLoadingStaff(false); });
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "staff" && user) {
      const dow = new Date().getDay();
      Promise.all([
        db.from("takings_assignment").select("staff_id").eq("date", todayISO()).maybeSingle(),
        db.from("takings_defaults").select("staff_id").eq("day_of_week", dow).eq("slot", 1).maybeSingle(),
      ]).then(([ovR, defR]) => {
        setEffectiveTakingsPerson(ovR.data?.staff_id || defR.data?.staff_id || null);
      });
    }
  }, [screen, user]);

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        {screen === "role" && <RolePicker onPick={r => setScreen(r === "staff" ? "staffLogin" : "managerLogin")} />}
        {screen === "staffLogin" && (loadingStaff ? <Loading text="Loading…" /> : <StaffLogin staff={allStaff} onLogin={u => { setUser(u); setScreen("staff"); }} onBack={() => setScreen("role")} onRegister={() => setScreen("staffRegister")} />)}
        {screen === "staffRegister" && <StaffRegister onBack={() => setScreen("staffLogin")} onRegister={u => { setUser(u); setScreen("staff"); }} />}
        {screen === "managerLogin" && <ManagerLogin onLogin={() => setScreen("manager")} onBack={() => setScreen("role")} />}
        {screen === "staff" && user && <StaffApp user={user} onLogout={() => { setUser(null); setScreen("role"); }} effectiveTakingsPerson={effectiveTakingsPerson} />}
        {screen === "manager" && <ManagerApp onLogout={() => setScreen("role")} />}
      </div>
    </>
  );
}
