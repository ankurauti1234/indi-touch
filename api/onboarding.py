#!/usr/bin/env python3
# api/onboarding.py — Onboarding flow: installation check, hhid, OTP, finalize, BLE plug pairing & calibration

import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import requests as http_requests
from flask import Blueprint, jsonify, request

from .config import (
    METER_ID, SYSTEM_FILES, INITIATE_URL, VERIFY_URL, MEMBERS_URL,
    load_hhid, save_hhid, is_installation_done, set_installation_done, set_current_state,
)
from .db import save_members_data

onboarding_bp = Blueprint("onboarding", __name__)

TIMEOUT = 30  # seconds for external HTTP calls

TV_MONITOR_DB = os.environ.get("TV_MONITOR_DB", "/var/lib/apm/tv-monitor.db")
METER_CONFIG_FILE = os.environ.get("METER_CONFIG", "/var/lib/apm/meter_config.json")
TV_CALIBRATION_FILE = "/var/lib/apm/tv_calibration.json"
TARGET_PREFIXES = ["TV-SMARTPLUG", "INDI-PLUG", "TV-SMARTPLUG-V2", "IP"]
SEC_SCRIPT_PATH = "/opt/apm/scripts/tv-status/ble_plug_sec.py"

# Regex parsing stdout from ble_plug_sec.py:
# e.g.: [AC:A7:04:A0:A7:E6] (IP000026) Live Load: 38.00 Watts | TV Status: [ON]
WATT_REGEX = re.compile(r"\[([0-9A-Fa-f:]+)\].*?Live Load:\s*([\d.]+)\s*Watts\s*\|\s*TV Status:\s*\[(ON|OFF)\]")

# ── Subprocess State for ble_plug_sec.py ──────────────────────────────────────
_sec_process = None
_sec_thread = None
_proc_lock = threading.Lock()
_last_reading = {
    "connected": False,
    "watt": 0.0,
    "state": "OFF",
    "mac": None,
    "last_seen": 0
}


def _read_sec_output(proc):
    global _last_reading
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            line_str = line.strip()
            match = WATT_REGEX.search(line_str)
            if match:
                mac, watt_str, status = match.groups()
                _last_reading = {
                    "connected": True,
                    "watt": float(watt_str),
                    "state": status,
                    "mac": mac,
                    "last_seen": time.time()
                }
    except Exception as e:
        print(f"[BLE-SEC-RUNNER] Stream read note: {e}")
    finally:
        if proc.stdout:
            proc.stdout.close()


def ensure_sec_monitor_running():
    global _sec_process, _sec_thread
    with _proc_lock:
        if _sec_process is None or _sec_process.poll() is not None:
            if os.path.exists(SEC_SCRIPT_PATH):
                try:
                    # Pass paired MAC argument if already present
                    cmd = ["/usr/bin/python3", SEC_SCRIPT_PATH]
                    if os.path.exists(METER_CONFIG_FILE):
                        try:
                            with open(METER_CONFIG_FILE, "r") as f:
                                cdata = json.load(f)
                                pm = cdata.get("paired_mac_address")
                                if pm:
                                    cmd.extend(["--mac", pm.upper().strip()])
                        except Exception:
                            pass

                    print(f"[BLE-SEC-RUNNER] Starting {cmd}")
                    _sec_process = subprocess.Popen(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        text=True,
                        bufsize=1
                    )
                    _sec_thread = threading.Thread(target=_read_sec_output, args=(_sec_process,), daemon=True)
                    _sec_thread.start()
                except Exception as ex:
                    print(f"[BLE-SEC-RUNNER] Failed to start: {ex}")


def stop_sec_monitor():
    global _sec_process
    with _proc_lock:
        if _sec_process and _sec_process.poll() is None:
            try:
                _sec_process.terminate()
                _sec_process.wait(timeout=2)
            except Exception:
                try:
                    _sec_process.kill()
                except Exception:
                    pass
            _sec_process = None
            print("[BLE-SEC-RUNNER] Stopped")


# ── Existing Routes ───────────────────────────────────────────────────────────

@onboarding_bp.route("/status", methods=["GET"])
def onboarding_status():
    return jsonify({
        "installed": is_installation_done(),
        "meter_id":  METER_ID,
    })


@onboarding_bp.route("/mark_done", methods=["POST"])
def onboarding_mark_done():
    stop_sec_monitor()
    set_installation_done()
    return jsonify({"success": True})


