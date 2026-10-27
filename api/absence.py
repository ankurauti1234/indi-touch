#!/usr/bin/env python3
# api/absence.py — Household Absence / Vacation Mode Endpoint

from flask import Blueprint, request, jsonify
import time
from .collector_service import send_event

absence_bp = Blueprint("absence", __name__)

@absence_bp.route("/absence", methods=["POST"])
def set_absence():
    data = request.get_json() or {}
    start_time = data.get("start_time", int(time.time()))
    end_time = data.get("end_time")

    if not end_time:
        return jsonify({"success": False, "error": "Missing end_time parameter"}), 400

    # Calculate days away
    days = max(1, round((end_time - start_time) / 86400))

    # Event Type 5 Details
    event_details = {
        "status": "START",
        "start_time": int(start_time),
        "end_time": int(end_time),
        "days": days
    }

    try:
        # Dispatch Event Type 5 to data-collector
        send_event("5", event_details)
        return jsonify({"success": True, "details": event_details})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500