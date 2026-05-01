import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { subscribeAll, saveKey } from './firebase.js'

// ── 祝日データ 2024〜2026
const HOLIDAYS = new Set([
  "2024-01-01","2024-01-08","2024-02-11","2024-02-12","2024-02-23","2024-03-20",
  "2024-04-29","2024-05-03","2024-05-04","2024-05-05","2024-05-06","2024-07-15",
  "2024-08-11","2024-08-12","2024-09-16","2024-09-22","2024-09-23","2024-10-14",
  "2024-11-03","2024-11-04","2024-11-23","2025-01-01","2025-01-13","2025-02-11",
  "2025-02-23","2025-02-24","2025-03-20","2025-04-29","2025-05-03","2025-05-04",
  "2025-05-05","2025-05-06","2025-07-21","2025-08-11","2025-09-15","2025-09-21",
  "2025-09-22","2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-11-24",
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29",
  "2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11",
  "2026-09-21","2026-09-22","2026-09-23","2026-10-12","2026-11-03","2026-11-23",
]);

// ── 等級定義
// J=新人相当, L=中堅, M=中堅〜ベテラン間, SM=ベテラン相当, GM=管理者
const GRADES = ["J","L","M","SM","GM"];
const GRADE_COLOR = { J:"#34d399", L:"#60a5fa", M:"#facc15", SM:"#f97316", GM:"#e879f9" };
const GRADE_LABEL = { J:"J", L:"L", M:"M", SM:"SM", GM:"GM" };
// 新人相当: J  中堅相当: L,M  ベテラン相当: SM,GM
const isJunior  = g => g==="J";
const isSenior  = g => g==="SM"||g==="GM";
const isMid     = g => g==="L"||g==="M";

// ── 夜時間
const NIGHT_TIMES = ["17:00","17:15","17:30","18:00"];
const NIGHT_ORDER = ["17:00","17:15","17:30","18:00"];
const NIGHT_TC = {"17:00":"#f43f5e","17:15":"#f97316","17:30":"#8b5cf6","18:00":"#3b82f6"};
const DOW_JP = ["日","月","火","水","木","金","土"];

