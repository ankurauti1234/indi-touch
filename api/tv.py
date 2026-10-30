#!/usr/bin/env python3
"""
api/tv.py — TV device UI endpoints + fast subnet scan
======================================================
Lives in /opt/apm/apm-touch-ui/api/tv.py

Scan approach:
  TCP port check (0.3s) as gate before any protocol handshake.
  30 parallel workers. ~15s total scan time.
  No ping, no ARP.
"""

import re
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests
from flask import Blueprint, jsonify, request
from .db import get_conn

tv_bp = Blueprint("tv", __name__)

SCAN_WORKERS = 30
TCP_GATE_TIMEOUT = 0.3    # fast reject for closed/filtered ports
HTTP_TIMEOUT = 2.0
ADB_TIMEOUT = 5

SAMSUNG_PORTS = [8001]
ADB_PORTS = [5555]
LG_PORTS = [3000, 3001]

# Full 16-port TV matrix — must mirror tv_monitor.py so the UI scan matches
# what the daemon can actually monitor. port → brand.
TV_PORT_MAP = {
    8001: "samsung", 8002: "samsung",
    3000: "lg", 3001: "lg",
    5555: "android_tv",
    8008: "cast_tv", 8009: "cast_tv",
    8060: "roku",
    1925: "philips",
    36669: "hisense",
    9000: "vizio", 7345: "vizio",
    10000: "sony", 50001: "sony",
    6466: "vise", 6467: "vise",
}
TV_PORTS = list(TV_PORT_MAP.keys())
BRAND_PRIORITY = ["samsung", "lg", "android_tv", "roku", "philips",
                  "cast_tv", "hisense", "vizio", "sony", "vise"]

# Small offline OUI → vendor table (first 3 MAC octets). Best-effort hint
# so an installer can spot a TV among "other devices". Not exhaustive.
_OUI = {
    "0C:79:55": "Samsung", "8C:79:F5": "Samsung", "F8:3F:51": "Samsung",
    "00:1C:62": "LG", "A8:16:B2": "LG", "C4:36:6C": "LG",
    "D0:93:95": "Vizio", "70:49:A2": "Vizio",
    "54:60:09": "Google/Cast", "F4:F5:D8": "Google/Cast",
    "B0:A7:37": "Roku", "CC:6D:A0": "Roku",
    "DC:85:DE": "Hisense", "20:F1:7C": "Hisense",
    "04:5D:4B": "Sony", "FC:F1:52": "Sony",
    "88:36:6C": "Philips", "00:1A:11": "Google/Cast",
}


def _get_mac(ip):
    """Read MAC from the kernel ARP table (no privilege needed)."""
    try:
        with open("/proc/net/arp") as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip:
                    mac = parts[3].upper()
                    if mac and mac != "00:00:00:00:00:00":
                        return mac
    except Exception:
        pass
    return None


def _oui_vendor(mac):
    if not mac:
        return None
    return _OUI.get(mac[:8].upper())


def _ping(ip):
    """Liveness via one ICMP echo. Used to surface non-TV hosts too."""
    try:
        r = subprocess.run(["ping", "-c", "1", "-W", "1", ip],
                           capture_output=True, timeout=2)
        return r.returncode == 0
    except Exception:
        return False


def _classify_by_ports(ip):
    """
    TCP-touch the 16 TV ports. Return (tv_type, open_ports).
    A monitorable TV is any host with >=1 TV port open (brand from the port).
    """
    open_ports = [p for p in TV_PORTS if _tcp_open(ip, p)]
    if not open_ports:
        return None, []
    brands = {TV_PORT_MAP[p] for p in open_ports}
    # v4.2 — LG guard (mirrors tv_monitor.py). Port 3000 collides with
    # Next.js/Node dev servers; real LG is silent to a plain HTTP GET while
    # a web server answers 'HTTP/1.'. Reject LG if 3000 answers HTTP.
    # Scoped to LG only — Samsung/Roku/Cast/Philips ports are legit HTTP.
    if "lg" in brands and (3000 in open_ports or 3001 in open_ports):
        if _is_plain_http_server(ip, 3000):
            brands.discard("lg")
            open_ports = [p for p in open_ports if p not in (3000, 3001)]
            if not brands or not open_ports:
                return None, []
    for b in BRAND_PRIORITY:
        if b in brands:
            return b, open_ports
    return sorted(brands)[0], open_ports


