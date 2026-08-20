/* ================= CONFIG ================= */
const API_URL = "PASTE_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE";

/* ================= API CLIENT =================
 * Replaces google.script.run. Uses POST with a text/plain body so the
 * browser treats it as a "simple request" and skips the CORS preflight
 * that Apps Script web apps don't handle. */
function callApi(action, payload){
  return fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: action, payload: payload || [] })
  }).then(function(r){ return r.json(); });
}

/* ================= STATE ================= */
var TOKEN = localStorage.getItem("ams_token") || "";
var LUSER = localStorage.getItem("ams_user") || "";
var MODE = "in", G = null, CONFIRM_CB = null, ERR_SHOWN = false;
var SORT_COL = null, SORT_DIR = "asc";
var TCLASS = ["d0","d1","d2","d3"];
var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

var DEF_CATEGORIES = ["Static","Rotary","Scaffolding","Hot work fab","Torquing"];
var DEF_TRAININGS = ["Training 1","Training 2","Training 3","Training 4","Training 5"];
var DEF_HEADERS = ["Approved By","Aadhar Number","Employee Code","Name","Category","Trade","Assessment Date"]
  .concat(DEF_TRAININGS).concat(["Final Check","Remarks"]);

function el(id){ return document.getElementById(id); }
function show(id,m){ el(id).textContent = m || ""; }
function fail(err){ toast("Server error: " + (err && err.message ? err.message : err), "err"); }
function toast(msg,type,actionLabel,actionFn){
  var t=document.createElement("div"); t.className="toast "+(type||"");
  var span=document.createElement("span"); span.textContent=msg; t.appendChild(span);
  if(actionLabel && actionFn){
    var b=document.createElement("button"); b.className="toast-action"; b.textContent=actionLabel;
    b.onclick=function(){ actionFn(); dismiss(); };
    t.appendChild(b);
  }
  el("toasts").appendChild(t);
  function dismiss(){ t.classList.add("bye"); setTimeout(function(){ t.remove(); },300); }
  setTimeout(dismiss, actionLabel ? 6000 : 3200);
}
function busyOn(){ var b=el("busy"); b.className=""; b.style.width="0"; void b.offsetWidth; b.className="on"; }
function busyOff(){ var b=el("busy"); b.className=""; b.style.width="0"; }

/* Aadhar: digits only, max 12, auto-space every 4 */
function aadharFormat(v){ var d=String(v).replace(/\D/g,"").slice(0,12); return d.replace(/(\d{4})(?=\d)/g,"$1 "); }
function fmtAadhar(v){ var d=String(v==null?"":v).replace(/\D/g,""); return d.length===12 ? aadharFormat(d) : String(v==null?"":v); }
function fmtDate(s){
  if(!s) return ""; var p=String(s).split("-");
  if(p.length!==3) return String(s);
  return (+p[2])+" "+MONTHS[+p[1]-1]+" "+p[0];
}
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
function isComplete(v){
  var s=String(v==null?"":v).trim().toLowerCase();
  return (s==="complete"||s==="completed"||s==="true"||s==="yes"||s==="1"||s==="done"||s==="x"||s==="\u2713"||s==="\u2714");
}

/* ================= FILTER / SEARCH ================= */
function applyFilters(rows, trs){
  var q=(el("qSearch")?el("qSearch").value:"").trim().toLowerCase();
  var fCategory=el("qCategory")?el("qCategory").value:"";
  var fTrade=el("qTrade")?el("qTrade").value:"";
  var fTrain=el("qTrain")?el("qTrain").value:"";
  var fFinal=el("qFinalF")?el("qFinalF").value:"";
  return rows.filter(function(r){
    if(q){
      var hay=[r["Employee Code"],r.Name,r["Aadhar Number"],r.Category,r.Trade].join(" ").toLowerCase();
      if(hay.indexOf(q)===-1) return false;
    }
    if(fCategory && r.Category!==fCategory) return false;
    if(fTrade && r.Trade!==fTrade) return false;
    if(fTrain){
      var dated=trs.filter(function(t){ return !!r[t]; }).length;
      var status = dated===0 ? "none" : (dated<trs.length ? "partial" : "full");
      if(fTrain==="none" && status!=="none") return false;
      if(fTrain==="partial" && status!=="partial") return false;
      if(fTrain==="full" && status!=="full") return false;
    }
    if(fFinal){
      var isDone=isComplete(r["Final Check"]);
      if(fFinal==="done" && !isDone) return false;
      if(fFinal==="pending" && isDone) return false;
    }
    return true;
  });
}
function fillFilterOptions(){
  if(!G) return;
  var cSel=el("qCategory"); if(cSel && !cSel.dataset.filled){
    (G.categories||[]).forEach(function(c){ var o=document.createElement("option"); o.value=c; o.text=c; cSel.add(o); });
    cSel.dataset.filled="1";
  }
  var tSel=el("qTrade"); if(tSel){
    var cur=tSel.value; tSel.innerHTML="<option value=''>All Trades</option>";
    var all=[]; Object.keys((G.categoryTrades||{})).forEach(function(c){ (G.categoryTrades[c]||[]).forEach(function(t){ if(all.indexOf(t)===-1) all.push(t); }); });
    all.forEach(function(t){ var o=document.createElement("option"); o.value=t; o.text=t; tSel.add(o); });
    if(cur) tSel.value=cur;
  }
}

