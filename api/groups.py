from flask import Blueprint, jsonify, request
from .db import (
    load_groups_data,
    create_group_in_db,
    update_group_in_db,
    delete_group_from_db,
    toggle_group_in_db
)
from .members import publish_member_event

groups_bp = Blueprint("groups", __name__)

@groups_bp.route("", methods=["GET"])
def get_groups():
    try:
        groups = load_groups_data()
        return jsonify({"success": True, "groups": groups})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@groups_bp.route("", methods=["POST"])
def create_group():
    try:
        data = request.get_json(force=True)
        name = data.get("name")
        member_codes = data.get("member_codes", [])
        if not name:
            return jsonify({"success": False, "error": "Name is required"}), 400
        
        group = create_group_in_db(name, member_codes)
        return jsonify({"success": True, "group": group})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@groups_bp.route("/<int:group_id>", methods=["PUT"])
def update_group(group_id):
    try:
        data = request.get_json(force=True)
        name = data.get("name")
        member_codes = data.get("member_codes", [])
        if not name:
            return jsonify({"success": False, "error": "Name is required"}), 400
        
        update_group_in_db(group_id, name, member_codes)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@groups_bp.route("/<int:group_id>", methods=["DELETE"])
def delete_group(group_id):
    try:
        delete_group_from_db(group_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@groups_bp.route("/toggle", methods=["POST"])
def toggle_group():
    try:
        data = request.get_json(force=True)
        group_id = data.get("id")
        if group_id is None:
            return jsonify({"success": False, "error": "Group ID is required"}), 400
        
        new_state = toggle_group_in_db(int(group_id))
        publish_member_event()
        return jsonify({"success": True, "active": new_state})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
