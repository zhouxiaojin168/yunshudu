/**
 * login.js -- 用 runtime/credentials.txt 里的 root 账号密码换新的 access_token 并回写
 */
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const CF=path.join(ROOT,'runtime','credentials.txt');
const BASE='http://127.0.0.1:3000';
(async()=>{
  const txt=fs.readFileSync(CF,'utf8');
  const pw=(txt.match(/^password:\s*(.+)$/m)||[])[1];
  if(!pw) throw new Error('no password in credentials.txt');
  const r=await fetch(BASE+'/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'root',password:pw})});
  const j=await r.json();
  if(!j.success){ console.log('LOGIN FAIL', r.status, JSON.stringify(j).slice(0,200)); process.exit(1); }
  const tok=j.data.access_token, uid=j.data.id;
  const out=txt.replace(/^access_token:.*$/m,'access_token: '+tok);
  fs.writeFileSync(CF,out,'utf8');
  console.log('login ok  user='+j.data.username+' id='+uid+'  token refreshed -> runtime/credentials.txt');
})();
