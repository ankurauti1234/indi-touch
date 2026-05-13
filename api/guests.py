#!/usr/bin/env python3
# api/guests.py — Guest management routes

from flask import Blueprint, jsonify, request
from .config import METER_ID
from .db import load_guests_data, save_guests_data
from .collector_service import publish_guest_event
import traceback
import json

guests_bp = Blueprint("guests", __name__)


@guests_bp.route("", methods=["GET"])
def get_guests():
    try:
        guests = load_guests_data()

        return jsonify({
            "success": True,
            "guests": guests,
            "count": len(guests)
        })

    except Exception as e:
        print("GET GUESTS ERROR:", str(e))
        traceback.print_exc()

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@guests_bp.route("/add", methods=["POST"])
def add_guest():
    try:
        data = request.get_json(force=True) or {}
        new_guest = data.get("guest")

        if not new_guest:
            return jsonify({
                "success": False,
                "error": "Missing guest"
            }), 400

        guests = load_guests_data()

        # Generate safe ID
        next_id = max([g.get("id", 0) for g in guests], default=0) + 1
        new_guest["id"] = next_id

        guests.append(new_guest)

        # Save guests
        save_guests_data(guests)

        # MQTT/Event payload
        payload = {
            "meter_id": METER_ID,
            "action": "added",
            "guest": new_guest,
            "guests": guests,
            "count": len(guests)
        }

        print("\n========== GUEST ADD EVENT ==========")
        print(json.dumps(payload, indent=2))
        print("Publishing guest add event...")

        try:
            publish_guest_event(guests)
            print("Guest add event published successfully")
        except Exception as mqtt_error:
            print("MQTT PUBLISH ERROR:", str(mqtt_error))
            traceback.print_exc()

        return jsonify({
            "success": True,
            "guest": new_guest,
            "count": len(guests)
        })

    except Exception as e:
        print("ADD GUEST ERROR:", str(e))
        traceback.print_exc()

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@guests_bp.route("/remove", methods=["POST"])
def remove_guest():
    try:
        data = request.get_json(force=True) or {}
        guest_id = data.get("id")

        if guest_id is None:
            return jsonify({
                "success": False,
                "error": "Missing guest ID"
            }), 400

        guests = load_guests_data()

        guests = [g for g in guests if g.get("id") != guest_id]

        save_guests_data(guests)

        payload = {
            "guests": guests,
            "action": "removed",
            "id": guest_id
        }

        print("REMOVE EVENT PAYLOAD:")
        print(payload)

        publish_guest_event(guests)

        return jsonify({
            "success": True,
            "count": len(guests)
        })

    except Exception as e:
        print("REMOVE GUEST ERROR:", str(e))

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@guests_bp.route("/update", methods=["POST"])
def update_guests():
    """
    Replace guest list and publish update event.
    """

    try:
        data = request.get_json(force=True) or {}

        guest_list = (
            data.get("guests")
            or data.get("Details", {}).get("guests", [])
        )

        # Ensure all guests have IDs
        for idx, guest in enumerate(guest_list, start=1):
            if "id" not in guest:
                guest["id"] = idx

        save_guests_data(guest_list)

        payload = {
            "meter_id": METER_ID,
            "action": "updated",
            "guests": guest_list,
            "count": len(guest_list)
        }

        print("\n========== GUEST UPDATE EVENT ==========")
        print(json.dumps(payload, indent=2))
        print("Publishing guest update event...")

        try:
            publish_guest_event(guests)
            print("Guest update event published successfully")
        except Exception as mqtt_error:
            print("MQTT PUBLISH ERROR:", str(mqtt_error))
            traceback.print_exc()

        return jsonify({
            "success": True,
            "count": len(guest_list)
        })

    except Exception as e:
        print("UPDATE GUESTS ERROR:", str(e))
        traceback.print_exc()

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@guests_bp.route("/count", methods=["GET"])
def guest_count():
    try:
        guests = load_guests_data()

        return jsonify({
            "success": True,
            "count": len(guests)
        })

    except Exception as e:
        print("COUNT GUEST ERROR:", str(e))
        traceback.print_exc()

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500