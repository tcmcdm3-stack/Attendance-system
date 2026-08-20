/******************************************************************
 * ATTENDANCE MANAGEMENT SYSTEM — BACKEND API
 * Serves ONLY as a JSON API for the GitHub Pages frontend.
 * No HTML is served from here anymore (see doGet/doPost below).
 ******************************************************************/
var SPREADSHEET_ID = '1Eu_gI4UxkUONNsDW-2koBBVX0XY6e9BBjW2CtJuJv64';
var SHEET_NAME   = 'Attendance';
var FINAL_CHECK  = 'Final Check';
var TRAININGS    = ['Training 1','Training 2','Training 3','Training 4','Training 5'];

// ===== NEW Category / Trade structure (replaces the old Trade/Branch pair) =====
var CATEGORIES = ['Static', 'Rotary', 'Scaffolding', 'Hot work fab', 'Torquing'];

// Seeded defaults — admins can still add more trades under any category at runtime,
// exactly like the old "+ Add Branch" flow (now "+ Add Trade").
var DEFAULT_TRADES_BY_CATEGORY = {
  'Static':        ['STATIC FITTER', 'STATIC RIGGER', 'RIGGER FOREMAN', 'STATIC SUPERVISOR'],
  'Torquing':      ['TORQUING TECHNICIAN', 'TORQUING SUPERVISOR'],
  'Hot work fab':  ['GRINDER', 'FABRICATION RIGGER', 'GAS CUTTER', 'FABRICATION SUPERVISOR', 'FABRICATION FITTER', 'FABRICATOR'],
  'Scaffolding':   ['SCAFFOLDER', 'SCAFFOLDING SUPERVISOR', 'SCAFFOLDING RIGGER'],
  'Rotary':        ['ROTARY RIGGER', 'MILLWRIGHT TECHNICIAN', 'ROTARY SUPERVISOR']
};

var BASE_HEADERS = ['Approved By', 'Aadhar Number', 'Employee Code', 'Name', 'Category', 'Trade', 'Assessment Date']
                    .concat(TRAININGS).concat([FINAL_CHECK, 'Remarks', 'Status']);

var EDITABLE = ['Name', 'Aadhar Number', 'Assessment Date', 'Remarks', 'Category', 'Trade'].concat(TRAININGS);

var GREEN = '#e8f8ee';

/* ================= API ROUTER =================
 * The frontend calls this as:
 *   fetch(API_URL, { method:'POST',
 *                     headers:{'Content-Type':'text/plain;charset=utf-8'},  // avoids CORS preflight
 *                     body: JSON.stringify({action:'signIn', payload:[username,password]}) })
 * "payload" is an array of positional arguments for the target function.
 * doGet supports the same actions via ?action=...&payload=<url-encoded-json-array> for quick testing.
 */
var API_ACTIONS = {
  healthCheck: healthCheck,
  signUp: signUp,
  signIn: signIn,
  signOut: signOut,
  generateInviteCode: generateInviteCode,
  loadGrid: loadGrid,
  hardRefreshGrid: hardRefreshGrid,
  addCategoryTrade: addCategoryTrade,
  addRow: addRow,
  setCell: setCell,
  toggleFinal: toggleFinal,
  deleteRow: deleteRow,
  restoreRow: restoreRow,
  listDeleted: listDeleted,
  bulkAddRows: bulkAddRows
};

function _dispatch(action, payload){
  var fn = API_ACTIONS[action];
  if(!fn) return {ok:false, msg:'Unknown action: ' + action};
  payload = payload || [];
  try{
    return fn.apply(null, payload);
  }catch(e){
    return {ok:false, msg:'Server error: ' + String(e && e.message ? e.message : e)};
  }
}

function _output(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e){
  var action = e && e.parameter && e.parameter.action;
  if(!action) return _output({ok:true, msg:'Attendance Management System API is running.'});
  var payload = [];
  if(e.parameter.payload){
    try{ payload = JSON.parse(e.parameter.payload); }catch(err){ /* ignore, use [] */ }
  }
  return _output(_dispatch(action, payload));
}

function doPost(e){
  var body = {};
  try{ body = JSON.parse(e.postData.contents || '{}'); }catch(err){ /* ignore, use {} */ }
  return _output(_dispatch(body.action, body.payload));
}

