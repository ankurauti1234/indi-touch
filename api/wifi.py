#!/usr/bin/env python3
# api/wifi.py — WiFi scan, connect, disconnect routes

import configparser
import subprocess
import time
from io import StringIO
from pathlib import Path

from flask import Blueprint, jsonify, request

from .config import SYSTEM_FILES

wifi_bp = Blueprint("wifi", __name__)


def _run(cmd: list) -> tuple[bool, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True, r.stdout
    except subprocess.CalledProcessError as e:
        return False, e.stderr
    except Exception as e:
        return False, str(e)


# ── GET /api/wifi/status ──────────────────────────────────────────────────────
@wifi_bp.route("/status")
def wifi_status():
    """Fast status check via /run file (no nmcli needed)."""
    connected = SYSTEM_FILES["wifi_up"] and __import__("os").path.exists(SYSTEM_FILES["wifi_up"])
    return jsonify({"connected": connected})


# ── GET /api/wifi/current ─────────────────────────────────────────────────────
@wifi_bp.route("/current")
def current_wifi():
    ok, out = _run(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"])
    if not ok:
        return jsonify({"connected": False, "error": "nmcli failed"}), 500
    for line in out.strip().splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        name, ctype, device = parts
        if ctype == "802-11-wireless" and (device.startswith("wlan") or device.startswith("wlx")):
            return jsonify({"connected": True, "ssid": name})
    return jsonify({"connected": False})


# ── GET /api/wifi/networks ────────────────────────────────────────────────────
@wifi_bp.route("/networks")
def list_networks():
    """Scan available Wi-Fi networks + merge with saved NetworkManager connections."""
    # Rescan
    _run(["sudo", "nmcli", "device", "wifi", "rescan"])
    time.sleep(2.5)

    ok, out = _run(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"])
    if not ok:
        return jsonify({"success": False, "error": "Scan failed"}), 500

    merged: dict[str, dict] = {}
    for line in out.strip().splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3 or not parts[0].strip():
            continue
        ssid, signal, security = parts[0].strip(), parts[1].strip(), parts[2].strip() or "Open"
        if ssid not in merged:
            merged[ssid] = {
                "ssid":     ssid,
                "signal":   int(signal) if signal.isdigit() else 0,
                "security": security,
                "saved":    False,
                "password": None,
                "open":     security.lower() in ("--", "open", ""),
            }

    # Add saved from NetworkManager (ONLY if they are also in the scan results)
    nm_dir = Path("/etc/NetworkManager/system-connections")
    if nm_dir.exists():
        ok2, file_list = _run(["sudo", "ls", str(nm_dir)])
        if ok2:
            for fname in file_list.strip().splitlines():
                fpath = nm_dir / fname.strip()
                ok3, content = _run(["sudo", "cat", str(fpath)])
                if not ok3:
                    continue
                parser = configparser.RawConfigParser()
                try:
                    parser.read_string(content, source=fname)
                except Exception:
                    continue

                def safe(sec, key):
                    try:
                        return parser.get(sec, key)
                    except Exception:
                        return None

                ssid = (safe("wifi", "ssid") or safe("802-11-wireless", "ssid") or safe("connection", "id") or "").strip().strip('"\'')
                if not ssid:
                    continue
                    
                # Match against scanned networks
                if ssid in merged:
                    merged[ssid]["saved"] = True
                    km = (safe("wifi-security", "key-mgmt") or safe("802-11-wireless-security", "key-mgmt") or "none").lower()
                    pwd = safe("wifi-security", "psk") if km in ("wpa-psk", "wpa-eap") else ""
                    merged[ssid]["password"] = pwd if merged[ssid]["password"] is None else merged[ssid]["password"]

    result = sorted(merged.values(), key=lambda x: (not x["saved"], -x["signal"]))
    return jsonify({"success": True, "networks": result})


# ── POST /api/wifi/connect ────────────────────────────────────────────────────
@wifi_bp.route("/connect", methods=["POST"])
def wifi_connect():
    data = request.get_json() or {}
    ssid = data.get("ssid", "").strip()
    pwd  = data.get("password", "").strip()
    if not ssid:
        return jsonify({"success": False, "error": "SSID required"}), 400

    # Remove old saved connection (ignore errors)
    _run(["sudo", "nmcli", "connection", "delete", ssid])

    if pwd:
        cmd = ["sudo", "nmcli", "device", "wifi", "connect", ssid, "password", pwd]
    else:
        # Open network — no password
        cmd = ["sudo", "nmcli", "device", "wifi", "connect", ssid]

    ok, out = _run(cmd)
    if not ok:
        return jsonify({"success": False, "error": "Connection failed", "details": out.strip()}), 500

    # Touch the /run flag (nmcli success ≈ connected)
    try:
        subprocess.run(f"echo 1 | sudo tee {SYSTEM_FILES['wifi_up']}", shell=True, check=True)
    except Exception:
        pass

    print(f"[WiFi] Connected to {ssid}")
    return jsonify({"success": True, "ssid": ssid})


# ── POST /api/wifi/disconnect ─────────────────────────────────────────────────
@wifi_bp.route("/disconnect", methods=["POST"])
def wifi_disconnect():
    ok, _ = _run(["sudo", "nmcli", "device", "disconnect", "wlan0"])
    return jsonify({"success": ok})
