#!/usr/bin/env python3
# api/guests.py — Guest management routes

from flask import Blueprint, jsonify, request
from .config import METER_ID
from .db import load_guests_data, save_guests_data
from .collector_service import publish_guest_event

guests_bp = Blueprint("guests", __name__)


@guests_bp.route("", methods=["GET"])
def get_guests():
    guests = load_guests_data()
    return jsonify({"success": True, "guests": guests, "count": len(guests)})


@guests_bp.route("/update", methods=["POST"])
def update_guests():
    """Replace guest list and publish to MQTT (Type 4)."""
    data       = request.get_json(force=True) or {}
    guest_list = data.get("guests") or data.get("Details", {}).get("guests", [])
    try:
        save_guests_data(guest_list)
        publish_guest_event(guest_list)
        return jsonify({"success": True, "count": len(guest_list)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@guests_bp.route("/count", methods=["GET"])
def guest_count():
    return jsonify({"success": True, "count": len(load_guests_data())})