/* ================= DASHBOARD ================= */
function buildVisibleHeaders(headers, trainings){
  var out=[], inserted=false;
  (headers||[]).forEach(function(h){
    if(trainings.indexOf(h)!==-1){
      if(!inserted){ out.push("Training Dates"); inserted=true; }
    } else {
      out.push(h);
    }
  });
  return out;
}
function computeStats(rows, trs){
  var s={total:0, notStarted:0, inProgress:0, completed:0, finalPending:0, finalDone:0, byCategory:{}, byTrade:{}};
  (rows||[]).forEach(function(r){
    s.total++;
    var dated=trs.filter(function(t){ return !!r[t]; }).length;
    if(dated===0) s.notStarted++; else if(dated<trs.length) s.inProgress++; else s.completed++;
    if(isComplete(r["Final Check"])) s.finalDone++; else s.finalPending++;
    var c=r.Category||"(none)"; s.byCategory[c]=(s.byCategory[c]||0)+1;
    var t=r.Trade||"(none)"; s.byTrade[t]=(s.byTrade[t]||0)+1;
  });
  return s;
}
function renderDashboard(g){
  var box=el("dashStats"), grp=el("dashGroups");
  if(!box || !grp) return;
  var s=computeStats(g.rows||[], g.trainings||[]);
  box.innerHTML=[
    ["accent", s.total, "Total Employees"],
    ["", s.notStarted, "Not Started"],
    ["warn", s.inProgress, "In Progress"],
    ["ok", s.completed, "Training Completed"],
    ["warn", s.finalPending, "Final Check Pending"],
    ["ok", s.finalDone, "Final Check Completed"]
  ].map(function(x){ return "<div class='stat "+x[0]+"'><div class='n'>"+x[1]+"</div><div class='l'>"+x[2]+"</div></div>"; }).join("");
  function grpHtml(title, obj){
    var keys=Object.keys(obj).sort();
    if(!keys.length) return "<div class='dash-group'><h3>"+esc(title)+"</h3><div class='dash-row' style='color:var(--faint)'>No employees yet</div></div>";
    return "<div class='dash-group'><h3>"+esc(title)+"</h3>"+
      keys.map(function(k){ return "<div class='dash-row'><span>"+esc(k)+"</span><b>"+obj[k]+"</b></div>"; }).join("")+"</div>";
  }
  grp.innerHTML = grpHtml("By Category", s.byCategory) + grpHtml("By Trade", s.byTrade);
}