// ── ユーティリティ
const toStr = (y,m,d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const getDow = (y,m,d) => new Date(y,m,d).getDay();
const isHol  = (y,m,d) => HOLIDAYS.has(toStr(y,m,d));
const isSpec = (y,m,d) => { const w=getDow(y,m,d); return w===0||w===5||w===6||isHol(y,m,d); };
const daysIn = (y,m)   => new Date(y,m+1,0).getDate();
const isClosed=(y,m,d) => { const w=getDow(y,m,d); return w===2||w===3; };
const nightCompat=(cand,slot)=>NIGHT_ORDER.indexOf(cand)<=NIGHT_ORDER.indexOf(slot);

// ── 候補ウェイト計算（1日単位ではなく重み付き）
// 朝:1, 朝仕込:2, 夜:1, 朝+夜:1, 朝仕込+夜:2
function calcCandWeight(hasMorning, hasPrep, hasNight) {
  if (hasPrep && hasNight) return 2;
  if (hasPrep) return 2;
  if (hasMorning && hasNight) return 1;
  if (hasMorning) return 1;
  if (hasNight) return 1;
  return 0;
}

// ── 自動生成
function generateShifts(staff, year, month, avail, nightSlotConfig, aisaniConfig) {
  const days = daysIn(year, month);
  const result  = {};
  const worked  = {};
  const candW   = {}; // 候補ウェイト累計
  staff.forEach(s=>{ worked[s.id]=0; candW[s.id]=0; });

  const isAvail = (sid,key) => !!avail[sid]?.[key];

  // pick: 候補から count 人選ぶ（ルール付き）
  const pick = (candidates, count, opts={}) => {
    const { maxJunior=99, needSeniorIfJunior=false } = opts;
    const sorted = [...candidates].sort((a,b)=>{
      // 朝夜両方出してる人は朝・夜どちらか一方に偏らないよう worked で均等化
      const wd = worked[a.id]-worked[b.id]; if(wd!==0) return wd;
      const lo = {J:3,L:2,M:1,SM:0,GM:0}; return lo[a.grade]-lo[b.grade];
    });
    const res=[]; let nb=0;
    for(const s of sorted){
      if(res.length>=count) break;
      if(isJunior(s.grade)&&nb>=maxJunior) continue;
      res.push(s); if(isJunior(s.grade)) nb++;
    }
    // 新人いてシニアいない→シニアに差し替え
    if(needSeniorIfJunior&&res.some(s=>isJunior(s.grade))&&!res.some(s=>isSenior(s.grade))){
      const vet=candidates.find(s=>isSenior(s.grade)&&!res.includes(s));
      if(vet){ const ri=res.findLastIndex(s=>isMid(s.grade)); if(ri>=0) res[ri]=vet; else{ res.pop(); res.push(vet); } }
    }
    return res.slice(0,count);
  };

  const shortage={}; const warnings={};

  // 翌日の朝・朝仕込みが人員不足になりそうか予測（簡易: 候補者数が必要数以下なら不足リスク）
  const morningRisk=(d)=>{
    if(d>days||isClosed(year,month,d)) return false;
    const mc=staff.filter(s=>isAvail(s.id,`${d}_morning`)).length;
    const pc=staff.filter(s=>isAvail(s.id,`${d}_prep`)).length;
    return mc<2||pc<1;
  };

  for(let d=1;d<=days;d++){
    if(isClosed(year,month,d)){
      result[d]={morning:[],prep:[],night:{},aisani:null};
      shortage[d]={morning:0,prep:0,night:{},aisani:0};
      warnings[d]=[];
      continue;
    }
    const spec=isSpec(year,month,d);
    const dayR={morning:[],prep:[],night:{},aisani:null};
    const dayS={morning:0,prep:0,night:{},aisani:0};
    const dayW=[];
    const slots=nightSlotConfig[d]||[];

    // 前日夜ワーカー
    const prevNight=new Set(d>1?Object.values(result[d-1]?.night||{}).filter(Boolean):[]);
    // 翌日リスク確認（前日夜に入れると翌朝が不足する可能性）
    const nextDayRisk=morningRisk(d+1);

    // 候補ウェイト加算
    staff.forEach(s=>{
      const hM=isAvail(s.id,`${d}_morning`);
      const hP=isAvail(s.id,`${d}_prep`);
      const hN=NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`));
      const hA=s.aisaniOK&&isAvail(s.id,`${d}_aisani`);
      candW[s.id]+=calcCandWeight(hM,hP,hN)+(hA?1:0);
    });

    // ── 朝仕込み優先（前日夜NG、翌日朝確定者NG）
    const pStrict=staff.filter(s=>
      isAvail(s.id,`${d}_prep`)&&
      !prevNight.has(s.id)
    );
    const pAll=staff.filter(s=>isAvail(s.id,`${d}_prep`));
    const pCands=pStrict.length>=1?pStrict:pAll;
    const pPick=pick(pCands,1);
    if(pPick[0]&&prevNight.has(pPick[0].id)) dayW.push(`${pPick[0].name}：前日夜→朝仕込み（人手不足）`);
    dayR.prep=pPick.map(s=>s.id);
    pPick.forEach(s=>{worked[s.id]++;});
    dayS.prep=Math.max(0,1-pPick.length);

    // ── 朝 ×2（朝仕込済み除外、前日夜NG、翌日朝確定NG、新人2人以上NG）
    const mStrict=staff.filter(s=>
      isAvail(s.id,`${d}_morning`)&&
      !dayR.prep.includes(s.id)&&
      !prevNight.has(s.id)
    );
    const mAll=staff.filter(s=>isAvail(s.id,`${d}_morning`)&&!dayR.prep.includes(s.id));
    const mCands=mStrict.length>=2?mStrict:(mStrict.length>0?mAll:mAll);
    const mPick=pick(mCands,2,{maxJunior:1});
    mPick.forEach(s=>{ if(prevNight.has(s.id)) dayW.push(`${s.name}：前日夜→朝（人手不足）`); });
    dayR.morning=mPick.map(s=>s.id);
    mPick.forEach(s=>{worked[s.id]++;});
    dayS.morning=Math.max(0,2-mPick.length);

    // ── 夜
    const prepW=new Set(dayR.prep);
    const morningW=new Set(dayR.morning);
    const assignedNight=new Set();

    // 翌日朝確定者は夜に入れない（翌日が不足リスクの場合）
    const tomorrowMorningConfirmed=new Set();
    if(nextDayRisk&&d<days&&!isClosed(year,month,d+1)){
      // 翌日の朝候補が少ない場合、その候補者を今日の夜から除外
      staff.filter(s=>isAvail(s.id,`${d+1}_morning`)||isAvail(s.id,`${d+1}_prep`))
        .forEach(s=>tomorrowMorningConfirmed.add(s.id));
    }

    slots.forEach(slotTime=>{
      // 段階的に緩和しながら候補探し
      const baseCands=(relaxJunior,relaxMorning)=>staff.filter(s=>{
        if(prepW.has(s.id)) return false; // 朝仕込→夜は常にNG
        if(assignedNight.has(s.id)) return false;
        if(tomorrowMorningConfirmed.has(s.id)&&nextDayRisk) return false;
        if(!relaxMorning&&morningW.has(s.id)) return false; // 朝夜連続
        if(!relaxJunior&&isJunior(s.grade)&&spec) return false; // 新人特別夜NG
        return NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`)&&nightCompat(t,slotTime));
      });

      // 新人は同じ夜に1人まで
      const currentNightJuniors=[...assignedNight].filter(id=>isJunior(staffById_local(staff,id)?.grade));
      const maxJ=currentNightJuniors.length>=1?0:1;

      let nCands=baseCands(false,false);
      let relaxed="";
      if(!nCands.length){ nCands=baseCands(false,true); relaxed="朝夜連続"; }
      if(!nCands.length){ nCands=baseCands(true,false); relaxed="新人特別夜"; }
      if(!nCands.length){ nCands=baseCands(true,true); relaxed="朝夜連続+新人特別夜"; }

      const nPick=pick(nCands,1,{maxJunior:maxJ,needSeniorIfJunior:true});
      dayR.night[slotTime]=nPick[0]?.id||null;
      if(nPick[0]){
        worked[nPick[0].id]++;
        assignedNight.add(nPick[0].id);
        if(relaxed){
          const r=[];
          if(morningW.has(nPick[0].id)) r.push("朝夜連続");
          if(isJunior(nPick[0].grade)&&spec) r.push("新人特別夜");
          if(r.length) dayW.push(`${nPick[0].name}：${r.join("・")}（人手不足）`);
        }
      }
      dayS.night[slotTime]=nPick[0]?0:1;
    });

    // ── アイサニ（GMが枠をONかつスタッフが候補を出している人を割り当て）
    const aiConf=aisaniConfig[d];
    if(aiConf&&aiConf.enabled){
      const alreadyInNight=new Set(Object.values(dayR.night).filter(Boolean));
      // 第1優先：アイサニ候補を出している人
      const aiCandsStrict=staff.filter(s=>
        s.aisaniOK&&
        isAvail(s.id,`${d}_aisani`)&&
        !dayR.morning.includes(s.id)&&
        !dayR.prep.includes(s.id)&&
        !alreadyInNight.has(s.id)
      );
      // 第2優先（不足時）：夜に候補を出していてアイサニOKな人
      const aiCandsNightFallback=staff.filter(s=>
        s.aisaniOK&&
        !dayR.morning.includes(s.id)&&
        !dayR.prep.includes(s.id)&&
        !alreadyInNight.has(s.id)&&
        NIGHT_TIMES.some(t=>isAvail(s.id,`${d}_night_${t}`))
      );
      const aiCands=aiCandsStrict.length>0?aiCandsStrict:aiCandsNightFallback;
      const usingFallback=aiCandsStrict.length===0&&aiCandsNightFallback.length>0;
      const aiPick=pick(aiCands,1);
      dayR.aisani=aiPick[0]?.id||null;
      if(aiPick[0]){
        worked[aiPick[0].id]++;
        if(usingFallback) dayW.push(`${aiPick[0].name}：アイサニ（夜候補から補填）`);
      }
      dayS.aisani=aiPick[0]?0:1;
    }

    result[d]=dayR;
    shortage[d]=dayS;
    warnings[d]=dayW;
  }

  // 達成率
  const totalW=Object.values(worked).reduce((a,b)=>a+b,0);
  const totalC=Object.values(candW).reduce((a,b)=>a+b,0);
  const avgRate=totalC>0?Math.round(totalW/totalC*100):0;

  return {shifts:result,worked,candW,shortage,warnings,avgRate};
}

