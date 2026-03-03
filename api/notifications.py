#!/usr/bin/env python3
# api/notifications.py — Notification management routes

from flask import Blueprint, jsonify, request
from .db import get_notifications, mark_notification_read, save_notification

notifications_bp = Blueprint("notifications", __name__)

@notifications_bp.route("", methods=["GET"])
def get_notifs():
    unread_only = request.args.get("unread_only", "false").lower() == "true"
    try:
        data = get_notifications(unread_only=unread_only)
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@notifications_bp.route("/read", methods=["POST"])
def mark_read():
    notif_id = request.get_json(force=True).get("id")
    if not isinstance(notif_id, int):
        return jsonify({"success": False, "error": "id (int) required"}), 400
    try:
        mark_notification_read(notif_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@notifications_bp.route("/test", methods=["POST"])
def add_test_notif():
    """Debug endpoint to inject a notification."""
    data = request.get_json(force=True) or {}
    title = data.get("title", "Test Alert")
    msg = data.get("message", "This is a test notification from the API.")
    n_type = data.get("type", "info")
    try:
        save_notification(title, msg, n_type)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