/* ================= AUTH ================= */
function tab(m){ MODE=m;
  el("tIn").className=(m==="in")?"on":""; el("tUp").className=(m==="up")?"on":"";
  el("upFields").classList.toggle("open", m==="up");
}
function go(){
  var u=el("sUser").value,p=el("sPass").value;
  if(MODE==="up"){
    callApi("signUp",[el("sName").value,u,p,el("sInvite").value]).then(function(r){
      show("aMsg",r.msg); if(r.ok){ tab("in"); toast("Account created - sign in","ok"); }
    }).catch(fail);
  } else {
    callApi("signIn",[u,p]).then(function(r){
      if(r.ok){ TOKEN=r.token; LUSER=r.username||u;
        localStorage.setItem("ams_token",TOKEN); localStorage.setItem("ams_user",LUSER); enter(); }
      else show("aMsg",r.msg);
    }).catch(fail);
  }
}
function enter(){
  el("auth").style.display="none"; el("grid").style.display="block";
  show("who", LUSER); el("av").textContent=(LUSER||"?").charAt(0).toUpperCase();
  fillCategories(); fillTrades();
  renderSkeleton();
  load();
  callApi("healthCheck",[]).then(function(h){ if(h && !h.ok){ toast(h.error,"err"); } });
}
function resetToLogin(){
  TOKEN=""; LUSER=""; G=null; ERR_SHOWN=false;
  el("grid").style.display="none"; el("auth").style.display="flex";
  el("sPass").value=""; show("aMsg",""); tab("in");
}
function backToLogin(){ localStorage.removeItem("ams_token"); localStorage.removeItem("ams_user"); resetToLogin(); }
function out(){
  callApi("signOut",[TOKEN]);
  localStorage.removeItem("ams_token"); localStorage.removeItem("ams_user");
  resetToLogin();
  toast("Signed out","ok");
}
function load(){ callApi("loadGrid",[TOKEN]).then(render).catch(fail); }

/* ================= CATEGORY / TRADE DROPDOWNS ================= */
function fillCategories(){
  var sel=el("fCategory"), cur=sel.value; sel.innerHTML="";
  ((G&&G.categories)||DEF_CATEGORIES).forEach(function(c){ var o=document.createElement("option"); o.value=c; o.text=c; sel.add(o); });
  if(cur) sel.value=cur;
}
function fillTrades(){
  var category=el("fCategory").value, sel=el("fTrade"); sel.innerHTML="";
  var o0=document.createElement("option"); o0.value=""; o0.text="(no trade)"; sel.add(o0);
  (((G&&G.categoryTrades)||{})[category]||[]).forEach(function(t){ var o=document.createElement("option"); o.value=t; o.text=t; sel.add(o); });
}
function openTrade(){
  el("ovBody").innerHTML =
    "<h3>Add Trade</h3><div class='sub'>For category: " + esc(el("fCategory").value) + "</div>" +
    "<label>Trade name</label><input id='mVal' placeholder='e.g. STATIC FITTER'>" +
    "<button class='btn' onclick='submitTrade()'>Save Trade</button>" +
    "<button class='btn ghost' onclick='closeModal()'>Cancel</button>";
  el("ov").className="overlay on";
}
function submitTrade(){
  var v=el("mVal").value;
  callApi("addCategoryTrade",[TOKEN, el("fCategory").value, v]).then(function(r){
    if(r.ok){ G=G||{}; G.categoryTrades=r.categoryTrades; fillTrades(); el("fTrade").value=v; closeModal(); toast("Trade added","ok"); }
    else toast(r.msg,"err");
  }).catch(fail);
}

/* ================= TABLE RENDER ================= */
function buildThead(headers, trainings){
  var row="<tr>";
  headers.forEach(function(h){
    var label=(h==="Approved By")?"Verified By":esc(h);
    if(h==="Training Dates"){ row+="<th>"+label+"</th>"; return; }
    var arrow = (SORT_COL===h) ? (SORT_DIR==="asc" ? " &#9650;" : " &#9660;") : "";
    row+="<th class='sortable' onclick='sortBy(&quot;"+h+"&quot;)' title='Click to sort'>"+label+arrow+"</th>";
  });
  row+="<th>Actions</th>";
  return "<thead>"+row+"</tr></thead>";
}
function sortBy(col){
  if(SORT_COL===col){ SORT_DIR = (SORT_DIR==="asc") ? "desc" : "asc"; }
  else { SORT_COL=col; SORT_DIR="asc"; }
  if(G) render(G);
}
function sortRows(rows){
  if(!SORT_COL) return rows;
  var col=SORT_COL, dir=SORT_DIR;
  return rows.slice().sort(function(a,b){
    var av=String(a[col]||"").toLowerCase(), bv=String(b[col]||"").toLowerCase();
    if(av<bv) return dir==="asc" ? -1 : 1;
    if(av>bv) return dir==="asc" ? 1 : -1;
    return 0;
  });
}
function emptyRow(cols){
  return "<tr><td colspan='"+cols+"'><div class='empty'>" +
    "<div class='eicon'><svg width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><rect x='3' y='4' width='18' height='16' rx='2'/><line x1='3' y1='10' x2='21' y2='10'/><line x1='9' y1='4' x2='9' y2='20'/><line x1='15' y1='4' x2='15' y2='20'/></svg></div>" +
    "<div class='etitle'>No workers yet</div>" +
    "<div class='esub'>All columns are ready - add your first worker above to begin.</div>" +
    "</div></td></tr>";
}
function renderSkeleton(){
  el("tbl").innerHTML=buildThead(buildVisibleHeaders(DEF_HEADERS,DEF_TRAININGS),DEF_TRAININGS)+"<tbody>"+emptyRow(DEF_HEADERS.length+1)+"</tbody>";
  el("counts").textContent="0 workers  ·  0 completed";
}