function staffById_local(staffArr,id){ return staffArr.find(s=>s.id===id); }

// ══════════════════════════════════════════════════════
export default function App(){
  const now=new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth());
  const [staff,setStaff]=useState([
    {id:1,name:"田中 蓮",grade:"SM",aisaniOK:true},
    {id:2,name:"佐藤 彩",grade:"SM",aisaniOK:true},
    {id:3,name:"鈴木 翔",grade:"M",aisaniOK:false},
    {id:4,name:"高橋 美咲",grade:"L",aisaniOK:false},
    {id:5,name:"伊藤 大輝",grade:"J",aisaniOK:false},
    {id:6,name:"渡辺 ひな",grade:"J",aisaniOK:false},
  ]);
  const [avail,setAvail]=useState({});
  const [nightSlotConfig,setNightSlotConfig]=useState({});
  const [aisaniConfig,setAisaniConfig]=useState({}); // { d: {enabled:bool} }
  const [result,setResult]=useState(null);
  const [view,setView]=useState("slots"); // slots|avail|result
  const [gmMode,setGmMode]=useState(false);
  const [loginStaff,setLoginStaff]=useState(null); // スタッフモードで選択中
  const [newStaff,setNewStaff]=useState({name:"",grade:"L",aisaniOK:false});
  const [staffPanelOpen,setStaffPanelOpen]=useState(false);
  const [generating,setGenerating]=useState(false);
  const [exporting,setExporting]=useState(false);
  const shiftRef=useRef(null);

  const days=daysIn(year,month);
  const firstDow=getDow(year,month,1);
  const staffMap=useMemo(()=>{const m={};staff.forEach(s=>m[s.id]=s);return m;},[staff]);

  const prevMonth=()=>{if(month===0)updateYearMonth(year-1,11);else updateYearMonth(year,month-1);setResult(null);};
  const nextMonth=()=>{if(month===11)updateYearMonth(year+1,0);else updateYearMonth(year,month+1);setResult(null);};

  const toggleNightSlot=(d,time)=>setNightSlotConfig(p=>{
    const cur=p[d]||[];
    const next=cur.includes(time)?cur.filter(t=>t!==time):[...cur,time].sort();
    return {...p,[d]:next};
  });
  const toggleAisani=(d)=>updateAisaniCfg({...aisaniConfig,[d]:{enabled:!aisaniConfig[d]?.enabled}});

  // 候補入力（GM: 任意のスタッフ, スタッフ: 自分のみ）
  const targetSid=gmMode?null:(loginStaff?.id);

  const toggleAvail=(sid,key)=>updateAvail({...avail,[sid]:{...(avail[sid]||{}),[key]:!avail[sid]?.[key]}});
  const toggleNightAvail=(sid,d,time)=>{
    const cur=avail[sid]||{};
    const next={...cur};
    NIGHT_TIMES.forEach(t=>{next[`${d}_night_${t}`]=false;});
    if(!cur[`${d}_night_${time}`]) next[`${d}_night_${time}`]=true;
    updateAvail({...avail,[sid]:next});
  };
  const setAllAvail=(sid,type,val)=>{
    const cur=avail[sid]||{};const next={...cur};
    for(let d=1;d<=days;d++) if(!isClosed(year,month,d)) next[`${d}_${type}`]=val;
    updateAvail({...avail,[sid]:next});
  };

  const handleGenerate=()=>{
    setGenerating(true);
    setTimeout(()=>{
      const r=generateShifts(staff,year,month,avail,nightSlotConfig,aisaniConfig);
      setResult(r);setView("result");setGenerating(false);
    },500);
  };

  const handleExport=async()=>{
    if(!shiftRef.current)return;
    setExporting(true);
    try{
      if(!window.html2canvas){
        await new Promise((res,rej)=>{
          const s=document.createElement("script");
          s.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
          s.onload=res;s.onerror=rej;document.head.appendChild(s);
        });
      }
      const canvas=await window.html2canvas(shiftRef.current,{backgroundColor:"#030712",scale:2,useCORS:true,logging:false});
      const a=document.createElement("a");
      a.download=`シフト表_${year}年${month+1}月.png`;
      a.href=canvas.toDataURL("image/png");a.click();
    }catch{alert("画像出力に失敗しました");}
    setExporting(false);
  };

  const addStaff=()=>{
    if(!newStaff.name.trim())return;
    updateStaff([...staff,{...newStaff,id:Date.now()}]);
    setNewStaff({name:"",grade:"L",aisaniOK:false});
  };

  // スタッフモード: 自分の名前でログイン
  const staffModeStaff=staff.filter(s=>s.grade!=="GM");

  // GMパスワード
  const GM_PASSWORD="GM1234";
  const [pwModal,setPwModal]=useState(false);
  const [pwInput,setPwInput]=useState("");
  const [pwError,setPwError]=useState(false);
  const [loading,setLoading]=useState(true);
  const [syncing,setSyncing]=useState(false);
  const saveTimers=useRef({});
  const pendingKeys=useRef(new Set());

  // ── Firebase リアルタイム購読
  useEffect(()=>{
    const unsub=subscribeAll((data)=>{
      if(data.staff          &&!pendingKeys.current.has('staff'))          setStaff(data.staff);
      if(data.avail          &&!pendingKeys.current.has('avail'))          setAvail(data.avail);
      if(data.nightSlotConfig&&!pendingKeys.current.has('nightSlotConfig'))setNightSlotConfig(data.nightSlotConfig);
      if(data.aisaniConfig   &&!pendingKeys.current.has('aisaniConfig'))   setAisaniConfig(data.aisaniConfig);
      if(data.yearMonth      &&!pendingKeys.current.has('yearMonth'))      {setYear(data.yearMonth.y);setMonth(data.yearMonth.m);}
      setLoading(false);
    });
    const t=setTimeout(()=>setLoading(false),5000);
    return()=>{unsub();clearTimeout(t);};
  },[]);

  // ── デバウンス付き保存
  const debounceSave=useCallback((key,val)=>{
    clearTimeout(saveTimers.current[key]);
    setSyncing(true);
    pendingKeys.current.add(key);
    saveTimers.current[key]=setTimeout(async()=>{
      try{await saveKey(key,val);}catch(e){console.warn('save error',e);}
      pendingKeys.current.delete(key);
      setSyncing(pendingKeys.current.size>0);
    },600);
  },[]);

  // ── 状態変更 → Firebase保存
  const updateStaff=val=>{setStaff(val);debounceSave('staff',val);};
  const updateAvail=val=>{setAvail(val);debounceSave('avail',val);};
  const updateNightSlot=val=>{setNightSlotConfig(val);debounceSave('nightSlotConfig',val);};
  const updateAisaniCfg=val=>{setAisaniConfig(val);debounceSave('aisaniConfig',val);};
  const updateYearMonth=(y,m)=>{setYear(y);setMonth(m);debounceSave('yearMonth',{y,m});};
  const handleGmLogin=()=>{
    if(pwInput===GM_PASSWORD){
      setGmMode(true);setView("slots");
      setPwModal(false);setPwInput("");setPwError(false);
    } else {
      setPwError(true);setPwInput("");
    }
  };

  // ── スタイル
  const C={
    bg:"#030712",card:"#0f172a",border:"#1e2a3a",
    accent:"#6366f1",text:"#f0f4ff",muted:"#64748b",
  };
  const btn=(on,c=C.accent)=>({
    padding:"7px 14px",borderRadius:8,border:"none",cursor:"pointer",
    fontFamily:"inherit",fontSize:12,fontWeight:700,transition:"all .15s",
    background:on?c:"#1e2a3a",color:on?"#fff":C.muted,
  });
  const card={background:C.card,borderRadius:14,border:`1px solid ${C.border}`,padding:16};

  // GM/スタッフモード表示制御
  const showGmTabs=gmMode;
  const availSid=gmMode?null:loginStaff?.id; // GMはタブで切替、スタッフは自分のID

  // 候補日入力で表示するスタッフ（GMは全員タブ、スタッフは自分のみ）
  const [selectedStaffTab,setSelectedStaffTab]=useState(null);
  const availViewStaff=gmMode
    ?(selectedStaffTab?staff.find(s=>s.id===selectedStaffTab):staff[0])
    :loginStaff;

  if(loading) return(<div style={{minHeight:"100vh",background:"#030712",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}><div style={{fontSize:36}}>🍶</div><div style={{color:"#64748b",fontSize:13}}>データを読み込み中...</div></div>);

  return(
    <div style={{fontFamily:"'Zen Kaku Gothic New',sans-serif",minHeight:"100vh",background:C.bg,color:C.text}}>
      <link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;700;900&display=swap" rel="stylesheet"/>
      {/* GMパスワードモーダル */}
      {pwModal&&(
        <div style={{position:"fixed",inset:0,background:"#000000cc",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={e=>{if(e.target===e.currentTarget){setPwModal(false);setPwInput("");setPwError(false);}}}>
          <div style={{background:"#0f172a",borderRadius:16,padding:"28px 24px",width:300,border:"1px solid #6366f140",boxShadow:"0 8px 40px #0008"}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4,color:"#e879f9"}}>🔐 GMモード</div>
            <div style={{fontSize:11,color:"#64748b",marginBottom:16}}>パスワードを入力してください</div>
            <input
              type="password"
              value={pwInput}
              onChange={e=>{setPwInput(e.target.value);setPwError(false);}}
              onKeyDown={e=>e.key==="Enter"&&handleGmLogin()}
              placeholder="パスワード"
              autoFocus
              style={{width:"100%",padding:"10px 14px",borderRadius:8,border:`1px solid ${pwError?"#ef4444":"#1e2a3a"}`,
                background:"#07080f",color:"#f0f4ff",fontFamily:"inherit",fontSize:14,marginBottom:8,outline:"none"}}/>
            {pwError&&<div style={{fontSize:11,color:"#ef4444",marginBottom:8}}>パスワードが違います</div>}
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <button onClick={()=>{setPwModal(false);setPwInput("");setPwError(false);}}
                style={{flex:1,padding:"9px",borderRadius:8,border:"1px solid #1e2a3a",background:"transparent",color:"#64748b",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>
                キャンセル
              </button>
              <button onClick={handleGmLogin}
                style={{flex:1,padding:"9px",borderRadius:8,border:"none",background:"#e879f9",color:"#fff",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>
                ログイン
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`
        *{box-sizing:border-box} button:active{transform:scale(.95)}
        @keyframes fi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .fi{animation:fi .2s ease}
        .sth{position:sticky;top:0;background:#0f172a;z-index:5}
      `}</style>

      {/* ── ヘッダー */}
      <div style={{background:"#07080f",borderBottom:`1px solid ${C.border}`,padding:"12px 16px",position:"sticky",top:0,zIndex:30}}>
        <div style={{maxWidth:900,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:22}}>🍶</span>
              <div>
                <div style={{fontSize:8,letterSpacing:5,color:C.accent,textTransform:"uppercase"}}>Shift Master</div>
                <div style={{fontSize:17,fontWeight:900}}>{year}年{month+1}月</div>
              </div>
              {gmMode&&<>
                <button onClick={prevMonth} style={{...btn(false),padding:"5px 10px",fontSize:15,marginLeft:4}}>‹</button>
                <button onClick={nextMonth} style={{...btn(false),padding:"5px 10px",fontSize:15}}>›</button>
              </>}
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              {/* GM/スタッフ切替 */}
              <div style={{display:"flex",background:"#1e2a3a",borderRadius:8,padding:2,gap:2}}>
                <button onClick={()=>{if(gmMode)return; setPwModal(true);}} style={{...btn(gmMode,"#e879f9"),fontSize:11,padding:"5px 10px"}}>GM</button>
                <button onClick={()=>{setGmMode(false);setView("avail");setLoginStaff(null);}} style={{...btn(!gmMode,"#60a5fa"),fontSize:11,padding:"5px 10px"}}>スタッフ</button>
              </div>
              {gmMode&&<button onClick={()=>setStaffPanelOpen(v=>!v)} style={{...btn(staffPanelOpen,"#374151"),fontSize:11,padding:"6px 12px"}}>👥 スタッフ</button>}
            </div>
          </div>

          {/* スタッフモード: 自分を選ぶ */}
          {!gmMode&&!loginStaff&&(
            <div style={{padding:"8px 0"}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:6}}>名前を選んでください</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {staffModeStaff.map(s=>(
                  <button key={s.id} onClick={()=>setLoginStaff(s)}
                    style={{...btn(false),fontSize:12,padding:"7px 14px"}}>{s.name}</button>
                ))}
              </div>
            </div>
          )}
          {!gmMode&&loginStaff&&(
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:12,color:C.muted}}>ログイン中：</span>
              <span style={{fontWeight:700,fontSize:13}}>{loginStaff.name}</span>
              <button onClick={()=>setLoginStaff(null)} style={{...btn(false),fontSize:10,padding:"3px 8px"}}>変更</button>
            </div>
          )}

          {/* GMタブ */}
          {gmMode&&(
            <div style={{display:"flex",gap:4,marginTop:8}}>
              {[["slots","①夜枠設定"],["avail","②候補日入力"],["result","③シフト表"]].map(([v,l])=>(
                <button key={v} onClick={()=>setView(v)} style={{...btn(view===v),flex:1,fontSize:11,padding:"7px 4px"}}>{l}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"14px 12px"}}>

        {/* ── スタッフ管理パネル（GMのみ） */}
        {gmMode&&staffPanelOpen&&(
          <div className="fi" style={{...card,marginBottom:14}}>
            <div style={{fontSize:12,color:C.accent,fontWeight:700,marginBottom:12}}>スタッフ管理</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
              <input placeholder="名前" value={newStaff.name} onChange={e=>setNewStaff(p=>({...p,name:e.target.value}))}
                style={{flex:"1 1 130px",padding:"9px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:"#111827",color:C.text,fontFamily:"inherit",fontSize:13}}/>
              <select value={newStaff.grade} onChange={e=>setNewStaff(p=>({...p,grade:e.target.value}))}
                style={{padding:"9px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:"#111827",color:C.text,fontFamily:"inherit",fontSize:13}}>
                {GRADES.map(g=><option key={g} value={g}>{g}</option>)}
              </select>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.muted,cursor:"pointer"}}>
                <input type="checkbox" checked={newStaff.aisaniOK} onChange={e=>setNewStaff(p=>({...p,aisaniOK:e.target.checked}))}/>
                アイサニOK
              </label>
              <button onClick={addStaff} style={{...btn(true,C.accent),padding:"9px 18px"}}>追加</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {staff.map(s=>(
                <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",background:"#07080f",borderRadius:10,border:`1px solid ${C.border}`,flexWrap:"wrap"}}>
                  <span style={{flex:1,fontWeight:700,fontSize:13,minWidth:80}}>{s.name}</span>
                  <span style={{fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:700,background:GRADE_COLOR[s.grade]+"25",color:GRADE_COLOR[s.grade]}}>{s.grade}</span>
                  {/* 等級変更(GMのみ) */}
                  <div style={{display:"flex",gap:3}}>
                    {GRADES.map(g=>(
                      <button key={g} onClick={()=>updateStaff(staff.map(x=>x.id===s.id?{...x,grade:g}:x))}
                        style={{...btn(s.grade===g,GRADE_COLOR[g]),fontSize:10,padding:"3px 7px"}}>{g}</button>
                    ))}
                  </div>
                  <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:s.aisaniOK?"#34d399":C.muted,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!s.aisaniOK} onChange={e=>updateStaff(staff.map(x=>x.id===s.id?{...x,aisaniOK:e.target.checked}:x))}/>
                    アイサニ
                  </label>
                  <button onClick={()=>updateStaff(staff.filter(x=>x.id!==s.id))}
                    style={{padding:"3px 9px",borderRadius:6,border:"1px solid #ef444430",background:"transparent",color:"#ef4444",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>削除</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── ① 夜枠設定（GMのみ） */}
        {gmMode&&view==="slots"&&(
          <div className="fi">
            <div style={{...card,marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:700,color:C.accent,marginBottom:4}}>日ごとの夜・アイサニ枠を設定</div>
              <div style={{fontSize:11,color:C.muted}}>夜枠（複数可）とアイサニ（系列店ヘルプ）を日ごとに設定</div>
            </div>
            {/* 凡例 */}
            <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              {NIGHT_TIMES.map(t=>(
                <span key={t} style={{fontSize:10,display:"flex",alignItems:"center",gap:4}}>
                  <span style={{width:8,height:8,borderRadius:2,background:NIGHT_TC[t],display:"inline-block"}}/>
                  <span style={{color:C.muted}}>{t}</span>
                </span>
              ))}
              <span style={{fontSize:10,color:"#34d399",display:"flex",alignItems:"center",gap:4}}>
                <span style={{width:8,height:8,borderRadius:2,background:"#34d399",display:"inline-block"}}/>
                アイサニ
              </span>
            </div>
            {/* カレンダーグリッド */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:10}}>
              {DOW_JP.map((d,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:10,padding:"4px 0",fontWeight:700,color:i===0?"#f87171":i===6?"#60a5fa":C.muted}}>{d}</div>
              ))}
              {Array(firstDow).fill(null).map((_,i)=><div key={`e${i}`}/>)}
              {Array(days).fill(null).map((_,i)=>{
                const d=i+1,dow=getDow(year,month,d),hol=isHol(year,month,d);
                const closed=isClosed(year,month,d);
                const slots=nightSlotConfig[d]||[];
                const aiOn=aisaniConfig[d]?.enabled;
                return(
                  <div key={d} style={{borderRadius:8,padding:"5px 3px",background:closed?"#07080f":C.card,
                    border:`1px solid ${hol?"#6366f140":dow===0?"#f8717120":dow===6?"#60a5fa20":C.border}`,
                    minHeight:72,opacity:closed?0.35:1}}>
                    <div style={{textAlign:"center",fontSize:11,fontWeight:700,marginBottom:3,
                      color:closed?"#374151":hol?"#818cf8":dow===0?"#f87171":dow===6?"#60a5fa":C.text}}>
                      {d}{hol?"🎌":""}{closed?"🔒":""}
                    </div>
                    {!closed&&(
                      <>
                        <div style={{display:"flex",flexWrap:"wrap",gap:2,justifyContent:"center",marginBottom:3}}>
                          {NIGHT_TIMES.map(t=>{
                            const on=slots.includes(t);
                            return(
                              <button key={t} onClick={()=>toggleNightSlot(d,t)}
                                style={{padding:"2px 3px",borderRadius:4,border:"none",cursor:"pointer",fontSize:8,fontWeight:700,fontFamily:"inherit",
                                  background:on?NIGHT_TC[t]:"#1e2a3a",color:on?"#fff":"#4b5563",transition:"all .1s"}}>
                                {t}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{textAlign:"center"}}>
                          <button onClick={()=>toggleAisani(d)}
                            style={{padding:"2px 6px",borderRadius:4,border:"none",cursor:"pointer",fontSize:8,fontWeight:700,fontFamily:"inherit",
                              background:aiOn?"#34d399":"#1e2a3a",color:aiOn?"#07080f":"#4b5563",transition:"all .1s"}}>
                            アイサニ
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 一括 */}
            <div style={{...card}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:8}}>一括設定</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {NIGHT_TIMES.map(t=>(
                  <button key={t} onClick={()=>setNightSlotConfig(p=>{
                    const next={...p};
                    for(let d=1;d<=days;d++){
                      if(isClosed(year,month,d))continue;
                      const cur=next[d]||[];
                      next[d]=cur.includes(t)?cur.filter(x=>x!==t):[...cur,t].sort();
                    }
                    return next;
                  })} style={{...btn(false,NIGHT_TC[t]),color:NIGHT_TC[t],background:NIGHT_TC[t]+"18",border:`1px solid ${NIGHT_TC[t]}40`,fontSize:10}}>
                    {t} 全日切替
                  </button>
                ))}
                <button onClick={()=>setNightSlotConfig({})} style={{...btn(false),fontSize:10}}>全クリア</button>
              </div>
            </div>
            <button onClick={()=>setView("avail")} style={{width:"100%",marginTop:12,padding:"13px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"linear-gradient(135deg,#6366f1,#8b5cf6)",color:"#fff",boxShadow:"0 4px 20px #6366f138"}}>
              次へ：候補日入力 →
            </button>
          </div>
        )}

        {/* ── ② 候補日入力（GM: スタッフ切替タブ / スタッフ: 自分のみ） */}
        {(gmMode?view==="avail":(!gmMode&&loginStaff))&&(
          <div className="fi">
            {gmMode&&(
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:12}}>
                {staff.map(s=>(
                  <button key={s.id} onClick={()=>setSelectedStaffTab(s.id)}
                    style={{...btn((selectedStaffTab===s.id)||(selectedStaffTab===null&&s.id===staff[0]?.id),GRADE_COLOR[s.grade]),fontSize:12}}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}

            {availViewStaff&&(()=>{
              const sid=availViewStaff.id;
              const a=avail[sid]||{};
              const isJ=isJunior(availViewStaff.grade);
              return(
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                    <span style={{fontWeight:800,fontSize:15}}>{availViewStaff.name}</span>
                    {gmMode&&<span style={{fontSize:10,padding:"2px 8px",borderRadius:20,fontWeight:700,background:GRADE_COLOR[availViewStaff.grade]+"25",color:GRADE_COLOR[availViewStaff.grade]}}>{availViewStaff.grade}</span>}
                    {isJ&&<span style={{fontSize:10,color:"#f87171",background:"#f8717115",borderRadius:6,padding:"2px 8px"}}>金土日祝の夜は原則NG</span>}
                  </div>
                  {/* 一括 */}
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                    <button onClick={()=>setAllAvail(sid,"morning",true)} style={{...btn(false),background:"#f59e0b18",color:"#f59e0b",border:"1px solid #f59e0b30",fontSize:10}}>朝 全ON</button>
                    <button onClick={()=>setAllAvail(sid,"prep",true)} style={{...btn(false),background:"#10b98118",color:"#10b981",border:"1px solid #10b98130",fontSize:10}}>朝仕込 全ON</button>
                    {NIGHT_TIMES.map(t=>(
                      <button key={t} onClick={()=>setAllAvail(sid,`night_${t}`,true)}
                        style={{...btn(false),background:NIGHT_TC[t]+"18",color:NIGHT_TC[t],border:`1px solid ${NIGHT_TC[t]}30`,fontSize:10}}>
                        夜{t} 全ON
                      </button>
                    ))}
                    {availViewStaff.aisaniOK&&(
                      <button onClick={()=>setAllAvail(sid,"aisani",true)} style={{...btn(false),background:"#34d39918",color:"#34d399",border:"1px solid #34d39930",fontSize:10}}>アイサニ 全ON</button>
                    )}
                    <button onClick={()=>setAvail(p=>({...p,[sid]:{}}))} style={{...btn(false),fontSize:10}}>クリア</button>
                  </div>
                  {/* テーブル（ヘッダー固定） */}
                  <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"58vh",borderRadius:10,border:`1px solid ${C.border}`}}>
                    <table style={{borderCollapse:"collapse",width:"100%",minWidth:540}}>
                      <thead>
                        <tr>
                          <th className="sth" style={{fontSize:10,color:C.muted,fontWeight:400,padding:"7px 4px",textAlign:"center",width:28}}>日</th>
                          <th className="sth" style={{fontSize:10,color:C.muted,fontWeight:400,width:22,textAlign:"center"}}>曜</th>
                          <th className="sth" style={{fontSize:10,color:"#f59e0b",fontWeight:700,padding:"7px 8px",textAlign:"center"}}>朝<br/><span style={{fontSize:8,opacity:.7}}>7:00〜</span></th>
                          <th className="sth" style={{fontSize:10,color:"#10b981",fontWeight:700,padding:"7px 8px",textAlign:"center"}}>朝仕込<br/><span style={{fontSize:8,opacity:.7}}>8:30〜</span></th>
                          {NIGHT_TIMES.map(t=>(
                            <th key={t} className="sth" style={{fontSize:10,color:NIGHT_TC[t],fontWeight:700,padding:"7px 4px",textAlign:"center"}}>
                              {t}〜<br/><span style={{fontSize:8,opacity:.7}}>夜</span>
                            </th>
                          ))}
                          {availViewStaff.aisaniOK&&(
                            <th className="sth" style={{fontSize:10,color:"#34d399",fontWeight:700,padding:"7px 4px",textAlign:"center"}}>
                              アイサニ<br/><span style={{fontSize:8,opacity:.7}}>系列店</span>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({length:days},(_,i)=>i+1).map(d=>{
                          const dow=getDow(year,month,d),hol=isHol(year,month,d),spec=isSpec(year,month,d);
                          const closed=isClosed(year,month,d);
                          const slots=nightSlotConfig[d]||[];
                          const rowBg=closed?"#07080f":hol?"#818cf80a":dow===0?"#f871710a":dow===6?"#60a5fa0a":"transparent";
                          return(
                            <tr key={d} style={{background:rowBg,borderBottom:`1px solid ${C.border}`,opacity:closed?0.3:1}}>
                              <td style={{textAlign:"center",fontSize:12,fontWeight:700,padding:"4px 2px",
                                color:closed?"#374151":hol?"#818cf8":dow===0?"#f87171":dow===6?"#60a5fa":C.text}}>
                                {d}{hol?"🎌":""}{closed?"🔒":""}
                              </td>
                              <td style={{textAlign:"center",fontSize:10,color:closed?"#374151":C.muted}}>{DOW_JP[dow]}</td>
                              {closed?(
                                <td colSpan={availViewStaff.aisaniOK?7:6} style={{textAlign:"center",fontSize:10,color:"#374151",padding:"5px"}}>定休日</td>
                              ):(
                                <>
                                  {["morning","prep"].map(type=>{
                                    const on=!!a[`${d}_${type}`];
                                    return(
                                      <td key={type} style={{textAlign:"center",padding:"3px 5px"}}>
                                        <button onClick={()=>toggleAvail(sid,`${d}_${type}`)}
                                          style={{width:34,height:26,borderRadius:6,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,
                                            background:on?(type==="morning"?"#f59e0b":"#10b981"):"#1e2a3a",
                                            color:on?"#07080f":C.muted,transition:"all .1s"}}>
                                          {on?"✓":"　"}
                                        </button>
                                      </td>
                                    );
                                  })}
                                  {NIGHT_TIMES.map(t=>{
                                    const key=`${d}_night_${t}`;
                                    const slotExists=slots.includes(t);
                                    const on=!!a[key]&&slotExists;
                                    const otherOn=slots.some(ot=>ot!==t&&!!a[`${d}_night_${ot}`]);
                                    const disabledByOther=!on&&otherOn;
                                    return(
                                      <td key={t} style={{textAlign:"center",padding:"3px 3px"}}>
                                        {slotExists?(
                                          <button onClick={()=>!disabledByOther&&toggleNightAvail(sid,d,t)}
                                            style={{width:34,height:26,borderRadius:6,border:"none",
                                              cursor:disabledByOther?"not-allowed":"pointer",
                                              fontFamily:"inherit",fontSize:11,fontWeight:700,transition:"all .1s",
                                              background:on?NIGHT_TC[t]:disabledByOther?"#0d1020":"#1e2a3a",
                                              color:on?"#fff":disabledByOther?"#1e2a3a":C.muted,
                                              opacity:disabledByOther?0.2:1}}>
                                            {on?"✓":"　"}
                                          </button>
                                        ):(
                                          <div style={{width:34,height:26,borderRadius:6,background:"#07080f",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                            <span style={{fontSize:8,color:"#1e2a3a"}}>—</span>
                                          </div>
                                        )}
                                      </td>
                                    );
                                  })}
                                  {/* アイサニ列 - aisaniOKスタッフのみ表示 */}
                                  {availViewStaff.aisaniOK&&(
                                    <td style={{textAlign:"center",padding:"3px 3px"}}>
                                      <button onClick={()=>toggleAvail(sid,`${d}_aisani`)}
                                        style={{width:34,height:26,borderRadius:6,border:"none",cursor:"pointer",
                                          fontFamily:"inherit",fontSize:11,fontWeight:700,transition:"all .1s",
                                          background:!!a[`${d}_aisani`]?"#34d399":"#1e2a3a",
                                          color:!!a[`${d}_aisani`]?"#07080f":C.muted}}>
                                        {!!a[`${d}_aisani`]?"✓":"　"}
                                      </button>
                                    </td>
                                  )}
                                </>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{marginTop:7,fontSize:10,color:"#374151"}}>— は夜枠未設定 ／ 夜は1日1枠のみ選択可</div>
                </div>
              );
            })()}

            {gmMode&&(
              <button onClick={handleGenerate} disabled={generating}
                style={{width:"100%",marginTop:18,padding:"14px",borderRadius:12,border:"none",cursor:generating?"not-allowed":"pointer",
                  fontFamily:"inherit",fontSize:15,fontWeight:800,
                  background:generating?"#1e2a3a":"linear-gradient(135deg,#6366f1,#8b5cf6)",
                  color:generating?"#64748b":"#fff",boxShadow:generating?"none":"0 4px 20px #6366f138",transition:"all .2s"}}>
                {generating?"⏳ 生成中...":"✨ シフトを自動生成する"}
              </button>
            )}
            {!gmMode&&loginStaff&&(
              <div style={{marginTop:14,padding:"12px 14px",borderRadius:10,background:"#10b98110",border:"1px solid #10b98130",fontSize:12,color:"#10b981",textAlign:"center"}}>
                ✅ 入力内容は自動で保存されます
              </div>
            )}
          </div>
        )}

        {/* スタッフモードで名前未選択 */}
        {!gmMode&&!loginStaff&&(
          <div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}>
            <div style={{fontSize:48,marginBottom:12}}>👤</div>
            <div>上のリストから名前を選んでください</div>
          </div>
        )}

        {/* ── ③ シフト表（GMのみ） */}
        {gmMode&&view==="result"&&(
          <div className="fi">
            {!result?(
              <div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}>
                <div style={{fontSize:48,marginBottom:12}}>📋</div>
                <div style={{marginBottom:16}}>シフトがまだ生成されていません</div>
                <button onClick={()=>setView("slots")} style={{...btn(true),padding:"10px 24px",fontSize:13}}>夜枠を設定する</button>
              </div>
            ):(
              <div>
                <div style={{display:"flex",gap:8,marginBottom:14}}>
                  <button onClick={handleGenerate} style={{flex:1,padding:"11px",borderRadius:10,border:`1px solid ${C.accent}30`,background:"transparent",color:C.accent,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>
                    🔄 再生成
                  </button>
                  <button onClick={handleExport} disabled={exporting}
                    style={{flex:1,padding:"11px",borderRadius:10,border:"none",cursor:exporting?"wait":"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,
                      background:exporting?"#1e2a3a":"linear-gradient(135deg,#0ea5e9,#6366f1)",color:"#fff"}}>
                    {exporting?"⏳ 出力中...":"📷 画像で保存"}
                  </button>
                </div>

                <div ref={shiftRef} style={{background:C.bg,padding:14,borderRadius:14}}>
                  {/* タイトル */}
                  <div style={{textAlign:"center",marginBottom:14}}>
                    <div style={{fontSize:10,letterSpacing:5,color:C.accent,marginBottom:3}}>🍶 SHIFT TABLE</div>
                    <div style={{fontSize:20,fontWeight:900}}>{year}年{month+1}月 シフト表</div>
                  </div>

                  {/* サマリー */}
                  <div style={{...card,marginBottom:14}}>
                    <div style={{fontSize:11,color:C.accent,fontWeight:700,marginBottom:10}}>勤務実績 / 候補ウェイト（達成率）</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:7}}>
                      {staff.map(s=>{
                        const w=result.worked[s.id]||0;
                        const c=result.candW[s.id]||0;
                        const pct=c>0?Math.round(w/c*100):0;
                        const avg=result.avgRate;
                        const dc=pct>avg?"#34d399":pct<avg?"#f87171":C.muted;
                        return(
                          <div key={s.id} style={{background:"#07080f",borderRadius:10,padding:"9px 12px",textAlign:"center",border:`1px solid ${C.border}`,minWidth:84}}>
                            <div style={{fontSize:10,fontWeight:700,color:GRADE_COLOR[s.grade]}}>{s.name}</div>
                            <div style={{fontSize:17,fontWeight:900,color:C.text,marginTop:3}}>
                              {w}<span style={{fontSize:10,color:C.muted,fontWeight:400}}>/{c}</span>
                            </div>
                            <div style={{fontSize:11,fontWeight:700,color:dc}}>{pct}%</div>
                            <div style={{fontSize:8,color:"#374151"}}>実績/候補</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{fontSize:10,color:"#374151",marginTop:8}}>平均達成率：{result.avgRate}%</div>
                  </div>

                  {/* 日別カード */}
                  {Array.from({length:days},(_,i)=>i+1).map(d=>{
                    const dow=getDow(year,month,d),hol=isHol(year,month,d);
                    if(isClosed(year,month,d)) return null;
                    const day=result.shifts[d];
                    if(!day) return null;
                    const slots=nightSlotConfig[d]||[];
                    const aiOn=aisaniConfig[d]?.enabled;
                    const sh=result.shortage[d]||{};
                    const warns=result.warnings[d]||[];
                    const totalS=(sh.morning||0)+(sh.prep||0)+slots.reduce((s,t)=>s+(sh.night?.[t]||0),0)+(aiOn?sh.aisani||0:0);

                    return(
                      <div key={d} style={{...card,marginBottom:8,
                        borderColor:totalS>0?"#ef444440":warns.length?"#f59e0b30":hol?"#6366f130":dow===0?"#f8717120":dow===6?"#60a5fa20":C.border}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,flexWrap:"wrap"}}>
                          <span style={{fontWeight:800,fontSize:14,color:hol?"#818cf8":dow===0?"#f87171":dow===6?"#60a5fa":C.text}}>
                            {month+1}/{d}（{DOW_JP[dow]}）{hol?"🎌":""}
                          </span>
                          {isSpec(year,month,d)&&<span style={{fontSize:9,padding:"2px 6px",borderRadius:20,background:"#6366f118",color:"#818cf8",fontWeight:700}}>特別夜</span>}
                          {totalS>0&&<span style={{fontSize:9,padding:"2px 7px",borderRadius:20,background:"#ef444420",color:"#ef4444",fontWeight:700}}>⚠ 不足{totalS}名</span>}
                          {warns.length>0&&<span style={{fontSize:9,padding:"2px 7px",borderRadius:20,background:"#f59e0b15",color:"#f59e0b",fontWeight:700}}>⚡ 例外あり</span>}
                        </div>
                        {warns.length>0&&(
                          <div style={{marginBottom:8,padding:"6px 10px",background:"#f59e0b08",borderRadius:8,border:"1px solid #f59e0b1a"}}>
                            {warns.map((w,i)=><div key={i} style={{fontSize:10,color:"#f59e0b"}}>⚡ {w}</div>)}
                          </div>
                        )}
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          <SRow label="朝" time="7:00〜11:00" color="#f59e0b" people={day.morning.map(id=>staffMap[id]).filter(Boolean)} shortage={sh.morning||0}/>
                          <SRow label="朝仕込" time="8:30〜16:00" color="#10b981" people={day.prep.map(id=>staffMap[id]).filter(Boolean)} shortage={sh.prep||0}/>
                          {slots.map(t=>{
                            const p=day.night[t];
                            return <SRow key={t} label={`夜 ${t}〜`} time="" color={NIGHT_TC[t]} people={p?[staffMap[p]].filter(Boolean):[]} shortage={sh.night?.[t]||0}/>;
                          })}
                          {aiOn&&(
                            <SRow label="アイサニ" time="系列店" color="#34d399" people={day.aisani?[staffMap[day.aisani]].filter(Boolean):[]} shortage={sh.aisani||0}/>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SRow({label,time,color,people,shortage=0}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
      <div style={{minWidth:66,fontSize:10,fontWeight:700,color,background:color+"18",borderRadius:6,padding:"3px 8px",textAlign:"center",flexShrink:0}}>{label}</div>
      {time&&<div style={{fontSize:9,color:"#64748b",minWidth:76,flexShrink:0}}>{time}</div>}
      <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
        {people.map(s=>(
          <span key={s.id} style={{fontSize:12,padding:"3px 12px",borderRadius:20,background:"#ffffff0e",color:"#f0f4ff",fontWeight:600}}>
            {s.name}
          </span>
        ))}
        {shortage>0&&(
          <span style={{fontSize:10,padding:"2px 9px",borderRadius:20,background:"#ef444415",color:"#ef4444",fontWeight:700,border:"1px solid #ef444425"}}>
            あと{shortage}名不足
          </span>
        )}
        {people.length===0&&shortage===0&&<span style={{fontSize:11,color:"#1e2a3a"}}>—</span>}
      </div>
    </div>
  );
}