def _is_plain_http_server(ip, port=3000, timeout=1.5):
    """
    True if the port answers like a web server (Next.js/Node on 3000).
    Hardware-proven: LG .34:3000 -> silent (False); Next.js .191 -> HTTP (True).
    LG-only guard; never applied to Samsung/Roku/Cast/Philips HTTP ports.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, port))
        s.sendall(
            f"GET / HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n"
            .encode("utf-8")
        )
        return s.recv(64).decode("utf-8", errors="ignore").startswith("HTTP/1.")
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


# ── DB ────────────────────────────────────────────────────────────────────────

def init_tv_table():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tv_devices (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                mac         TEXT,
                ip          TEXT NOT NULL,
                tv_type     TEXT NOT NULL,
                label       TEXT,
                model       TEXT,
                pairing_key TEXT,
                first_seen  TEXT,
                last_seen   TEXT
            )
        """)
        conn.commit()
    print("[TV] tv_devices table ready")


def _get_all_devices():
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT id, mac, ip, tv_type, label, model, pairing_key, "
            "first_seen, last_seen FROM tv_devices ORDER BY id"
        )
        return [
            dict(zip(
                ["id", "mac", "ip", "tv_type", "label", "model",
                 "pairing_key", "first_seen", "last_seen"], row
            ))
            for row in cur.fetchall()
        ]


def _upsert_device(ip, tv_type, mac=None, model=None):
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        existing = None
        if mac:
            existing = conn.execute(
                "SELECT id FROM tv_devices WHERE mac=?", (mac,)
            ).fetchone()
        if not existing:
            existing = conn.execute(
                "SELECT id FROM tv_devices WHERE ip=? AND tv_type=? AND label IS NULL",
                (ip, tv_type)
            ).fetchone()
        if existing:
            conn.execute(
                "UPDATE tv_devices SET last_seen=?, ip=?, "
                "mac=COALESCE(?,mac), model=COALESCE(?,model) WHERE id=?",
                (now, ip, mac, model, existing[0])
            )
        else:
            conn.execute(
                "INSERT INTO tv_devices "
                "(mac, ip, tv_type, model, first_seen, last_seen) "
                "VALUES (?,?,?,?,?,?)",
                (mac, ip, tv_type, model, now, now)
            )
        conn.commit()


# ── Network ───────────────────────────────────────────────────────────────────