function cell(hname, val, r, trs){
  if(hname==="Approved By") return "<td data-col='"+hname+"' class='veil'>"+esc(val||"-")+"</td>";
  if(hname==="Aadhar Number") return "<td data-col='"+hname+"' class='aadhar editable' ondblclick='editText("+r.rn+",&quot;"+hname+"&quot;,&quot;"+esc(val||"")+"&quot;)'>"+fmtAadhar(val)+"</td>";
  if(hname==="Name") return "<td data-col='"+hname+"' class='nm editable' ondblclick='editText("+r.rn+",&quot;"+hname+"&quot;,&quot;"+esc(val||"")+"&quot;)'>"+esc(val||"")+"</td>";
  if(hname==="Category"){
    var cats=(G&&G.categories)||DEF_CATEGORIES; var ci=cats.indexOf(val);
    return "<td data-col='"+hname+"' class='editable' ondblclick='editSelect("+r.rn+",&quot;Category&quot;,&quot;"+esc(val||"")+"&quot;)'><span class='tag'><span class='dot "+TCLASS[ci<0?0:ci%4]+"'></span>"+esc(val||"-")+"</span></td>";
  }
  if(hname==="Trade") return "<td data-col='"+hname+"' class='editable' ondblclick='editSelect("+r.rn+",&quot;Trade&quot;,&quot;"+esc(val||"")+"&quot;)'><span class='chip'>"+(val?esc(val):"-")+"</span></td>";
  if(hname==="Assessment Date") return "<td data-col='"+hname+"' class='editable dateval' onclick='editDate("+r.rn+",&quot;"+hname+"&quot;,&quot;"+(val||"")+"&quot;)'>"+(val?fmtDate(val):"-")+"</td>";
  if(hname==="Remarks") return "<td data-col='"+hname+"' class='editable remark' ondblclick='editText("+r.rn+",&quot;"+hname+"&quot;,&quot;"+esc(val||"")+"&quot;)'>"+esc(val||"-")+"</td>";
  if(trs.indexOf(hname)!==-1){
    if(val) return "<td data-col='"+hname+"' class='editable dateval' onclick='editDate("+r.rn+",&quot;"+hname+"&quot;,&quot;"+val+"&quot;)'>"+fmtDate(val)+"<span class='clear-x' onclick='event.stopPropagation();clearCell("+r.rn+",&quot;"+hname+"&quot;)'>&times;</span></td>";
    return "<td data-col='"+hname+"' class='editable' onclick='editDate("+r.rn+",&quot;"+hname+"&quot;,&quot;&quot;)'>+ date</td>";
  }
  if(hname==="Final Check"){ var c=isComplete(r["Final Check"]); return "<td data-col='Final Check'><span class='check "+(c?"on":"")+"' onclick='toggleFinal("+r.rn+")'></span></td>"; }
  return "<td data-col='"+hname+"'>"+esc(val||"")+"</td>";
}
function actionsCell(r, trs){
  var complete=isComplete(r["Final Check"]);
  var allDated=trs.every(function(t){ return !!r[t]; });
  var pill=complete?"":(allDated?"<span class='pill ready'>Ready</span>":"<span class='pill wait'>In progress</span>");
  return "<td data-col='__act'>"+pill+" <button class='del' onclick='del("+r.rn+")'>Delete</button></td>";
}

