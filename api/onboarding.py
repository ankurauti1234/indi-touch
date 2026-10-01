#!/usr/bin/env python3
# api/onboarding.py — Onboarding flow: installation check, hhid, OTP, finalize

import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
import requests as http_requests
from flask import Blueprint, jsonify, request

from .config import (
    API_BASE, METER_ID, SYSTEM_FILES, INITIATE_URL, VERIFY_URL, MEMBERS_URL,
    load_hhid, save_hhid, is_installation_done, set_installation_done,
    set_current_state, current_state,
)
from .db import get_conn, load_members_data, save_members_data
from .settings_manager import load_settings, save_settings

onboarding_bp = Blueprint("onboarding", __name__)

TIMEOUT = 30  # seconds for external HTTP calls


def _otp_security_state():
    with get_conn() as conn:
        row = conn.execute(
            "SELECT failed_attempts, locked_until, resend_after FROM onboarding_security WHERE id = 1"
        ).fetchone()
    return row or (0, 0, 0)


def _save_otp_security_state(failed_attempts, locked_until, resend_after):
    with get_conn() as conn:
        conn.execute(
            "UPDATE onboarding_security SET failed_attempts = ?, locked_until = ?, resend_after = ? WHERE id = 1",
            (failed_attempts, locked_until, resend_after),
        )


def _mask_phone(value):
    digits = re.sub(r"\D", "", str(value or ""))
    return f"••••{digits[-2:]}" if len(digits) >= 2 else ""


def _mask_household_name(value):
    name = " ".join(str(value or "").split())
    if not name:
        return ""
    if "*" in name:
        return name
    words = name.split()
    if len(words) > 1 and words[-1].lower() in {"family", "household"}:
        return f"{words[0][:2]}*** {words[-1]}"
    return f"{name[:2]}***"


@onboarding_bp.route("/status", methods=["GET"])
def onboarding_status():
    state = current_state()
    match = re.fullmatch(r"onboarding:(\d+)", state)
    settings = load_settings()
    attempts, locked_until, resend_after = _otp_security_state()
    now = time.time()
    return jsonify({
        "installed": is_installation_done(),
        "meter_id":  METER_ID,
        "step": int(match.group(1)) if match else 1,
        "support_code": METER_ID,
        "support_phone": os.environ.get("INDI_SUPPORT_PHONE", ""),
        "pending_household_confirmation": settings.get("onboardingPendingHouseholdConfirmation", False),
        "masked_household_name": settings.get("onboardingMaskedHouseholdName", ""),
        "masked_phone": settings.get("onboardingMaskedPhone", ""),
        "otp_verified": settings.get("onboardingOtpVerified", False),
        "otp_locked": locked_until > now,
        "otp_retry_after": max(0, int(locked_until - now)),
        "otp_resend_after": max(0, int(resend_after - now)),
    })


@onboarding_bp.route("/progress", methods=["POST"])
def save_onboarding_progress():
    data = request.get_json(silent=True) or {}
    step = data.get("step")
    if not isinstance(step, int) or step < 1 or step > 7:
        return jsonify({"success": False, "error": "Invalid onboarding step"}), 400
    if is_installation_done():
        return jsonify({"success": False, "error": "Setup is already complete"}), 409
    settings = load_settings()
    state = current_state()
    match = re.fullmatch(r"onboarding:(\d+)", state)
    current_step = int(match.group(1)) if match else (1 if state == "welcome" else 0)
    if current_step and step > current_step + 1:
        return jsonify({"success": False, "error": "Complete the current setup step first"}), 409
    if not current_step and step > 4:
        return jsonify({"success": False, "error": "Resume setup from the beginning"}), 409
    if step == 5 and not settings.get("onboardingOtpVerified") and (
        not settings.get("onboardingPendingHouseholdConfirmation")
        or data.get("household_confirmed") is not True
    ):
        return jsonify({"success": False, "error": "Confirm the household before continuing"}), 409
    if step >= 6 and not settings.get("onboardingOtpVerified", False):
        return jsonify({"success": False, "error": "Verify the household before continuing"}), 409
    if step == 7 and not data.get("roster_confirmed"):
        return jsonify({"success": False, "error": "Confirm the household roster first"}), 409
    set_current_state(f"onboarding:{step}")
    if step == 7:
        save_settings({"onboardingRosterConfirmed": True})
    elif step < 7 and settings.get("onboardingRosterConfirmed"):
        save_settings({"onboardingRosterConfirmed": False})
    return jsonify({"success": True, "step": step})


