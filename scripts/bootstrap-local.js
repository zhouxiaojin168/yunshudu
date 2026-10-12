const fs=require('fs');
const B='http://127.0.0.1:3000';
const OUT='E:\\中转站测试\\newapi-relay-stack\\runtime\\';
const pw='wz-'+Math.random().toString(36).slice(2,10)+'!A9';
const j=async(u,o={})=>{const r=await fetch(B+u,{...o,headers:{'Content-Type':'application/json',...(o.headers||{})}});const t=await r.text();let b=null;try{b=JSON.parse(t);}catch(e){b=t;}return {s:r.status,b,r};};
(async()=>{
 const st=await j('/api/setup'); console.log('GET /api/setup ->',st.s,JSON.stringify(st.b));
 let token=null,uid=null;
 if(st.b && st.b.data && st.b.data.root_init===false){
  const r1=await j('/api/setup',{method:'POST',body:JSON.stringify({username:'root',password:pw,confirmPassword:pw,SelfUseModeEnabled:false,DemoSiteEnabled:false})});
  console.log('POST /api/setup ->',r1.s,JSON.stringify(r1.b).slice(0,200));
 }
 const lg=await j('/api/user/login',{method:'POST',body:JSON.stringify({username:'root',password:pw})});
 console.log('login ->',lg.s, (lg.b&&lg.b.success)?'ok':'fail', JSON.stringify(lg.b).slice(0,160));
 if(lg.b&&lg.b.data){ token=lg.b.data.access_token; uid=lg.b.data.id; }
 if(!token){ console.log('!! 登录失败，可能是已初始化过(pw 不同)。跳过 option 写入。'); process.exit(0); }
 const H={'Authorization':'Bearer '+token,'New-Api-User':String(uid)};
 const opts=[['SystemName','王炸AI·本地'],['RegisterEnabled','true'],['PasswordRegisterEnabled','true'],['QuotaPerUnit','500000'],['USDExchangeRate','6.8'],['DisplayInCurrencyEnabled','true'],['UptimeKumaEnabled','true'],['CheckInEnabled','false']];
 for(const [k,v] of opts){
  const r=await j('/api/option/',{method:'PUT',headers:H,body:JSON.stringify({key:k,value:v})});
  console.log('  PUT',k,'=',v,'->',r.s,(r.b&&r.b.success)?'ok':JSON.stringify(r.b).slice(0,80));
 }
 const st2=await j('/api/status');
 console.log('status now -> system_name=',st2.b.data.system_name,'register=',st2.b.data.register_enabled,'qpu=',st2.b.data.quota_per_unit,'rate=',st2.b.data.usd_exchange_rate);
 fs.writeFileSync(OUT+'credentials.txt',
  ['new-api local instance (newapi-relay-stack)','url: http://127.0.0.1:3000','username: root','password: '+pw,'access_token: '+token,'created: '+new Date().toISOString()].join('\n'),'utf8');
 console.log('credentials saved -> runtime/credentials.txt');
})();