function render(g){
  if(!g.auth){ backToLogin(); return; }
  G=g;
  show("who",g.veiled); el("av").textContent=(g.veiled||"?").charAt(0);
  fillCategories(); fillTrades(); fillFilterOptions();
  if(g.error){
    el("counts").innerHTML="<span class='err'>Sheet problem: "+esc(g.error)+"</span>";
    if(!ERR_SHOWN){ ERR_SHOWN=true; toast("Sheet problem: "+g.error,"err"); }
  }
  try{ renderDashboard(g); }catch(e){ var db=el("dashStats"); if(db) db.innerHTML="<div style='color:var(--danger);font-size:12px'>Dashboard failed to render: "+esc(e.message)+"</div>"; }
  var headers=buildVisibleHeaders(g.headers||[], g.trainings||[]);
  var trs=g.trainings||[];
  var rows=sortRows(applyFilters(g.rows||[], trs));
  var html=buildThead(headers,trs)+"<tbody>";
  if(!rows.length){ html+=emptyRow(headers.length+1); }
  else{
    rows.forEach(function(r){
      try{
        var complete=isComplete(r["Final Check"]);
        var cells="";
        for(var j=0;j<headers.length;j++){ cells+=cell(headers[j], r[headers[j]], r, trs); }
        html+="<tr data-rn='"+r.rn+"' class='"+(complete?"done":"")+"'>"+cells+actionsCell(r,trs)+"</tr>";
      }catch(e){ html+="<tr><td colspan='"+(headers.length+1)+"' style='color:#dc2626'>Row error: "+e.message+"</td></tr>"; }
    });
  }
  html+="</tbody>";
  el("tbl").innerHTML=html;
  updateCounts();
}
function updateCounts(){
  if(!G || !G.rows){ return; }
  var n=G.rows.length, done=G.rows.filter(function(r){ return isComplete(r["Final Check"]); }).length;
  if(!el("counts").querySelector(".err")) el("counts").textContent=n+" worker"+(n===1?"":"s")+"  ·  "+done+" completed";
}
function rowObj(rn){ if(!G||!G.rows) return null; for(var i=0;i<G.rows.length;i++){ if(G.rows[i].rn===rn) return G.rows[i]; } return null; }

/* ================= ROW ACTIONS (optimistic UI) ================= */
function toggleFinal(rn){
  var r=rowObj(rn); if(!r) return;
  var old=r["Final Check"], next=isComplete(old) ? "" : "Complete";
  r["Final Check"]=next; render(G); /* instant */
  callApi("toggleFinal",[TOKEN,rn,next]).then(function(res){
    if(res && !res.ok){ r["Final Check"]=old; render(G); toast(res.msg,"err"); }
  }).catch(function(e){ r["Final Check"]=old; render(G); fail(e); });
}
function del(rn){
  askConfirm("Delete this employee's record?", function(){
    if(!G||!G.rows) return;
    var idx=-1; for(var i=0;i<G.rows.length;i++){ if(G.rows[i].rn===rn) idx=i; }
    if(idx<0) return;
    var old=G.rows[idx];
    G.rows.splice(idx,1); render(G); /* instant */
    callApi("deleteRow",[TOKEN,rn]).then(function(res){
      if(res && !res.ok){ G.rows.splice(idx,0,old); render(G); toast(res.msg,"err"); }
      else toast("Row deleted","ok","Undo",function(){ restoreEmployee(rn); });
    }).catch(function(e){ G.rows.splice(idx,0,old); render(G); fail(e); });
  });
}
function clearCell(rn,col){
  askConfirm("Clear this value?", function(){ editLocal(rn,col,""); });
}
function editLocal(rn,col,newVal){
  var r=rowObj(rn); if(!r) return;
  var old=r[col];
  r[col]=newVal; closeModal(); render(G); /* instant */
  callApi("setCell",[TOKEN,rn,col,newVal]).then(function(res){
    if(res && !res.ok){ r[col]=old; render(G); toast(res.msg,"err"); }
  }).catch(function(e){ r[col]=old; render(G); fail(e); });
}
function submitDate(rn,col){ editLocal(rn,col,el("mVal").value); }
function submitText(rn,col){
  var v=el("mVal").value;
  if(col==="Aadhar Number") v=v.replace(/\D/g,"").slice(0,12);
  editLocal(rn,col,v);
}

