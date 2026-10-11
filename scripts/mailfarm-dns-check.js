'use strict';
/**
 * mailfarm-dns-check.js -- 收信域 DNS 体检（零依赖）
 *
 *   买入域名后先跑这个，确认「MX 指向收信机 + SPF 只收不发」，再去配 mailfarm。
 *
 *  用法：
 *    node scripts/mailfarm-dns-check.js 你的域1 你的域2 ...
 *    node scripts/mailfarm-dns-check.js --expect-mail mail.example.com a.online b.cyou
 *
 *  退出码：0=全通过 / 1=有问题
 */
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const argv = process.argv.slice(2);
let expectMail = null;
const domains = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--expect-mail') { expectMail = argv[++i]; continue; }
  domains.push(argv[i]);
}
if (domains.length === 0) {
  console.log('用法: node scripts/mailfarm-dns-check.js [--expect-mail mail.你的域] 你的域 [...]');
  process.exit(2);
}

function ask(fn, name) {
  return new Promise(function (res) {
    fn(name, function (err, recs) { res(err ? [] : (recs || [])); });
  });
}
function mxList(d) { return ask(dns.resolveMx.bind(dns), d); }
function aList(h) { return ask(dns.resolve4.bind(dns), h); }
function txtList(d) { return ask(dns.resolveTxt.bind(dns), d); }

(async function main() {
  let bad = 0;
  for (const d of domains) {
    console.log('=== ' + d + ' ===');
    const mx = await mxList(d);
    if (mx.length === 0) {
      bad++;
      console.log('  [x] MX         缺少！邮件投不进来。需要: MX @ -> mail.' + d + ' (优先级 10)');
    } else {
      const hosts = mx.map(function (m) { return m.exchange.replace(/\.$/, ''); }).sort();
      console.log('  [v] MX         ' + hosts.join(', '));
      for (const h of hosts) {
        const ips = await aList(h);
        if (ips.length === 0) { bad++; console.log('    [x] A ' + h + ' 无解析 -> MX 目标不可达'); }
        else {
          console.log('    [v] A ' + h + ' -> ' + ips.join(', '));
          if (expectMail && h !== expectMail) { console.log('    [!] 期望 ' + expectMail + '，实际 ' + h); }
          if (expectMail && ips.indexOf(expectMail) < 0 && /^\d+\.\d+\.\d+\.\d+$/.test(expectMail) && ips.indexOf(expectMail) < 0) {
            // 允许 --expect-mail 传 IP
          }
        }
      }
    }
    const txts = await txtList(d);
    const spf = txts.map(function (t) { return t.join(''); }).filter(function (s) { return /^v=spf1/i.test(s); });
    if (spf.length === 0) {
      bad++;
      console.log('  [x] SPF TXT    缺少！建议: TXT @ -> "v=spf1 -all"（只收不发）');
    } else {
      console.log('  [v] SPF        ' + spf.join(' | '));
      if (!/-\s*all/i.test(spf.join(' '))) console.log('    [!] 建议用 -all（硬失败），别用 ~all');
    }
  }
  console.log('');
  if (bad === 0) { console.log('DONE 全部通过：可以把这个域加进 MF_DOMAINS 了。'); process.exit(0); }
  console.log('DONE 有 ' + bad + ' 处问题，按上面提示去 DNS 面板改。');
  process.exit(1);
})();
