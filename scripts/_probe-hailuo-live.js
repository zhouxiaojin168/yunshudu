
const fs=require('fs'), path=require('path');
const ROOT='E:\\中转站测试\\newapi-relay-stack';
const HS=require(path.join(ROOT,'scripts','hailuo-sign.js'));
const U='C:\\Users\\Administrator\\.yunshudu\\';
const toks=[['cn',fs.readFileSync(U+'hailuo-token.txt','utf8').trim()],['intl',fs.readFileSync(U+'hailuo-token-intl.txt','utf8').trim()]];
(async()=>{
  for(const [name,tok] of toks){
    const req=HS.buildSignedRequest({url:'/v1/api/billing/credit',method:'GET',body:undefined,raw:tok,time:Date.now()});
    const r=await fetch('https://hailuoai.com'+req.url,{method:'GET',headers:req.headers});
    const t=await r.text();
    console.log('['+name+'] HTTP '+r.status+' :: '+t.slice(0,400));
    console.log('   url='+req.url.slice(0,160));
    console.log('   hdr keys='+Object.keys(req.headers).join(','));
  }
})();
