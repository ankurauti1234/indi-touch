#!/usr/bin/env python3
# api/onboarding.py — Onboarding flow: installation check, hhid, OTP, finalize, BLE plug pairing & calibration

import json
import os
import sqlite3
import subprocess
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


@onboarding_bp.route("/status", methods=["GET"])
def onboarding_status():
    return jsonify({
        "installed": is_installation_done(),
        "meter_id":  METER_ID,
    })


@onboarding_bp.route("/mark_done", methods=["POST"])
def onboarding_mark_done():
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
    """Step 3: Fetch members from cloud, save to DB, mark installation done."""
    hhid = load_hhid()
    if not hhid:
        return jsonify({"success": False, "error": "HHID not set"}), 400

    # Ensure we use fresh Meter ID
    from .config import get_meter_id
    mid = get_meter_id()
    members = []

    try:
        url = f"{MEMBERS_URL}?meterid={mid}&hhid={hhid}"
        print(f"[ONBOARD] Finalizing: GET {url}")
        
        resp = http_requests.get(url, timeout=TIMEOUT)
        print(f"[ONBOARD] Cloud Status: {resp.status_code}")
        
        # Log response body for debugging
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

        set_installation_done()
        set_current_state("main")
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


# ── BLE SMART PLUG: DISCOVERY, PAIRING & CALIBRATION ─────────────────────────

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
        # Quick 3-second bluetoothctl discovery
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
                        "is_paired": (paired_mac and mac == paired_mac)
                    })
    except Exception as e:
        print(f"[BLE-SCAN] Error: {e}")

    # Fallback: if database has recorded a plug recently, ensure it is in the list
    if os.path.exists(TV_MONITOR_DB):
        try:
            conn = sqlite3.connect(TV_MONITOR_DB)
            row = conn.execute("SELECT plug_id FROM tv_events ORDER BY id DESC LIMIT 1").fetchone()
            conn.close()
            if row and row[0]:
                db_mac = row[0].upper().strip()
                if not any(d["mac"] == db_mac for d in devices):
                    devices.append({
                        "name": "TV-SmartPlug",
                        "mac": db_mac,
                        "is_paired": (paired_mac and db_mac == paired_mac)
                    })
        except Exception:
            pass

    return jsonify({"success": True, "devices": devices, "paired_mac": paired_mac})


@onboarding_bp.route("/ble/pair", methods=["POST"])
def ble_pair():
    """Saves chosen MAC to /var/lib/apm/meter_config.json."""
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

    return jsonify({"success": True, "paired_mac": mac})


@onboarding_bp.route("/ble/live-watt", methods=["GET"])
def ble_live_watt():
    """Returns the most recent wattage, plug link status, and state from SQLite."""
    if not os.path.exists(TV_MONITOR_DB):
        return jsonify({"connected": False, "watt": 0.0, "state": "UNKNOWN"})

    try:
        conn = sqlite3.connect(TV_MONITOR_DB)
        status = conn.execute("SELECT last_seen_plug, current_state FROM monitor_status WHERE id = 1").fetchone()
        recent_event = conn.execute("SELECT power_w, state, ts FROM tv_events ORDER BY id DESC LIMIT 1").fetchone()
        conn.close()

        now = int(time.time())
        is_connected = False
        if status and status[0]:
            is_connected = (now - status[0]) < 120  # Link active within 120s grace period

        watt = 0.0
        state = status[1] if status else "OFF"
        if recent_event and recent_event[0] is not None:
            watt = float(recent_event[0])

        return jsonify({
            "connected": is_connected,
            "watt": watt,
            "state": state
        })
    except Exception as e:
        return jsonify({"connected": False, "watt": 0.0, "error": str(e)})


@onboarding_bp.route("/ble/calibrate", methods=["POST"])
def ble_calibrate():
    """Saves computed ON/OFF thresholds into tv_calibration.json."""
    data = request.get_json(force=True) or {}
    on_baseline = float(data.get("on_baseline", 50.0))
    off_baseline = float(data.get("off_baseline", 2.0))

    off_threshold = min(off_baseline + 3.0, (on_baseline + off_baseline) / 2.0)
    on_threshold = max(off_threshold + 5.0, (on_baseline + off_baseline) / 2.0)

    cal = {
        "on_threshold_low": round(on_threshold, 1),
        "off_threshold_high": round(off_threshold, 1),
        "ambiguous_seconds": 30,
        "confirm_seconds": 5,
        "quality": "good" if (on_baseline - off_baseline) >= 15 else "marginal",
        "calibrated_at": int(time.time()),
        "on_max_w": on_baseline,
        "off_max_w": off_baseline
    }

    os.makedirs(os.path.dirname(TV_CALIBRATION_FILE), exist_ok=True)
    with open(TV_CALIBRATION_FILE, "w") as f:
        json.dump(cal, f, indent=4)

    return jsonify({"success": True, "calibration": cal})