/* ================= USERS / SESSIONS ================= */
function _props(){ return PropertiesService.getScriptProperties(); }
function _getUsers(){ return JSON.parse(_props().getProperty('USERS') || '{}'); }
function _setUsers(u){ _props().setProperty('USERS', JSON.stringify(u)); }
function _getSessions(){ return JSON.parse(_props().getProperty('SESSIONS') || '{}'); }
function _setSessions(s){ _props().setProperty('SESSIONS', JSON.stringify(s)); }

/* Category -> [Trade,...] map, seeded with defaults on first use */
function _getCategoryTrades(){
  var raw = _props().getProperty('CATEGORY_TRADES');
  if(!raw){
    _setCategoryTrades(DEFAULT_TRADES_BY_CATEGORY);
    return JSON.parse(JSON.stringify(DEFAULT_TRADES_BY_CATEGORY));
  }
  var parsed = JSON.parse(raw);
  // fill in any category missing entirely (e.g. after an upgrade) with its defaults
  CATEGORIES.forEach(function(c){ if(!parsed[c]) parsed[c] = (DEFAULT_TRADES_BY_CATEGORY[c] || []).slice(); });
  return parsed;
}
function _setCategoryTrades(m){ _props().setProperty('CATEGORY_TRADES', JSON.stringify(m)); }