@onboarding_bp.route("/network-check", methods=["GET"])
def network_check():
    """Verify general internet, provisioning API reachability, signal, and NTP."""
    internet_ok = False
    try:
        internet_response = http_requests.get(
            "https://connectivitycheck.gstatic.com/generate_204", timeout=6
        )
        internet_ok = internet_response.status_code == 204
    except http_requests.RequestException:
        pass

    started = time.monotonic()
    service_reachable = False
    try:
        service_url = f"{urlparse(API_BASE).scheme}://{urlparse(API_BASE).netloc}"
        service_response = http_requests.get(service_url, timeout=8, allow_redirects=False)
        service_reachable = service_response.status_code < 500
    except http_requests.RequestException:
        pass
    latency_ms = round((time.monotonic() - started) * 1000)

    signal = None
    try:
        result = subprocess.run(
            ["nmcli", "-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        for row in result.stdout.splitlines():
            if row.startswith("*:"):
                signal = int(row.split(":", 1)[1])
                break
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass

    ntp_synced = False
    try:
        subprocess.run(
            ["timedatectl", "set-ntp", "true"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = subprocess.run(
                ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                capture_output=True, text=True, timeout=2, check=False,
            )
            ntp_synced = result.returncode == 0 and result.stdout.strip().lower() == "yes"
            if ntp_synced:
                break
            time.sleep(1)
    except (OSError, subprocess.TimeoutExpired):
        pass

    failure_reason = None
    if not internet_ok:
        failure_reason = "internet_unreachable"
    elif not service_reachable:
        failure_reason = "service_unreachable"
    elif not ntp_synced:
        failure_reason = "time_not_synced"

    return jsonify({
        "success": True,
        "internet": internet_ok,
        "service_reachable": service_reachable,
        "latency_ms": latency_ms,
        "signal": signal,
        "ntp_synced": ntp_synced,
        "can_proceed": internet_ok and service_reachable and ntp_synced,
        "failure_reason": failure_reason,
    })


@onboarding_bp.route("/mark_done", methods=["POST"])
def onboarding_mark_done():
    data = request.get_json(silent=True) or {}
    if data.get("accepted") is not True or not data.get("consent_version"):
        return jsonify({"success": False, "error": "Consent is required"}), 400
    if current_state() != "onboarding:7":
        return jsonify({"success": False, "error": "Complete the required setup steps first"}), 409
    settings = load_settings()
    if not settings.get("onboardingOtpVerified") or not settings.get("onboardingRosterConfirmed"):
        return jsonify({"success": False, "error": "Household confirmation is incomplete"}), 409
    if not load_members_data().get("members"):
        return jsonify({"success": False, "error": "Household members are not synced"}), 409
    saved = save_settings({
        "onboardingConsentVersion": data["consent_version"],
        "onboardingConsentAt": datetime.now(timezone.utc).isoformat(),
        "onboardingPendingHouseholdConfirmation": False,
        "onboardingMaskedHouseholdName": "",
        "onboardingMaskedPhone": "",
        "onboardingOtpVerified": False,
        "onboardingRosterConfirmed": False,
    })
    if not saved:
        return jsonify({"success": False, "error": "Could not save consent"}), 500
    set_installation_done()
    set_current_state("main")
    return jsonify({"success": True})


@onboarding_bp.route("/check_installation", methods=["GET"])
def check_installation():
    return jsonify({
        "installed": is_installation_done(),
        "meter_id":  METER_ID,
    })


@onboarding_bp.route("/initiate-assignment", methods=["POST"])
def initiate_assignment():
    """Validate the full household identifier and request its OTP."""
    hhid = str((request.get_json(silent=True) or {}).get("hhid", "")).strip().upper()
    if hhid.isdigit() and len(hhid) == 4:
        hhid = f"HH{hhid}"
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{2,31}", hhid):
        return jsonify({"success": False, "error": "Enter a valid Household ID"}), 400

    try:
        resp = http_requests.post(INITIATE_URL, json={"meter_id": METER_ID, "hhid": hhid}, timeout=TIMEOUT)
        data = resp.json() if resp.ok else {}
        if not isinstance(data, dict) or not data.get("success"):
            return jsonify({"success": False, "error": "Household link could not be verified"}), 400

        save_hhid(hhid)
        resend_after = time.time() + 60
        _save_otp_security_state(0, 0, resend_after)
        raw_phone = data.get("phone_number") or data.get("phone")
        masked_phone = data.get("masked_phone") or _mask_phone(raw_phone)
        masked_name = _mask_household_name(data.get("masked_household_name") or data.get("household_name"))
        save_settings({
            "onboardingPendingHouseholdConfirmation": True,
            "onboardingMaskedHouseholdName": masked_name,
            "onboardingMaskedPhone": masked_phone,
            "onboardingOtpVerified": False,
            "onboardingRosterConfirmed": False,
        })
        set_current_state("onboarding:4")
        return jsonify({
            "success": True,
            "message": "Verification code sent",
            "masked_phone": masked_phone,
            "household_name": masked_name,
            "resend_after": 60,
        })
    except http_requests.Timeout:
        return jsonify({"success": False, "error": "Request timed out"}), 504
    except http_requests.ConnectionError:
        return jsonify({"success": False, "error": "No internet connection"}), 503
    except Exception as e:
        print(f"[ONBOARD] Assignment request failed: {type(e).__name__}")
        return jsonify({"success": False, "error": "Household service unavailable"}), 502


@onboarding_bp.route("/verify-otp", methods=["POST"])
def verify_otp():
    """Verify the OTP with server-side attempt and lockout enforcement."""
    data = request.get_json(force=True) or {}
    hhid = data.get("hhid") or load_hhid()
    otp  = data.get("otp", "").strip()
    if not hhid or not re.fullmatch(r"\d{4}", otp):
        return jsonify({"success": False, "error": "Enter the four-digit verification code"}), 400

    attempts, locked_until, resend_after = _otp_security_state()
    now = time.time()
    if locked_until > now:
        return jsonify({"success": False, "locked": True, "retry_after": int(locked_until - now)}), 429
    if locked_until and locked_until <= now and attempts >= 5:
        attempts = 0
        locked_until = 0
        _save_otp_security_state(attempts, locked_until, resend_after)

    try:
        resp = http_requests.post(VERIFY_URL, json={"meter_id": METER_ID, "hhid": hhid, "otp": otp}, timeout=TIMEOUT)
        result = resp.json() if resp.ok else {}
        if isinstance(result, dict) and result.get("success"):
            save_hhid(hhid)
            _save_otp_security_state(0, 0, resend_after)
            save_settings({
                "onboardingPendingHouseholdConfirmation": False,
                "onboardingMaskedHouseholdName": "",
                "onboardingMaskedPhone": "",
                "onboardingOtpVerified": True,
            })
            set_current_state("onboarding:6")
            return jsonify({"success": True, "message": "Household verified"})

        attempts += 1
        locked_until = now + 600 if attempts >= 5 else 0
        _save_otp_security_state(attempts, locked_until, resend_after)
        return jsonify({
            "success": False,
            "error": "Code not accepted",
            "attempts_remaining": max(0, 5 - attempts),
            "locked": attempts >= 5,
            "retry_after": 600 if attempts >= 5 else 0,
        }), 429 if attempts >= 5 else 400
    except http_requests.Timeout:
        return jsonify({"success": False, "error": "Verification timed out. Try again."}), 504
    except http_requests.RequestException:
        return jsonify({"success": False, "error": "Verification service unavailable"}), 503
    except Exception as e:
        print(f"[ONBOARD] OTP verification failed: {type(e).__name__}")
        return jsonify({"success": False, "error": "Verification service unavailable"}), 502


@onboarding_bp.route("/resend-otp", methods=["POST"])
def resend_otp():
    hhid = load_hhid()
    if not hhid:
        return jsonify({"success": False, "error": "Link a household first"}), 409

    attempts, locked_until, resend_after = _otp_security_state()
    now = time.time()
    if locked_until > now:
        return jsonify({"success": False, "locked": True, "retry_after": int(locked_until - now)}), 429
    if resend_after > now:
        return jsonify({"success": False, "retry_after": int(resend_after - now)}), 429

    try:
        resp = http_requests.post(INITIATE_URL, json={"meter_id": METER_ID, "hhid": hhid}, timeout=TIMEOUT)
        data = resp.json() if resp.ok else {}
        if not isinstance(data, dict) or not data.get("success"):
            return jsonify({"success": False, "error": "A new code could not be sent"}), 400
        resend_after = now + 60
        _save_otp_security_state(attempts, locked_until, resend_after)
        raw_phone = data.get("phone_number") or data.get("phone")
        return jsonify({
            "success": True,
            "masked_phone": data.get("masked_phone") or _mask_phone(raw_phone),
            "retry_after": 60,
        })
    except http_requests.RequestException:
        return jsonify({"success": False, "error": "Verification service unavailable"}), 503


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


@onboarding_bp.route("/self-check", methods=["GET"])
def self_check():
    """Return pre-network readiness checks for the installer wizard."""
    storage_path = os.path.dirname(os.path.abspath(SYSTEM_FILES["install_done"]))
    try:
        disk = shutil.disk_usage(storage_path)
        storage_ok = os.access(storage_path, os.W_OK) and disk.free >= 100 * 1024 * 1024
        storage_detail = f"{disk.free // (1024 * 1024)} MB available"
    except OSError:
        storage_ok = False
        storage_detail = "Application storage is not accessible"

    clock_synced = False
    clock_detail = "Time sync will be checked after network setup"
    try:
        result = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        clock_synced = result.returncode == 0 and result.stdout.strip().lower() == "yes"
        if clock_synced:
            clock_detail = "System clock is synchronized"
    except (OSError, subprocess.TimeoutExpired):
        pass

    wifi_radio = False
    try:
        result = subprocess.run(
            ["nmcli", "radio", "wifi"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        wifi_radio = result.returncode == 0 and result.stdout.strip().lower() == "enabled"
    except (OSError, subprocess.TimeoutExpired):
        pass

    jack = os.path.exists(SYSTEM_FILES["jack_status"])
    hdmi = os.path.exists(SYSTEM_FILES["hdmi_input"])
    gsm = os.path.exists(SYSTEM_FILES["gsm_up"])
    checks = [
        {"id": "storage", "status": "pass" if storage_ok else "fail", "required": True, "detail": storage_detail},
        {"id": "clock", "status": "pass" if clock_synced else "warn", "required": False, "detail": clock_detail},
        {"id": "input", "status": "pass" if jack or hdmi else "warn", "required": False, "detail": "Input detected" if jack or hdmi else "No HDMI or USB audio input detected"},
        {"id": "usb_audio", "status": "pass" if jack else "warn", "required": False, "detail": "USB audio detected" if jack else "USB audio not detected"},
        {"id": "gsm", "status": "pass" if gsm else "warn", "required": False, "detail": "GSM modem detected" if gsm else "GSM modem not detected"},
        {"id": "wifi_radio", "status": "pass" if wifi_radio else "fail", "required": True, "detail": "Wi-Fi radio enabled" if wifi_radio else "Enable the Wi-Fi radio to continue"},
    ]
    return jsonify({"success": True, "can_proceed": all(not c["required"] or c["status"] == "pass" for c in checks), "checks": checks})


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
    """Fetch and save the household roster; completion requires separate consent."""
    hhid = load_hhid()
    if not hhid:
        return jsonify({"success": False, "error": "HHID not set"}), 400
    if not load_settings().get("onboardingOtpVerified", False):
        return jsonify({"success": False, "error": "Household verification is required"}), 409

    # Ensure we use fresh Meter ID
    from .config import get_meter_id
    mid = get_meter_id()
    members = []

    try:
        url = f"{MEMBERS_URL}?meterid={mid}&hhid={hhid}"
        resp = http_requests.get(url, timeout=TIMEOUT)
        try:
            data = resp.json()
        except ValueError:
            return jsonify({"success": False, "error": "Invalid cloud response format"}), 502

        if not resp.ok or not isinstance(data, dict) or not data.get("success"):
            return jsonify({"success": False, "error": "Household member sync failed"}), 502

        raw_members = data.get("members")
        if not isinstance(raw_members, list):
            return jsonify({"success": False, "error": "Invalid household member list"}), 502
        for member in raw_members:
            if isinstance(member, dict) and all(key in member for key in ("member_code", "dob", "gender")):
                members.append({
                    "member_code": member["member_code"],
                    "name": member.get("name", member["member_code"]),
                    "dob": member["dob"],
                    "gender": member["gender"],
                    "created_at": member.get("created_at"),
                    "avatar_url": member.get("avatar_url"),
                    "active": False,
                })
        if not members:
            return jsonify({"success": False, "error": "No valid household members were returned"}), 502

        save_members_data({"meter_id": mid, "hhid": hhid, "members": members})
        set_current_state("onboarding:6")
        return jsonify({
            "success": True,
            "member_count": len(members),
            "message": "Household members synced",
        })

    except http_requests.Timeout:
        return jsonify({"success": False, "error": "Cloud request timed out"}), 504
    except Exception as e:
        print(f"[ONBOARD] Member sync failed: {type(e).__name__}")
        return jsonify({"success": False, "error": "Could not sync household members"}), 500