function editDate(rn,col,cur){
  el("ovBody").innerHTML="<h3>Set "+esc(col)+"</h3><div class='sub'>Pick a date from the calendar</div>" +
    "<label>Date</label><input id='mVal' type='date' value='"+esc(cur)+"'>" +
    "<button class='btn' onclick='submitDate("+rn+",&quot;"+col+"&quot;)'>Save</button>" +
    (cur ? "<button class='btn ghost' onclick='clearCell("+rn+",&quot;"+col+"&quot;);closeModal()'>Clear date</button>" : "") +
    "<button class='btn ghost' onclick='closeModal()'>Cancel</button>";
  el("ov").className="overlay on";
}
function editText(rn,col,cur){
  var isA = col==="Aadhar Number";
  var fmtAttr = isA ? " oninput='this.value=aadharFormat(this.value)'" : "";
  var val = isA ? fmtAadhar(cur) : cur;
  el("ovBody").innerHTML="<h3>Edit "+esc(col)+"</h3>" +
    "<label>"+esc(col)+"</label><input id='mVal' value='"+esc(val)+"'"+fmtAttr+(isA?" inputmode='numeric' placeholder='1234 5678 9012'":"")+">" +
    "<button class='btn' onclick='submitText("+rn+",&quot;"+col+"&quot;)'>Save</button>" +
    "<button class='btn ghost' onclick='closeModal()'>Cancel</button>";
  el("ov").className="overlay on";
}
/* Category/Trade inline edit — reuses the same modal pattern as editDate/editText */
function editSelect(rn,col,cur){
  var opts;
  if(col==="Category"){ opts=(G&&G.categories)||DEF_CATEGORIES; }
  else {
    var category=(function(){ for(var i=0;i<(G.rows||[]).length;i++){ if(G.rows[i].rn===rn) return G.rows[i].Category; } return ""; })();
    opts=(((G&&G.categoryTrades)||{})[category]||[]);
  }
  var optHtml="<option value=''>(none)</option>"+opts.map(function(o){
    return "<option value='"+esc(o)+"'"+(o===cur?" selected":"")+">"+esc(o)+"</option>";
  }).join("");
  el("ovBody").innerHTML="<h3>Edit "+esc(col)+"</h3><label>"+esc(col)+"</label><select id='mVal'>"+optHtml+"</select>"+
    "<button class='btn' onclick='submitText("+rn+",&quot;"+col+"&quot;)'>Save</button>"+
    "<button class='btn ghost' onclick='closeModal()'>Cancel</button>";
  el("ov").className="overlay on";
}
function closeModal(){ el("ov").className="overlay"; }
function askConfirm(msg,cb){ el("cMsg").textContent=msg; CONFIRM_CB=cb; el("cov").className="overlay on"; }
function doConfirm(){ if(CONFIRM_CB) CONFIRM_CB(); closeConfirm(); }
function closeConfirm(){ el("cov").className="overlay"; CONFIRM_CB=null; }

/* ================= ADD WORKER ================= */
function add(){
  var data={ aadhar:el("fAadhar").value, name:el("fName").value, category:el("fCategory").value,
             trade:el("fTrade").value, assess:el("fAssess").value };
  busyOn();
  callApi("addRow",[TOKEN,data]).then(function(r){
    busyOff();
    if(r.ok){ show("fMsg",""); el("fAadhar").value=""; el("fName").value=""; el("fAssess").value=""; load(); toast("Worker added","ok"); }
    else show("fMsg",r.msg);
  }).catch(function(e){ busyOff(); fail(e); });
}

/* ================= DELETED EMPLOYEES ================= */
function openDeleted(){
  el("ovBody").innerHTML="<h3>Deleted Employees</h3><div class='sub' id='delList'>Loading...</div>"+
    "<button class='btn ghost' onclick='closeModal()'>Close</button>";
  el("ov").className="overlay on";
  callApi("listDeleted",[TOKEN]).then(function(res){
    var box=el("delList"); if(!box) return;
    if(!res.ok){ box.textContent=res.msg; return; }
    if(!res.rows.length){ box.textContent="No deleted employees."; return; }
    box.innerHTML=res.rows.map(function(r){
      return "<div style='display:flex;justify-content:space-between;align-items:center;padding:6px 0'>"+
        "<span><b>"+esc(r.code)+"</b> - "+esc(r.name)+"</span>"+
        "<button class='btn small' onclick='restoreEmployee("+r.rn+")'>Restore</button></div>";
    }).join("");
  }).catch(fail);
}
function restoreEmployee(rn){
  callApi("restoreRow",[TOKEN,rn]).then(function(res){
    if(res.ok){ toast("Restored","ok"); closeModal(); load(); } else toast(res.msg,"err");
  }).catch(fail);
}