/* ---- password hashing (SHA-256 + per-user salt) ---- */
function _makeSalt(){ return Utilities.getUuid(); }
function _hashPassword(password, salt){
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password) + String(salt));
  return raw.map(function(b){ var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}

/* ---- admin invite gate: first admin is free, every admin after that needs a one-time invite code ---- */
function _getInvites(){ return JSON.parse(_props().getProperty('INVITES') || '{}'); }
function _setInvites(i){ _props().setProperty('INVITES', JSON.stringify(i)); }
function generateInviteCode(token){
  if(!_adminName(token)) return {ok:false, msg:'Session expired.'};
  var code = Utilities.getUuid().split('-')[0].toUpperCase();
  var inv = _getInvites();
  inv[code] = {createdBy:_adminUsername(token), t:Date.now() + 24 * 60 * 60 * 1000, used:false};
  _setInvites(inv);
  return {ok:true, code:code};
}

function signUp(name, username, password, invite){
  name = String(name || '').trim(); username = String(username || '').trim().toLowerCase(); password = String(password || '');
  if(!name || !username || password.length < 4) return {ok:false, msg:'Fill all fields (password 4+ chars).'};
  if(!/^[a-z0-9_.]{3,20}$/.test(username)) return {ok:false, msg:'Username: 3-20 chars, letters/numbers/._ only.'};
  var u = _getUsers();
  if(u[username]) return {ok:false, msg:'That username is taken. Please sign in.'};
  var isFirst = Object.keys(u).length === 0;
  if(!isFirst){
    invite = String(invite || '').trim().toUpperCase();
    var inv = _getInvites();
    var rec = inv[invite];
    if(!rec || rec.used || Date.now() > rec.t) return {ok:false, msg:'Valid invite code required from an existing admin.'};
    rec.used = true; _setInvites(inv);
  }
  var salt = _makeSalt();
  u[username] = {name:name, salt:salt, hash:_hashPassword(password, salt)}; _setUsers(u);
  return {ok:true, msg:'Account created. You can sign in now.'};
}

function signIn(username, password){
  username = String(username || '').trim().toLowerCase();
  var u = _getUsers(); var a = u[username];
  if(!a) return {ok:false, msg:'Incorrect username or password.'};
  var okPass = false;
  if(a.hash){ okPass = (a.hash === _hashPassword(password, a.salt)); }
  else if(a.pass !== undefined){ // legacy plaintext account - verify then upgrade transparently
    okPass = (a.pass === password);
    if(okPass){ var salt = _makeSalt(); a.salt = salt; a.hash = _hashPassword(password, salt); delete a.pass; _setUsers(u); }
  }
  if(!okPass) return {ok:false, msg:'Incorrect username or password.'};
  var token = Utilities.getUuid();
  var s = _getSessions(); s[token] = {u:username, t:Date.now() + 8 * 60 * 60 * 1000}; _setSessions(s);
  return {ok:true, token:token, username:username};
}
function _adminUsername(t){ var s = _getSessions(); var x = s[t || '']; if(!x || Date.now() > x.t) return null; return x.u; }
function _adminName(t){ var un = _adminUsername(t); if(!un) return null; return (_getUsers()[un] || {}).name || un; }
function signOut(t){ var s = _getSessions(); delete s[t || '']; _setSessions(s); return {ok:true}; }
function veil(n){
  return String(n || '').trim().split(/\s+/).filter(String).map(function(w){
    return w.charAt(0).toUpperCase() + Array(w.length).join('*');
  }).join(' ');
}
/*** BACKEND-ONLY rename — run from the Apps Script editor. No UI for this. ***/
function backendRenameAdmin(username, newName){
  var u = _getUsers(); username = String(username).trim().toLowerCase();
  if(!u[username]) throw 'Admin not found: ' + username;
  u[username].name = String(newName); _setUsers(u);
}

/* ================= SHEET (auto-migration) ================= */
function _sheet(){
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if(!sh){
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(BASE_HEADERS);
    sh.getRange(1, 1, 1, BASE_HEADERS.length).setFontWeight('bold').setBackground('#dddddd');
    sh.setFrozenRows(1);
  }
  var h = _headers(sh);
  // legacy sheets may still have 'Trade'/'Branch' headers — relabel in place, values are preserved
  if(h.indexOf('Category') === -1 && h.indexOf('Trade') !== -1 && h.indexOf('Branch') !== -1){
    sh.getRange(1, h.indexOf('Trade') + 1).setValue('Category');
    sh.getRange(1, h.indexOf('Branch') + 1).setValue('Trade');
    h = _headers(sh);
  }
  if(h.indexOf('Category') === -1){
    sh.insertColumnBefore(1); // placeholder position, will just append below if truly missing
    sh.deleteColumn(1);
  }
  if(h.indexOf('Trade') === -1 && h.indexOf('Category') !== -1){
    var p = h.indexOf('Category') + 2; sh.insertColumnBefore(p);
    sh.getRange(1, p).setValue('Trade').setFontWeight('bold').setBackground('#dddddd');
    h = _headers(sh);
  }
  if(h.indexOf('Remarks') === -1){
    var fc = h.indexOf(FINAL_CHECK);
    var pos = fc >= 0 ? fc + 2 : h.length + 1;
    sh.insertColumnAfter(pos - 1);
    sh.getRange(1, pos).setValue('Remarks').setFontWeight('bold').setBackground('#dddddd');
    h = _headers(sh);
  }
  if(h.indexOf('Status') === -1){
    sh.insertColumnAfter(h.length);
    sh.getRange(1, h.length + 1).setValue('Status').setFontWeight('bold').setBackground('#dddddd');
    h = _headers(sh);
  }
  if(h.indexOf('Employee Code') === -1 && h.indexOf('Name') !== -1){
    var npos = h.indexOf('Name') + 1; sh.insertColumnBefore(npos);
    sh.getRange(1, npos).setValue('Employee Code').setFontWeight('bold').setBackground('#dddddd');
    h = _headers(sh);
    _backfillEmployeeCodes(sh, h);
  }
  return sh;
}
function _headers(sh){ return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String); }
function _cleanAadhar(v){ return String(v || '').replace(/\D/g, '').slice(0, 12); }
function _maskAadhar(v){ var d = _cleanAadhar(v); return d.length === 12 ? 'XXXX XXXX ' + d.slice(8) : d; }
function _colIndexCI(h, name){
  var target = String(name || '').trim().toLowerCase();
  for(var i = 0; i < h.length; i++){ if(String(h[i] || '').trim().toLowerCase() === target) return i; }
  return -1;
}
function _isCompleteValue(v){
  if(v === true) return true;
  var s = String(v || '').trim().toLowerCase();
  return (s === 'complete' || s === 'completed' || s === 'true' || s === 'yes' || s === '1' || s === 'done' || s === 'x' || s === '\u2713' || s === '\u2714');
}
function _normHeaderName(x){
  var s = String(x || '').trim().toLowerCase();
  if(s === 'approved by') return 'Approved By';
  if(s === 'aadhar number' || s === 'aadhaar number') return 'Aadhar Number';
  if(s === 'employee code') return 'Employee Code';
  if(s === 'name') return 'Name';
  if(s === 'category') return 'Category';
  if(s === 'trade') return 'Trade';
  if(s === 'assessment date') return 'Assessment Date';
  if(s === 'final check') return 'Final Check';
  if(s === 'remarks') return 'Remarks';
  if(s === 'status') return 'Status';
  return String(x || '').trim();
}

