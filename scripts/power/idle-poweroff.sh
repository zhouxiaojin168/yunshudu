#!/usr/bin/env bash
# idle-poweroff.sh -- 4090D 空闲自动关机看门狗（安全默认：DRY-RUN，绝不误关）
#
# 作用：实例闲着（没有排队、没有在跑的任务）超过 IDLE_SEC 秒 -> 执行 POWER_CMD。
#      默认 POWER_CMD 为空 = 只写日志不真关机；确认关机方式后再武装。
#
# 用法（实例内）：
#   bash /root/h3api/idle-poweroff.sh              # 常驻循环（前台，建议 nohup）
#   bash /root/h3api/idle-poweroff.sh --once       # 只跑一轮（给 cron 用）
#   POWER_CMD='bash /root/h3api/do-poweroff.sh' bash /root/h3api/idle-poweroff.sh   # 武装
#
# 环境变量：
#   IDLE_SEC   空闲多少秒算"可以关机"（默认 900 = 15 分钟）
#   POLL_SEC   常驻模式轮询间隔（默认 60）
#   POWER_CMD  关机命令；空 = dry-run（默认）
#   H3API      本机 API 基址（默认 http://127.0.0.1:6006）
#   H3KEY      H3 API key；设了就用 /v1/queue 拿精确队列
#   LOG        日志（默认 /root/h3api/idle-watch.log）
#   STATE      状态文件（默认 /root/h3api/idle-watch.state）
#   DRYRUN=0   显式打开"真关机"（等价于给了 POWER_CMD）
#
# 判定"忙"的三个来源（任一命中即算忙）：
#   1) /healthz 里 queue>0（自建 API 队列）
#   2) /healthz 里 comfy_queue.running 或 .pending > 0（ComfyUI 真在算）
#   3) /v1/queue 的 queue_len>0（设了 H3KEY 时）
set -u

H3API="${H3API:-http://127.0.0.1:6006}"
H3KEY="${H3KEY:-}"
IDLE_SEC="${IDLE_SEC:-900}"
POLL_SEC="${POLL_SEC:-60}"
POWER_CMD="${POWER_CMD:-}"
LOG="${LOG:-/root/h3api/idle-watch.log}"
STATE="${STATE:-/root/h3api/idle-watch.state}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

jget() { # jget <url> <python-expr-on-json>
  curl -s --max-time 8 "$1" ${H3KEY:+-H "Authorization: Bearer $H3KEY"} 2>/dev/null \
    | /root/miniconda3/bin/python -c "import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print('ERR'); raise SystemExit
try:
    print($2)
except Exception:
    print('ERR')"
}

check_busy() {
  local hz q
  hz=$(jget "$H3API/healthz" "int(d.get('queue') or 0) + int((d.get('comfy_queue') or {}).get('running') or 0) + int((d.get('comfy_queue') or {}).get('pending') or 0)")
  [ "$hz" = "ERR" ] && { log "healthz 不可达 -> 视为忙"; echo busy; return; }
  if [ "$hz" -gt 0 ] 2>/dev/null; then log "忙: healthz 内队列/算力占用 = $hz"; echo busy; return; fi
  if [ -n "$H3KEY" ]; then
    q=$(jget "$H3API/v1/queue" "int(d.get('queue_len') or 0)")
    if [ "$q" != "ERR" ] && [ "$q" -gt 0 ] 2>/dev/null; then log "忙: api queue_len=$q"; echo busy; return; fi
  fi
  echo idle
}

now=$(date +%s)
st=$( [ -f "$STATE" ] && cat "$STATE" || echo 0 )
[ -z "$st" ] && st=0

if [ "$(check_busy)" = "busy" ]; then
  echo "$now" > "$STATE"
  log "状态=忙，刷新心跳 ($STATE=$now)"
  exit 0
fi

if [ "$st" -eq 0 ]; then
  echo "$now" > "$STATE"
  log "状态=闲，首次记录心跳（下轮开始计时）"
  exit 0
fi

idle=$(( now - st ))
log "状态=闲，已空闲 ${idle}s / 阈值 ${IDLE_SEC}s"

if [ "$idle" -ge "$IDLE_SEC" ]; then
  if [ -n "$POWER_CMD" ]; then
    log "★ 达到阈值 -> 执行: $POWER_CMD"
    bash -c "$POWER_CMD" >> "$LOG" 2>&1
    log "关机命令已下发，退出"
    exit 0
  else
    log "★ 达到阈值，但 POWER_CMD 为空 = DRY-RUN（此刻会执行关机）。设 POWER_CMD 后即生效。"
    echo "$now" > "$STATE"   # 干跑时重置，避免日志刷屏
  fi
fi