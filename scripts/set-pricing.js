const fs=require('fs'),path=require('path');
const ROOT='E:\\中转站测试\\newapi-relay-stack';
const cred=fs.readFileSync(path.join(ROOT,'runtime','credentials.txt'),'utf8');
const tok=(cred.match(/^access_token:\s*(.+)$/m)||[])[1];
const H={'Content-Type':'application/json','Authorization':'Bearer '+tok,'New-Api-User':'1'};
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:3300'+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=JSON.parse(t)}catch(e){j=t}return{s:r.status,j}};
(async()=>{
  const cur=await api('GET','/api/option/');
  const arr=cur.j.data||[];
  const map={}; for(const o of arr) map[o.key]=o.value;
  let mp={}; try{ mp=JSON.parse(map.ModelPrice||'{}'); }catch(e){}
  const price=0.047945205479;
  for(const m of ['MiniMax-H3','MiniMax-M3','MiniMax-H3-image','MiniMax-M3-image']) mp[m]=price;
  let mr={}; try{ mr=JSON.parse(map.ModelRatio||'{}'); }catch(e){}
  mr['MiniMax-H3']=1; mr['MiniMax-M3']=1;
  let cr={}; try{ cr=JSON.parse(map.CompletionRatio||'{}'); }catch(e){}
  cr['MiniMax-H3']=1; cr['MiniMax-M3']=1;
  for(const [k,v] of [['ModelPrice',mp],['ModelRatio',mr],['CompletionRatio',cr]]){
    const r=await api('PUT','/api/option/',{key:k,value:JSON.stringify(v)});
    console.log('PUT',k,'->',r.s,JSON.stringify(r.j).slice(0,100));
  }
  // 顺带核对渠道
  const ch=await api('GET','/api/channel/?p=0&page_size=100');
  const items=(ch.j.data&&(ch.j.data.items||ch.j.data))||[];
  for(const c of items) console.log('  [ch]',c.id,c.name,'status='+c.status,'multi='+(c.channel_info&&c.channel_info.is_multi_key),'mode='+(c.channel_info&&c.channel_info.multi_key_mode),'base='+c.base_url,'models='+c.models);
})();