@onboarding_bp.route("/check_installation", methods=["GET"])
def check_installation():
    return jsonify({
        "installed": is_installation_done(),
        "meter_id":  METER_ID,
    })


@onboarding_bp.route("/initiate-assignment", methods=["POST"])
def initiate_assignment():
    """Step 4: Send HHID to cloud to initiate OTP.
    HH is hardcoded, user sends 4 digits.
    """
    digits = (request.get_json(force=True) or {}).get("hhid", "").strip()
    if not digits or len(digits) != 4 or not digits.isdigit():
        return jsonify({"success": False, "error": "4-digit HHID required"}), 400

    hhid = f"HH{digits}"
    save_hhid(hhid)
    set_current_state("hhid_input")
    
    print(f"[ONBOARD] Initiating assignment for METER:{METER_ID}, HHID:{hhid}")
    try:
        resp = http_requests.post(INITIATE_URL, json={"meter_id": METER_ID, "hhid": hhid}, timeout=TIMEOUT)
        print(f"[ONBOARD] Cloud Response: {resp.status_code}\n{resp.text}")
        data = resp.json()
        set_current_state("otp_verification")
        return jsonify({"success": data.get("success", False), "message": data.get("message")})
    except http_requests.Timeout:
        return jsonify({"success": False, "error": "Request timed out"}), 504
    except http_requests.ConnectionError:
        return jsonify({"success": False, "error": "No internet connection"}), 503
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@onboarding_bp.route("/verify-otp", methods=["POST"])
def verify_otp():
    """Step 2: Verify OTP with cloud."""
    data = request.get_json(force=True) or {}
    hhid = data.get("hhid") or load_hhid()
    otp  = data.get("otp", "").strip()
    if not hhid or not otp:
        return jsonify({"success": False, "error": "hhid and otp required"}), 400

    print(f"[ONBOARD] Verifying OTP for METER:{METER_ID}, HHID:{hhid}, OTP:{otp}")
    try:
        resp = http_requests.post(VERIFY_URL, json={"meter_id": METER_ID, "hhid": hhid, "otp": otp}, timeout=TIMEOUT)
        print(f"[ONBOARD] Cloud Response: {resp.status_code}\n{resp.text}")
        result = resp.json()
        if result.get("success"):
            save_hhid(hhid)
            set_current_state("input_source_detection")
        return jsonify({"success": result.get("success", False), "message": result.get("message")})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@onboarding_bp.route("/connectivity", methods=["GET"])
def connectivity():
    """Check WiFi, Jack, HDMI, and Video Detection status."""
    return jsonify({
        "success": True,
        "wifi":    os.path.exists(SYSTEM_FILES["wifi_up"]),
        "jack":    os.path.exists(SYSTEM_FILES["jack_status"]),
        "hdmi":    os.path.exists(SYSTEM_FILES["hdmi_input"]),
        "video":   os.path.exists(SYSTEM_FILES["video_detection"])
    })


@onboarding_bp.route("/input_sources", methods=["GET"])
def input_sources():
    """Legacy/Simplified detect for backward compatibility."""
    sources = []
    if os.path.exists(SYSTEM_FILES["jack_status"]):
        sources.append("line_in")
    if os.path.exists(SYSTEM_FILES["hdmi_input"]):
        sources.append("HDMI")
    return jsonify({"success": bool(sources), "sources": sources})