/* ================= AUDIT LOG ================= */
function _auditSheet(){
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName('AuditLog');
  if(!sh){
    sh = ss.insertSheet('AuditLog');
    sh.appendRow(['Timestamp', 'Admin', 'Action', 'Employee Code', 'Employee Name', 'Field', 'Old Value', 'New Value']);
    sh.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#dddddd');
    sh.setFrozenRows(1);
  }
  return sh;
}
function _auditLog(admin, action, empCode, empName, field, oldV, newV){
  try{
    _auditSheet().appendRow([new Date(), admin || '', action || '', empCode || '', empName || '', field || '', oldV || '', newV || '']);
  }catch(e){ /* never let logging break the primary action */ }
}

/* ================= EMPLOYEE CODE =================
 * FIRST 3 LETTERS OF NAME + FIRST 4 DIGITS OF AADHAAR. Server-side only,
 * never regenerated on edit. Collisions get a deterministic -01, -02...
 * suffix. LockService serializes concurrent generation; CacheService
 * gives near-O(1) lookups without a full-column read on every add. */
function _genEmployeeCode(name, aadhar){
  var letters = String(name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  while(letters.length < 3) letters += 'X';
  var digits = _cleanAadhar(aadhar).slice(0, 4);
  while(digits.length < 4) digits += '0';
  return letters + digits;
}
function _codeMapGet(){ try{ var r = CacheService.getScriptCache().get('EMP_CODE_MAP'); return r ? JSON.parse(r) : null; }catch(e){ return null; } }
function _codeMapSet(m){ try{ CacheService.getScriptCache().put('EMP_CODE_MAP', JSON.stringify(m), 21600); }catch(e){} }
function _codeMapClear(){ try{ CacheService.getScriptCache().remove('EMP_CODE_MAP'); }catch(e){} }
function _buildCodeMap(sh, h){
  var map = {};
  var last = sh.getLastRow();
  var ecIdx = h.indexOf('Employee Code');
  if(last > 1 && ecIdx >= 0){
    var vals = sh.getRange(2, ecIdx + 1, last - 1, 1).getValues();
    vals.forEach(function(r){ var c = String(r[0] || ''); if(c) map[c] = true; });
  }
  _codeMapSet(map);
  return map;
}
function _assignEmployeeCode(sh, h, name, aadhar){
  var base = _genEmployeeCode(name, aadhar);
  var map = _codeMapGet();
  if(!map) map = _buildCodeMap(sh, h);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    map = _codeMapGet() || _buildCodeMap(sh, h);
    var code = base, n = 1;
    while(map[code]){ code = base + '-' + (n < 10 ? '0' + n : n); n++; }
    map[code] = true; _codeMapSet(map);
    return code;
  } finally { lock.releaseLock(); }
}
function _backfillEmployeeCodes(sh, h){
  var last = sh.getLastRow();
  if(last < 2) return;
  var nmIdx = h.indexOf('Name'), aaIdx = h.indexOf('Aadhar Number'), ecIdx = h.indexOf('Employee Code');
  if(nmIdx < 0 || aaIdx < 0 || ecIdx < 0) return;
  var vals = sh.getRange(2, 1, last - 1, h.length).getValues();
  var used = {};
  for(var i = 0; i < vals.length; i++){
    if(vals[i][ecIdx]) { used[String(vals[i][ecIdx])] = true; continue; }
    var base = _genEmployeeCode(vals[i][nmIdx], vals[i][aaIdx]);
    var code = base, n = 1;
    while(used[code]){ code = base + '-' + (n < 10 ? '0' + n : n); n++; }
    used[code] = true;
    vals[i][ecIdx] = code;
  }
  sh.getRange(2, 1, last - 1, h.length).setValues(vals);
  _codeMapClear();
}
function _findAadharRow(sh, h, aadhar){
  var last = sh.getLastRow();
  var ai = h.indexOf('Aadhar Number'), si = h.indexOf('Status');
  if(last < 2 || ai < 0) return -1;
  var vals = sh.getRange(2, 1, last - 1, h.length).getValues();
  for(var i = 0; i < vals.length; i++){
    if(si >= 0 && String(vals[i][si] || '') === 'DELETED') continue;
    if(_cleanAadhar(vals[i][ai]) === aadhar) return i + 2;
  }
  return -1;
}