/* ================= INVITE ADMIN ================= */
function openInvite(){
  callApi("generateInviteCode",[TOKEN]).then(function(res){
    if(!res.ok){ toast(res.msg,"err"); return; }
    el("ovBody").innerHTML="<h3>Invite Code</h3><div class='sub'>Valid 24 hours, single use. Share it with the new admin.</div>"+
      "<input readonly value='"+esc(res.code)+"' style='font-weight:800;letter-spacing:2px;text-align:center'>"+
      "<button class='btn ghost' onclick='closeModal()'>Close</button>";
    el("ov").className="overlay on";
  }).catch(fail);
}

/* ================= CSV EXPORT / PRINT ================= */
function csvEscape(v){
  var s=String(v==null?"":v);
  if(/[",\n]/.test(s)) s='"'+s.replace(/"/g,'""')+'"';
  return s;
}
function exportCSV(){
  if(!G){ toast("No data loaded yet","err"); return; }
  var headers=(G.headers||[]).filter(function(h){ return h!=="Status"; });
  var rows=sortRows(applyFilters(G.rows||[], G.trainings||[]));
  var lines=[headers.map(csvEscape).join(",")];
  rows.forEach(function(r){
    lines.push(headers.map(function(h){ return csvEscape(r[h]); }).join(","));
  });
  var csv=lines.join("\r\n");
  var blob=new Blob([csv], {type:"text/csv;charset=utf-8;"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url; a.download="attendance_export_"+(new Date().toISOString().slice(0,10))+".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("CSV downloaded ("+rows.length+" rows) - opens directly in Excel","ok");
}
function printTable(){ window.print(); }

/* ================= BULK IMPORT (CSV / Excel) ================= */
function pad(n){ return (n<10?"0":"")+n; }
function clean(v){ return v===null||v===undefined ? "" : String(v).trim(); }
function cleanAadhar(v){
  var s=clean(v); if(!s) return "";
  var low=s.toLowerCase();
  if(low.indexOf("e+")!==-1 || low.indexOf("e-")!==-1){ var n=Number(s); if(!isNaN(n)) s=String(n); }
  else if(s.indexOf(".")!==-1 && !isNaN(Number(s))){ s=s.split(".")[0]; }
  return s.replace(/[^0-9]/g,"");
}
function fixDate(v){
  if(v===null||v===undefined||v==="") return "";
  if(typeof v==="number" && v>20000 && v<80000){
    var ed=new Date(Math.round((v-25569)*86400*1000));
    return ed.getUTCFullYear()+"-"+pad(ed.getUTCMonth()+1)+"-"+pad(ed.getUTCDate());
  }
  var s=String(v).trim(); if(!s) return "";
  if(s.length>=10 && s.charAt(4)==="-" && s.charAt(7)==="-") return s.substring(0,10);
  var d=new Date(s);
  if(Object.prototype.toString.call(d)==="[object Date]" && !isNaN(d.getTime())) return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
  return s;
}
function parseCSV(text){
  var rows=[], row=[], cur="", inQ=false;
  var NL=String.fromCharCode(10), CR=String.fromCharCode(13);
  for(var i=0;i<text.length;i++){
    var c=text.charAt(i);
    if(inQ){
      if(c==='"'){ if(text.charAt(i+1)==='"'){ cur+='"'; i++; } else { inQ=false; } }
      else cur+=c;
    } else {
      if(c==='"') inQ=true;
      else if(c===','){ row.push(cur); cur=""; }
      else if(c===NL){ row.push(cur); rows.push(row); row=[]; cur=""; }
      else if(c===CR){ /* ignore */ }
      else cur+=c;
    }
  }
  if(cur!=="" || row.length){ row.push(cur); rows.push(row); }
  return rows;
}
function findHeaderMap(rows){
  var maxScan=Math.min(rows.length,5);
  for(var r=0;r<maxScan;r++){
    var row=rows[r]||[];
    var map={aadhar:-1,name:-1,category:-1,trade:-1,assess:-1};
    var hasAadhar=false, hasName=false;
    for(var c=0;c<row.length;c++){
      var h=clean(row[c]).toLowerCase(); if(!h) continue;
      if(h.indexOf("aadhar")!==-1 || h.indexOf("aadhaar")!==-1){ if(map.aadhar===-1){ map.aadhar=c; hasAadhar=true; } }
      else if(h==="name" || h.indexOf("employee name")!==-1 || h.indexOf("name")!==-1){ if(map.name===-1){ map.name=c; hasName=true; } }
      else if(h.indexOf("category")!==-1){ if(map.category===-1) map.category=c; }
      else if(h.indexOf("trade")!==-1){ if(map.trade===-1) map.trade=c; }
      else if(h.indexOf("assess")!==-1){ if(map.assess===-1) map.assess=c; }
      else if(h.indexOf("date")!==-1){ if(map.assess===-1) map.assess=c; }
    }
    if(hasAadhar && hasName) return {map:map, headerIndex:r};
  }
  return null;
}
function tabularRowsToObjects(rows){
  if(!rows || !rows.length) return [];
  var found=findHeaderMap(rows);
  var map, start;
  if(found){ map=found.map; start=found.headerIndex+1; }
  else { map={aadhar:0,name:1,category:2,trade:3,assess:4}; start=0; }
  var out=[];
  for(var i=start;i<rows.length;i++){
    var row=rows[i]||[];
    var empty=true;
    for(var j=0;j<row.length;j++){ if(clean(row[j])!==""){ empty=false; break; } }
    if(empty) continue;
    out.push({
      aadhar: cleanAadhar(row[map.aadhar]),
      name: clean(row[map.name]),
      category: clean(row[map.category]),
      trade: clean(row[map.trade]),
      assess: fixDate(row[map.assess])
    });
  }
  return out;
}
function showBulkResult(res){
  if(!res.ok){ toast(res.msg,"err"); return; }
  var msg="Imported "+res.added+" workers.";
  if(res.duplicates) msg+=" Duplicates: "+res.duplicates+".";
  if(res.invalid) msg+=" Invalid: "+res.invalid+".";
  if(res.errors && res.errors.length) msg+=" First issue: "+res.errors[0];
  toast(msg, res.added?"ok":"err");
  if(res.added) load();
}
function sendBulk(mapped){
  if(!mapped.length){ toast("No rows found. Use first row headers: Aadhar Number, Name, Category, Trade, Assessment Date.","err"); return; }
  if(mapped.length>10000){ toast("Too many rows. Please split into 10,000 rows or fewer.","err"); return; }
  toast("Importing "+mapped.length+" rows...","ok");
  callApi("bulkAddRows",[TOKEN,mapped]).then(showBulkResult).catch(fail);
}
function handleBulkUpload(input){
  var file=input.files && input.files[0]; if(!file) return;
  input.value="";
  var fileName=(file.name||"").toLowerCase();
  var isCsv=(file.type && file.type.indexOf("csv")!==-1) || fileName.slice(-4)===".csv";
  if(isCsv){
    toast("Parsing CSV file...","ok");
    var r=new FileReader();
    r.onload=function(e){
      try{
        var text=String(e.target.result||"");
        if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
        sendBulk(tabularRowsToObjects(parseCSV(text)));
      }catch(err){ toast("CSV parse error: "+err.message,"err"); }
    };
    r.onerror=function(){ toast("Could not read CSV file.","err"); };
    r.readAsText(file);
    return;
  }
  if(!window.XLSX){ toast("Excel parser not loaded. Please use a CSV file instead.","err"); return; }
  toast("Parsing Excel file...","ok");
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      var data=new Uint8Array(e.target.result);
      var workbook=window.XLSX.read(data,{type:"array",cellDates:true});
      var firstSheet=workbook.Sheets[workbook.SheetNames[0]];
      var rows=window.XLSX.utils.sheet_to_json(firstSheet,{header:1,defval:"",raw:true});
      sendBulk(tabularRowsToObjects(rows));
    }catch(err){ toast("Failed to parse Excel file: "+err.message,"err"); }
  };
  reader.onerror=function(){ toast("Could not read Excel file.","err"); };
  reader.readAsArrayBuffer(file);
}

/* ================= WIRE-UP ================= */
document.addEventListener("DOMContentLoaded", function(){
  el("fAadhar").addEventListener("input", function(){ this.value = aadharFormat(this.value); });
  function refreshFiltered(){ if(G) render(G); }
  ["qSearch"].forEach(function(id){ var n=el(id); if(n) n.addEventListener("input", refreshFiltered); });
  ["qCategory","qTrade","qTrain","qFinalF"].forEach(function(id){ var n=el(id); if(n) n.addEventListener("change", refreshFiltered); });

  try{ if(TOKEN){ enter(); } else { tab("in"); } }
  catch(e){ el("auth").style.display="flex"; }
});
