#!/usr/bin/env bash
# gw-deploy-linux.sh -- 一键把「自建出口网关」(ysd-gw-server.js) 部署到任意 Linux VPS
#
# 用法：
#   bash scripts/gw-deploy-linux.sh --host 1.2.3.4 --user root [--key ~/.ssh/id_rsa] [--port 38472] [--token gw_xxx]
#   bash scripts/gw-deploy-linux.sh --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_ed25519 --port 38472
#
# 完成后本机接入（Windows 侧）：
#   set GW_REMOTE=1.2.3.4:38472
#   set GW_TOKEN=gw_xxx
#   node scripts/ysd-gw-client.js            # 监听 127.0.0.1:18081 SOCKS5
#   curl -x socks5h://127.0.0.1:18081 https://api.ipify.org
set -euo pipefail

HOST=""; USER_NAME="root"; KEY=""; GPORT="38472"; TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --user) USER_NAME="$2"; shift 2;;
    --key)  KEY="$2"; shift 2;;
    --port) GPORT="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done
[ -n "$HOST" ] || { echo "用法: bash scripts/gw-deploy-linux.sh --host <IP> [--user root] [--key ~/.ssh/id_rsa] [--port 38472] [--token gw_xxx]"; exit 1; }
[ -n "$TOKEN" ] || TOKEN="gw_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-12)"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRV="$DIR/scripts/ysd-gw-server.js"
[ -f "$SRV" ] || { echo "找不到 $SRV"; exit 1; }

SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
SCP=(scp -o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && { SSH+=(-i "$KEY"); SCP+=(-i "$KEY"); }
SSH+=("$USER_NAME@$HOST")
SCP+=("$SRV" "$USER_NAME@$HOST:/tmp/ysd-gw-server.js")

echo "==> 1/5 检查远端 node"
if "${SSH[@]}" 'command -v node >/dev/null 2>&1'; then
  echo "    已装 node: $("${SSH[@]}" 'node -v')"
else
  echo "    未装 node，尝试安装"
  "${SSH[@]}" 'if command -v apt-get >/dev/null; then sudo apt-get update -y && sudo apt-get install -y nodejs; elif command -v dnf >/dev/null; then sudo dnf install -y nodejs; elif command -v yum >/dev/null; then sudo yum install -y nodejs; fi' || true
  "${SSH[@]}" 'command -v node >/dev/null 2>&1' || { echo "    远端仍无 node，请手动装 Node 18+ 后重跑"; exit 1; }
fi

echo "==> 2/5 上传网关"
"${SCP[@]}"
"${SSH[@]}" "sudo mkdir -p /opt/ysd-gw && sudo mv /tmp/ysd-gw-server.js /opt/ysd-gw/ysd-gw-server.js && sudo chmod 644 /opt/ysd-gw/ysd-gw-server.js"

echo "==> 3/5 写 systemd 单元 (ysd-gw.service)"
"${SSH[@]}" "NODE_BIN=\$(command -v node); sudo tee /etc/systemd/system/ysd-gw.service >/dev/null <<EOF
[Unit]
Description=ysd-gw egress gateway (token tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=GW_PORT=$GPORT
Environment=GW_HOST=0.0.0.0
Environment=GW_TOKEN=$TOKEN
Environment=GW_LOG=/var/log/ysd-gw.log
ExecStart=\$NODE_BIN /opt/ysd-gw/ysd-gw-server.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now ysd-gw"

echo "==> 4/5 放行端口 $GPORT"
"${SSH[@]}" "if command -v ufw >/dev/null && sudo ufw status >/dev/null 2>&1; then sudo ufw allow $GPORT/tcp; elif command -v firewall-cmd >/dev/null; then sudo firewall-cmd --permanent --add-port=$GPORT/tcp && sudo firewall-cmd --reload; fi" || true

echo "==> 5/5 验证"
sleep 2
"${SSH[@]}" "sudo systemctl is-active ysd-gw; (command -v ss >/dev/null && ss -lntp | grep ':$GPORT' ) || (command -v netstat >/dev/null && netstat -lntp | grep ':$GPORT') || echo '端口未见监听，看 journalctl -u ysd-gw -n 50'"

cat <<EOF

✅ 部署完成
   远端：$HOST:$GPORT   token=$TOKEN   (systemd: ysd-gw)
   日志：sudo journalctl -u ysd-gw -f
   Windows 侧接入：
     set GW_REMOTE=$HOST:$GPORT
     set GW_TOKEN=$TOKEN
     node scripts/ysd-gw-client.js
     curl -x socks5h://127.0.0.1:18081 https://api.ipify.org
   接入后验活：
     node scripts/isp-onboard.js verify 18081
EOF