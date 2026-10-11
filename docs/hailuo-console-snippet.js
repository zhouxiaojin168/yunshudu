/* ★ 海螺(hailuoai.com) 取号 + 探额度 一段式脚本（在【已登录海螺号的浏览器】里用）
   用法：打开 https://hailuoai.com 并确认已登录 -> F12 -> Console -> 整段粘贴 -> 回车
   输出：token 长度/uuid/device_id 摘要 + 4 个接口的完整 JSON（含 data.* 字段名）
   把输出的 JSON 复制给我即可；不想给 token 也行，字段名够我填适配器了。 */
(async () => {
  function md5(str){str=String(str);var bytes=[];for(var i=0;i<str.length;i++){var c=str.charCodeAt(i);if(c<128)bytes.push(c);else if(c<2048)bytes.push(192|(c>>6),128|(c&63));else bytes.push(224|(c>>12),128|((c>>6)&63),128|(c&63));}
  var n=bytes.length;bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);var bits=n*8;for(var k=0;k<8;k++)bytes.push((k<4?(bits>>>(8*k)):0)&0xff);
  function rl(x,c){return (x<<c)|(x>>>(32-c));}var a0=1732584193,b0=-271733879,c0=-1732584194,d0=271733878;
  var K=[],s=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  for(var i2=0;i2<64;i2++)K[i2]=Math.floor(Math.abs(Math.sin(i2+1))*4294967296)|0;
  for(var off=0;off<bytes.length;off+=64){var M=[];for(var j=0;j<16;j++)M[j]=bytes[off+j*4]|(bytes[off+j*4+1]<<8)|(bytes[off+j*4+2]<<16)|(bytes[off+j*4+3]<<24);
  var A=a0,B=b0,C=c0,D=d0;for(var i3=0;i3<64;i3++){var F,g;if(i3<16){F=(B&C)|(~B&D);g=i3;}else if(i3<32){F=(D&B)|(~D&C);g=(5*i3+1)%16;}else if(i3<48){F=B^C^D;g=(3*i3+5)%16;}else{F=C^(B|~D);g=(7*i3)%16;}F=(F+A+K[i3]+M[g])|0;A=D;D=C;C=B;B=(B+rl(F,s[i3]))|0;}
  a0=(a0+A)|0;b0=(b0+B)|0;c0=(c0+C)|0;d0=(d0+D)|0;}
  function hx(x){var o='';for(var i=0;i<4;i++)o+=('0'+((x>>>(i*8))&0xff).toString(16)).slice(-2);return o;}return hx(a0)+hx(b0)+hx(c0)+hx(d0);}

  const APP_ID='3001', VC='22203', BIZ='0';
  const tok  = localStorage.getItem('_token')||'';
  const uuid = localStorage.getItem('UNIQUE_USER_ID')||'';
  const dev  = localStorage.getItem('USER_HARD_WARE_INFO')||'';
  console.log('%c海螺取号器', 'font-size:16px;font-weight:bold;color:#0a0');
  console.log('token 长度=' + tok.length + '  uuid=' + (uuid||'(空)') + '  device_id=' + (dev ? dev.slice(0,20)+'…' : '(空)'));
  if (!tok) { console.log('%c没读到 _token —— 先登录海螺号再跑！','color:#c00'); return; }

  function mk(path, method, body) {
    const t = Date.now();
    const p = { device_platform:'web', app_id:APP_ID, version_code:VC, biz_id:BIZ, unix:String(t), lang:'zh-Hans', uuid:uuid,
      os_name:'Windows', browser_name:'Chrome', browser_language:navigator.language, browser_platform:navigator.platform,
      screen_width:String(screen.width), screen_height:String(screen.height) };
    if (dev) p.device_id = dev;
    const qs = Object.keys(p).map(k => encodeURIComponent(k)+'='+encodeURIComponent(p[k])).join('&');
    const full = path + (path.includes('?') ? '&' : '?') + qs;
    const bodyStr = (method==='POST'||method==='DELETE') ? JSON.stringify(body||{}) : '{}';
    return { full:full, bodyStr:bodyStr, yy: md5(encodeURIComponent(full)+'_'+bodyStr+md5(String(t))+'ooui') };
  }
  async function call(method, path, body) {
    const s = mk(path, method, body);
    let r, txt='', j=null;
    try { r = await fetch(s.full, { method:method, headers:{ token:tok, yy:s.yy, 'content-type':'application/json' }, body: method==='GET'?undefined:s.bodyStr, credentials:'include' }); txt = await r.text(); try{ j=JSON.parse(txt); }catch(e){} }
    catch (e) { console.log('\n### ' + method + ' ' + path + ' -> 网络错误 ' + e.message); return null; }
    const st = j && j.statusInfo;
    console.log('\n### ' + method + ' ' + path + '  HTTP ' + r.status + '  statusInfo.code=' + (st ? st.code : 'n/a') + (st && st.message ? ('  msg=' + st.message) : ''));
    console.log(j || txt);
    return j;
  }
  await call('GET','/v1/api/user/info');
  await call('GET','/v1/api/billing/credit');
  await call('GET','/v1/api/user/equity');
  await call('GET','/v1/api/user/subscription');
  console.log('\n%c完成：把上面 4 段 JSON 复制给我（token 想给就给，不给也能填适配器）。','font-weight:bold;color:#0a0');
})();