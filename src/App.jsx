import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════════════════════════
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const SHIFT_TYPES = ["Off","Full Day (11am–close)","Night (5:30pm–close)","Custom"];
const ADDITION_LABELS = ["Bank Holiday","Red Day","Other"];
const DEDUCTION_LABELS = ["Left Early","Sick Leave","Other"];
const TAKING_FIELDS = [
  {key:"deliveroo",label:"Deliveroo 🛵",sign:1},
  {key:"uber",label:"Uber Eats 🛵",sign:1},
  {key:"cash",label:"Cash 💵",sign:1},
  {key:"card",label:"Card 💳",sign:1},
  {key:"online",label:"Online 🌐",sign:1},
  {key:"depositReceipt",label:"Deposit Receipt",sign:1,hasCashCard:true,dbKey:"deposit_receipt",dbPayKey:"deposit_pay_type"},
  {key:"voucherRedemption",label:"Voucher Redemption 🎟️",sign:-1,hint:"Enter as a normal number — we handle the deduction automatically",dbKey:"voucher_redemption"},
  {key:"voucherPurchase",label:"Voucher Purchase 🎫",sign:1,hasCashCard:true,dbKey:"voucher_purchase",dbPayKey:"voucher_pay_type"},
];

function todayISO(){ return new Date().toISOString().split("T")[0]; }
function nowTime(){ return new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}); }
function fmtDate(iso){ if(!iso)return""; const[y,m,d]=iso.split("-"); return`${d}/${m}/${y}`; }
function parseHours(inn,out){
  if(!inn||!out)return 0;
  const p=t=>{const[h,mn]=t.split(":").map(Number);return h+mn/60;};
  return Math.max(0,p(out)-p(inn));
}
function getWeekRange(dateISO){
  const d=new Date(dateISO+"T12:00:00");
  const sun=new Date(d); sun.setDate(d.getDate()-d.getDay());
  const sat=new Date(sun); sat.setDate(sun.getDate()+6);
  return{start:sun.toISOString().split("T")[0],end:sat.toISOString().split("T")[0]};
}
function fmtRange(s,e){ return`${fmtDate(s)} - ${fmtDate(e)}`; }
function isoToDisplay(iso){ if(!iso)return""; const d=new Date(iso+"T12:00:00"); return d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}); }
function currentWeekRange(){ return getWeekRange(todayISO()); }

