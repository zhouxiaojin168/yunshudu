/**
 * set-site.js -- 登录 + 写入站点参数（站名等）
 *   node scripts/set-site.js [siteName]
 */
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const CF=path.join(ROOT,'runtime','credentials.txt');
const BASE='http://127.0.0.1:3000';
const SITE=process.argv[2]||'yunshudu';

(async()=>{
  const txt=fs.readFileSync(CF,'utf8');
  const pw=(txt.match(/^password:\s*(.+)$/m)||[])[1];
  const lr=await fetch(BASE+'/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'root',password:pw})});
  const lj=await lr.json();
  if(!lj.success){ console.log('LOGIN FAIL',JSON.stringify(lj).slice(0,200)); process.exit(1); }
  const tok=lj.data.access_token, uid=lj.data.id;
  fs.writeFileSync(CF, txt.replace(/^access_token:.*$/m,'access_token: '+tok),'utf8');
  const H={'Content-Type':'application/json','Authorization':'Bearer '+tok,'New-Api-User':String(uid)};
  const put=async(k,v)=>{const r=await fetch(BASE+'/api/option/',{method:'PUT',headers:H,body:JSON.stringify({key:k,value:v})});const j=await r.json();console.log('  PUT',k,'=',v,'->',r.status,(j.success?'ok':JSON.stringify(j).slice(0,80)));};
  await put('SystemName', SITE);
  await put('ServerAddress', 'http://localhost:3000');
  await put('RegisterEnabled','true');
  await put('PasswordRegisterEnabled','true');
  await put('QuotaPerUnit','500000');
  await put('USDExchangeRate','6.8');
  await put('DisplayInCurrencyEnabled','true');
  const st=await (await fetch(BASE+'/api/status')).json();
  console.log('status -> system_name=',st.data.system_name,' register=',st.data.register_enabled,' qpu=',st.data.quota_per_unit);
})();
