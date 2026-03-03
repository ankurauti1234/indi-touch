#!/usr/bin/env python3
# api/onboarding.py — Onboarding flow: installation check, hhid, OTP, finalize

import os
import requests as http_requests
from flask import Blueprint, jsonify, request

from .config import (
    METER_ID, SYSTEM_FILES, INITIATE_URL, VERIFY_URL, MEMBERS_URL,
    load_hhid, save_hhid, is_installation_done, set_installation_done, set_current_state,
)
from .db import save_members_data

onboarding_bp = Blueprint("onboarding", __name__)

TIMEOUT = 30  # seconds for external HTTP calls


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
        print(f"[ONBOARD] Cloud Response: {resp.status_code} - {resp.text}")
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
        print(f"[ONBOARD] Cloud Response: {resp.status_code} - {resp.text}")
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