@onboarding_bp.route("/finalize", methods=["POST"])
def finalize():
    """Step 3/9: Fetch members from cloud, save to DB, mark installation done, and start production monitor."""
    # Ensure temporary calibration process is halted
    stop_sec_monitor()

    hhid = load_hhid()
    if not hhid:
        return jsonify({"success": False, "error": "HHID not set"}), 400

    from .config import get_meter_id
    mid = get_meter_id()
    members = []

    try:
        url = f"{MEMBERS_URL}?meterid={mid}&hhid={hhid}"
        print(f"[ONBOARD] Finalizing: GET {url}")
        
        resp = http_requests.get(url, timeout=TIMEOUT)
        print(f"[ONBOARD] Cloud Status: {resp.status_code}")
        
        try:
            data = resp.json()
            print(f"[ONBOARD] Cloud Data: {data}")
        except Exception as je:
            print(f"[ONBOARD] JSON Parse Error: {je}")
            print(f"[ONBOARD] Raw Body: {resp.text[:500]}")
            return jsonify({"success": False, "error": "Invalid cloud response format"}), 502

        if data.get("success"):
            raw_members = data.get("members", [])
            for m in raw_members:
                if all(k in m for k in ["member_code", "dob", "gender"]):
                    members.append({
                        "member_code": m["member_code"],
                        "name":        m.get("name", m["member_code"]),
                        "dob":         m["dob"],
                        "gender":      m["gender"],
                        "created_at":  m.get("created_at"),
                        "avatar_url":  m.get("avatar_url"),
                        "active":      False,
                    })
            
            save_members_data({"meter_id": mid, "hhid": hhid, "members": members})
            print(f"[ONBOARD] Saved {len(members)} members to DB.")

        # Mark installation complete on disk
        set_installation_done()
        set_current_state("main")

        # Start and enable the production BLE monitor daemon
        try:
            subprocess.run(["sudo", "systemctl", "enable", "--now", "ble-plug-monitor.service"], check=False)
            print("[ONBOARD] ble-plug-monitor.service enabled and started.")
        except Exception as se:
            print(f"[ONBOARD] Failed to start ble-plug-monitor.service: {se}")

        return jsonify({
            "success": data.get("success", False), 
            "member_count": len(members),
            "message": data.get("message", "Success")
        })

    except http_requests.Timeout:
        return jsonify({"success": False, "error": "Cloud request timed out"}), 504
    except Exception as e:
        print(f"[ONBOARD] Finalize Error: {e}")
        return jsonify({"success": False, "error": f"Internal error: {str(e)}"}), 500


# ── BLE SMART PLUG: DISCOVERY, PAIRING & LIVE TELEMETRY ──────────────────────

@onboarding_bp.route("/ble/scan", methods=["GET"])
def ble_scan():
    """Scans for nearby Smart Plugs matching target prefixes."""
    paired_mac = None
    if os.path.exists(METER_CONFIG_FILE):
        try:
            with open(METER_CONFIG_FILE, "r") as f:
                cdata = json.load(f)
                paired_mac = cdata.get("paired_mac_address")
                if paired_mac:
                    paired_mac = paired_mac.upper().strip()
        except Exception:
            pass

    devices = []
    try:
        subprocess.run(["bluetoothctl", "--timeout", "3", "scan", "on"], capture_output=True, text=True)
        out = subprocess.run(["bluetoothctl", "devices"], capture_output=True, text=True).stdout
        for line in out.strip().split("\n"):
            parts = line.split(" ", 2)
            if len(parts) >= 3 and parts[0] == "Device":
                mac = parts[1].upper().strip()
                name = parts[2].strip()
                if any(p in name.upper() for p in TARGET_PREFIXES) or (paired_mac and mac == paired_mac):
                    devices.append({
                        "name": name,
                        "mac": mac,
                        "is_paired": bool(paired_mac and mac == paired_mac)
                    })
    except Exception as e:
        print(f"[BLE-SCAN] Error: {e}")

    # Fallback to database or paired config if not seen in immediate 3s scan
    if paired_mac and not any(d["mac"] == paired_mac for d in devices):
        devices.insert(0, {
            "name": "Paired SmartPlug",
            "mac": paired_mac,
            "is_paired": True
        })

    return jsonify({"success": True, "devices": devices, "paired_mac": paired_mac})


@onboarding_bp.route("/ble/pair", methods=["POST"])
def ble_pair():
    """Saves chosen MAC to /var/lib/apm/meter_config.json and restarts the monitor process."""
    data = request.get_json(force=True) or {}
    mac = data.get("mac", "").upper().strip()
    if not mac:
        return jsonify({"success": False, "error": "MAC address required"}), 400

    os.makedirs(os.path.dirname(METER_CONFIG_FILE), exist_ok=True)
    cfg = {}
    if os.path.exists(METER_CONFIG_FILE):
        try:
            with open(METER_CONFIG_FILE, "r") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}

    cfg["paired_mac_address"] = mac
    cfg["paired_at"] = int(time.time())

    with open(METER_CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=4)

    # Stop current process so next reading restarts with this newly chosen MAC
    stop_sec_monitor()
    ensure_sec_monitor_running()

    return jsonify({"success": True, "paired_mac": mac})


