# api/absence.py
from flask import Blueprint, request, jsonify
import time
from .collector_service import send_event

absence_bp = Blueprint('absence_bp', __name__)

# In-memory absence state (or persisted to local SQLite/JSON storage)
current_absence = None

@absence_bp.route('/absence', methods=['GET', 'POST', 'DELETE'])
def household_absence():
    global current_absence

    if request.method == 'GET':
        if current_absence and current_absence.get('end_time', 0) > time.time():
            return jsonify({'active': True, 'absence': current_absence}), 200
        if current_absence and current_absence.get('end_time', 0) <= time.time():
            current_absence = None
        return jsonify({'active': False, 'absence': None}), 200

    elif request.method == 'POST':
        data = request.get_json(force=True) or {}
        start_time = data.get('start_time', int(time.time()))
        end_time = data.get('end_time')

        if not end_time or end_time <= start_time:
            return jsonify({'success': False, 'error': 'Invalid date range'}), 400

        activated_at = int(time.time())
        current_absence = {
            'start_time': int(start_time),
            'end_time': int(end_time),
            'activated_at': activated_at
        }

        # D-Bus event dispatch (Event Type 5: Away Mode Activated)
        payload_activate = {
            'action': 'activated',
            'start_time': current_absence['start_time'],
            'end_time': current_absence['end_time'],
            'activated_at': activated_at
        }
        send_event(5, payload_activate)

        return jsonify({'success': True, 'absence': current_absence}), 200

    elif request.method == 'DELETE':
        cancelled_at = int(time.time())

        # D-Bus event dispatch (Event Type 6: Away Mode Cancelled)
        payload_cancel = {
            'action': 'cancelled',
            'cancelled_at': cancelled_at
        }
        send_event(6, payload_cancel)

        current_absence = None
        return jsonify({'success': True, 'message': 'Absence cancelled'}), 200