def _get_pi_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def _tcp_open(ip, port):
    """Fast TCP gate — 0.3s timeout. True = port open."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(TCP_GATE_TIMEOUT)
        ok = s.connect_ex((ip, port)) == 0
        s.close()
        return ok
    except Exception:
        return False


def _check_samsung(ip):
    if not _tcp_open(ip, 8001):
        return None
    try:
        r = requests.get(f"http://{ip}:8001/api/v2/", timeout=HTTP_TIMEOUT)
        if r.status_code == 200:
            device = r.json().get("device", {})
            if device:
                return {
                    "ip": ip, "tv_type": "samsung",
                    "mac": (device.get("wifiMac") or "").upper() or None,
                    "model": device.get("modelName") or "Samsung TV",
                }
    except Exception:
        pass
    return None


def _check_adb(ip):
    if not _tcp_open(ip, 5555):
        return None
    try:
        r = subprocess.run(
            ["adb", "connect", f"{ip}:5555"],
            capture_output=True, text=True, timeout=ADB_TIMEOUT
        )
        if "unable" in r.stdout.lower() or "connected" not in r.stdout.lower():
            subprocess.run(["adb", "disconnect", f"{ip}:5555"],
                           capture_output=True, timeout=3)
            return None

        r = subprocess.run(
            ["adb", "-s", f"{ip}:5555", "shell",
             "getprop", "ro.product.model"],
            capture_output=True, text=True, timeout=ADB_TIMEOUT
        )
        model = r.stdout.strip() or "Android TV"

        r = subprocess.run(
            ["adb", "-s", f"{ip}:5555", "shell",
             "getprop", "ro.build.characteristics"],
            capture_output=True, text=True, timeout=ADB_TIMEOUT
        )
        is_tv = "tv" in r.stdout.lower()

        subprocess.run(["adb", "disconnect", f"{ip}:5555"],
                       capture_output=True, timeout=3)
        if is_tv:
            return {"ip": ip, "tv_type": "android_tv",
                    "mac": None, "model": model}
    except Exception:
        try:
            subprocess.run(["adb", "disconnect", f"{ip}:5555"],
                           capture_output=True, timeout=3)
        except Exception:
            pass
    return None


def _check_lg(ip):
    for port in LG_PORTS:
        if _tcp_open(ip, port):
            return {"ip": ip, "tv_type": "lg", "mac": None, "model": "LG TV"}
    return None


def _scan_one(ip):
    """
    Classify a single host for the hybrid selection list.
      tier "tv"    → >=1 TV port open → monitorable, brand from port
      tier "other" → alive (ARP/ping) but no TV port → shown, NOT monitorable
      None         → not alive
    """
    tv_type, open_ports = _classify_by_ports(ip)
    mac = _get_mac(ip)
    vendor = _oui_vendor(mac)
    if tv_type:
        return {"ip": ip, "tv_type": tv_type, "mac": mac, "vendor": vendor,
                "model": f"{tv_type} TV", "ports": open_ports,
                "monitorable": True, "tier": "tv"}
    if mac or _ping(ip):
        return {"ip": ip, "tv_type": None, "mac": mac, "vendor": vendor,
                "model": vendor or "Unknown device", "ports": [],
                "monitorable": False, "tier": "other"}
    return None


# ── Scan engine ───────────────────────────────────────────────────────────────

_scan_lock = threading.Lock()
_scan_state = {"status": "idle", "candidates": [], "error": None}


def _ip_key(ip):
    try:
        return tuple(int(o) for o in ip.split("."))
    except Exception:
        return (999,)


def _run_scan():
    global _scan_state
    pi_ip = _get_pi_ip()
    if not pi_ip:
        with _scan_lock:
            _scan_state = {"status": "error", "candidates": [],
                           "error": "Cannot determine Pi IP"}
        return

    subnet = ".".join(pi_ip.split(".")[:3])
    with _scan_lock:
        _scan_state = {"status": "scanning", "candidates": [], "error": None}

    print(f"[TV-SCAN] Sweeping {subnet}.0/24 — all live hosts ({SCAN_WORKERS} workers)...")
    start = time.time()
    results = []

    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        futures = {
            pool.submit(_scan_one, f"{subnet}.{i}"): f"{subnet}.{i}"
            for i in range(1, 255)
            if f"{subnet}.{i}" != pi_ip
        }
        for future in as_completed(futures):
            try:
                r = future.result()
                if not r:
                    continue
                results.append(r)
                print(f"[TV-SCAN]   {r['ip']} → {r['tv_type'] or 'other'} ({r.get('vendor') or r.get('model','?')})")
            except Exception as e:
                print(f"[TV-SCAN]   probe error: {e}")

    # Upsert and resolve SQLite database ID for all discovered devices
    for r in results:
        if r["tier"] == "tv":
            _upsert_device(r["ip"], r["tv_type"],
                           mac=r.get("mac"), model=r.get("model"))
            try:
                with get_conn() as conn:
                    if r.get("mac"):
                        row = conn.execute("SELECT id FROM tv_devices WHERE mac=?", (r["mac"],)).fetchone()
                    else:
                        row = conn.execute("SELECT id FROM tv_devices WHERE ip=? AND tv_type=?", (r["ip"], r["tv_type"])).fetchone()
                    if row:
                        r["id"] = row[0]
            except Exception as e:
                print(f"[TV-SCAN] Error attaching device id: {e}")

    tvs = sorted([r for r in results if r["tier"] == "tv"],
                 key=lambda x: _ip_key(x["ip"]))
    others = sorted([r for r in results if r["tier"] == "other"],
                    key=lambda x: _ip_key(x["ip"]))
    ordered = tvs + others

    elapsed = time.time() - start
    print(f"[TV-SCAN] Done — {len(tvs)} TV(s), {len(others)} other host(s) in {elapsed:.1f}s")

    with _scan_lock:
        _scan_state = {"status": "done", "candidates": ordered,
                       "tv_count": len(tvs), "other_count": len(others),
                       "error": None}


# ── Routes ────────────────────────────────────────────────────────────────────

@tv_bp.route("/list", methods=["GET"])
def list_devices():
    try:
        return jsonify({"success": True, "devices": _get_all_devices()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@tv_bp.route("/scan", methods=["POST"])
def start_scan():
    if _scan_state.get("status") == "scanning":
        return jsonify({"success": True, "message": "Scan already running"})
    threading.Thread(target=_run_scan, daemon=True, name="tv-scan").start()
    return jsonify({"success": True, "message": "Scan started"})


@tv_bp.route("/scan/status", methods=["GET"])
def scan_status():
    with _scan_lock:
        return jsonify({"success": True, **_scan_state})


@tv_bp.route("/probe", methods=["POST"])
def probe_ip():
    data = request.get_json(force=True)
    ip = (data.get("ip") or "").strip()
    if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip) or \
       any(int(o) > 255 for o in ip.split(".")):
        return jsonify({"success": False, "error": "valid IPv4 required"}), 400

    tv_type, open_ports = _classify_by_ports(ip)
    mac = _get_mac(ip)
    vendor = _oui_vendor(mac)

    if tv_type:
        _upsert_device(ip, tv_type, mac=mac, model=f"{tv_type} TV")
        try:
            with get_conn() as conn:
                row = conn.execute(
                    "SELECT id FROM tv_devices WHERE ip=? AND tv_type=? "
                    "ORDER BY id DESC LIMIT 1", (ip, tv_type)
                ).fetchone()
            dev_id = row[0] if row else None
        except Exception:
            dev_id = None
        return jsonify({
            "success": True, "monitorable": True, "id": dev_id,
            "ip": ip, "tv_type": tv_type, "mac": mac, "vendor": vendor,
            "open_ports": open_ports,
            "message": f"{tv_type} TV found and registered — label it (TV1–TV7) to start monitoring.",
        })

    if mac or _ping(ip):
        return jsonify({
            "success": True, "monitorable": False, "ip": ip,
            "mac": mac, "vendor": vendor,
            "message": "Device responds but exposes no monitorable TV port — "
                       "WiFi ON/OFF cannot track this TV; it needs the BT plug.",
        })

    return jsonify({
        "success": True, "monitorable": False, "ip": ip,
        "message": "No response — is the TV ON and on the same WiFi as the meter?",
    })


@tv_bp.route("/status", methods=["GET"])
def tv_status():
    import json as _json
    state_path = "/var/lib/tv_monitor_state.json"
    try:
        with open(state_path, "r") as f:
            states = _json.load(f)
    except (FileNotFoundError, ValueError):
        states = {}
    return jsonify({"success": True, "states": states})


@tv_bp.route("/label", methods=["POST"])
def label_device():
    data = request.get_json(force=True)
    device_id = data.get("id")
    mac = data.get("mac")
    ip = data.get("ip")
    label = data.get("label")

    VALID_LABELS = {"TV1", "TV2", "TV3", "TV4", "TV5", "TV6", "TV7"}
    if label is not None:
        label = label.strip()
        if label not in VALID_LABELS:
            return jsonify({"success": False, "error": "label must be one of TV1–TV7"}), 400

    try:
        with get_conn() as conn:
            # Fallback lookup if id was not provided
            if not isinstance(device_id, int):
                if mac:
                    row = conn.execute("SELECT id FROM tv_devices WHERE mac=?", (mac,)).fetchone()
                    if row:
                        device_id = row[0]
                elif ip:
                    row = conn.execute("SELECT id FROM tv_devices WHERE ip=?", (ip,)).fetchone()
                    if row:
                        device_id = row[0]

            if not isinstance(device_id, int):
                return jsonify({"success": False, "error": "id (int) or valid mac/ip required"}), 400

            if label:
                conn.execute("UPDATE tv_devices SET label=NULL WHERE label=?", (label,))
            conn.execute("UPDATE tv_devices SET label=? WHERE id=?", (label, device_id))
            conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@tv_bp.route("/remove", methods=["POST"])
def remove_device():
    data = request.get_json(force=True)
    device_id = data.get("id")
    if not isinstance(device_id, int):
        return jsonify({"success": False, "error": "id (int) required"}), 400
    try:
        with get_conn() as conn:
            conn.execute("DELETE FROM tv_devices WHERE id=?", (device_id,))
            conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@tv_bp.route("/verify-poll", methods=["GET"])
def verify_poll():
    """Poll TV state during Step 6 Wi-Fi Calibration."""
    dev_id = request.args.get("id", type=int)
    if not dev_id:
        return jsonify({"success": False, "error": "id parameter required"}), 400

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, ip, tv_type, mac, label FROM tv_devices WHERE id=?", (dev_id,)
        ).fetchone()

    if not row:
        return jsonify({"success": False, "error": "Device not found"}), 404

    tv_id, ip, tv_type, mac, label = row

    # 1. Check TCP TV ports
    tv_ports = [p for p, b in TV_PORT_MAP.items() if b == tv_type] or [8001, 8008, 3000, 5555, 6466]
    port_open = any(_tcp_open(ip, p) for p in tv_ports)

    # 2. Check Samsung REST API standby if applicable
    samsung_standby = False
    if tv_type == "samsung" and port_open:
        try:
            r = requests.get(f"http://{ip}:8001/api/v2/", timeout=1.0)
            if r.status_code == 200:
                p_state = r.json().get("device", {}).get("PowerState", "").lower()
                if p_state == "standby":
                    samsung_standby = True
        except Exception:
            pass

    # 3. Check ICMP ping
    ping_alive = _ping(ip)

    # Classify state
    if samsung_standby:
        state = "STANDBY"
    elif port_open:
        state = "ON"
    elif ping_alive:
        state = "STANDBY"
    else:
        state = "OFF"

    return jsonify({
        "success": True,
        "id": tv_id,
        "ip": ip,
        "tv_type": tv_type,
        "state": state,  # "ON" | "STANDBY" | "OFF"
        "port_open": port_open,
        "ping_alive": ping_alive
    })