/* ================= GRID API ================= */
function loadGrid(token){
  var name = _adminName(token);
  if(!name) return {auth:false};
  var out = {
    auth:true, veiled:veil(name), headers:BASE_HEADERS, rows:[],
    trainings:TRAININGS, categories:CATEGORIES, categoryTrades:_getCategoryTrades(), error:''
  };
  try{
    var sh = _sheet(), h = _headers(sh), last = sh.getLastRow();
    var hOut = h.map(_normHeaderName);
    var fi = _colIndexCI(h, FINAL_CHECK);
    var si = _colIndexCI(h, 'Status');
    if(last > 1){
      var vals = sh.getRange(2, 1, last - 1, h.length).getValues();
      for(var i = 0; i < vals.length; i++){
        var statusVal = si >= 0 ? String(vals[i][si] || '').trim().toUpperCase() : '';
        if(statusVal === 'DELETED') continue;
        var o = {rn:i + 2};
        for(var j = 0; j < h.length; j++){
          var v = vals[i][j];
          if(v instanceof Date){ v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
          o[hOut[j]] = (v === null || v === undefined) ? '' : String(v);
        }
        o['Approved By'] = veil(o['Approved By']);
        var fcRaw = fi >= 0 ? vals[i][fi] : o[FINAL_CHECK];
        o[FINAL_CHECK] = _isCompleteValue(fcRaw) ? 'Complete' : '';
        if(si >= 0) o['Status'] = statusVal;
        out.rows.push(o);
      }
    }
    out.headers = hOut;
  }catch(e){ out.error = String(e && e.message ? e.message : e); }
  return out;
}
function hardRefreshGrid(token){
  _codeMapClear();
  return loadGrid(token);
}

function addCategoryTrade(token, category, tradeName){
  if(!_adminName(token)) return {ok:false, msg:'Session expired.'};
  if(CATEGORIES.indexOf(category) === -1) return {ok:false, msg:'Select a category first.'};
  tradeName = String(tradeName || '').trim();
  if(!tradeName) return {ok:false, msg:'Trade name required.'};
  var m = _getCategoryTrades(); var list = m[category] || [];
  var dup = list.some(function(x){ return x.toLowerCase() === tradeName.toLowerCase(); });
  if(dup) return {ok:false, msg:'Trade already exists under this category.'};
  list.push(tradeName); m[category] = list; _setCategoryTrades(m);
  return {ok:true, categoryTrades:m};
}

function addRow(token, data){
  var admin = _adminName(token); if(!admin) return {ok:false, msg:'Session expired.'};
  try{
    var aadhar = _cleanAadhar(data.aadhar), name = String(data.name || '').trim();
    var category = String(data.category || '').trim(), trade = String(data.trade || '').trim();
    var assess = String(data.assess || '').trim();
    if(!aadhar || !name) return {ok:false, msg:'Aadhar number and name are required.'};
    if(!/^\d{12}$/.test(aadhar)) return {ok:false, msg:'Aadhar must be exactly 12 digits.'};
    if(CATEGORIES.indexOf(category) === -1) return {ok:false, msg:'Select a valid category.'};
    if(trade){
      var list = (_getCategoryTrades()[category] || []);
      if(!list.some(function(x){ return x.toLowerCase() === trade.toLowerCase(); }))
        return {ok:false, msg:'Trade does not belong to this category.'};
    }
    if(!assess) return {ok:false, msg:'Select an assessment date.'};
    var sh = _sheet(), h = _headers(sh);
    var dupRow = _findAadharRow(sh, h, aadhar);
    if(dupRow > 0){
      var dv = sh.getRange(dupRow, 1, 1, h.length).getValues()[0];
      var dCode = h.indexOf('Employee Code') >= 0 ? String(dv[h.indexOf('Employee Code')] || '') : '';
      var dName = h.indexOf('Name') >= 0 ? String(dv[h.indexOf('Name')] || '') : '';
      return {ok:false, msg:'This Aadhar is already registered. Employee Code: ' + (dCode || '-') + ', Name: ' + (dName || '-')};
    }
    var empCode = _assignEmployeeCode(sh, h, name, aadhar);
    var row = h.map(function(k){
      switch(k){
        case 'Approved By': return admin;
        case 'Aadhar Number': return aadhar;
        case 'Employee Code': return empCode;
        case 'Name': return name;
        case 'Category': return category;
        case 'Trade': return trade;
        case 'Assessment Date': return assess;
        case 'Status': return '';
        default: return '';
      }
    });
    sh.appendRow(row);
    _codeMapClear();
    _auditLog(admin, 'ADD EMPLOYEE', empCode, name, '', '', 'Category=' + category + ', Trade=' + trade);
    return {ok:true};
  }catch(e){ return {ok:false, msg:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}

function setCell(token, rowNum, colName, value){
  var admin = _adminName(token); if(!admin) return {ok:false, msg:'Session expired.'};
  if(EDITABLE.indexOf(colName) === -1) return {ok:false, msg:'That field is not editable.'};
  try{
    if(colName === 'Aadhar Number') value = _cleanAadhar(value);
    if(colName === 'Aadhar Number' && !/^\d{12}$/.test(String(value))) return {ok:false, msg:'Aadhar must be exactly 12 digits.'};
    if(colName === 'Category' && CATEGORIES.indexOf(value) === -1) return {ok:false, msg:'Select a valid category.'};
    if(colName === 'Trade' && value){
      var sh0 = _sheet(), h0 = _headers(sh0);
      var curCategory = sh0.getRange(rowNum, h0.indexOf('Category') + 1).getValue();
      var list = (_getCategoryTrades()[curCategory] || []);
      if(!list.some(function(x){ return x.toLowerCase() === String(value).toLowerCase(); }))
        return {ok:false, msg:'Trade does not belong to this employee\'s category.'};
    }
    var sh = _sheet(), h = _headers(sh);
    var c = h.indexOf(colName); if(c < 0) return {ok:false, msg:'Unknown column.'};
    var old = sh.getRange(rowNum, c + 1).getValue();
    sh.getRange(rowNum, c + 1).setValue(value);
    sh.getRange(rowNum, h.indexOf('Approved By') + 1).setValue(admin);
    var fc = h.indexOf(FINAL_CHECK);
    var done = _isCompleteValue(sh.getRange(rowNum, fc + 1).getValue());
    sh.getRange(rowNum, 1, 1, h.length).setBackground(done ? GREEN : null);
    var ecIdx = h.indexOf('Employee Code'), nmIdx = h.indexOf('Name');
    var rowVals = sh.getRange(rowNum, 1, 1, h.length).getValues()[0];
    var logOld = colName === 'Aadhar Number' ? _maskAadhar(old) : old;
    var logNew = colName === 'Aadhar Number' ? _maskAadhar(value) : value;
    _auditLog(admin, 'EDIT EMPLOYEE', rowVals[ecIdx], rowVals[nmIdx], colName, logOld, logNew);
    return {ok:true};
  }catch(e){ return {ok:false, msg:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}

function toggleFinal(token, rowNum, next){
  var admin = _adminName(token); if(!admin) return {ok:false, msg:'Session expired.'};
  try{
    var sh = _sheet(), h = _headers(sh);
    var fi = _colIndexCI(h, FINAL_CHECK);
    if(fi < 0) return {ok:false, msg:'Final Check column missing.'};
    var current = _isCompleteValue(sh.getRange(rowNum, fi + 1).getValue()) ? 'Complete' : '';
    var v = (typeof next === 'undefined' || next === null) ? (current === 'Complete' ? '' : 'Complete') : (_isCompleteValue(next) ? 'Complete' : '');
    sh.getRange(rowNum, fi + 1).setValue(v);
    var ai = _colIndexCI(h, 'Approved By');
    if(ai >= 0) sh.getRange(rowNum, ai + 1).setValue(admin);
    sh.getRange(rowNum, 1, 1, h.length).setBackground(v === 'Complete' ? GREEN : null);
    var rowVals = sh.getRange(rowNum, 1, 1, h.length).getValues()[0];
    var ecIdx = _colIndexCI(h, 'Employee Code'), nmIdx = _colIndexCI(h, 'Name');
    _auditLog(admin, 'FINAL CHECK', ecIdx >= 0 ? rowVals[ecIdx] : '', nmIdx >= 0 ? rowVals[nmIdx] : '', 'Final Check', current || '(cleared)', v || '(cleared)');
    return {ok:true, value:v};
  }catch(e){ return {ok:false, msg:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}

function deleteRow(token, rowNum){
  var admin = _adminName(token); if(!admin) return {ok:false, msg:'Session expired.'};
  try{
    var sh = _sheet(), h = _headers(sh);
    var si = h.indexOf('Status'); if(si < 0) return {ok:false, msg:'Sheet error: Status column missing.'};
    var rowVals = sh.getRange(rowNum, 1, 1, h.length).getValues()[0];
    var ecIdx = h.indexOf('Employee Code'), nmIdx = h.indexOf('Name');
    sh.getRange(rowNum, si + 1).setValue('DELETED');
    _auditLog(admin, 'DELETE EMPLOYEE', rowVals[ecIdx], rowVals[nmIdx], '', '', '');
    return {ok:true};
  }catch(e){ return {ok:false, msg:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}
function restoreRow(token, rowNum){
  var admin = _adminName(token); if(!admin) return {ok:false, msg:'Session expired.'};
  try{
    var sh = _sheet(), h = _headers(sh);
    var si = h.indexOf('Status'); if(si < 0) return {ok:false, msg:'Sheet error: Status column missing.'};
    sh.getRange(rowNum, si + 1).setValue('');
    var rowVals = sh.getRange(rowNum, 1, 1, h.length).getValues()[0];
    var ecIdx = h.indexOf('Employee Code'), nmIdx = h.indexOf('Name');
    _auditLog(admin, 'RESTORE EMPLOYEE', rowVals[ecIdx], rowVals[nmIdx], '', '', '');
    return {ok:true};
  }catch(e){ return {ok:false, msg:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}
function listDeleted(token){
  if(!_adminName(token)) return {ok:false, msg:'Session expired.'};
  try{
    var sh = _sheet(), h = _headers(sh), last = sh.getLastRow();
    var si = h.indexOf('Status'), ecIdx = h.indexOf('Employee Code'), nmIdx = h.indexOf('Name');
    var out = [];
    if(last > 1){
      var vals = sh.getRange(2, 1, last - 1, h.length).getValues();
      for(var i = 0; i < vals.length; i++){
        if(String(vals[i][si] || '') === 'DELETED') out.push({rn:i + 2, code:vals[i][ecIdx], name:vals[i][nmIdx]});
      }
    }
    return {ok:true, rows:out};
  }catch(e){ return {ok:false, msg:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}

/* ================= BULK IMPORT ================= */
function _bulkAadhar(v){
  var s = String(v || '').trim();
  var low = s.toLowerCase();
  if(low.indexOf('e+') !== -1 || low.indexOf('e-') !== -1){
    var n = Number(s); if(!isNaN(n)) s = String(n);
  } else if(s.indexOf('.') !== -1 && !isNaN(Number(s))){ s = s.split('.')[0]; }
  return s.replace(/\D/g, '');
}
function bulkAddRows(token, rowsData){
  var admin = _adminName(token);
  if(!admin) return {ok:false, msg:'Session expired.'};
  if(!Array.isArray(rowsData)) return {ok:false, msg:'Invalid data format. Expected rows array.'};
  if(!rowsData.length) return {ok:false, msg:'No rows found. First row should contain headers: Aadhar Number, Name, Category, Trade, Assessment Date.'};
  try{
    var sh = _sheet(), h = _headers(sh);
    var added = 0, invalid = 0, duplicates = 0, errors = [];
    var ai = h.indexOf('Aadhar Number'), si = h.indexOf('Status');
    var existingAadhars = {};
    var last = sh.getLastRow();
    if(last > 1 && ai >= 0){
      var vals = sh.getRange(2, 1, last - 1, h.length).getValues();
      for(var i = 0; i < vals.length; i++){
        if(si >= 0 && String(vals[i][si] || '') === 'DELETED') continue;
        var exAadhar = _bulkAadhar(vals[i][ai]);
        if(exAadhar.length === 12) existingAadhars[exAadhar] = true;
      }
    }
    var rowsToAppend = [];
    for(var r = 0; r < rowsData.length; r++){
      var data = rowsData[r] || {};
      var aadhar = _bulkAadhar(data.aadhar);
      var name = String(data.name || '').trim();
      var category = String(data.category || '').trim();
      var trade = String(data.trade || '').trim();
      var assess = String(data.assess || '').trim();
      if(!aadhar && !name){ invalid++; if(errors.length < 8) errors.push('Row ' + (r + 1) + ': missing Aadhar and Name'); continue; }
      if(!aadhar){ invalid++; if(errors.length < 8) errors.push('Row ' + (r + 1) + ': missing Aadhar'); continue; }
      if(!name){ invalid++; if(errors.length < 8) errors.push('Row ' + (r + 1) + ': missing Name'); continue; }
      if(!/^\d{12}$/.test(aadhar)){ invalid++; if(errors.length < 8) errors.push('Row ' + (r + 1) + ': Aadhar must be exactly 12 digits. Found: "' + aadhar + '"'); continue; }
      if(existingAadhars[aadhar]){ duplicates++; continue; }
      var empCode = _assignEmployeeCode(sh, h, name, aadhar);
      var row = h.map(function(k){
        switch(k){
          case 'Approved By': return admin;
          case 'Aadhar Number': return aadhar;
          case 'Employee Code': return empCode;
          case 'Name': return name;
          case 'Category': return category;
          case 'Trade': return trade;
          case 'Assessment Date': return assess;
          case 'Status': return '';
          default: return '';
        }
      });
      rowsToAppend.push(row);
      existingAadhars[aadhar] = true;
      added++;
    }
    if(rowsToAppend.length > 0) sh.getRange(last + 1, 1, rowsToAppend.length, h.length).setValues(rowsToAppend);
    _codeMapClear();
    _auditLog(admin, 'BULK IMPORT', '', '', '', '', 'Added: ' + added + ', Invalid: ' + invalid + ', Duplicates: ' + duplicates);
    return {ok:true, added:added, skipped:invalid + duplicates, invalid:invalid, duplicates:duplicates, errors:errors};
  }catch(e){ return {ok:false, msg:'Bulk import error: ' + String(e && e.message ? e.message : e)}; }
}

/* Optional one-time cleaner — run manually from the Apps Script editor if you want to convert
   old TRUE / YES / tick values inside the Final Check column into clean Complete / blank values. */
function fixAllFinalCheckValues(){
  var sh = _sheet(); var h = _headers(sh); var fi = _colIndexCI(h, FINAL_CHECK);
  if(fi < 0) return 'Final Check column missing.';
  var last = sh.getLastRow();
  if(last < 2) return 'No data rows found.';
  var rng = sh.getRange(2, fi + 1, last - 1, 1);
  var vals = rng.getValues();
  var changed = false;
  for(var i = 0; i < vals.length; i++){
    var nv = _isCompleteValue(vals[i][0]) ? 'Complete' : '';
    if(String(vals[i][0]) !== String(nv)){ vals[i][0] = nv; changed = true; }
  }
  if(changed) rng.setValues(vals);
  return 'Final Check values cleaned.';
}

function healthCheck(){
  try{
    if(String(SPREADSHEET_ID).indexOf('PASTE') === 0)
      return {ok:false, error:'SPREADSHEET_ID is not set - paste your Google Sheet ID at the top of the code.'};
    _sheet();
    return {ok:true};
  }catch(e){ return {ok:false, error:'Sheet error: ' + String(e && e.message ? e.message : e)}; }
}
