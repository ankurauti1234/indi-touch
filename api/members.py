#!/usr/bin/env python3
# api/members.py — Member management routes

from flask import Blueprint, jsonify, request
from .config import METER_ID
from .db import load_members_data, toggle_member_in_db, rename_member_in_db
from .collector_service import publish_member_event

members_bp = Blueprint("members", __name__)


@members_bp.route("", methods=["GET"])
def get_members():
    try:
        data = load_members_data()
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@members_bp.route("/toggle", methods=["POST"])
def toggle_member():
    index = request.get_json(force=True).get("index")
    if not isinstance(index, int):
        return jsonify({"success": False, "error": "index (int) required"}), 400
    try:
        member, new_state = toggle_member_in_db(index)
        publish_member_event()
        return jsonify({"success": True, "member": member, "active": new_state})
    except IndexError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@members_bp.route("/toggle_bulk", methods=["POST"])
def toggle_members_bulk():
    indexes = request.get_json(force=True).get("indexes")
    if not isinstance(indexes, list):
        return jsonify({"success": False, "error": "indexes (list) required"}), 400
    
    try:
        updated_members = []
        # Update the database for all provided indexes silently
        for index in indexes:
            member, new_state = toggle_member_in_db(index)
            updated_members.append({"member": member, "active": new_state})
        
        # Fire the device event EXACTLY ONCE after all DB updates are complete
        if indexes:
            publish_member_event()
        
        return jsonify({"success": True, "updated": updated_members})
    
    except IndexError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    

@members_bp.route("/rename", methods=["POST"])
def rename_member():
    data  = request.get_json(force=True)
    index = data.get("index")
    name  = data.get("name", "").strip()
    if not isinstance(index, int) or not name:
        return jsonify({"success": False, "error": "index and name required"}), 400
    try:
        member = rename_member_in_db(index, name)
        publish_member_event()
        return jsonify({"success": True, "member": member})
    except IndexError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@members_bp.route("/undeclare", methods=["POST"])
def undeclare_all():
    try:
        from .db import undeclare_all_members_in_db
        undeclare_all_members_in_db()
        publish_member_event()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
