#!/usr/bin/env bash
# READ-ONLY inspection of the VPS, so nothing is changed or broken by guessing.
#
#   ssh BMC-NetCup 'bash -s' < deploy/inspect-vps.sh | tee vps-report.txt
#
# What it does: prints versions, hardware, free memory/disk, which ports are taken, what Docker and Caddy are
# running, and whether the server can reach the places a deployment needs.
# What it never does: write, install, restart or delete anything; read .env files, keys or passwords; print a
# Caddyfile or compose file (only site addresses and upstream ports); use sudo (except `sudo -n ufw status`, a
# read-only query that is skipped if sudo would ask for a password).
# Read it first if you like. It is plain bash.
set +e
export LC_ALL=C
hr() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
try() { "$@" 2>&1 | head -${LINES_MAX:-40}; }

hr "who and where"
echo "user: $(whoami)   groups: $(id -Gn)"
echo "host: $(hostname)   time: $(date -Is)"
uname -srm
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
uptime

hr "cpu (Whisper speed depends on this)"
if have lscpu; then lscpu | grep -E 'Model name|^CPU\(s\)|Thread|Core|Socket|MHz|L3|Hypervisor|Virtualization type'; fi
echo "instructions: $(grep -m1 -o -wE 'avx2|avx512f|avx512_vnni|avx_vnni|fma' /proc/cpuinfo | sort -u | tr '\n' ' ')"
echo "(avx2 is the minimum for fast CPU inference; avx512 / vnni is better)"
echo "steal (time stolen by neighbours on a shared host; high = slow, noisy CPU):"
top -bn1 2>/dev/null | grep -iE '^%?cpu' | head -2

hr "memory and swap"
free -h
swapon --show 2>/dev/null || echo "no swap"
echo "top memory users:"; ps -eo pid,user,comm,%mem,rss --sort=-rss 2>/dev/null | head -8

hr "disk"
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
echo "your home: $(du -sh "$HOME" 2>/dev/null | cut -f1)"

hr "ports already in use (so nothing collides)"
if have ss; then ss -ltn 2>/dev/null | awk 'NR==1 || /LISTEN/' | head -40; fi
for p in 80 443 8000 8787; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p$"; then echo "port $p: IN USE"; else echo "port $p: free"; fi
done

hr "docker"
if have docker; then
  docker --version
  docker compose version 2>&1 | head -1
  echo "-- can this user talk to docker?"
  if docker info >/dev/null 2>&1; then
    echo yes
    docker info --format 'storage driver: {{.Driver}} | cgroup: {{.CgroupVersion}} | containers: {{.Containers}} (running {{.ContainersRunning}}) | images: {{.Images}}' 2>&1
    echo "-- running containers (names, images, ports; no environment shown)"
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>&1 | head -30
    echo "-- volumes"; docker volume ls --format '{{.Name}}' 2>&1 | head -20
    echo "-- networks"; docker network ls --format '{{.Name}} ({{.Driver}})' 2>&1 | head -20
    echo "-- disk used by docker"; docker system df 2>&1 | head -6
  else
    echo "NO: $(docker info 2>&1 | grep -iE 'permission|denied|cannot connect' | head -1)"
    echo "(add this user to the docker group, or use sudo, before deploying)"
  fi
else
  echo "docker is not installed"
fi

hr "caddy"
have caddy && caddy version 2>&1 | head -1 || echo "caddy binary not on PATH for this user"
echo "systemd: $(systemctl is-active caddy 2>&1)"
for f in /etc/caddy/Caddyfile "$HOME/Caddyfile" /srv/Caddyfile; do
  if [ -r "$f" ]; then
    echo "-- $f (site addresses and proxy targets only)"
    grep -nE '^[^[:space:]#].*\{[[:space:]]*$|^[[:space:]]*(reverse_proxy|import)[[:space:]]' "$f" | sed -E 's/(basic_?auth|token|password|secret)[^ ]*/\1 [hidden]/Ig' | head -40
  elif [ -e "$f" ]; then echo "-- $f exists but this user cannot read it"; fi
done
[ -d /etc/caddy ] && { echo "-- files in /etc/caddy:"; ls -1 /etc/caddy 2>&1 | head -20; }

hr "other services running (names only)"
systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | head -30

hr "tools"
for t in git curl node npm python3 pip3 ffmpeg make; do
  if have $t; then printf '%-8s %s\n' "$t" "$($t --version 2>&1 | head -1)"; else printf '%-8s -\n' "$t"; fi
done

hr "existing projects in your home (names only)"
ls -1 "$HOME" 2>/dev/null | head -30
find "$HOME" -maxdepth 3 \( -name 'compose.y*ml' -o -name 'docker-compose.y*ml' \) 2>/dev/null | head -10
echo "cron:"; crontab -l 2>&1 | grep -vE '^#|^$' | sed -E 's/(token|key|pass[a-z]*)=[^ ]+/\1=[hidden]/Ig' | head -10

hr "firewall (read-only)"
if sudo -n true 2>/dev/null; then sudo -n ufw status 2>&1 | head -15; else echo "skipped: sudo needs a password, which is fine"; fi

hr "can this server reach what a deployment needs?"
for u in https://registry-1.docker.io/v2/ https://huggingface.co https://pypi.org https://generativelanguage.googleapis.com https://api.openai.com; do
  printf '%-48s %s\n' "$u" "$(curl -s -o /dev/null -m 8 -w 'HTTP %{http_code}' "$u" 2>&1)"
done

hr "end of report (nothing was changed)"