// ═══════════════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════════════
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:#F7F4EF;-webkit-tap-highlight-color:transparent;overscroll-behavior:none;}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;position:relative;overflow-x:hidden;}
.role-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;background:linear-gradient(160deg,#1A2744 0%,#2C3E6B 100%);}
.role-logo{font-size:52px;margin-bottom:12px;}
.role-title{font-size:28px;font-weight:900;color:#fff;text-align:center;margin-bottom:6px;}
.role-sub{font-size:14px;color:rgba(255,255,255,.55);margin-bottom:36px;text-align:center;}
.role-btn{width:100%;padding:20px;border-radius:18px;border:none;cursor:pointer;margin-bottom:12px;display:flex;align-items:center;gap:14px;transition:transform .1s;}
.role-btn:active{transform:scale(.97);}
.role-btn.staff{background:#F5A623;color:#1A2744;}
.role-btn.manager{background:#fff;color:#1A2744;}
.role-btn-icon{font-size:30px;}
.role-btn-label{font-size:17px;font-weight:800;display:block;}
.role-btn-desc{font-size:12px;font-weight:500;opacity:.6;display:block;}
.auth-screen{min-height:100vh;padding:48px 24px 32px;display:flex;flex-direction:column;}
.auth-back{background:none;border:none;font-size:26px;cursor:pointer;align-self:flex-start;margin-bottom:20px;color:#1A2744;}
.auth-title{font-size:25px;font-weight:900;color:#1A2744;margin-bottom:6px;}
.auth-sub{font-size:14px;color:#888;margin-bottom:24px;line-height:1.6;}
.lbl{font-size:12px;font-weight:700;color:#888;margin-bottom:5px;display:block;text-transform:uppercase;letter-spacing:.5px;}
.inp{width:100%;padding:14px;border:2px solid #E5E5E5;border-radius:12px;font-size:15px;font-family:inherit;margin-bottom:14px;outline:none;transition:border-color .2s;background:#fff;}
.inp:focus{border-color:#F5A623;}
.inp.code{font-size:26px;letter-spacing:8px;font-weight:800;text-align:center;color:#1A2744;}
.inp.sm{padding:9px 11px;font-size:13px;margin-bottom:0;border-radius:9px;}
.inp.time{padding:8px 9px;font-size:12px;margin-bottom:0;width:auto;flex:1;border-radius:8px;}
.btn{width:100%;padding:16px;background:#F5A623;border:none;border-radius:14px;font-size:15px;font-weight:800;color:#1A2744;cursor:pointer;margin-top:8px;transition:transform .1s;display:block;text-align:center;}
.btn:active{transform:scale(.98);}
.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn.sec{background:#F0F0F0;color:#1A2744;margin-top:10px;}
.btn.danger{background:#E05252;color:#fff;}
.btn.green{background:#50DC78;color:#1A2744;}
.btn.sm{padding:9px 14px;font-size:12px;width:auto;margin-top:0;border-radius:9px;}
.btn.navy{background:#1A2744;color:#fff;}
.err{color:#E05252;font-weight:700;font-size:13px;margin-bottom:10px;}
.staff-list{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;}
.staff-item{padding:14px 16px;background:#F7F4EF;border-radius:12px;display:flex;align-items:center;gap:12px;cursor:pointer;border:2px solid transparent;}
.staff-item:hover{border-color:#ddd;}
.avatar{width:42px;height:42px;border-radius:21px;background:#1A2744;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;flex-shrink:0;}
.hdr{padding:18px 18px 8px;display:flex;align-items:center;justify-content:space-between;}
.hdr-name{font-size:19px;font-weight:900;color:#1A2744;}
.hdr-greet{font-size:12px;color:#aaa;font-weight:500;}
.hdr-logout{background:none;border:none;font-size:22px;cursor:pointer;}
.body{padding:0 16px 110px;}
.sec{font-size:16px;font-weight:800;color:#1A2744;margin:16px 0 10px;}
.sec-sub{font-size:12px;color:#aaa;margin-top:-6px;margin-bottom:10px;}
.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:#fff;border-top:1px solid #F0F0F0;display:flex;padding:8px 0 env(safe-area-inset-bottom,18px);z-index:100;}
.nbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;border:none;background:none;cursor:pointer;padding:4px;position:relative;}
.nbtn .ni{font-size:20px;}
.nbtn .nl{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:.3px;}
.nbtn.active .nl{color:#F5A623;}
.nbadge{position:absolute;top:0;right:calc(50% - 18px);background:#E05252;color:#fff;border-radius:10px;font-size:10px;font-weight:800;padding:1px 5px;min-width:16px;text-align:center;}
.clk-card{background:linear-gradient(135deg,#1A2744,#2C3E6B);border-radius:20px;padding:20px;margin-bottom:14px;color:#fff;}
.clk-time{font-size:40px;font-weight:900;letter-spacing:-1px;}
.clk-date{font-size:12px;color:rgba(255,255,255,.5);margin-bottom:12px;}
.clk-st{display:inline-block;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:700;margin-bottom:14px;}
.clk-st.in{background:rgba(80,220,120,.2);color:#50DC78;}
.clk-st.out{background:rgba(255,255,255,.1);color:rgba(255,255,255,.4);}
.clk-btns{display:flex;gap:8px;}
.clk-btn{flex:1;padding:13px;border-radius:11px;border:none;font-size:13px;font-weight:800;cursor:pointer;}
.clk-btn.in{background:#50DC78;color:#1A2744;}
.clk-btn.out{background:#E05252;color:#fff;}
.clk-btn:disabled{opacity:.3;cursor:not-allowed;}
.clk-hist{margin-top:12px;}
.clk-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:11px;color:rgba(255,255,255,.65);}
.clk-row:last-child{border:none;}
.rday{background:#F7F4EF;border-radius:13px;padding:12px 13px;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
.rday.today{background:#FFF8EC;border:2px solid #F5A623;}
.rday.off{opacity:.4;}
.rday-lbl{min-width:34px;}
.rday-name{font-size:12px;font-weight:800;color:#1A2744;}
.rday-flag{font-size:9px;font-weight:700;color:#F5A623;}
.rday-shift{flex:1;font-size:13px;font-weight:700;color:#1A2744;}
.rday-actions{display:flex;gap:5px;}
.reject-btn{border:none;background:#FEE2E2;color:#E05252;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;}
.confirm-btn{border:none;background:#D1FAE5;color:#065F46;border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;cursor:pointer;}
.abs-card{background:#FFF8EC;border:2px solid #F5A623;border-radius:16px;padding:16px;margin-bottom:14px;}
.period-btns{display:flex;gap:6px;margin-bottom:12px;}
.pbtn{flex:1;padding:10px 4px;border:2px solid #E5E5E5;border-radius:10px;background:#fff;font-size:12px;font-weight:700;color:#1A2744;cursor:pointer;text-align:center;}
.pbtn.sel{border-color:#F5A623;background:#FFF8EC;}
.toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#1A2744;color:#fff;padding:10px 18px;border-radius:40px;font-size:13px;font-weight:700;z-index:999;white-space:nowrap;animation:fio 2.8s forwards;pointer-events:none;}
@keyframes fio{0%{opacity:0;top:10px}12%{opacity:1;top:24px}80%{opacity:1}100%{opacity:0}}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:200;}
.sheet{background:#fff;border-radius:24px 24px 0 0;padding:24px 20px 40px;width:100%;max-width:430px;max-height:90vh;overflow-y:auto;}
.sheet-title{font-size:19px;font-weight:900;color:#1A2744;margin-bottom:4px;}
.sheet-sub{font-size:13px;color:#888;margin-bottom:14px;}
.toggle{display:flex;border:2px solid #E5E5E5;border-radius:10px;overflow:hidden;width:fit-content;}
.tgl-btn{padding:6px 13px;border:none;background:#fff;font-size:12px;font-weight:700;cursor:pointer;color:#888;}
.tgl-btn.active{background:#1A2744;color:#fff;}
.mgr-hdr{background:linear-gradient(135deg,#1A2744,#0F1D3A);padding:22px 16px 14px;display:flex;justify-content:space-between;align-items:flex-start;}
.mgr-title{font-size:20px;font-weight:900;color:#fff;}
.mgr-sub{font-size:11px;color:rgba(255,255,255,.4);}
.mgr-lo{background:rgba(255,255,255,.12);border:none;color:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600;}
.mgr-tabs{display:flex;overflow-x:auto;gap:2px;padding:0 12px;border-bottom:2px solid #F0F0F0;scrollbar-width:none;}
.mgr-tabs::-webkit-scrollbar{display:none;}
.mtab{white-space:nowrap;padding:10px 11px;border:none;background:none;font-size:12px;font-weight:700;color:#bbb;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;}
.mtab.active{color:#1A2744;border-bottom-color:#F5A623;}
.mgr-body{padding:12px 16px 110px;}
.card{background:#F7F4EF;border-radius:14px;padding:13px 14px;margin-bottom:10px;}
.card.white{background:#fff;border:1.5px solid #F0F0F0;}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.card-name{font-size:14px;font-weight:800;color:#1A2744;}
.card-sub{font-size:11px;color:#888;margin-top:2px;}
.chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;}
.chip.g{background:#D1FAE5;color:#065F46;}
.chip.r{background:#FEE2E2;color:#7F1D1D;}
.chip.a{background:#FEF3C7;color:#78350F;}
.chip.b{background:#DBEAFE;color:#1E40AF;}
.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #F0F0F0;font-size:13px;color:#555;}
.row:last-child{border:none;}
.row-bold{font-weight:800;color:#1A2744;}
.rej-banner{background:#FEE2E2;border:1.5px solid #E05252;border-radius:11px;padding:9px 13px;margin-bottom:8px;font-size:12px;color:#7F1D1D;font-weight:600;display:flex;justify-content:space-between;align-items:center;}
.taking-msg{background:#D1FAE5;border:1.5px solid #50DC78;border-radius:13px;padding:12px 14px;margin-bottom:10px;}
.taking-msg-head{font-size:13px;font-weight:800;color:#065F46;margin-bottom:3px;}
.taking-msg-detail{font-size:12px;color:#047857;}
.taking-msg.new-sub{background:#FFF8EC;border-color:#F5A623;}
.taking-msg.new-sub .taking-msg-head{color:#78350F;}
.taking-msg.new-sub .taking-msg-detail{color:#92400E;}
.log-entry{padding:9px 0;border-bottom:1px dashed #E5E5E5;}
.log-entry:last-child{border:none;}
.log-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;}
.log-note{width:100%;padding:7px 9px;border:1.5px solid #E5E5E5;border-radius:8px;font-size:12px;font-family:inherit;outline:none;margin-top:4px;background:#fff;resize:none;}
.log-note:focus{border-color:#F5A623;}
.log-edit-row{display:flex;gap:5px;align-items:center;margin-bottom:5px;}
.log-edit-lbl{font-size:10px;font-weight:700;color:#aaa;min-width:24px;}
.pay-card{background:#fff;border:2px solid #F0F0F0;border-radius:14px;margin-bottom:10px;overflow:hidden;}
.pay-head{background:#F7F4EF;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;}
.pay-name{font-size:14px;font-weight:800;color:#1A2744;}
.pay-total{font-size:18px;font-weight:900;color:#F5A623;}
.pay-body{padding:11px 14px;}
.mini-inp{width:74px;padding:5px 7px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-family:inherit;outline:none;}
.mini-inp:focus{border-color:#F5A623;}
.add-row{display:flex;gap:5px;align-items:center;margin-top:6px;}
.add-inp{flex:1;padding:7px 9px;border:1.5px solid #E5E5E5;border-radius:8px;font-size:12px;font-family:inherit;outline:none;}
.add-inp:focus{border-color:#F5A623;}
.add-btn-sm{padding:7px 11px;background:#F5A623;border:none;border-radius:7px;font-size:11px;font-weight:800;color:#1A2744;cursor:pointer;}
.add-btn-sm.r{background:#FEE2E2;color:#7F1D1D;}
.exp-sec{background:#F7F4EF;border-radius:14px;padding:13px;margin-top:12px;}
.exp-title{font-size:13px;font-weight:800;color:#1A2744;margin-bottom:9px;}
.exp-btn{width:100%;padding:13px;border:none;border-radius:11px;font-size:13px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:7px;}
.exp-btn:last-child{margin-bottom:0;}
.exp-btn.primary{background:#1A2744;color:#fff;}
.exp-btn.sec{background:#E8F0E9;color:#1A2744;}
.exp-hint{font-size:11px;color:#aaa;margin-top:6px;line-height:1.5;}
.take-field{margin-bottom:9px;}
.take-lbl{font-size:12px;font-weight:700;color:#555;margin-bottom:3px;display:flex;justify-content:space-between;align-items:center;}
.take-hint{font-size:10px;color:#aaa;margin-top:2px;font-style:italic;}
.notif{background:linear-gradient(135deg,#F5A623,#E8940A);border-radius:14px;padding:14px;margin-bottom:14px;cursor:pointer;}
.notif-title{font-size:14px;font-weight:900;color:#1A2744;margin-bottom:3px;}
.notif-sub{font-size:12px;color:rgba(26,39,68,.7);}
.warn-banner{background:#FEE2E2;border:2px solid #E05252;border-radius:13px;padding:12px 14px;margin-bottom:12px;}
.warn-title{font-size:13px;font-weight:800;color:#7F1D1D;margin-bottom:3px;}
.warn-sub{font-size:12px;color:#991B1B;}
.divider{height:1px;background:#F0F0F0;margin:10px 0;}
.empty{text-align:center;padding:36px 20px;color:#ccc;}
.empty-icon{font-size:42px;margin-bottom:8px;}
.empty-text{font-size:14px;font-weight:600;}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#F7F4EF;gap:16px;}
.loading-spinner{width:40px;height:40px;border:4px solid #E5E5E5;border-top-color:#F5A623;border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-text{font-size:14px;font-weight:600;color:#888;}
.gs-info{background:#F7F4EF;border-radius:10px;padding:10px 12px;font-size:12px;color:#888;margin-bottom:14px;line-height:1.7;}
`;

// ═══════════════════════════════════════════════════════════════════
// GOOGLE SHEETS PUSH
// ═══════════════════════════════════════════════════════════════════
async function pushSheet(apiKey, spreadsheetId, sheetName, rows) {
  if (!apiKey || !spreadsheetId) return { ok: false, err: "Not configured" };
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName+"!A1:Z2000")}:clear?key=${apiKey}`,{method:"POST"});
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName+"!A1")}?valueInputOption=USER_ENTERED&key=${apiKey}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({values:rows})});
    if (!res.ok){const e=await res.json();return{ok:false,err:e.error?.message||"API error"};}
    return {ok:true};
  } catch(e){return{ok:false,err:e.message};}
}
function copyTSV(rows, t) {
  const tsv = rows.map(r=>r.map(c=>String(c??'')).join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(()=>t("📋 Copied! Open Google Sheets → click A1 → Ctrl+V")).catch(()=>t("❌ Copy failed — try a different browser"));
}

// ═══════════════════════════════════════════════════════════════════
// TOAST & LOADING
// ═══════════════════════════════════════════════════════════════════
function Toast({msg}){return msg?<div className="toast">{msg}</div>:null;}
function Loading({text="Loading…"}){return(<div className="loading"><div className="loading-spinner"/><div className="loading-text">{text}</div></div>);}

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
        <span className="role-btn-icon">👤</span>
        <span><span className="role-btn-label">I'm a Staff Member</span><span className="role-btn-desc">Clock in/out · View rota · Report absence</span></span>
      </button>
      <button className="role-btn manager" onClick={()=>onPick("manager")}>
        <span className="role-btn-icon">🔑</span>
        <span><span className="role-btn-label">I'm the Manager</span><span className="role-btn-desc">Rota · Payroll · Takings · Expenses</span></span>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF AUTH
// ═══════════════════════════════════════════════════════════════════
function StaffLogin({staff,onLogin,onBack,onRegister}){
  const[sel,setSel]=useState(null);
  const[code,setCode]=useState("");
  const[step,setStep]=useState("pick");
  const[err,setErr]=useState("");

  if(step==="code") return(
    <div className="auth-screen">
      <button className="auth-back" onClick={()=>{setStep("pick");setErr("");}}>←</button>
      <div className="auth-title">Hi {sel.name.split(" ")[0]}! 👋</div>
      <div className="auth-sub">Enter your 8-digit code to sign in</div>
      <label className="lbl">Your Code</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} onChange={e=>{setCode(e.target.value);setErr("");}} autoFocus/>
      {err&&<div className="err">{err}</div>}
      <button className="btn" onClick={()=>{if(code===sel.code)onLogin(sel);else{setErr("Wrong code — try again");setCode("");}}} disabled={code.length!==8}>Sign In</button>
      <div style={{textAlign:"center",fontSize:13,color:"#aaa",marginTop:14}}>Forgot your code? Ask the manager</div>
    </div>
  );

  return(
    <div className="auth-screen">
      <button className="auth-back" onClick={onBack}>←</button>
      <div className="auth-title">Who are you? 👋</div>
      <div className="auth-sub">Tap your name, then enter your code</div>
      <div className="staff-list">
        {staff.map(s=>(
          <div key={s.id} className="staff-item" onClick={()=>{setSel(s);setStep("code");setCode("");setErr("");}}>
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
    if(!name.trim())return setErr("Please type your name");
    if(!/^\d{8}$/.test(code))return setErr("Code must be exactly 8 digits");
    if(code!==confirm)return setErr("Codes don't match — try again");
    setSaving(true);
    const{error}=await supabase.from("staff").insert({id:code,name:name.trim(),code,pay_type:"hourly",rate:"0",shift_rate:"0",night_rate:"0",cash_card:"cash"});
    if(error){setSaving(false);return setErr(error.message==="duplicate key value violates unique constraint \"staff_pkey\""?"That code is already taken — choose a different one":error.message);}
    onRegister({id:code,name:name.trim(),code,payType:"hourly",rate:"0",shiftRate:"0",nightRate:"0",cashCard:"cash"});
  }
  return(
    <div className="auth-screen">
      <button className="auth-back" onClick={onBack}>←</button>
      <div className="auth-title">Create Account 🎉</div>
      <div className="auth-sub">Pick 8 numbers you'll remember — like your birthday: 01051990</div>
      <label className="lbl">Your Full Name</label>
      <input className="inp" placeholder="e.g. Amy Chen" value={name} onChange={e=>setName(e.target.value)}/>
      <label className="lbl">Choose 8-Digit Code</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={code} onChange={e=>setCode(e.target.value)}/>
      <label className="lbl">Type Code Again to Confirm</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={confirm} onChange={e=>setConfirm(e.target.value)}/>
      {err&&<div className="err">{err}</div>}
      <button className="btn" onClick={handle} disabled={saving}>{saving?"Creating…":"Create Account"}</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STAFF APP
// ═══════════════════════════════════════════════════════════════════
function StaffApp({user,onLogout,takingsAssignment}){
  const[tab,setTab]=useState("home");
  const[toast,setToast]=useState("");
  const[clockedIn,setClockedIn]=useState(false);
  const[clockInTime,setClockInTime]=useState(null);
  const[clockLogs,setClockLogs]=useState([]);
  const[rota,setRota]=useState([]);
  const[absences,setAbsences]=useState([]);
  const[rejections,setRejections]=useState([]);
  const[confirmations,setConfirmations]=useState([]);
  const[absDate,setAbsDate]=useState("");
  const[absPeriod,setAbsPeriod]=useState("");
  const[rejectModal,setRejectModal]=useState(null);
  const[rejectReason,setRejectReason]=useState("");
  const[takingsValues,setTakingsValues]=useState({});
  const[takingsPayTypes,setTakingsPayTypes]=useState({});
  const[takingsNote,setTakingsNote]=useState("");
  const[loading,setLoading]=useState(true);

  const assigned=takingsAssignment?.staff_id===user.id&&takingsAssignment?.date===todayISO();
  const now=new Date();

  function t(m){setToast(m);setTimeout(()=>setToast(""),2800);}

  useEffect(()=>{loadData();},[]);

  async function loadData(){
    setLoading(true);
    const weekStart=currentWeekRange().start;
    const[logsRes,rotaRes,absRes,rejRes,confRes]=await Promise.all([
      supabase.from("clock_logs").select("*").eq("staff_id",user.id).order("date",{ascending:false}).limit(20),
      supabase.from("rota").select("*").eq("staff_id",user.id).eq("week_start",weekStart),
      supabase.from("absences").select("*").eq("staff_id",user.id).order("date",{ascending:false}),
      supabase.from("rejections").select("*").eq("staff_id",user.id),
      supabase.from("confirmations").select("*").eq("staff_id",user.id),
    ]);
    setClockLogs(logsRes.data||[]);
    // Build rota array indexed by day
    const rotaArr=DAYS.map((_,i)=>{
      const row=(rotaRes.data||[]).find(r=>r.day_index===i);
      return row?{type:row.shift_type,customIn:row.custom_in||"",customOut:row.custom_out||""}:{type:"Off",customIn:"",customOut:""};
    });
    setRota(rotaArr);
    setAbsences(absRes.data||[]);
    setRejections(rejRes.data||[]);
    setConfirmations(confRes.data||[]);
    // Check if currently clocked in
    const active=(logsRes.data||[]).find(l=>l.date===todayISO()&&l.time_in&&!l.time_out);
    if(active){setClockedIn(true);setClockInTime(active.time_in);}
    setLoading(false);
  }

  async function clockIn(){
    const time=nowTime();
    const{data,error}=await supabase.from("clock_logs").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),time_in:time,note:""}).select().single();
    if(!error){setClockLogs(p=>[data,...p]);setClockedIn(true);setClockInTime(time);t("✅ Clocked in at "+time);}
    else t("❌ Error: "+error.message);
  }

  async function clockOut(){
    const time=nowTime();
    const active=clockLogs.find(l=>l.date===todayISO()&&l.time_in&&!l.time_out);
    if(!active)return;
    const{error}=await supabase.from("clock_logs").update({time_out:time}).eq("id",active.id);
    if(!error){setClockLogs(p=>p.map(l=>l.id===active.id?{...l,time_out:time}:l));setClockedIn(false);t("👋 Clocked out at "+time);}
    else t("❌ Error: "+error.message);
  }

  async function reportAbsence(){
    if(!absDate||!absPeriod)return t("Please pick a date and period");
    const{data,error}=await supabase.from("absences").insert({staff_id:user.id,staff_name:user.name,date:absDate,period:absPeriod}).select().single();
    if(!error){setAbsences(p=>[...p,data]);setAbsDate("");setAbsPeriod("");t("📅 Absence sent to manager!");}
    else t("❌ "+error.message);
  }

  async function confirmShift(dayIndex){
    const{data,error}=await supabase.from("confirmations").insert({staff_id:user.id,staff_name:user.name,day:DAYS[dayIndex]}).select().single();
    if(!error){setConfirmations(p=>[...p,data]);t("✅ Shift confirmed!");}
  }

  async function rejectShift(){
    const{data,error}=await supabase.from("rejections").insert({staff_id:user.id,staff_name:user.name,day:DAYS[rejectModal],reason:rejectReason}).select().single();
    if(!error){setRejections(p=>[...p,data]);setRejectModal(null);t("Rejection sent to manager");}
  }

  async function submitTakings(){
    const vals={};
    TAKING_FIELDS.forEach(f=>{vals[f.dbKey||f.key]=parseFloat(takingsValues[f.key]||0);if(f.dbPayKey)vals[f.dbPayKey]=takingsPayTypes[f.key]||"cash";});
    const{error}=await supabase.from("takings").insert({staff_id:user.id,staff_name:user.name,date:todayISO(),...vals,note:takingsNote,is_new:true});
    if(!error){setTakingsValues({});setTakingsPayTypes({});setTakingsNote("");t("📊 Takings submitted!");setTab("home");}
    else t("❌ "+error.message);
  }

  function shiftLabel(sh){
    if(!sh||sh.type==="Off")return"Day off";
    if(sh.type==="Full Day (11am–close)")return"Full Day 11am–close";
    if(sh.type==="Night (5:30pm–close)")return"Night 5:30pm–close";
    if(sh.type==="Custom")return`${sh.customIn||"?"}–${sh.customOut||"?"}`;
    return sh.type;
  }

  // Check if already submitted takings today
  const[alreadySubmitted,setAlreadySubmitted]=useState(false);
  useEffect(()=>{
    if(assigned){
      supabase.from("takings").select("id").eq("staff_id",user.id).eq("date",todayISO()).then(({data})=>setAlreadySubmitted((data||[]).length>0));
    }
  },[assigned]);

  if(loading)return<Loading text="Loading your data…"/>;

  const recentLogs=clockLogs.slice(0,5);
  const navItems=[
    {id:"home",icon:"🏠",label:"Home"},
    {id:"rota",icon:"📋",label:"Rota"},
    {id:"absence",icon:"📅",label:"Absence"},
    ...(assigned?[{id:"takings",icon:"📊",label:"Takings",badge:!alreadySubmitted}]:[]),
  ];

  function RotaDays(){
    return rota.map((shift,i)=>{
      const isToday=i===now.getDay();
      const rejected=rejections.some(r=>r.day===DAYS[i]);
      const confirmed=confirmations.some(r=>r.day===DAYS[i]);
      const isOff=!shift||shift.type==="Off";
      return(
        <div key={i} className={`rday${isToday?" today":""}${isOff?" off":""}`}>
          <div className="rday-lbl"><div className="rday-name">{DAYS[i]}</div>{isToday&&<div className="rday-flag">TODAY</div>}</div>
          <div className="rday-shift">{shiftLabel(shift)}</div>
          {!isOff&&!rejected&&!confirmed&&(
            <div className="rday-actions">
              <button className="confirm-btn" onClick={()=>confirmShift(i)}>✓ OK</button>
              <button className="reject-btn" onClick={()=>{setRejectModal(i);setRejectReason("");}}>✕ Can't</button>
            </div>
          )}
          {confirmed&&<span className="chip g">✓ Confirmed</span>}
          {rejected&&<span className="chip r">Rejected</span>}
        </div>
      );
    });
  }

  return(
    <div className="app">
      <Toast msg={toast}/>
      <div className="hdr">
        <div>
          <div className="hdr-greet">Good {now.getHours()<12?"morning":now.getHours()<18?"afternoon":"evening"},</div>
          <div className="hdr-name">{user.name.split(" ")[0]} 👋</div>
        </div>
        <button className="hdr-logout" onClick={onLogout}>🚪</button>
      </div>

      {tab==="home"&&(
        <div className="body">
          {assigned&&!alreadySubmitted&&(
            <div className="notif" onClick={()=>setTab("takings")}>
              <div className="notif-title">📊 You're today's Takings Person!</div>
              <div className="notif-sub">Tap here to record today's daily takings →</div>
            </div>
          )}
          <div className="clk-card">
            <div className="clk-time">{now.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>
            <div className="clk-date">{now.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</div>
            <div className={`clk-st ${clockedIn?"in":"out"}`}>{clockedIn?`● Clocked in at ${clockInTime}`:"● Not clocked in"}</div>
            <div className="clk-btns">
              <button className="clk-btn in" onClick={clockIn} disabled={clockedIn}>🟢 Clock In</button>
              <button className="clk-btn out" onClick={clockOut} disabled={!clockedIn}>🔴 Clock Out</button>
            </div>
            {recentLogs.length>0&&(
              <div className="clk-hist">
                {recentLogs.slice(0,3).map(l=>(
                  <div key={l.id} className="clk-row">
                    <span>{isoToDisplay(l.date)}</span>
                    <span>{l.time_in} → {l.time_out||"active"}</span>
                    <span style={{fontWeight:700}}>{l.time_out?parseHours(l.time_in,l.time_out).toFixed(1)+"h":""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="sec">This Week</div>
          <RotaDays/>
        </div>
      )}

      {tab==="rota"&&(
        <div className="body">
          <div className="sec">My Full Rota</div>
          <div className="sec-sub">Week of {now.toLocaleDateString("en-GB",{day:"numeric",month:"long"})}</div>
          <RotaDays/>
        </div>
      )}

      {tab==="absence"&&(
        <div className="body">
          <div className="sec">Report Absence</div>
          <div className="abs-card">
            <div style={{fontSize:14,fontWeight:800,color:"#1A2744",marginBottom:4}}>📅 Can't come in?</div>
            <div style={{fontSize:12,color:"#888",marginBottom:12}}>Pick the date and when you can't work</div>
            <label className="lbl">Which day?</label>
            <input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:12}} value={absDate} min={todayISO()} onChange={e=>setAbsDate(e.target.value)}/>
            <label className="lbl" style={{marginBottom:7}}>Which part of the day?</label>
            <div className="period-btns">
              {["Morning","Evening","Full Day"].map(p=>(
                <button key={p} className={`pbtn${absPeriod===p?" sel":""}`} onClick={()=>setAbsPeriod(p)}>
                  {p==="Morning"?"🌅":p==="Evening"?"🌙":"☀️"}<br/>{p}
                </button>
              ))}
            </div>
            <button className="btn" style={{marginTop:10}} onClick={reportAbsence} disabled={!absDate||!absPeriod}>Send to Manager</button>
          </div>
          {absences.length>0&&(
            <>
              <div className="sec">Reported</div>
              {absences.map(a=>(
                <div key={a.id} style={{background:"#F7F4EF",borderRadius:12,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                  <div><div style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>{isoToDisplay(a.date)}</div><div style={{fontSize:11,color:"#aaa"}}>{a.period}</div></div>
                  <span className="chip a">Sent ✓</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab==="takings"&&(
        <div className="body">
          <div className="sec">📊 Daily Takings</div>
          {alreadySubmitted?(
            <div className="empty"><div className="empty-icon">✅</div><div className="empty-text">Already submitted today!</div></div>
          ):!assigned?(
            <div className="empty"><div className="empty-icon">🔒</div><div className="empty-text">Not assigned today</div></div>
          ):(
            <>
              <div style={{fontSize:12,color:"#888",marginBottom:14}}>
                Record today's takings for {isoToDisplay(todayISO())}.<br/>
                <strong>Enter all amounts as positive numbers.</strong>
              </div>
              {TAKING_FIELDS.map(f=>(
                <div key={f.key} className="take-field">
                  <div className="take-lbl">
                    <span>{f.label}</span>
                    {f.hasCashCard&&(
                      <div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>
                        {["cash","card"].map(c=><button key={c} className={`tgl-btn${(takingsPayTypes[f.key]||"cash")===c?" active":""}`} onClick={()=>setTakingsPayTypes(p=>({...p,[f.key]:c}))}>{c}</button>)}
                      </div>
                    )}
                  </div>
                  {f.hint&&<div className="take-hint">{f.hint}</div>}
                  <input className="inp sm" style={{display:"block",width:"100%",marginTop:4}} type="number" min="0" placeholder="0.00" value={takingsValues[f.key]||""} onChange={e=>setTakingsValues(p=>({...p,[f.key]:e.target.value}))}/>
                </div>
              ))}
              <label className="lbl" style={{marginTop:10}}>Note (optional)</label>
              <textarea className="log-note" rows={3} style={{marginBottom:12}} placeholder="Any notes about today's takings…" value={takingsNote} onChange={e=>setTakingsNote(e.target.value)}/>
              <button className="btn green" onClick={submitTakings}>Submit to Manager ✓</button>
            </>
          )}
        </div>
      )}

      <div className="bnav">
        {navItems.map(n=>(
          <button key={n.id} className={`nbtn${tab===n.id?" active":""}`} onClick={()=>setTab(n.id)}>
            {n.badge&&<span className="nbadge">!</span>}
            <span className="ni">{n.icon}</span>
            <span className="nl">{n.label}</span>
          </button>
        ))}
      </div>

      {rejectModal!==null&&(
        <div className="overlay" onClick={()=>setRejectModal(null)}>
          <div className="sheet" onClick={e=>e.stopPropagation()}>
            <div className="sheet-title">Can't work {DAYS[rejectModal]}?</div>
            <div className="sheet-sub">Tell the manager why (optional)</div>
            <textarea className="log-note" rows={3} placeholder="e.g. Doctor appointment…" value={rejectReason} onChange={e=>setRejectReason(e.target.value)}/>
            <button className="btn danger" style={{marginTop:12}} onClick={rejectShift}>Send Rejection</button>
            <button className="btn sec" onClick={()=>setRejectModal(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER AUTH
// ═══════════════════════════════════════════════════════════════════
function ManagerLogin({onLogin,onBack}){
  const[pin,setPin]=useState("");const[err,setErr]=useState("");
  return(
    <div className="auth-screen">
      <button className="auth-back" onClick={onBack}>←</button>
      <div className="auth-title">Manager Sign In 🔑</div>
      <div className="auth-sub">Enter your manager PIN</div>
      <label className="lbl">Manager PIN</label>
      <input className="inp code" type="password" inputMode="numeric" maxLength={8} placeholder="••••••••" value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} autoFocus/>
      {err&&<div className="err">{err}</div>}
      <button className="btn" onClick={()=>pin==="00000000"?onLogin():setErr("Wrong PIN")} disabled={pin.length<4}>Sign In</button>
      <div style={{textAlign:"center",fontSize:13,color:"#aaa",marginTop:14}}>Default PIN: 00000000</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER APP
// ═══════════════════════════════════════════════════════════════════
function ManagerApp({onLogout,gsConfig,setGsConfig}){
  const[tab,setTab]=useState("rota");
  const[toast,setToast]=useState("");
  const[loading,setLoading]=useState(true);
  const[staff,setStaff]=useState([]);
  const[rota,setRota]=useState({});
  const[absences,setAbsences]=useState([]);
  const[clockLogs,setClockLogs]=useState([]);
  const[rejections,setRejections]=useState([]);
  const[takings,setTakings]=useState([]);
  const[expenses,setExpenses]=useState([]);
  const[kitchenStaff,setKitchenStaff]=useState([]);
  const[payrollExtras,setPayrollExtras]=useState({});
  const[takingsAssignment,setTakingsAssignment]=useState(null);
  const[staffSetupModal,setStaffSetupModal]=useState(null);
  const[gsModal,setGsModal]=useState(false);
  const[weekRange,setWeekRange]=useState(currentWeekRange);
  const[newKName,setNewKName]=useState("");

  const newTakingsCount=takings.filter(s=>s.is_new).length;

  function t(m){setToast(m);setTimeout(()=>setToast(""),3000);}

  useEffect(()=>{loadAll();},[]);

  async function loadAll(){
    setLoading(true);
    const weekStart=currentWeekRange().start;
    const[staffRes,rotaRes,absRes,logsRes,rejRes,takingsRes,expRes,kitchenRes,assignRes]=await Promise.all([
      supabase.from("staff").select("*").order("name"),
      supabase.from("rota").select("*").eq("week_start",weekStart),
      supabase.from("absences").select("*").order("date",{ascending:false}),
      supabase.from("clock_logs").select("*").order("date",{ascending:false}),
      supabase.from("rejections").select("*"),
      supabase.from("takings").select("*").order("date",{ascending:false}),
      supabase.from("expenses").select("*").order("date",{ascending:false}),
      supabase.from("kitchen_staff").select("*"),
      supabase.from("takings_assignment").select("*").eq("date",todayISO()).maybeSingle(),
    ]);
    const staffData=(staffRes.data||[]).map(s=>({...s,payType:s.pay_type,rate:s.rate,shiftRate:s.shift_rate,nightRate:s.night_rate,cashCard:s.cash_card,cashSplit:s.cash_split,cardSplit:s.card_split}));
    setStaff(staffData);
    // Build rota map
    const rotaMap={};
    staffData.forEach(s=>{
      rotaMap[s.id]=DAYS.map((_,i)=>{
        const row=(rotaRes.data||[]).find(r=>r.staff_id===s.id&&r.day_index===i);
        return row?{type:row.shift_type,customIn:row.custom_in||"",customOut:row.custom_out||"",rowId:row.id}:{type:"Off",customIn:"",customOut:""};
      });
    });
    setRota(rotaMap);
    setAbsences(absRes.data||[]);
    setClockLogs(logsRes.data||[]);
    setRejections(rejRes.data||[]);
    setTakings(takingsRes.data||[]);
    setExpenses(expRes.data||[]);
    setKitchenStaff(kitchenRes.data||[]);
    setTakingsAssignment(assignRes.data||null);
    // Load payroll extras for current week
    const extrasRes=await supabase.from("payroll_extras").select("*").eq("week_start",weekStart);
    const extMap={};
    (extrasRes.data||[]).forEach(e=>{extMap[e.staff_id]={tips:e.tips,additions:e.additions||[],deductions:e.deductions||[],notes:e.notes||[],id:e.id};});
    setPayrollExtras(extMap);
    setLoading(false);
  }

  // ── Rota ──
  async function setShift(sId,di,field,val){
    setRota(p=>{
      const cur=p[sId]||DAYS.map(()=>({type:"Off",customIn:"",customOut:""}));
      return{...p,[sId]:cur.map((s,i)=>i===di?{...s,[field]:val}:s)};
    });
    const weekStart=currentWeekRange().start;
    const cur=(rota[sId]||[])[di]||{};
    const updates={staff_id:sId,day_index:di,week_start:weekStart,shift_type:field==="type"?val:(cur.type||"Off"),custom_in:field==="customIn"?val:(cur.customIn||""),custom_out:field==="customOut"?val:(cur.customOut||"")};
    if(cur.rowId){await supabase.from("rota").update(updates).eq("id",cur.rowId);}
    else{const{data}=await supabase.from("rota").insert(updates).select().single();if(data){setRota(p=>({...p,[sId]:p[sId].map((s,i)=>i===di?{...s,rowId:data.id}:s)}));}}
  }

  // ── Clock logs ──
  async function updateLog(id,field,val){
    setClockLogs(p=>p.map(l=>l.id===id?{...l,[field]:val}:l));
    await supabase.from("clock_logs").update({[field]:val}).eq("id",id);
  }
  async function addLogEntry(sId,sName){
    const{data,error}=await supabase.from("clock_logs").insert({staff_id:sId,staff_name:sName,date:todayISO(),time_in:"",time_out:"",note:""}).select().single();
    if(!error)setClockLogs(p=>[data,...p]);
  }

  // ── Payroll ──
  function getExtras(sId){return payrollExtras[sId]||{tips:"",additions:[],deductions:[],notes:[]};}
  async function saveExtras(sId,newExtras){
    setPayrollExtras(p=>({...p,[sId]:newExtras}));
    const weekStart=currentWeekRange().start;
    const existing=payrollExtras[sId];
    const payload={staff_id:sId,week_start:weekStart,tips:newExtras.tips||"0",additions:newExtras.additions||[],deductions:newExtras.deductions||[],notes:newExtras.notes||[]};
    if(existing?.id){await supabase.from("payroll_extras").update(payload).eq("id",existing.id);}
    else{const{data}=await supabase.from("payroll_extras").insert(payload).select().single();if(data)setPayrollExtras(p=>({...p,[sId]:{...newExtras,id:data.id}}));}
  }
  function setExtras(sId,fn){const next=fn(getExtras(sId));saveExtras(sId,next);}

  function calcStaffPay(s){
    const myRota=rota[s.id]||[];
    const logsInRange=clockLogs.filter(l=>l.staff_id===s.id&&l.date>=weekRange.start&&l.date<=weekRange.end);
    let fullShifts=0,nightShifts=0,totalHrs=0;
    myRota.forEach(sh=>{if(!sh||sh.type==="Off")return;if(sh.type==="Full Day (11am–close)")fullShifts++;else if(sh.type==="Night (5:30pm–close)")nightShifts++;});
    logsInRange.forEach(l=>{totalHrs+=parseHours(l.time_in,l.time_out);});
    const extras=getExtras(s.id);
    const tips=parseFloat(extras.tips||0);
    const addTotal=(extras.additions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    const dedTotal=(extras.deductions||[]).reduce((a,x)=>a+parseFloat(x.amount||0),0);
    let base=0;
    if(s.payType==="hourly")base=totalHrs*parseFloat(s.rate||0);
    else base=fullShifts*parseFloat(s.shiftRate||0)+nightShifts*parseFloat(s.nightRate||0);
    const total=Math.max(0,base+tips+addTotal-dedTotal);
    return{fullShifts,nightShifts,totalHrs:totalHrs.toFixed(2),base:base.toFixed(2),tips:tips.toFixed(2),addTotal:addTotal.toFixed(2),dedTotal:dedTotal.toFixed(2),total:total.toFixed(2)};
  }

  // ── Kitchen ──
  async function addKitchen(){
    if(!newKName.trim())return;
    const{data,error}=await supabase.from("kitchen_staff").insert({name:newKName.trim(),hours:"",rate:"",cash_card:"cash"}).select().single();
    if(!error){setKitchenStaff(p=>[...p,data]);setNewKName("");}
  }
  async function updateKitchen(id,field,val){
    setKitchenStaff(p=>p.map(k=>k.id===id?{...k,[field]:val}:k));
    await supabase.from("kitchen_staff").update({[field]:val}).eq("id",id);
  }
  async function deleteKitchen(id){
    setKitchenStaff(p=>p.filter(k=>k.id!==id));
    await supabase.from("kitchen_staff").delete().eq("id",id);
  }

  // ── Takings assignment ──
  async function assignTakings(staffId){
    if(!staffId){
      if(takingsAssignment)await supabase.from("takings_assignment").delete().eq("date",todayISO());
      setTakingsAssignment(null);return;
    }
    if(takingsAssignment){await supabase.from("takings_assignment").update({staff_id:staffId}).eq("date",todayISO());setTakingsAssignment({...takingsAssignment,staff_id:staffId});}
    else{const{data}=await supabase.from("takings_assignment").insert({staff_id:staffId,date:todayISO()}).select().single();setTakingsAssignment(data);}
  }

  // ── Expenses ──
  async function addExpense(desc,amount,payType,date){
    const{data,error}=await supabase.from("expenses").insert({description:desc,amount:parseFloat(amount),pay_type:payType,date}).select().single();
    if(!error){setExpenses(p=>[data,...p]);t("✓ Expense added");}
    else t("❌ "+error.message);
  }
  async function deleteExpense(id){
    setExpenses(p=>p.filter(e=>e.id!==id));
    await supabase.from("expenses").delete().eq("id",id);
  }

  // ── Build export rows ──
  function buildPayrollRows(){
    const hdr=["Date Range","Name","Full Day Shifts","Night Shifts","Hours","Cash (£)","Card (£)","Tips (£)","Additions (£)","Deductions (£)","Total (£)","Notes"];
    const rows=[hdr];
    staff.forEach(s=>{
      const p=calcStaffPay(s);const cc=s.cashCard||"cash";const extras=getExtras(s.id);
      rows.push([fmtRange(weekRange.start,weekRange.end),s.name,p.fullShifts,p.nightShifts,p.totalHrs,cc==="cash"?p.total:cc==="mixed"?(s.cashSplit||"0"):"0",cc==="card"?p.total:cc==="mixed"?(s.cardSplit||"0"):"0",p.tips,p.addTotal,p.dedTotal,p.total,(extras.notes||[]).join("; ")]);
    });
    return rows;
  }

  function buildDailyRows(){
    const allDates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].sort();
    const hdr=["Date","Deliveroo","Uber Eats","Cash","Card","Online","Deposit Receipt","Voucher Redemption","Voucher Purchase","Total","Cash in Hand","Net Total","Expenses"];
    const rows=[hdr];
    allDates.forEach(date=>{
      const sub=takings.find(s=>s.date===date);
      const v=sub||{};
      const dayExp=expenses.filter(e=>e.date===date);
      const total=TAKING_FIELDS.reduce((s,f)=>s+parseFloat(v[f.dbKey||f.key]||0)*f.sign,0);
      const cashExp=dayExp.filter(e=>e.pay_type==="cash").reduce((s,e)=>s+e.amount,0);
      const expNotes=dayExp.map(e=>`${e.description}(£${e.amount.toFixed(2)},${e.pay_type})`).join("; ");
      rows.push([fmtDate(date),v.deliveroo||0,v.uber||0,v.cash||0,v.card||0,v.online||0,v.deposit_receipt||0,v.voucher_redemption||0,v.voucher_purchase||0,total.toFixed(2),(parseFloat(v.cash||0)-cashExp).toFixed(2),(total-cashExp).toFixed(2),expNotes]);
    });
    return rows;
  }

  function buildWeeklyRows(){
    const allDates=[...new Set([...takings.map(s=>s.date),...expenses.map(e=>e.date)])].sort();
    const weekMap={};
    allDates.forEach(d=>{const{start}=getWeekRange(d);if(!weekMap[start])weekMap[start]=[];weekMap[start].push(d);});
    const hdr=["Week (Sun–Sat)","Deliveroo","Uber Eats","Cash","Card","Online","Deposit Receipt","Voucher Redemption","Voucher Purchase","Total","Cash in Hand","Net Total"];
    const rows=[["WEEKLY SUMMARY"],hdr];
    Object.entries(weekMap).sort().forEach(([ws,dates])=>{
      const{end}=getWeekRange(ws);let tot={};TAKING_FIELDS.forEach(f=>tot[f.dbKey||f.key]=0);let cashExpTot=0;
      dates.forEach(d=>{
        const sub=takings.find(s=>s.date===d);
        if(sub)TAKING_FIELDS.forEach(f=>{tot[f.dbKey||f.key]+=parseFloat(sub[f.dbKey||f.key]||0);});
        cashExpTot+=expenses.filter(e=>e.date===d&&e.pay_type==="cash").reduce((a,e)=>a+e.amount,0);
      });
      const total=TAKING_FIELDS.reduce((s,f)=>s+tot[f.dbKey||f.key]*f.sign,0);
      rows.push([fmtRange(ws,end),tot.deliveroo.toFixed(2),tot.uber.toFixed(2),tot.cash.toFixed(2),tot.card.toFixed(2),tot.online.toFixed(2),tot.deposit_receipt.toFixed(2),tot.voucher_redemption.toFixed(2),tot.voucher_purchase.toFixed(2),total.toFixed(2),(tot.cash-cashExpTot).toFixed(2),(total-cashExpTot).toFixed(2)]);
    });
    return rows;
  }

  async function doPayrollExport(){
    if(gsConfig.payrollId&&gsConfig.apiKey){t("⏳ Pushing to Payroll sheet…");const r=await pushSheet(gsConfig.apiKey,gsConfig.payrollId,"Payroll",buildPayrollRows());t(r.ok?"✅ Payroll sheet updated!":"❌ "+r.err);}
    else copyTSV(buildPayrollRows(),t);
  }
  async function doTakingsExport(){
    if(gsConfig.takingsId&&gsConfig.apiKey){
      t("⏳ Updating Daily tab…");const r1=await pushSheet(gsConfig.apiKey,gsConfig.takingsId,"Daily",buildDailyRows());if(!r1.ok){t("❌ "+r1.err);return;}
      t("⏳ Updating Weekly tab…");const r2=await pushSheet(gsConfig.apiKey,gsConfig.takingsId,"Weekly",buildWeeklyRows());t(r2.ok?"✅ Takings sheet updated!":"❌ "+r2.err);
    }else{copyTSV([...buildDailyRows(),[""],[""],...buildWeeklyRows()],t);}
  }

  // ── Absence conflict check ──
  function getAbsenceConflicts(staffId){
    const myRota=rota[staffId]||[];
    return absences.filter(a=>a.staff_id===staffId).filter(a=>{
      const dow=new Date(a.date+"T12:00:00").getDay();
      const sh=myRota[dow];if(!sh||sh.type==="Off")return false;
      if(a.period==="Full Day")return true;
      if(a.period==="Morning"&&sh.type==="Full Day (11am–close)")return true;
      if(a.period==="Evening"&&(sh.type==="Night (5:30pm–close)"||sh.type==="Full Day (11am–close)"))return true;
      return false;
    });
  }

  // ── AddDeductRow ──
  function AddDeductRow({sId,type}){
    const extras=getExtras(sId);
    const key=type==="add"?"additions":"deductions";
    const items=extras[key]||[];
    const labels=type==="add"?ADDITION_LABELS:DEDUCTION_LABELS;
    const[amount,setAmount]=useState("");const[label,setLabel]=useState(labels[0]);const[custom,setCustom]=useState("");
    return(
      <div>
        {items.map((item,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px dashed #F0F0F0"}}>
            <span style={{fontSize:12,color:"#555"}}>{item.label}: £{item.amount}</span>
            <button onClick={()=>setExtras(sId,ex=>({...ex,[key]:items.filter((_,j)=>j!==i)}))} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"#ccc"}}>✕</button>
          </div>
        ))}
        <div className="add-row">
          <select className="add-inp" style={{flex:"none",width:"auto",padding:"6px 7px",fontSize:11}} value={label} onChange={e=>setLabel(e.target.value)}>{labels.map(l=><option key={l}>{l}</option>)}</select>
          <input className="add-inp" type="number" min="0" placeholder="£0" value={amount} onChange={e=>setAmount(e.target.value)} style={{width:62}}/>
          <button className={`add-btn-sm${type==="ded"?" r":""}`} onClick={()=>{if(!amount)return;const fl=label==="Other"&&custom?custom:label;setExtras(sId,ex=>({...ex,[key]:[...(ex[key]||[]),{label:fl,amount}]}));setAmount("");setCustom("");}}>+ Add</button>
        </div>
        {label==="Other"&&<input className="add-inp" style={{marginTop:5,width:"100%"}} placeholder="Custom label…" value={custom} onChange={e=>setCustom(e.target.value)}/>}
      </div>
    );
  }

  // ── Staff Setup Modal ──
  function StaffSetupModal({s,onClose}){
    const[payType,setPT]=useState(s.payType||"hourly");const[rate,setRate]=useState(s.rate||"");const[shiftRate,setSR]=useState(s.shiftRate||"");const[nightRate,setNR]=useState(s.nightRate||"");const[cashCard,setCC]=useState(s.cashCard||"cash");const[saving,setSaving]=useState(false);
    async function save(){
      setSaving(true);
      const updates={pay_type:payType,rate,shift_rate:shiftRate,night_rate:nightRate,cash_card:cashCard};
      const{error}=await supabase.from("staff").update(updates).eq("id",s.id);
      if(!error){setStaff(p=>p.map(x=>x.id===s.id?{...x,payType,rate,shiftRate,nightRate,cashCard}:x));t(`✅ ${s.name} pay settings saved`);onClose();}
      else t("❌ "+error.message);
      setSaving(false);
    }
    return(
      <div className="overlay" onClick={onClose}>
        <div className="sheet" onClick={e=>e.stopPropagation()}>
          <div className="sheet-title">⚙️ Pay Settings — {s.name}</div>
          <div className="sheet-sub">Private — staff cannot see this</div>
          <label className="lbl">Pay Method</label>
          <div className="toggle" style={{marginBottom:14}}>
            <button className={`tgl-btn${payType==="hourly"?" active":""}`} onClick={()=>setPT("hourly")}>By Hour</button>
            <button className={`tgl-btn${payType==="shift"?" active":""}`} onClick={()=>setPT("shift")}>By Shift</button>
          </div>
          {payType==="hourly"?(<><label className="lbl">Hourly Rate (£)</label><input className="inp" type="number" placeholder="e.g. 12.50" value={rate} onChange={e=>setRate(e.target.value)}/></>):(<><label className="lbl">Full Day Shift Rate (£)</label><input className="inp" type="number" placeholder="e.g. 80.00" value={shiftRate} onChange={e=>setSR(e.target.value)}/><label className="lbl">Night Shift Rate (£)</label><input className="inp" type="number" placeholder="e.g. 60.00" value={nightRate} onChange={e=>setNR(e.target.value)}/></>)}
          <label className="lbl">Pay By</label>
          <div className="toggle" style={{marginBottom:18}}>
            <button className={`tgl-btn${cashCard==="cash"?" active":""}`} onClick={()=>setCC("cash")}>💵 Cash</button>
            <button className={`tgl-btn${cashCard==="card"?" active":""}`} onClick={()=>setCC("card")}>💳 Card</button>
            <button className={`tgl-btn${cashCard==="mixed"?" active":""}`} onClick={()=>setCC("mixed")}>Split</button>
          </div>
          <button className="btn" onClick={save} disabled={saving}>{saving?"Saving…":"Save Settings"}</button>
          <button className="btn sec" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── GS Modal ──
  function GsModal({onClose}){
    const[apiKey,setApiKey]=useState(gsConfig.apiKey||"");const[payrollId,setPayrollId]=useState(gsConfig.payrollId||"");const[takingsId,setTakingsId]=useState(gsConfig.takingsId||"");
    return(
      <div className="overlay" onClick={onClose}>
        <div className="sheet" onClick={e=>e.stopPropagation()}>
          <div className="sheet-title">🔗 Google Sheets Setup</div>
          <div className="sheet-sub">Two spreadsheets: one for payroll, one for takings</div>
          <label className="lbl">Google API Key</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} placeholder="AIzaSy…" value={apiKey} onChange={e=>setApiKey(e.target.value)}/>
          <label className="lbl">📋 Payroll Spreadsheet ID</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} placeholder="Needs a 'Payroll' tab" value={payrollId} onChange={e=>setPayrollId(e.target.value)}/>
          <label className="lbl">📊 Takings Spreadsheet ID</label>
          <input className="inp sm" style={{display:"block",width:"100%",marginBottom:14}} placeholder="Needs 'Daily' and 'Weekly' tabs" value={takingsId} onChange={e=>setTakingsId(e.target.value)}/>
          <div className="gs-info"><strong>Tabs needed:</strong><br/>Payroll sheet → tab named <strong>Payroll</strong><br/>Takings sheet → tabs named <strong>Daily</strong> and <strong>Weekly</strong></div>
          <button className="btn" onClick={()=>{setGsConfig({apiKey,payrollId,takingsId});t("✅ Saved!");onClose();}}>Save Config</button>
          <button className="btn sec" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  if(loading)return<Loading text="Loading manager data…"/>;

  return(
    <div className="app">
      <Toast msg={toast}/>
      <div className="mgr-hdr">
        <div><div className="mgr-title">🔑 Manager Panel</div><div className="mgr-sub">Restaurant back office</div></div>
        <div style={{display:"flex",gap:7,alignItems:"center"}}>
          <button onClick={()=>setGsModal(true)} style={{background:"rgba(255,255,255,.12)",border:"none",color:"#F5A623",borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:12}}>🔗 Sheets</button>
          <button className="mgr-lo" onClick={onLogout}>Sign out</button>
        </div>
      </div>

      <div className="mgr-tabs">
        {[{id:"rota",label:"📋 Rota"},{id:"clock",label:"⏱ Clock"},{id:"payroll",label:"💷 Payroll"},{id:"takings",label:`📊 Takings${newTakingsCount>0?` (${newTakingsCount})`:""}`},{id:"expenses",label:"🧾 Expenses"},{id:"absence",label:"📅 Absences"}]
          .map(tb=><button key={tb.id} className={`mtab${tab===tb.id?" active":""}`} onClick={()=>setTab(tb.id)}>{tb.label}</button>)}
      </div>

      <div className="mgr-body">

        {/* ROTA */}
        {tab==="rota"&&(
          <>
            <div className="sec">Assign Weekly Rota</div>
            {rejections.length>0&&(
              <div style={{marginBottom:10}}>
                <div style={{fontSize:12,fontWeight:700,color:"#E05252",marginBottom:6}}>⚠️ Shift Rejections</div>
                {rejections.map(r=>(
                  <div key={r.id} className="rej-banner">
                    <span><strong>{r.staff_name}</strong> can't do <strong>{r.day}</strong>{r.reason?` — "${r.reason}"`:""}</span>
                    <button onClick={async()=>{await supabase.from("rejections").delete().eq("id",r.id);setRejections(p=>p.filter(x=>x.id!==r.id));}} style={{background:"none",border:"none",cursor:"pointer",fontSize:16}}>✓</button>
                  </div>
                ))}
              </div>
            )}
            {staff.map(s=>{
              const conflicts=getAbsenceConflicts(s.id);
              return(
                <div key={s.id} className="card">
                  <div className="card-head">
                    <div><div className="card-name">👤 {s.name}</div><div className="card-sub">{s.payType==="shift"?`Full £${s.shiftRate} / Night £${s.nightRate}`:`£${s.rate}/hr`}</div></div>
                    <button onClick={()=>setStaffSetupModal(s)} style={{background:"#E8F0E9",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer"}}>⚙️ Pay</button>
                  </div>
                  {conflicts.length>0&&(
                    <div className="warn-banner">
                      <div className="warn-title">⚠️ Absence Conflict</div>
                      <div className="warn-sub">{s.name} reported absence: {conflicts.map(c=>`${isoToDisplay(c.date)} (${c.period})`).join(", ")}</div>
                    </div>
                  )}
                  {DAYS.map((d,i)=>{
                    const sh=(rota[s.id]||[])[i]||{type:"Off",customIn:"",customOut:""};
                    return(
                      <div key={d} style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
                        <div style={{minWidth:30,fontSize:11,fontWeight:700,color:"#888"}}>{d}</div>
                        <select className="inp sm" style={{flex:1}} value={sh.type||"Off"} onChange={e=>setShift(s.id,i,"type",e.target.value)}>{SHIFT_TYPES.map(o=><option key={o}>{o}</option>)}</select>
                        {sh.type==="Custom"&&(<><input type="time" className="inp time" value={sh.customIn||""} onChange={e=>setShift(s.id,i,"customIn",e.target.value)}/><span style={{fontSize:10,color:"#aaa"}}>–</span><input type="time" className="inp time" value={sh.customOut||""} onChange={e=>setShift(s.id,i,"customOut",e.target.value)}/></>)}
                      </div>
                    );
                  })}
                  <button className="btn green" style={{marginTop:8,padding:"11px"}} onClick={()=>t(`✅ Rota saved for ${s.name}!`)}>📤 Send Rota to {s.name.split(" ")[0]}</button>
                </div>
              );
            })}
          </>
        )}

        {/* CLOCK */}
        {tab==="clock"&&(
          <>
            <div className="sec">Clock Logs</div>
            <div className="sec-sub">Edit times or add notes to any entry</div>
            {staff.map(s=>{
              const logs=clockLogs.filter(l=>l.staff_id===s.id);
              const totalHrs=logs.reduce((a,l)=>a+parseHours(l.time_in,l.time_out),0);
              return(
                <div key={s.id} className="card">
                  <div className="card-name">👤 {s.name}</div>
                  <div className="card-sub" style={{marginBottom:10}}>Total: {totalHrs.toFixed(1)} hrs</div>
                  {logs.length===0&&<div style={{fontSize:12,color:"#ccc",fontStyle:"italic"}}>No records yet</div>}
                  {logs.map(l=>(
                    <div key={l.id} className="log-entry">
                      <div className="log-top">
                        <span style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>{isoToDisplay(l.date)}</span>
                        <span style={{fontSize:13,fontWeight:800,color:l.time_out?"#1A2744":"#50DC78"}}>{l.time_out?parseHours(l.time_in,l.time_out).toFixed(1)+"h":"active"}</span>
                      </div>
                      <div className="log-edit-row">
                        <span className="log-edit-lbl">In</span>
                        <input type="time" className="inp time" value={l.time_in||""} onChange={e=>updateLog(l.id,"time_in",e.target.value)}/>
                        <span className="log-edit-lbl">Out</span>
                        <input type="time" className="inp time" value={l.time_out||""} onChange={e=>updateLog(l.id,"time_out",e.target.value)}/>
                      </div>
                      <textarea className="log-note" rows={2} placeholder="Note / question about these hours…" value={l.note||""} onChange={e=>updateLog(l.id,"note",e.target.value)}/>
                    </div>
                  ))}
                  <button className="btn sm" style={{marginTop:9,background:"#F5A623"}} onClick={()=>addLogEntry(s.id,s.name)}>+ Add Entry</button>
                </div>
              );
            })}
          </>
        )}

        {/* PAYROLL */}
        {tab==="payroll"&&(
          <>
            <div className="sec">Payroll</div>
            <div className="sec-sub">Private — staff never see salaries</div>
            <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center"}}>
              <input type="date" className="inp sm" style={{flex:1}} value={weekRange.start} onChange={e=>setWeekRange(p=>({...p,start:e.target.value}))}/>
              <span style={{fontSize:12,color:"#aaa"}}>→</span>
              <input type="date" className="inp sm" style={{flex:1}} value={weekRange.end} onChange={e=>setWeekRange(p=>({...p,end:e.target.value}))}/>
            </div>
            <div style={{fontSize:13,fontWeight:800,color:"#1A2744",marginBottom:8}}>Front of House</div>
            {staff.map(s=>{
              const p=calcStaffPay(s);const extras=getExtras(s.id);const cc=s.cashCard||"cash";
              return(
                <div key={s.id} className="pay-card">
                  <div className="pay-head">
                    <div><div className="pay-name">👤 {s.name}</div><span className="chip" style={{background:cc==="cash"?"#D1FAE5":cc==="card"?"#DBEAFE":"#FEF3C7",color:cc==="cash"?"#065F46":cc==="card"?"#1E40AF":"#78350F"}}>{cc==="cash"?"💵 Cash":cc==="card"?"💳 Card":"Split"}</span></div>
                    <div className="pay-total">£{p.total}</div>
                  </div>
                  <div className="pay-body">
                    {s.payType==="shift"?(<><div className="row"><span>Full Day shifts</span><span className="row-bold">{p.fullShifts} × £{s.shiftRate} = £{(p.fullShifts*parseFloat(s.shiftRate||0)).toFixed(2)}</span></div><div className="row"><span>Night shifts</span><span className="row-bold">{p.nightShifts} × £{s.nightRate} = £{(p.nightShifts*parseFloat(s.nightRate||0)).toFixed(2)}</span></div></>):(<div className="row"><span>Hours</span><span className="row-bold">{p.totalHrs} h × £{s.rate} = £{p.base}</span></div>)}
                    <div className="row"><span>Tips (£)</span><input type="number" className="mini-inp" min="0" placeholder="0.00" value={extras.tips||""} onChange={e=>setExtras(s.id,ex=>({...ex,tips:e.target.value}))}/></div>
                    <div style={{marginTop:8}}><div style={{fontSize:11,fontWeight:700,color:"#50DC78",marginBottom:4}}>ADDITIONS</div><AddDeductRow sId={s.id} type="add"/></div>
                    <div style={{marginTop:8}}><div style={{fontSize:11,fontWeight:700,color:"#E05252",marginBottom:4}}>DEDUCTIONS</div><AddDeductRow sId={s.id} type="ded"/></div>
                    <div style={{marginTop:8}}>
                      <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>PAYROLL NOTES</div>
                      {(extras.notes||[]).map((n,i)=>(<div key={i} style={{display:"flex",justifyContent:"space-between",padding:"2px 0"}}><span style={{fontSize:12,color:"#555"}}>📌 {n}</span><button onClick={()=>setExtras(s.id,ex=>({...ex,notes:ex.notes.filter((_,j)=>j!==i)}))} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:"#ccc"}}>✕</button></div>))}
                      <div className="add-row" style={{marginTop:5}}>
                        <select className="add-inp" style={{fontSize:11,padding:"5px 7px"}} id={`ns-${s.id}`}>{["Bank Holiday","Red Day","Custom"].map(l=><option key={l}>{l}</option>)}</select>
                        <button className="add-btn-sm" onClick={()=>{const sel=document.getElementById(`ns-${s.id}`);if(sel.value==="Custom"){const cn=window.prompt("Enter custom note:");if(cn)setExtras(s.id,ex=>({...ex,notes:[...(ex.notes||[]),cn]}));}else setExtras(s.id,ex=>({...ex,notes:[...(ex.notes||[]),sel.value]}));}}>+ Note</button>
                      </div>
                    </div>
                    {cc==="mixed"&&(<div style={{marginTop:10,background:"#F7F4EF",borderRadius:9,padding:"9px"}}><div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:6}}>SPLIT PAYMENT (total £{p.total})</div><div style={{display:"flex",gap:8}}><div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>💵 Cash (£)</div><input type="number" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.cashSplit||""} onChange={async e=>{const v=e.target.value;setStaff(pp=>pp.map(x=>x.id===s.id?{...x,cashSplit:v}:x));await supabase.from("staff").update({cash_split:v}).eq("id",s.id);}}/></div><div style={{flex:1}}><div style={{fontSize:10,color:"#aaa",marginBottom:3}}>💳 Card (£)</div><input type="number" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={s.cardSplit||""} onChange={async e=>{const v=e.target.value;setStaff(pp=>pp.map(x=>x.id===s.id?{...x,cardSplit:v}:x));await supabase.from("staff").update({card_split:v}).eq("id",s.id);}}/></div></div></div>)}
                    <div className="divider"/>
                    <div className="row"><span style={{fontWeight:800}}>Total</span><span style={{fontWeight:900,color:"#F5A623",fontSize:15}}>£{p.total}</span></div>
                  </div>
                </div>
              );
            })}
            <div style={{fontSize:13,fontWeight:800,color:"#1A2744",margin:"14px 0 8px"}}>Kitchen Staff</div>
            <div style={{display:"flex",gap:6,marginBottom:10}}>
              <input className="inp sm" style={{flex:1}} placeholder="Add kitchen staff name…" value={newKName} onChange={e=>setNewKName(e.target.value)}/>
              <button className="btn sm navy" onClick={addKitchen}>Add</button>
            </div>
            {kitchenStaff.map(k=>{
              const pay=(parseFloat(k.hours||0)*parseFloat(k.rate||0)).toFixed(2);
              return(
                <div key={k.id} className="card white">
                  <div className="card-head"><div className="card-name">👨‍🍳 {k.name}</div><button onClick={()=>deleteKitchen(k.id)} style={{background:"none",border:"none",cursor:"pointer",fontSize:15,color:"#ddd"}}>🗑️</button></div>
                  <div style={{display:"flex",gap:7,marginBottom:8,flexWrap:"wrap"}}>
                    <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>HOURS</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0" value={k.hours||""} onChange={e=>updateKitchen(k.id,"hours",e.target.value)}/></div>
                    <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>£/HR</div><input type="number" min="0" className="inp sm" style={{width:"100%"}} placeholder="0.00" value={k.rate||""} onChange={e=>updateKitchen(k.id,"rate",e.target.value)}/></div>
                    <div style={{flex:1,minWidth:76}}><div style={{fontSize:10,fontWeight:700,color:"#aaa",marginBottom:3}}>GROSS</div><div style={{fontSize:16,fontWeight:900,color:"#F5A623",paddingTop:5}}>£{pay}</div></div>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontSize:11,color:"#888",fontWeight:700}}>Pay by:</div>
                    <div className="toggle">{["cash","card"].map(c=><button key={c} className={`tgl-btn${k.cash_card===c?" active":""}`} onClick={()=>updateKitchen(k.id,"cash_card",c)}>{c==="cash"?"💵":"💳"} {c}</button>)}</div>
                  </div>
                </div>
              );
            })}
            <div className="exp-sec">
              <div className="exp-title">📤 Export Payroll</div>
              <button className="exp-btn primary" onClick={doPayrollExport}>{gsConfig.payrollId&&gsConfig.apiKey?"🔗 Push to Payroll Sheet":"📋 Copy — Paste into Payroll Sheet"}</button>
              <div className="exp-hint">Open your Payroll spreadsheet → click cell A1 → Ctrl+V (or ⌘+V on Mac)</div>
            </div>
          </>
        )}

        {/* TAKINGS */}
        {tab==="takings"&&(
          <>
            <div className="sec">Daily Takings</div>
            <div className="card">
              <div className="card-name" style={{marginBottom:7}}>👥 Today's Takings Person</div>
              <select className="inp sm" style={{display:"block",width:"100%",marginBottom:8}} value={takingsAssignment?.staff_id||""} onChange={e=>assignTakings(e.target.value)}>
                <option value="">— Manager will record —</option>
                {staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {takingsAssignment?.staff_id&&<span className="chip g">✓ Assigned for {isoToDisplay(takingsAssignment.date)}</span>}
            </div>
            {takings.length>0&&(
              <>
                <div style={{fontSize:13,fontWeight:800,color:"#1A2744",marginBottom:8}}>📨 Submissions</div>
                {[...takings].sort((a,b)=>b.date.localeCompare(a.date)).map(sub=>{
                  const total=TAKING_FIELDS.reduce((s,f)=>s+parseFloat(sub[f.dbKey||f.key]||0)*f.sign,0);
                  return(
                    <div key={sub.id} className={`taking-msg${sub.is_new?" new-sub":""}`}>
                      <div className="taking-msg-head">{sub.is_new?"🆕 New — ":"✓ "}{sub.staff_name||"Manager"} · {isoToDisplay(sub.date)}<span style={{float:"right",fontSize:14,fontWeight:900}}>£{total.toFixed(2)}</span></div>
                      <div className="taking-msg-detail">{TAKING_FIELDS.filter(f=>parseFloat(sub[f.dbKey||f.key]||0)>0).map(f=>`${f.label.replace(/[🛵💵💳🌐🎟️🎫]/g,"").trim()}: £${sub[f.dbKey||f.key]}`).join(" · ")}</div>
                      {sub.note&&<div style={{marginTop:4,fontSize:12,opacity:.8}}>📝 {sub.note}</div>}
                      {sub.is_new&&<button className="btn sm" style={{marginTop:8,background:"#065F46",color:"#fff"}} onClick={async()=>{await supabase.from("takings").update({is_new:false}).eq("id",sub.id);setTakings(p=>p.map(x=>x.id===sub.id?{...x,is_new:false}:x));}}>Mark Seen ✓</button>}
                    </div>
                  );
                })}
              </>
            )}
            <div className="card" style={{marginTop:10}}>
              <div className="card-name" style={{marginBottom:8}}>✏️ Enter Takings Manually</div>
              <ManagerTakingsForm setTakings={setTakings} t={t}/>
            </div>
            <div className="exp-sec">
              <div className="exp-title">📤 Export Takings (Daily + Weekly)</div>
              <button className="exp-btn primary" onClick={doTakingsExport}>{gsConfig.takingsId&&gsConfig.apiKey?"🔗 Push to Takings Sheet":"📋 Copy — Paste into Takings Sheet"}</button>
              <div className="exp-hint">Open your Takings spreadsheet → click A1 → Ctrl+V</div>
            </div>
          </>
        )}

        {/* EXPENSES */}
        {tab==="expenses"&&<ExpensesTab expenses={expenses} onAdd={addExpense} onDelete={deleteExpense} t={t}/>}

        {/* ABSENCES */}
        {tab==="absence"&&(
          <>
            <div className="sec">Reported Absences</div>
            {absences.length===0?<div className="empty"><div className="empty-icon">📅</div><div className="empty-text">No absences reported</div></div>
              :absences.map(a=>(<div key={a.id} style={{background:"#FFF8EC",border:"1.5px solid #F5A623",borderRadius:12,padding:"10px 13px",marginBottom:9}}><div style={{fontWeight:800,color:"#1A2744",fontSize:13}}>👤 {a.staff_name}</div><div style={{fontSize:12,color:"#888",marginTop:2}}>{isoToDisplay(a.date)} — {a.period}</div></div>))}
          </>
        )}
      </div>

      {staffSetupModal&&<StaffSetupModal s={staffSetupModal} onClose={()=>setStaffSetupModal(null)}/>}
      {gsModal&&<GsModal onClose={()=>setGsModal(false)}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MANAGER TAKINGS FORM
// ═══════════════════════════════════════════════════════════════════
function ManagerTakingsForm({setTakings,t}){
  const[values,setValues]=useState({});const[payTypes,setPayTypes]=useState({});const[note,setNote]=useState("");const[date,setDate]=useState(todayISO());const[saving,setSaving]=useState(false);
  async function submit(){
    setSaving(true);
    const vals={};
    TAKING_FIELDS.forEach(f=>{vals[f.dbKey||f.key]=parseFloat(values[f.key]||0);if(f.dbPayKey)vals[f.dbPayKey]=payTypes[f.key]||"cash";});
    const{data,error}=await supabase.from("takings").insert({staff_id:"manager",staff_name:"Manager",date,...vals,note,is_new:false}).select().single();
    if(!error){setTakings(p=>[data,...p]);setValues({});setNote("");setDate(todayISO());t("✅ Takings saved!");}
    else t("❌ "+error.message);
    setSaving(false);
  }
  return(
    <>
      <label className="lbl">Date</label>
      <input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:12}} value={date} onChange={e=>setDate(e.target.value)}/>
      {TAKING_FIELDS.map(f=>(
        <div key={f.key} className="take-field">
          <div className="take-lbl"><span>{f.label}</span>{f.hasCashCard&&(<div className="toggle" style={{transform:"scale(.8)",transformOrigin:"right"}}>{["cash","card"].map(c=><button key={c} className={`tgl-btn${(payTypes[f.key]||"cash")===c?" active":""}`} onClick={()=>setPayTypes(p=>({...p,[f.key]:c}))}>{c}</button>)}</div>)}</div>
          {f.hint&&<div className="take-hint">{f.hint}</div>}
          <input className="inp sm" style={{display:"block",width:"100%",marginTop:3}} type="number" min="0" placeholder="0.00" value={values[f.key]||""} onChange={e=>setValues(p=>({...p,[f.key]:e.target.value}))}/>
        </div>
      ))}
      <label className="lbl" style={{marginTop:8}}>Note</label>
      <textarea className="log-note" rows={2} style={{marginBottom:10}} placeholder="Any notes…" value={note} onChange={e=>setNote(e.target.value)}/>
      <button className="btn" onClick={submit} disabled={saving}>{saving?"Saving…":"Save Takings"}</button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EXPENSES TAB
// ═══════════════════════════════════════════════════════════════════
function ExpensesTab({expenses,onAdd,onDelete,t}){
  const[desc,setDesc]=useState("");const[amount,setAmount]=useState("");const[payType,setPayType]=useState("cash");const[date,setDate]=useState(todayISO());const[saving,setSaving]=useState(false);
  async function add(){
    if(!desc||!amount)return t("Fill in description and amount");
    setSaving(true);await onAdd(desc,amount,payType,date);setDesc("");setAmount("");setSaving(false);
  }
  const total=expenses.reduce((a,e)=>a+e.amount,0);
  return(
    <>
      <div className="sec">Shop Expenses</div>
      <div className="card">
        <label className="lbl">Date of Expense</label>
        <input type="date" className="inp sm" style={{display:"block",width:"100%",marginBottom:10}} value={date} onChange={e=>setDate(e.target.value)}/>
        <label className="lbl">Description</label>
        <input className="inp sm" style={{display:"block",width:"100%",marginBottom:10}} placeholder="e.g. Cleaning supplies, milk" value={desc} onChange={e=>setDesc(e.target.value)}/>
        <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"flex-end"}}>
          <div style={{flex:1}}><label className="lbl">Amount (£)</label><input className="inp sm" style={{width:"100%"}} type="number" min="0" placeholder="0.00" value={amount} onChange={e=>setAmount(e.target.value)}/></div>
          <div><label className="lbl">Paid by</label><div className="toggle">{["cash","card"].map(c=><button key={c} className={`tgl-btn${payType===c?" active":""}`} onClick={()=>setPayType(c)}>{c==="cash"?"💵":"💳"} {c}</button>)}</div></div>
        </div>
        <button className="btn" onClick={add} disabled={saving}>{saving?"Adding…":"Add Expense"}</button>
      </div>
      {expenses.length===0?<div className="empty"><div className="empty-icon">🧾</div><div className="empty-text">No expenses yet</div></div>:(
        <>
          <div className="sec">Logged Expenses</div>
          {[...expenses].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>(
            <div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #F0F0F0"}}>
              <div><div style={{fontSize:13,fontWeight:700,color:"#1A2744"}}>{e.description}</div><div style={{fontSize:11,color:"#aaa"}}>{fmtDate(e.date)} · {e.pay_type==="cash"?"💵 Cash":"💳 Card"}</div></div>
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
  const[takingsAssignment,setTakingsAssignment]=useState(null);
  const[gsConfig,setGsConfig]=useState({apiKey:"",payrollId:"",takingsId:""});

  // Load staff list for login screen
  useEffect(()=>{
    if(screen==="staffLogin"){
      setLoadingStaff(true);
      supabase.from("staff").select("id,name,code").order("name").then(({data})=>{setAllStaff(data||[]);setLoadingStaff(false);});
    }
  },[screen]);

  // Load today's takings assignment when staff logs in
  useEffect(()=>{
    if(screen==="staff"&&user){
      supabase.from("takings_assignment").select("*").eq("date",todayISO()).maybeSingle().then(({data})=>setTakingsAssignment(data));
    }
  },[screen,user]);

  return(
    <>
      <style>{CSS}</style>
      <div className="app">
        {screen==="role"&&<RolePicker onPick={r=>setScreen(r==="staff"?"staffLogin":"managerLogin")}/>}
        {screen==="staffLogin"&&(loadingStaff?<Loading text="Loading staff list…"/>:<StaffLogin staff={allStaff} onLogin={u=>{setUser(u);setScreen("staff");}} onBack={()=>setScreen("role")} onRegister={()=>setScreen("staffRegister")}/>)}
        {screen==="staffRegister"&&<StaffRegister onBack={()=>setScreen("staffLogin")} onRegister={u=>{setUser(u);setScreen("staff");}}/>}
        {screen==="managerLogin"&&<ManagerLogin onLogin={()=>setScreen("manager")} onBack={()=>setScreen("role")}/>}
        {screen==="staff"&&user&&<StaffApp user={user} onLogout={()=>{setUser(null);setScreen("role");}} takingsAssignment={takingsAssignment}/>}
        {screen==="manager"&&<ManagerApp onLogout={()=>setScreen("role")} gsConfig={gsConfig} setGsConfig={setGsConfig}/>}
      </div>
    </>
  );
}
