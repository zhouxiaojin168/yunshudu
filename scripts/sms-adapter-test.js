/**
 * sms-adapter-test.js -- 接码解析适配层自测（无需网络）
 *   跑法：node scripts/sms-adapter-test.js
 */
'use strict';
const { parsePhone, parseCode } = require('./sms-adapter');

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got      ' + a + '\n        expected ' + b); }
}
function ok(cond, name) { eq(!!cond, true, name); }

console.log('== parsePhone ==');
/* A. JSON：sms-man 风格 */
eq(parsePhone('{"success":true,"number":"79991234567","request_id":90210}'), { phone: '79991234567', id: '90210' }, 'sms-man JSON -> number/request_id');
/* A2. JSON：嵌套 data + 国际号 */
eq(parsePhone('{"data":{"phone":"+12025550143","id":7}}'), { phone: '+12025550143', id: '7' }, 'nested JSON intl phone');
/* A3. JSON：只有数字 id 没有 phone 字段 -> 应报错而不是瞎猜 */
eq(parsePhone('{"status":0,"message":"no numbers"}'), { error: 'no numbers' }, 'JSON status=0 -> error');
/* A4. JSON：sms-man 错误体 */
eq(parsePhone('{"success":false,"error_code":"wrong_token","error_msg":"Wrong token!"}'), { error: 'wrong_token' }, 'JSON success=false -> error');
/* B. 文本协议：sms-activate ACCESS_NUMBER */
eq(parsePhone('ACCESS_NUMBER:1234567:79991234567'), { phone: '79991234567', id: '1234567' }, 'ACCESS_NUMBER:id:phone');
eq(parsePhone('ACCESS_NUMBER:1234567:+447700900123'), { phone: '+447700900123', id: '1234567' }, 'ACCESS_NUMBER intl');
/* C. 兜底：国内号 */
eq(parsePhone('your number is 13800138000 ok'), { phone: '13800138000', id: '13800138000' }, 'CN mobile fallback');
/* D. 啥也没有 */
ok(parsePhone('SERVICE_UNAVAILABLE').error, 'no phone -> error');

console.log('== parseCode ==');
eq(parseCode('STATUS_OK:1234'), { code: '1234' }, 'STATUS_OK');
eq(parseCode('STATUS_WAIT_CODE'), { waiting: true }, 'STATUS_WAIT_CODE -> waiting');
eq(parseCode('STATUS_WAIT_RETRY:0'), { waiting: true }, 'STATUS_WAIT_RETRY -> waiting');
eq(parseCode('STATUS_CANCEL'), { terminal: true, error: 'STATUS_CANCEL' }, 'STATUS_CANCEL -> terminal');
eq(parseCode('{"code":"889900"}'), { code: '889900' }, 'JSON code');
eq(parseCode('{"success":true,"sms_code":"4321","received":true}'), { code: '4321' }, 'JSON sms_code');
eq(parseCode('{"success":false,"error_code":"no_balance"}'), { terminal: true, error: 'no_balance' }, 'JSON error -> terminal');
eq(parseCode('{"received":false}'), { waiting: true }, 'JSON received=false -> waiting');
eq(parseCode('TRY_AGAIN_LATER'), { waiting: true }, 'onlinesim TRY_AGAIN_LATER -> waiting');
eq(parseCode('NO_ACTIVATION'), { terminal: true, error: 'NO_ACTIVATION' }, 'NO_ACTIVATION -> terminal');

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