@onboarding_bp.route("/ble/live-watt", methods=["GET"])
def ble_live_watt():
    """Returns real-time wattage directly from the running ble_plug_sec.py instance."""
    ensure_sec_monitor_running()

    now = time.time()
    is_live = (now - _last_reading["last_seen"]) < 4.0 if _last_reading["last_seen"] else False

    # Primary check: reading from running ble_plug_sec.py process
    if is_live:
        return jsonify({
            "connected": True,
            "watt": _last_reading["watt"],
            "state": _last_reading["state"],
            "mac": _last_reading["mac"]
        })

    # Secondary check: SQLite database fallback
    if os.path.exists(TV_MONITOR_DB):
        try:
            conn = sqlite3.connect(TV_MONITOR_DB)
            status = conn.execute("SELECT last_seen_plug, current_state FROM monitor_status WHERE id = 1").fetchone()
            recent_event = conn.execute("SELECT power_w, state, ts FROM tv_events ORDER BY id DESC LIMIT 1").fetchone()
            conn.close()

            if status and status[0] and (now - status[0]) < 15:
                w = float(recent_event[0]) if (recent_event and recent_event[0] is not None) else 0.0
                return jsonify({
                    "connected": True,
                    "watt": w,
                    "state": status[1] or ("ON" if w >= 10.0 else "OFF")
                })
        except Exception:
            pass

    return jsonify({
        "connected": False,
        "watt": 0.0,
        "state": "DISCONNECTED"
    })


@onboarding_bp.route("/ble/calibrate", methods=["POST"])
def ble_calibrate():
    """Saves computed ON/OFF thresholds into tv_calibration.json and stops the CLI monitor."""
    data = request.get_json(force=True) or {}
    on_baseline = float(data.get("on_baseline", 50.0))
    off_baseline = float(data.get("off_baseline", 2.0))

    # Calculate optimal hysteresis thresholds
    off_threshold = min(off_baseline + 3.0, (on_baseline + off_baseline) / 2.0)
    on_threshold = max(off_threshold + 5.0, (on_baseline + off_baseline) / 2.0)

    quality = "good" if (on_baseline - off_baseline) >= 12.0 else "marginal"
    calibrated_at = int(time.time())

    # Load currently paired MAC for SQLite table consistency
    plug_mac = "UNKNOWN"
    if os.path.exists(METER_CONFIG_FILE):
        try:
            with open(METER_CONFIG_FILE, "r") as f:
                cdata = json.load(f)
                plug_mac = cdata.get("paired_mac_address", "UNKNOWN")
        except Exception:
            pass

    cal = {
        "on_threshold_low": round(on_threshold, 1),
        "off_threshold_high": round(off_threshold, 1),
        "ambiguous_seconds": 30,
        "confirm_seconds": 5,
        "quality": quality,
        "calibrated_at": calibrated_at,
        "on_max_w": on_baseline,
        "off_max_w": off_baseline
    }

    # 1. Save to persistent JSON config
    try:
        os.makedirs(os.path.dirname(TV_CALIBRATION_FILE), exist_ok=True)
        with open(TV_CALIBRATION_FILE, "w") as f:
            json.dump(cal, f, indent=4)
        print(f"[CALIBRATE] Saved {TV_CALIBRATION_FILE}: ON={cal['on_threshold_low']}W, OFF={cal['off_threshold_high']}W")
    except Exception as e:
        print(f"[CALIBRATE] Error saving JSON: {e}")

    # 2. Insert into SQLite calibration table for daemon pickup
    if os.path.exists(TV_MONITOR_DB):
        try:
            with sqlite3.connect(TV_MONITOR_DB) as conn:
                conn.execute(
                    """
                    INSERT INTO calibration (
                        calibrated_at, plug_id, on_threshold_low, off_threshold_high,
                        ambiguous_seconds, confirm_seconds, quality, on_max_seen, off_min_seen
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        calibrated_at, plug_mac, cal["on_threshold_low"], cal["off_threshold_high"],
                        30, 5, quality, on_baseline, off_baseline
                    )
                )
                conn.commit()
            print(f"[CALIBRATE] Inserted calibration record into {TV_MONITOR_DB}")
        except Exception as e:
            print(f"[CALIBRATE] SQLite insert error: {e}")

    # 3. Cleanly terminate the temporary onboarding BLE process
    stop_sec_monitor()

    return jsonify({"success": True, "calibration": cal})

@onboarding_bp.route("/ble/stop-monitor", methods=["POST"])
def ble_stop_monitor():
    """Manually stops the CLI monitor process."""
    stop_sec_monitor()
    return jsonify({"success": True})